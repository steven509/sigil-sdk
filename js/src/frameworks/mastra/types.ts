/**
 * Structural (duck-typed) mirrors of the Mastra observability contracts from
 * `@mastra/core/observability` (core >= 1.16). Declaring them locally keeps
 * `@grafana/sigil-sdk-js` free of a runtime or type dependency on
 * `@mastra/core`; every field is intentionally typed at least as wide as the
 * Mastra original so Mastra's `ObservabilityExporter`, `TracingEvent`, and
 * `InitExporterOptions` values assign cleanly to these shapes.
 */

/** Mastra `TracingEventType` values (string enum in Mastra). */
export type MastraTracingEventType = 'span_started' | 'span_updated' | 'span_ended';

/**
 * Mastra `SpanType` values relevant to this adapter. The exporter receives
 * every span type; unknown values are stored for ancestry lookups and
 * otherwise ignored.
 */
export const MASTRA_SPAN_TYPES = {
  agentRun: 'agent_run',
  modelGeneration: 'model_generation',
  modelStep: 'model_step',
  modelInference: 'model_inference',
  modelChunk: 'model_chunk',
  toolCall: 'tool_call',
  mcpToolCall: 'mcp_tool_call',
  clientToolCall: 'client_tool_call',
  workflowRun: 'workflow_run',
  workflowStep: 'workflow_step',
} as const;

/**
 * Structural mirror of Mastra's `ExportedSpan`. Field types are widened
 * (`unknown` for payload-ish fields) so any `AnyExportedSpan` assigns to it.
 */
export interface MastraExportedSpan {
  /** OTel-compatible 16-hex span id. */
  id: string;
  /** OTel-compatible 32-hex trace id. */
  traceId: string;
  name: string;
  /** Mastra `SpanType` string, e.g. `model_generation`. */
  type: string;
  parentSpanId?: string;
  isRootSpan?: boolean;
  /** Event spans occur at `startTime` and never carry an `endTime`. */
  isEvent?: boolean;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  startTime?: Date | string | number;
  endTime?: Date | string | number;
  /** Per-span-type attributes (e.g. model/provider/usage for generations). */
  attributes?: unknown;
  metadata?: unknown;
  /** Root-span tags (string list in Mastra). */
  tags?: unknown;
  input?: unknown;
  output?: unknown;
  /** Mastra `SpanErrorInfo`: `{ message, id?, category?, details?, ... }`. */
  errorInfo?: unknown;
  requestContext?: unknown;
}

/** Structural mirror of Mastra's `TracingEvent`. */
export interface MastraTracingEvent {
  type: MastraTracingEventType | (string & {});
  exportedSpan: MastraExportedSpan;
}

/** Structural mirror of Mastra's `InitExporterOptions`. */
export interface MastraInitExporterOptions {
  mastra?: unknown;
  config?: { serviceName?: string } | undefined;
  emitDropEvent?: unknown;
}

/**
 * Minimal logger shape compatible with Mastra's `IMastraLogger`, used when
 * Mastra injects its logger through `__setLogger`.
 */
export interface MastraLoggerLike {
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

/**
 * Structural mirror of Mastra's `ObservabilityExporter` contract implemented
 * by {@link SigilMastraExporter}. Mastra duck-types exporters at runtime, so
 * satisfying this shape is sufficient for
 * `new Observability({ configs: { ...: { exporters: [exporter] } } })`.
 */
export interface MastraObservabilityExporterLike {
  name: string;
  init?(options: MastraInitExporterOptions): void;
  __setLogger?(logger: MastraLoggerLike): void;
  onTracingEvent?(event: MastraTracingEvent): void | Promise<void>;
  exportTracingEvent(event: MastraTracingEvent): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Resolves a Sigil conversation id from a Mastra span. */
export type MastraConversationIdResolver = (span: MastraExportedSpan) => string | undefined;

/** Resolves a Sigil provider name from Mastra model/provider identifiers. */
export type MastraProviderResolverFn = (context: {
  /** Raw Mastra/AI SDK provider string, e.g. `openai.chat`. */
  provider: string;
  /** Model name, e.g. `gpt-5-mini`. */
  modelName: string;
}) => string;

/** Options accepted by {@link SigilMastraExporter}. */
export interface SigilMastraExporterOptions {
  /**
   * Agent name applied to generations, tool executions, and workflow steps.
   * Defaults to the `entityName`/`entityId` of the nearest `agent_run`
   * ancestor span, then the Mastra observability config `serviceName`.
   */
  agentName?: string;
  /** Agent version. Defaults to the agent's resolved version id when present. */
  agentVersion?: string;
  /**
   * Provider resolution. `'auto'` (default) normalizes Mastra provider
   * strings (`openai.chat` → `openai`) and falls back to model-name
   * inference. Pass a function for custom mapping, or use `provider` to force
   * a fixed value.
   */
  providerResolver?: 'auto' | MastraProviderResolverFn;
  /** Fixed provider override applied to every generation. */
  provider?: string;
  /** Capture prompt/input content. Defaults to true. */
  captureInputs?: boolean;
  /** Capture completion/output content. Defaults to true. */
  captureOutputs?: boolean;
  /** Extra tags merged into every generation (reserved sigil.* keys win). */
  extraTags?: Record<string, string>;
  /** Extra metadata merged into every generation (reserved sigil.* keys win). */
  extraMetadata?: Record<string, unknown>;
  /**
   * Custom conversation id resolution, applied before the default chain
   * (`agent_run` `conversationId` attribute → span metadata `threadId` →
   * `sessionId`/`conversationId` → deterministic per-trace fallback).
   */
  resolveConversationId?: MastraConversationIdResolver;
  /** Export Mastra `workflow_step` spans as Sigil workflow steps. Defaults to true. */
  exportWorkflowSteps?: boolean;
  /**
   * Shut the Sigil client down when Mastra shuts the exporter down.
   * Defaults to true when the exporter constructed its own client and false
   * when a client was passed in.
   */
  shutdownClient?: boolean;
  /**
   * Milliseconds of inactivity after which per-trace bookkeeping is dropped.
   * Guards against traces that never receive their root `span_ended` event.
   * Defaults to 600_000 (10 minutes).
   */
  traceTtlMs?: number;
  /**
   * Maximum number of concurrently tracked traces. The least recently active
   * traces are evicted beyond this. Defaults to 1000.
   */
  maxTrackedTraces?: number;
}
