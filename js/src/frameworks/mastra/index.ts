import { context as otelContext, trace as otelTrace, ROOT_CONTEXT, TraceFlags, type Tracer } from '@opentelemetry/api';
import { Agento11yClient } from '../../client.js';
import type { GenerationRecorder, GenerationStart, Message, WorkflowStep } from '../../types.js';
import {
  asFiniteNumber,
  asRecord,
  asString,
  asStringArray,
  asStringOrUndefined,
  coerceDate,
  detectThinkingEnabled,
  isValidOtelSpanId,
  isValidOtelTraceId,
  mapAvailableTools,
  mapMastraError,
  mapMastraErrorClassification,
  mapMastraInputMessages,
  mapMastraOutputMessages,
  mapMastraUsage,
  mapToolChoice,
  normalizeMetadataRecord,
  resolveMastraProvider,
  safeJSONStringify,
  spanAttributeString,
  spanMetadataString,
  splitSystemPrompt,
  toStateRecord,
} from './mapping.js';
import {
  type Agento11yMastraOptions,
  MASTRA_SPAN_TYPES,
  type MastraExportedSpan,
  type MastraInitExporterOptions,
  type MastraLoggerLike,
  type MastraObservabilityExporterLike,
  type MastraTracingEvent,
} from './types.js';

export type {
  Agento11yMastraOptions,
  MastraConversationIdResolver,
  MastraExportedSpan,
  MastraInitExporterOptions,
  MastraLoggerLike,
  MastraObservabilityExporterLike,
  MastraProviderResolverFn,
  MastraTracingEvent,
  MastraTracingEventType,
} from './types.js';
export { MASTRA_SPAN_TYPES };

const frameworkName = 'mastra';
const frameworkSource = 'exporter';
const frameworkLanguage = 'typescript';

const metadataKeyRunID = 'agento11y.framework.run_id';
const metadataKeyRunType = 'agento11y.framework.run_type';
const metadataKeyThreadID = 'agento11y.framework.thread_id';
const metadataKeyParentRunID = 'agento11y.framework.parent_run_id';
const metadataKeyComponentName = 'agento11y.framework.component_name';
const metadataKeyTags = 'agento11y.framework.tags';
const metadataKeyMastraSpanType = 'agento11y.framework.mastra.span_type';
const metadataKeyMastraProvider = 'agento11y.framework.mastra.provider';
const metadataKeyMastraMetadata = 'agento11y.framework.mastra.metadata';
const metadataKeyMastraUsageRollup = 'agento11y.framework.mastra.usage_rollup';

const eventSpanEnded = 'span_ended';

const defaultTraceTtlMs = 600_000;
const defaultMaxTrackedTraces = 1_000;
const traceCleanupDelayMs = 30_000;

const toolSpanTypes = new Set<string>([
  MASTRA_SPAN_TYPES.toolCall,
  MASTRA_SPAN_TYPES.mcpToolCall,
  MASTRA_SPAN_TYPES.clientToolCall,
]);

/**
 * Workflow constructs whose child steps run concurrently: their steps share
 * the predecessors captured before the construct, and the construct's end
 * publishes all of its steps as the joint heads for whatever follows.
 */
const concurrentConstructTypes = new Set<string>(['workflow_parallel', 'workflow_conditional']);

interface StepChain {
  /** Span id of the nearest `workflow_run`/`workflow_step` ancestor scope. */
  anchorKey: string;
  /** Outermost construct span between the step and its anchor, if any. */
  groupId?: string;
  /** Whether that construct runs its steps concurrently. */
  concurrent: boolean;
}

interface TraceState {
  /** Slimmed ancestry copies (no input/output payloads) keyed by span id. */
  spans: Map<string, MastraExportedSpan>;
  /** Last exported generation id; chains `parentGenerationIds` per trace. */
  lastGenerationId?: string;
  /** Generation ids linked to their nearest `workflow_step` ancestor. */
  stepGenerationLinks: Map<string, string[]>;
  /** Current step DAG heads per chain scope; next step's `parentStepIds`. */
  stepChainHeads: Map<string, string[]>;
  /** Steps accumulated inside a concurrent construct, keyed by construct id. */
  pendingStepGroups: Map<string, { anchorKey: string; stepIds: string[] }>;
  /**
   * Ended tool round-trips awaiting embedding into their generation's output
   * messages, keyed by the nearest `model_generation` ancestor span id ('' when
   * none — those attach to the next generation ending in the trace).
   */
  pendingToolMessages: Map<string, PendingToolMessage[]>;
  /**
   * Per-step outputs (text, reasoning, tool calls) awaiting reconstruction of
   * the generation's interleaved output, keyed by the `model_generation`
   * ancestor span id.
   */
  pendingStepOutputs: Map<string, PendingStepOutput[]>;
  /** Reasoning chunk texts keyed by their `model_step` ancestor span id. */
  pendingStepThinking: Map<string, { seq: number; text: string }[]>;
  /** Combined size of the three buffers above (per-trace memory guard). */
  pendingContentCount: number;
  lastActivity: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface PendingToolMessage {
  toolName: string;
  toolCallId: string;
  inputJSON?: string;
  resultJSON?: string;
  isError: boolean;
  endedAt: number;
}

interface PendingStepOutput {
  stepIndex: number;
  text?: string;
  thinking: string[];
  toolCalls: { id?: string; name: string; inputJSON?: string }[];
}

/** Cap on buffered output content items per trace (memory guard for tool/step storms). */
const maxPendingContentPerTrace = 500;

function isAgento11yClient(value: unknown): value is Agento11yClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { startGeneration?: unknown }).startGeneration === 'function' &&
    typeof (value as { enqueueWorkflowStep?: unknown }).enqueueWorkflowStep === 'function'
  );
}

function maybeUnrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  const withUnref = timer as { unref?: () => void };
  if (typeof withUnref.unref === 'function') {
    withUnref.unref();
  }
}

/**
 * Renders per-step records into the interleaved message sequence the turn
 * actually produced: per step an assistant message (thinking → text → tool
 * calls) followed by a tool message with that step's results, then any tool
 * executions the steps did not account for as standalone round-trips.
 */
function buildSteppedOutput(steps: PendingStepOutput[], toolResults: PendingToolMessage[]): Message[] {
  const unclaimed = [...toolResults];
  const messages: Message[] = [];
  for (const step of steps) {
    const parts: NonNullable<Message['parts']> = [];
    for (const thinking of step.thinking) {
      if (thinking.trim().length > 0) {
        parts.push({ type: 'thinking', thinking });
      }
    }
    if (step.text !== undefined && step.text.trim().length > 0) {
      parts.push({ type: 'text', text: step.text });
    }
    for (const call of step.toolCalls) {
      parts.push({ type: 'tool_call', toolCall: { id: call.id, name: call.name, inputJSON: call.inputJSON } });
    }
    if (parts.length > 0) {
      messages.push({ role: 'assistant', parts });
    }

    const resultParts: NonNullable<Message['parts']> = [];
    for (const call of step.toolCalls) {
      // Executions pair with the step's calls by tool name in completion
      // order (Mastra tool spans do not carry the model's toolCallId).
      const index = unclaimed.findIndex((record) => record.toolName === call.name);
      if (index < 0) {
        continue;
      }
      const [record] = unclaimed.splice(index, 1);
      resultParts.push({
        type: 'tool_result',
        toolResult: {
          toolCallId: call.id ?? record?.toolCallId,
          name: call.name,
          contentJSON: record?.resultJSON,
          isError: record?.isError ? true : undefined,
        },
      });
    }
    if (resultParts.length > 0) {
      messages.push({ role: 'tool', parts: resultParts });
    }
  }

  for (const record of unclaimed) {
    messages.push(
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            toolCall: { id: record.toolCallId, name: record.toolName, inputJSON: record.inputJSON },
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolResult: {
              toolCallId: record.toolCallId,
              name: record.toolName,
              contentJSON: record.resultJSON,
              isError: record.isError ? true : undefined,
            },
          },
        ],
      },
    );
  }
  return messages;
}

/**
 * Copy of a span kept for ancestry lookups. Input/output/error payloads are
 * dropped so one long-lived trace (e.g. an agent with thousands of tool
 * calls) does not pin its full message history in memory.
 */
function slimSpanForAncestry(span: MastraExportedSpan): MastraExportedSpan {
  return {
    id: span.id,
    traceId: span.traceId,
    name: span.name,
    type: span.type,
    parentSpanId: span.parentSpanId,
    isRootSpan: span.isRootSpan,
    isEvent: span.isEvent,
    entityType: span.entityType,
    entityId: span.entityId,
    entityName: span.entityName,
    attributes: span.attributes,
    metadata: span.metadata,
    tags: span.tags,
  };
}

/**
 * Mastra observability exporter backed by a {@link Agento11yClient}.
 *
 * Register it in the Mastra observability config:
 *
 * ```ts
 * import { Mastra } from '@mastra/core/mastra';
 * import { Observability } from '@mastra/observability';
 * import { Agento11yClient } from '@grafana/agento11y';
 * import { createAgento11yMastra } from '@grafana/agento11y/mastra';
 *
 * const agento11y = new Agento11yClient(); // reads AGENTO11Y_* env vars
 * export const mastra = new Mastra({
 *   observability: new Observability({
 *     configs: {
 *       agento11y: {
 *         serviceName: 'my-service',
 *         exporters: [createAgento11yMastra(agento11y, { agentVersion: '1.0.0' })],
 *       },
 *     },
 *   }),
 * });
 * ```
 *
 * Mapping:
 * - `model_generation` spans become Agento11y generations (plus `gen_ai.client.*`
 *   metrics and a `generateText`/`streamText` OTel span).
 * - `tool_call` / `mcp_tool_call` / `client_tool_call` spans become
 *   `execute_tool` OTel spans.
 * - `workflow_step` spans become Agento11y workflow steps with linked generations
 *   and sequential `parentStepIds`.
 * - `agent_run` spans supply agent name/version, conversation id, system
 *   instructions, and available tools to their descendants.
 *
 * OTel spans created by the Agento11y client are parented on the originating
 * Mastra span context, so pairing this exporter with `@mastra/otel-exporter`
 * (pointed at the same Grafana stack) yields a single joined trace.
 */
export class Agento11yMastraExporter implements MastraObservabilityExporterLike {
  readonly name = 'agento11y';

  private readonly client: Agento11yClient;
  private readonly ownsClient: boolean;
  private readonly options: Agento11yMastraOptions;
  private readonly traces = new Map<string, TraceState>();
  private serviceName?: string;
  private mastraLogger?: MastraLoggerLike;
  private lastSweepAt = 0;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(client: Agento11yClient, options?: Agento11yMastraOptions);
  constructor(options?: Agento11yMastraOptions);
  constructor(clientOrOptions?: Agento11yClient | Agento11yMastraOptions, maybeOptions?: Agento11yMastraOptions) {
    if (isAgento11yClient(clientOrOptions)) {
      this.client = clientOrOptions;
      this.ownsClient = false;
      this.options = { ...(maybeOptions ?? {}) };
    } else {
      this.client = new Agento11yClient();
      this.ownsClient = true;
      this.options = { ...(clientOrOptions ?? {}) };
    }
  }

  /** Mastra calls this once the exporter is attached to an instance. */
  init(options: MastraInitExporterOptions): void {
    const serviceName = options?.config?.serviceName;
    if (typeof serviceName === 'string' && serviceName.length > 0) {
      this.serviceName = serviceName;
    }
  }

  /** Mastra injects its logger here. */
  __setLogger(logger: MastraLoggerLike): void {
    this.mastraLogger = logger;
  }

  /** Mastra event-bus entry point; delegates to {@link exportTracingEvent}. */
  onTracingEvent(event: MastraTracingEvent): void | Promise<void> {
    return this.exportTracingEvent(event);
  }

  /** Handles a Mastra tracing event. Never rejects. */
  async exportTracingEvent(event: MastraTracingEvent): Promise<void> {
    try {
      this.handleEvent(event);
    } catch (error) {
      this.logWarn('agento11y mastra exporter failed to process tracing event', error);
    }
  }

  /** Flushes queued generations and workflow steps. Never rejects. */
  async flush(): Promise<void> {
    try {
      await this.client.flush();
    } catch (error) {
      this.logWarn('agento11y client flush failed', error);
    }
  }

  /** Releases per-trace state; shuts the owned Agento11y client down. */
  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const state of this.traces.values()) {
      if (state.cleanupTimer !== undefined) {
        clearTimeout(state.cleanupTimer);
      }
    }
    this.traces.clear();
    this.stopSweepTimer();
    // Never reject into Mastra's shutdown sequence — a shared client may
    // already have been shut down by the application, which makes flush()
    // throw 'agento11y client is shutdown'.
    try {
      const shutdownClient = this.options.shutdownClient ?? this.ownsClient;
      if (shutdownClient) {
        await this.client.shutdown();
      } else {
        await this.client.flush();
      }
    } catch (error) {
      this.logWarn('agento11y client flush/shutdown during exporter shutdown failed', error);
    }
  }

  private handleEvent(event: MastraTracingEvent): void {
    if (this.closed || event === null || typeof event !== 'object') {
      return;
    }
    const span = event.exportedSpan;
    if (
      span === null ||
      typeof span !== 'object' ||
      typeof span.id !== 'string' ||
      span.id.length === 0 ||
      typeof span.traceId !== 'string' ||
      span.traceId.length === 0
    ) {
      return;
    }

    const state = this.getTraceState(span.traceId);
    state.lastActivity = Date.now();
    state.spans.set(span.id, slimSpanForAncestry(span));
    if (state.cleanupTimer !== undefined) {
      // Late activity on a trace whose root already ended; let the new data
      // settle before dropping the bookkeeping again.
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }

    if (event.type === eventSpanEnded) {
      if (span.isEvent !== true) {
        this.dispatchEndedSpan(state, span);
      }
      if (span.isRootSpan === true) {
        this.scheduleTraceCleanup(span.traceId, state);
      }
    }

    this.sweep();
  }

  private dispatchEndedSpan(state: TraceState, span: MastraExportedSpan): void {
    if (span.type === MASTRA_SPAN_TYPES.modelGeneration) {
      this.recordGeneration(state, span);
      return;
    }
    if (span.type === MASTRA_SPAN_TYPES.modelChunk) {
      this.bufferReasoningChunk(state, span);
      return;
    }
    if (span.type === MASTRA_SPAN_TYPES.modelStep) {
      this.bufferStepOutput(state, span);
      return;
    }
    if (toolSpanTypes.has(span.type)) {
      this.recordToolExecution(state, span);
      return;
    }
    if (span.type === MASTRA_SPAN_TYPES.workflowStep) {
      if (this.options.exportWorkflowSteps ?? true) {
        this.recordWorkflowStep(state, span);
      }
      this.recordUsageRollup(state, span);
      return;
    }
    if (span.type === MASTRA_SPAN_TYPES.agentRun || span.type === MASTRA_SPAN_TYPES.workflowRun) {
      // Internal/excluded model spans roll their token usage onto the nearest
      // exported ancestor's `internalUsage`; surface it so cost data survives.
      this.recordUsageRollup(state, span);
      return;
    }
    if (concurrentConstructTypes.has(span.type)) {
      // A parallel/conditional block finished: its steps jointly become the
      // DAG heads for the next step in the enclosing scope.
      const group = state.pendingStepGroups.get(span.id);
      if (group !== undefined) {
        if (group.stepIds.length > 0) {
          state.stepChainHeads.set(group.anchorKey, group.stepIds);
        }
        state.pendingStepGroups.delete(span.id);
      }
    }
  }

  private recordGeneration(state: TraceState, span: MastraExportedSpan): void {
    const attributes = asRecord(span.attributes) ?? {};
    const parameters = asRecord(attributes.parameters) ?? {};
    const rawProvider = asString(attributes.provider);
    const modelName = asString(attributes.model) || 'unknown';
    const provider = resolveMastraProvider(
      this.options.provider,
      this.options.providerResolver ?? 'auto',
      rawProvider,
      modelName,
    );
    const streaming = attributes.streaming === true;
    const startedAt = coerceDate(span.startTime) ?? new Date();
    const completedAt = coerceDate(span.endTime) ?? new Date();
    const captureInputs = this.options.captureInputs ?? true;
    const captureOutputs = this.options.captureOutputs ?? true;
    const { systemPrompt, messages } = splitSystemPrompt(captureInputs ? mapMastraInputMessages(span.input) : []);
    const agentSpan = this.findAncestor(state, span, MASTRA_SPAN_TYPES.agentRun);
    const inferenceAttributes = this.findInferenceAttributes(state, span);
    // Deterministic id: the Mastra span id doubles as the generation id, so
    // re-exported spans are idempotent server-side and applications can
    // reference a generation from anywhere the span id is known.
    const generationId = span.id;

    const metadata = this.buildMetadata(state, span, 'llm');
    if (rawProvider.length > 0 && rawProvider !== provider) {
      metadata[metadataKeyMastraProvider] = rawProvider;
    }
    const errorClassification = mapMastraErrorClassification(span.errorInfo);
    if (errorClassification !== undefined) {
      Object.assign(metadata, errorClassification);
    }

    const seed: GenerationStart = {
      id: generationId,
      conversationId: this.resolveConversationId(state, span),
      userId: this.resolveUserId(state, span),
      agentName: this.resolveAgentName(agentSpan),
      agentVersion: this.resolveAgentVersion(agentSpan),
      mode: streaming ? 'STREAM' : 'SYNC',
      model: { provider, name: modelName },
      // The `instructions` fallback is additionally gated on the span's own
      // input being present: Mastra's `hideInput` nulls `input` but leaves
      // attributes intact, and the system prompt must not bypass it.
      systemPrompt:
        systemPrompt ??
        (captureInputs && span.input !== undefined && agentSpan !== undefined
          ? spanAttributeString(agentSpan, 'instructions')
          : undefined),
      maxTokens: asFiniteNumber(parameters.maxOutputTokens),
      temperature: asFiniteNumber(parameters.temperature),
      topP: asFiniteNumber(parameters.topP),
      toolChoice: mapToolChoice(inferenceAttributes?.toolChoice),
      thinkingEnabled: detectThinkingEnabled(attributes, inferenceAttributes),
      parentGenerationIds: state.lastGenerationId === undefined ? undefined : [state.lastGenerationId],
      tools: mapAvailableTools(asRecord(agentSpan?.attributes)?.availableTools),
      tags: this.buildTags(),
      metadata,
      startedAt,
    };

    const finalSeed = this.applyGenerationCustomizer(seed, span);
    const recorder: GenerationRecorder = this.withMastraParentContext(span, () =>
      streaming ? this.client.startStreamingGeneration(finalSeed) : this.client.startGeneration(finalSeed),
    );

    const completionStartTime = coerceDate(attributes.completionStartTime);
    if (completionStartTime !== undefined) {
      recorder.setFirstTokenAt(completionStartTime);
    }
    const errorMessage = mapMastraError(span.errorInfo);
    if (errorMessage !== undefined) {
      recorder.setCallError(new Error(errorMessage));
    }
    const outputMessages = captureOutputs ? mapMastraOutputMessages(span.output) : [];
    // Reconstruct the turn's real interleaving unless the framework already
    // put tool parts in the output. Preference order: native tool parts →
    // per-step records (thinking → text → tool call → result, per round) →
    // buffered tool round-trips ahead of the aggregated text.
    const hasNativeToolParts = outputMessages.some((message) =>
      (message.parts ?? []).some((part) => part.type === 'tool_call' || part.type === 'tool_result'),
    );
    const embed = captureOutputs && (this.options.embedToolMessages ?? true) && !hasNativeToolParts;
    const stepRecords = embed ? this.takeStepOutputs(state, span.id) : [];
    const toolRecords = embed ? this.takeToolRecords(state, span.id) : [];
    const combinedOutput =
      stepRecords.length > 0
        ? buildSteppedOutput(stepRecords, toolRecords)
        : [...buildSteppedOutput([], toolRecords), ...outputMessages];
    recorder.setResult({
      input: messages.length > 0 ? messages : undefined,
      output: combinedOutput.length > 0 ? combinedOutput : undefined,
      // internalUsage carries token counts rolled up from hidden internal
      // descendants; use it only when the span has no direct usage so the
      // two sources are never double counted.
      usage: mapMastraUsage(attributes.usage) ?? mapMastraUsage(attributes.internalUsage),
      stopReason: asStringOrUndefined(attributes.finishReason),
      responseId: asStringOrUndefined(attributes.responseId),
      responseModel: asStringOrUndefined(attributes.responseModel),
      completedAt,
    });
    recorder.end();
    const recorderError = recorder.getError();
    if (recorderError !== undefined) {
      this.logWarn('agento11y mastra exporter failed to record generation', recorderError);
      return;
    }

    state.lastGenerationId = generationId;
    const stepAncestor = this.findAncestor(state, span, MASTRA_SPAN_TYPES.workflowStep);
    if (stepAncestor !== undefined) {
      const links = state.stepGenerationLinks.get(stepAncestor.id) ?? [];
      links.push(generationId);
      state.stepGenerationLinks.set(stepAncestor.id, links);
    }
  }

  /**
   * Exports a usage-only generation when an `agent_run`/`workflow_run`/
   * `workflow_step` span carries `internalUsage` — Mastra's rollup of token
   * usage from model spans that were marked internal or excluded and thus
   * never reach this exporter as `model_generation` events. Without it, the
   * documented `excludeSpanTypes`/`TracingPolicy` cost-reduction configs
   * silently zero every token count in Agento11y. `internalUsage` never overlaps
   * with usage reported by exported `model_generation` spans, so this cannot
   * double count.
   */
  private recordUsageRollup(state: TraceState, span: MastraExportedSpan): void {
    const usage = mapMastraUsage(asRecord(span.attributes)?.internalUsage);
    if (usage === undefined) {
      return;
    }
    const agentSpan =
      span.type === MASTRA_SPAN_TYPES.agentRun ? span : this.findAncestor(state, span, MASTRA_SPAN_TYPES.agentRun);
    const generationId = span.id;
    const metadata = this.buildMetadata(state, span, 'llm');
    metadata[metadataKeyMastraUsageRollup] = true;

    const seed = this.applyGenerationCustomizer(
      {
        id: generationId,
        conversationId: this.resolveConversationId(state, span),
        userId: this.resolveUserId(state, span),
        agentName: this.resolveAgentName(agentSpan),
        agentVersion: this.resolveAgentVersion(agentSpan),
        model: { provider: 'custom', name: 'unknown' },
        parentGenerationIds: state.lastGenerationId === undefined ? undefined : [state.lastGenerationId],
        tags: this.buildTags(),
        metadata,
        startedAt: coerceDate(span.startTime) ?? new Date(),
      },
      span,
    );
    const recorder = this.withMastraParentContext(span, () => this.client.startGeneration(seed));
    recorder.setResult({ usage, completedAt: coerceDate(span.endTime) ?? new Date() });
    recorder.end();
    const recorderError = recorder.getError();
    if (recorderError !== undefined) {
      this.logWarn('agento11y mastra exporter failed to record usage rollup', recorderError);
      return;
    }
    state.lastGenerationId = generationId;
  }

  /** Applies the user's `customizeGeneration` hook; never throws. */
  private applyGenerationCustomizer(seed: GenerationStart, span: MastraExportedSpan): GenerationStart {
    const customize = this.options.customizeGeneration;
    if (customize === undefined) {
      return seed;
    }
    try {
      return customize(seed, span) ?? seed;
    } catch (error) {
      this.logWarn('agento11y mastra exporter customizeGeneration hook failed; using the unmodified seed', error);
      return seed;
    }
  }

  /**
   * Finds the attributes of a `model_inference` descendant of the given
   * generation span (inference spans nest a few levels below it and end
   * first, so they are already stored). Request controls like `toolChoice`
   * only appear there.
   */
  private findInferenceAttributes(
    state: TraceState,
    generationSpan: MastraExportedSpan,
  ): Record<string, unknown> | undefined {
    for (const candidate of state.spans.values()) {
      if (candidate.type !== MASTRA_SPAN_TYPES.modelInference) {
        continue;
      }
      let currentId = candidate.parentSpanId;
      for (let hops = 0; hops < 4 && currentId !== undefined && currentId.length > 0; hops++) {
        if (currentId === generationSpan.id) {
          return asRecord(candidate.attributes);
        }
        currentId = state.spans.get(currentId)?.parentSpanId;
      }
    }
    return undefined;
  }

  private recordToolExecution(state: TraceState, span: MastraExportedSpan): void {
    const attributes = asRecord(span.attributes) ?? {};
    const toolName = span.entityName ?? span.entityId ?? span.name;
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      return;
    }
    const startedAt = coerceDate(span.startTime) ?? new Date();
    const completedAt = coerceDate(span.endTime) ?? new Date();
    const captureInputs = this.options.captureInputs ?? true;
    const captureOutputs = this.options.captureOutputs ?? true;
    const agentSpan = this.findAncestor(state, span, MASTRA_SPAN_TYPES.agentRun);
    const generationSpan = this.findAncestor(state, span, MASTRA_SPAN_TYPES.modelGeneration);
    const generationAttributes = asRecord(generationSpan?.attributes);

    const toolType =
      span.type === MASTRA_SPAN_TYPES.mcpToolCall
        ? 'mcp'
        : span.type === MASTRA_SPAN_TYPES.clientToolCall
          ? 'client'
          : (asStringOrUndefined(attributes.toolType) ?? 'tool');

    const recorder = this.withMastraParentContext(span, () =>
      this.client.startToolExecution({
        toolName,
        // Correlates the execution span with the generation's tool_call part
        // when Mastra exposes the id (not all versions do).
        toolCallId: asStringOrUndefined(attributes.toolCallId) ?? spanMetadataString(span, 'toolCallId'),
        toolType,
        toolDescription: asStringOrUndefined(attributes.toolDescription),
        conversationId: this.resolveConversationId(state, span),
        agentName: this.resolveAgentName(agentSpan),
        agentVersion: this.resolveAgentVersion(agentSpan),
        requestModel: asStringOrUndefined(generationAttributes?.model),
        requestProvider:
          generationAttributes === undefined
            ? undefined
            : resolveMastraProvider(
                this.options.provider,
                this.options.providerResolver ?? 'auto',
                asString(generationAttributes.provider),
                asString(generationAttributes.model),
              ),
        // Match the shared framework handler: capture flags opt tool content
        // into spans under the default no_tool_content client mode.
        includeContent: captureInputs || captureOutputs,
        startedAt,
      }),
    );

    const errorMessage = mapMastraError(span.errorInfo);
    if (errorMessage !== undefined) {
      recorder.setCallError(new Error(errorMessage));
    }
    recorder.setResult({
      arguments: captureInputs ? span.input : undefined,
      result: captureOutputs ? span.output : undefined,
      completedAt,
    });
    recorder.end();
    const recorderError = recorder.getError();
    if (recorderError !== undefined) {
      this.logWarn('agento11y mastra exporter failed to record tool execution', recorderError);
    }

    this.bufferToolMessage(state, span, generationSpan, toolName, captureInputs, captureOutputs);
  }

  /**
   * Buffers a reasoning chunk's text under its `model_step` ancestor so the
   * step's thinking can be replayed in the reconstructed output.
   */
  private bufferReasoningChunk(state: TraceState, span: MastraExportedSpan): void {
    if ((this.options.embedToolMessages ?? true) === false || (this.options.captureOutputs ?? true) === false) {
      return;
    }
    const attributes = asRecord(span.attributes) ?? {};
    if (asString(attributes.chunkType) !== 'reasoning') {
      return;
    }
    const text = asString(asRecord(span.output)?.text);
    if (text.trim().length === 0 || state.pendingContentCount >= maxPendingContentPerTrace) {
      return;
    }
    const stepSpan = this.findAncestor(state, span, MASTRA_SPAN_TYPES.modelStep);
    if (stepSpan === undefined) {
      return;
    }
    state.pendingContentCount += 1;
    const list = state.pendingStepThinking.get(stepSpan.id) ?? [];
    list.push({ seq: asFiniteNumber(attributes.sequenceNumber) ?? list.length, text });
    state.pendingStepThinking.set(stepSpan.id, list);
  }

  /**
   * Buffers a `model_step` span's per-round output (thinking, text, tool
   * calls with the model's real toolCallIds) under its generation, keyed for
   * interleaved output reconstruction at generation end.
   */
  private bufferStepOutput(state: TraceState, span: MastraExportedSpan): void {
    if ((this.options.embedToolMessages ?? true) === false || (this.options.captureOutputs ?? true) === false) {
      return;
    }
    const captureInputs = this.options.captureInputs ?? true;
    const attributes = asRecord(span.attributes) ?? {};
    const output = asRecord(span.output);
    const thinking = (state.pendingStepThinking.get(span.id) ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((entry) => entry.text);
    state.pendingStepThinking.delete(span.id);
    state.pendingContentCount = Math.max(0, state.pendingContentCount - thinking.length);

    const text = asStringOrUndefined(output?.text);
    const toolCalls: PendingStepOutput['toolCalls'] = [];
    if (Array.isArray(output?.toolCalls)) {
      for (const item of output.toolCalls) {
        const call = asRecord(item);
        const name = asString(call?.toolName);
        if (name.length === 0) {
          continue;
        }
        toolCalls.push({
          id: asStringOrUndefined(call?.toolCallId),
          name,
          inputJSON: captureInputs && call?.args !== undefined ? safeJSONStringify(call.args) : undefined,
        });
      }
    }
    if (
      (text === undefined && thinking.length === 0 && toolCalls.length === 0) ||
      state.pendingContentCount >= maxPendingContentPerTrace
    ) {
      return;
    }
    const generationSpan = this.findAncestor(state, span, MASTRA_SPAN_TYPES.modelGeneration);
    if (generationSpan === undefined) {
      return;
    }
    state.pendingContentCount += 1 + thinking.length;
    const list = state.pendingStepOutputs.get(generationSpan.id) ?? [];
    list.push({ stepIndex: asFiniteNumber(attributes.stepIndex) ?? list.length, text, thinking, toolCalls });
    state.pendingStepOutputs.set(generationSpan.id, list);
  }

  /**
   * Buffers an ended tool round-trip for embedding into its generation's
   * output messages (Mastra's generation output carries only the final text,
   * so without this tools are invisible inside the generation).
   */
  private bufferToolMessage(
    state: TraceState,
    span: MastraExportedSpan,
    generationSpan: MastraExportedSpan | undefined,
    toolName: string,
    captureInputs: boolean,
    captureOutputs: boolean,
  ): void {
    if ((this.options.embedToolMessages ?? true) === false) {
      return;
    }
    if (state.pendingContentCount >= maxPendingContentPerTrace) {
      return;
    }
    state.pendingContentCount += 1;
    const attributes = asRecord(span.attributes) ?? {};
    const key = generationSpan?.id ?? '';
    const list = state.pendingToolMessages.get(key) ?? [];
    list.push({
      toolName,
      // The span id doubles as the call/result pairing id when Mastra does
      // not expose the model's toolCallId.
      toolCallId: asStringOrUndefined(attributes.toolCallId) ?? spanMetadataString(span, 'toolCallId') ?? span.id,
      inputJSON: captureInputs && span.input !== undefined ? safeJSONStringify(span.input) : undefined,
      resultJSON: captureOutputs && span.output !== undefined ? safeJSONStringify(span.output) : undefined,
      isError: span.errorInfo !== undefined || attributes.success === false,
      endedAt: (coerceDate(span.endTime) ?? new Date()).getTime(),
    });
    state.pendingToolMessages.set(key, list);
  }

  /**
   * Consumes the buffered tool round-trips for a generation (plus any without
   * a generation ancestor, e.g. client tool calls parented on the agent run).
   */
  private takeToolRecords(state: TraceState, generationSpanId: string): PendingToolMessage[] {
    const records = [
      ...(state.pendingToolMessages.get(generationSpanId) ?? []),
      ...(state.pendingToolMessages.get('') ?? []),
    ].sort((a, b) => a.endedAt - b.endedAt);
    state.pendingToolMessages.delete(generationSpanId);
    state.pendingToolMessages.delete('');
    state.pendingContentCount = Math.max(0, state.pendingContentCount - records.length);
    return records;
  }

  /** Consumes the buffered per-step outputs for a generation, in step order. */
  private takeStepOutputs(state: TraceState, generationSpanId: string): PendingStepOutput[] {
    const steps = (state.pendingStepOutputs.get(generationSpanId) ?? []).sort((a, b) => a.stepIndex - b.stepIndex);
    state.pendingStepOutputs.delete(generationSpanId);
    state.pendingContentCount = Math.max(
      0,
      state.pendingContentCount - steps.reduce((total, step) => total + 1 + step.thinking.length, 0),
    );
    return steps;
  }

  private recordWorkflowStep(state: TraceState, span: MastraExportedSpan): void {
    const attributes = asRecord(span.attributes) ?? {};
    // On workflow_step spans entityId is the step id while entityName carries
    // the parent workflow's name — prefer the step id.
    const stepName = asStringOrUndefined(span.entityId) ?? asStringOrUndefined(span.entityName) ?? span.name;
    if (typeof stepName !== 'string' || stepName.trim().length === 0) {
      return;
    }
    const captureInputs = this.options.captureInputs ?? true;
    const captureOutputs = this.options.captureOutputs ?? true;
    const agentSpan = this.findAncestor(state, span, MASTRA_SPAN_TYPES.agentRun);
    const stepId = `wfs-${span.id}`;
    const chain = this.resolveStepChain(state, span);
    const predecessors = state.stepChainHeads.get(chain.anchorKey);
    const linkedGenerationIds = state.stepGenerationLinks.get(span.id);

    const metadata: Record<string, unknown> = {
      [metadataKeyMastraSpanType]: span.type,
      [metadataKeyRunID]: span.id,
    };
    const status = asStringOrUndefined(attributes.status);
    if (status !== undefined) {
      metadata['agento11y.framework.mastra.status'] = status;
    }
    const errorClassification = mapMastraErrorClassification(span.errorInfo);
    if (errorClassification !== undefined) {
      Object.assign(metadata, errorClassification);
    }
    const workflowRun = this.findAncestor(state, span, MASTRA_SPAN_TYPES.workflowRun);
    const workflowName = asStringOrUndefined(workflowRun?.entityName) ?? asStringOrUndefined(workflowRun?.entityId);
    if (workflowName !== undefined) {
      metadata['agento11y.framework.mastra.workflow'] = workflowName;
    }

    const step: WorkflowStep = {
      id: stepId,
      conversationId: this.resolveConversationId(state, span),
      stepName,
      framework: frameworkName,
      startedAt: coerceDate(span.startTime),
      completedAt: coerceDate(span.endTime),
      inputState: captureInputs ? toStateRecord(span.input) : undefined,
      outputState: captureOutputs ? toStateRecord(span.output) : undefined,
      error: mapMastraError(span.errorInfo),
      linkedGenerationIds,
      parentStepIds: predecessors === undefined || predecessors.length === 0 ? undefined : [...predecessors],
      agentName: this.resolveAgentName(agentSpan),
      agentVersion: this.resolveAgentVersion(agentSpan),
      traceId: span.traceId,
      spanId: span.id,
      metadata,
    };

    this.client.enqueueWorkflowStep(step);
    if (chain.concurrent && chain.groupId !== undefined) {
      // Steps inside a parallel/conditional block all read the same
      // predecessors; the chain heads advance only when the block ends.
      const group = state.pendingStepGroups.get(chain.groupId) ?? { anchorKey: chain.anchorKey, stepIds: [] };
      group.stepIds.push(stepId);
      state.pendingStepGroups.set(chain.groupId, group);
    } else {
      state.stepChainHeads.set(chain.anchorKey, [stepId]);
    }
    state.stepGenerationLinks.delete(span.id);
  }

  private buildTags(): Record<string, string> {
    return {
      ...(this.options.extraTags ?? {}),
      'agento11y.framework.name': frameworkName,
      'agento11y.framework.source': frameworkSource,
      'agento11y.framework.language': frameworkLanguage,
    };
  }

  private buildMetadata(state: TraceState, span: MastraExportedSpan, runType: string): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      ...(this.options.extraMetadata ?? {}),
      [metadataKeyRunID]: span.id,
      [metadataKeyRunType]: runType,
      [metadataKeyMastraSpanType]: span.type,
    };
    if (span.parentSpanId !== undefined && span.parentSpanId.length > 0) {
      metadata[metadataKeyParentRunID] = span.parentSpanId;
    }
    const threadId = this.resolveFromChain(state, span, (candidate) => spanMetadataString(candidate, 'threadId'));
    if (threadId !== undefined) {
      metadata[metadataKeyThreadID] = threadId;
    }
    const componentName = asStringOrUndefined(span.entityName) ?? asStringOrUndefined(span.entityId);
    if (componentName !== undefined) {
      metadata[metadataKeyComponentName] = componentName;
    }
    const rootTags = this.resolveFromChain(state, span, (candidate) => {
      const tags = asStringArray(candidate.tags);
      return tags.length > 0 ? tags : undefined;
    });
    if (rootTags !== undefined) {
      metadata[metadataKeyTags] = rootTags;
    }
    const spanMetadata = asRecord(span.metadata);
    if (spanMetadata !== undefined && Object.keys(spanMetadata).length > 0) {
      metadata[metadataKeyMastraMetadata] = spanMetadata;
    }
    // Normalize the whole bag — including user-supplied extraMetadata — so
    // cyclic, invalid-Date, or non-JSON-safe values cannot break export.
    return normalizeMetadataRecord(metadata);
  }

  private resolveConversationId(state: TraceState, span: MastraExportedSpan): string {
    const custom = this.options.resolveConversationId;
    if (custom !== undefined) {
      const resolved = this.resolveFromChain(state, span, (candidate) => {
        const value = custom(candidate);
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      });
      if (resolved !== undefined) {
        return resolved;
      }
    }
    const fromAgent = this.resolveFromChain(state, span, (candidate) =>
      candidate.type === MASTRA_SPAN_TYPES.agentRun ? spanAttributeString(candidate, 'conversationId') : undefined,
    );
    if (fromAgent !== undefined) {
      return fromAgent;
    }
    const fromMetadata = this.resolveFromChain(
      state,
      span,
      (candidate) =>
        spanMetadataString(candidate, 'threadId') ??
        spanMetadataString(candidate, 'sessionId') ??
        spanMetadataString(candidate, 'conversationId'),
    );
    if (fromMetadata !== undefined) {
      return fromMetadata;
    }
    return `agento11y:framework:${frameworkName}:${span.traceId}`;
  }

  private resolveUserId(state: TraceState, span: MastraExportedSpan): string | undefined {
    return this.resolveFromChain(
      state,
      span,
      (candidate) => spanMetadataString(candidate, 'userId') ?? spanMetadataString(candidate, 'resourceId'),
    );
  }

  private resolveAgentName(agentSpan: MastraExportedSpan | undefined): string | undefined {
    return (
      this.options.agentName ??
      asStringOrUndefined(agentSpan?.entityName) ??
      asStringOrUndefined(agentSpan?.entityId) ??
      this.serviceName
    );
  }

  private resolveAgentVersion(agentSpan: MastraExportedSpan | undefined): string | undefined {
    if (this.options.agentVersion !== undefined) {
      return this.options.agentVersion;
    }
    if (agentSpan === undefined) {
      return undefined;
    }
    return spanMetadataString(agentSpan, 'entityVersionId') ?? spanAttributeString(agentSpan, 'resolvedVersionId');
  }

  /**
   * Walks the span itself and its stored ancestors (nearest first) and
   * returns the first non-undefined resolution.
   */
  private resolveFromChain<T>(
    state: TraceState,
    span: MastraExportedSpan,
    resolve: (candidate: MastraExportedSpan) => T | undefined,
  ): T | undefined {
    const seen = new Set<string>();
    let current: MastraExportedSpan | undefined = span;
    while (current !== undefined && !seen.has(current.id)) {
      const resolved = resolve(current);
      if (resolved !== undefined) {
        return resolved;
      }
      seen.add(current.id);
      current =
        current.parentSpanId === undefined || current.parentSpanId.length === 0
          ? undefined
          : state.spans.get(current.parentSpanId);
    }
    return undefined;
  }

  private findAncestor(state: TraceState, span: MastraExportedSpan, spanType: string): MastraExportedSpan | undefined {
    return this.resolveFromChain(state, span, (candidate) =>
      candidate.id !== span.id && candidate.type === spanType ? candidate : undefined,
    );
  }

  /**
   * Resolves the DAG chain scope for a workflow step: the nearest
   * `workflow_run`/`workflow_step` ancestor anchors the chain, and construct
   * spans in between (parallel, conditional, loop, …) are transparent. Steps
   * under a concurrent construct are grouped so they share predecessors
   * instead of being chained sequentially.
   */
  private resolveStepChain(state: TraceState, span: MastraExportedSpan): StepChain {
    const seen = new Set<string>([span.id]);
    let outermostConstruct: MastraExportedSpan | undefined;
    let currentId = span.parentSpanId;
    while (currentId !== undefined && currentId.length > 0 && !seen.has(currentId)) {
      seen.add(currentId);
      const parent = state.spans.get(currentId);
      if (parent === undefined) {
        break;
      }
      if (parent.type === MASTRA_SPAN_TYPES.workflowRun || parent.type === MASTRA_SPAN_TYPES.workflowStep) {
        return {
          anchorKey: parent.id,
          groupId: outermostConstruct?.id,
          concurrent: outermostConstruct !== undefined && concurrentConstructTypes.has(outermostConstruct.type),
        };
      }
      outermostConstruct = parent;
      currentId = parent.parentSpanId;
    }
    return { anchorKey: span.parentSpanId ?? '', concurrent: false };
  }

  /**
   * Runs `fn` with the Mastra span installed as the OTel parent so the
   * Agento11y-created span joins the Mastra trace. When the Mastra spans are also
   * exported over OTLP (e.g. via `@mastra/otel-exporter`, which preserves
   * Mastra's OTel-compatible ids), the Agento11y span nests under the Mastra span
   * in the same trace.
   *
   * The parent is injected both through the active context and directly into
   * `tracer.startSpan`: exporter events fire outside the original execution
   * context, so `context.with` alone only works when a context manager is
   * registered. Explicit injection also keeps the join intact with no OTel
   * SDK at all — the API's no-op tracer then reuses the parent span context,
   * stamping the Mastra trace/span ids onto the exported generation.
   */
  private withMastraParentContext<T>(span: MastraExportedSpan, fn: () => T): T {
    if (
      (this.options.joinMastraTrace ?? true) === false ||
      !isValidOtelTraceId(span.traceId) ||
      !isValidOtelSpanId(span.id)
    ) {
      return fn();
    }
    const parentContext = otelTrace.setSpanContext(ROOT_CONTEXT, {
      traceId: span.traceId,
      spanId: span.id,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });

    // Same internal access the shared framework handler uses. The swap is
    // safe because `fn` starts the recorder synchronously — no other client
    // caller can observe the wrapped tracer.
    const internalClient = this.client as unknown as { tracer?: Tracer };
    const baseTracer = internalClient.tracer;
    if (baseTracer === undefined || typeof baseTracer.startSpan !== 'function') {
      return otelContext.with(parentContext, fn);
    }
    const wrappedTracer: Tracer = {
      startSpan: (name, options, contextArg) => baseTracer.startSpan(name, options, contextArg ?? parentContext),
      startActiveSpan: baseTracer.startActiveSpan.bind(baseTracer) as Tracer['startActiveSpan'],
    };
    internalClient.tracer = wrappedTracer;
    try {
      return otelContext.with(parentContext, fn);
    } finally {
      internalClient.tracer = baseTracer;
    }
  }

  private getTraceState(traceId: string): TraceState {
    const existing = this.traces.get(traceId);
    if (existing !== undefined) {
      return existing;
    }
    const state: TraceState = {
      spans: new Map(),
      stepGenerationLinks: new Map(),
      stepChainHeads: new Map(),
      pendingStepGroups: new Map(),
      pendingToolMessages: new Map(),
      pendingStepOutputs: new Map(),
      pendingStepThinking: new Map(),
      pendingContentCount: 0,
      lastActivity: Date.now(),
    };
    this.traces.set(traceId, state);
    this.startSweepTimer();
    return state;
  }

  /**
   * Periodic TTL sweep so orphaned trace state (root span never ended) is
   * released even when no further events arrive. Active only while traces
   * are tracked; the timer is unref'd so it never keeps the process alive.
   */
  private startSweepTimer(): void {
    if (this.sweepTimer !== undefined || this.closed) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.lastSweepAt = 0; // force the TTL pass
      this.sweep();
    }, 60_000);
    maybeUnrefTimer(this.sweepTimer);
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private scheduleTraceCleanup(traceId: string, state: TraceState): void {
    if (state.cleanupTimer !== undefined) {
      clearTimeout(state.cleanupTimer);
    }
    state.cleanupTimer = setTimeout(() => {
      this.traces.delete(traceId);
    }, traceCleanupDelayMs);
    maybeUnrefTimer(state.cleanupTimer);
  }

  /**
   * Lazy bookkeeping guard: drops traces idle beyond the TTL and evicts the
   * least recently active traces when the tracked-trace cap is exceeded.
   */
  private sweep(): void {
    const maxTraces = this.options.maxTrackedTraces ?? defaultMaxTrackedTraces;
    const ttlMs = this.options.traceTtlMs ?? defaultTraceTtlMs;
    const now = Date.now();

    if (now - this.lastSweepAt >= Math.min(ttlMs, 60_000)) {
      this.lastSweepAt = now;
      for (const [traceId, state] of this.traces) {
        if (now - state.lastActivity >= ttlMs) {
          if (state.cleanupTimer !== undefined) {
            clearTimeout(state.cleanupTimer);
          }
          this.traces.delete(traceId);
        }
      }
    }

    if (this.traces.size > maxTraces) {
      const byActivity = [...this.traces.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
      for (const [traceId, state] of byActivity.slice(0, this.traces.size - maxTraces)) {
        if (state.cleanupTimer !== undefined) {
          clearTimeout(state.cleanupTimer);
        }
        this.traces.delete(traceId);
      }
    }

    if (this.traces.size === 0) {
      this.stopSweepTimer();
    }
  }

  private logWarn(message: string, error?: unknown): void {
    if (this.mastraLogger?.warn !== undefined) {
      this.mastraLogger.warn(`[Agento11yMastraExporter] ${message}`, error);
      return;
    }
    const internalClient = this.client as unknown as { internalLogWarn?: (message: string, error?: unknown) => void };
    if (typeof internalClient.internalLogWarn === 'function') {
      internalClient.internalLogWarn(`[Agento11yMastraExporter] ${message}`, error);
    }
  }
}

/**
 * Creates a {@link Agento11yMastraExporter}.
 *
 * Pass an existing {@link Agento11yClient} to share transport/config with other
 * instrumentation, or omit it to let the exporter construct one from `AGENTO11Y_*`
 * environment variables (the exporter then owns the client and shuts it down
 * on `shutdown()`).
 */
export function createAgento11yMastra(
  client: Agento11yClient,
  options?: Agento11yMastraOptions,
): Agento11yMastraExporter;
export function createAgento11yMastra(options?: Agento11yMastraOptions): Agento11yMastraExporter;
export function createAgento11yMastra(
  clientOrOptions?: Agento11yClient | Agento11yMastraOptions,
  maybeOptions?: Agento11yMastraOptions,
): Agento11yMastraExporter {
  if (isAgento11yClient(clientOrOptions)) {
    return new Agento11yMastraExporter(clientOrOptions, maybeOptions);
  }
  return new Agento11yMastraExporter(clientOrOptions);
}
