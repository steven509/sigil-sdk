import assert from 'node:assert/strict';
import test from 'node:test';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Agento11yMastraExporter, createAgento11yMastra } from '../.test-dist/frameworks/mastra/index.js';
import { Agento11yClient, defaultConfig } from '../.test-dist/index.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const AGENT_SPAN_ID = 'aaaaaaaaaaaaaaa1';
const GEN_SPAN_ID = 'bbbbbbbbbbbbbbb1';
const TOOL_SPAN_ID = 'ccccccccccccccc1';

class CapturingExporter {
  generationRequests = [];
  workflowStepRequests = [];

  async exportGenerations(request) {
    this.generationRequests.push(structuredClone(request));
    return {
      results: request.generations.map((generation) => ({ generationId: generation.id, accepted: true })),
    };
  }

  async exportWorkflowSteps(request) {
    this.workflowStepRequests.push(structuredClone(request));
    return {
      results: request.workflowSteps.map((step) => ({ stepId: step.id, accepted: true })),
    };
  }

  get generations() {
    return this.generationRequests.flatMap((request) => request.generations);
  }

  get workflowSteps() {
    return this.workflowStepRequests.flatMap((request) => request.workflowSteps);
  }
}

function newClient(extra = {}) {
  const defaults = defaultConfig();
  const exporter = new CapturingExporter();
  const client = new Agento11yClient({
    generationExport: {
      ...defaults.generationExport,
      batchSize: 10,
      flushIntervalMs: 0,
    },
    generationExporter: exporter,
    ...extra,
  });
  return { client, exporter };
}

async function emit(target, type, span) {
  await target.exportTracingEvent({ type, exportedSpan: span });
}

function agentRunSpan(overrides = {}) {
  return {
    id: AGENT_SPAN_ID,
    traceId: TRACE_ID,
    name: "agent run: 'test-agent'",
    type: 'agent_run',
    isRootSpan: true,
    isEvent: false,
    entityType: 'agent',
    entityId: 'test-agent',
    entityName: 'Test Agent',
    startTime: new Date('2026-07-13T10:00:00.000Z'),
    attributes: {
      conversationId: 'thread-42',
      instructions: 'You are a test agent',
      availableTools: ['calculator'],
    },
    metadata: { runId: 'run-1', resourceId: 'user-9', threadId: 'thread-42' },
    input: 'Calculate 5 + 3',
    ...overrides,
  };
}

function generationSpan(overrides = {}) {
  return {
    id: GEN_SPAN_ID,
    traceId: TRACE_ID,
    name: "llm: 'gpt-5-mini'",
    type: 'model_generation',
    parentSpanId: AGENT_SPAN_ID,
    isRootSpan: false,
    isEvent: false,
    entityType: 'agent',
    entityName: 'Test Agent',
    startTime: new Date('2026-07-13T10:00:00.100Z'),
    attributes: {
      model: 'gpt-5-mini',
      provider: 'openai.chat',
      streaming: true,
      parameters: { temperature: 0.2, maxOutputTokens: 512, topP: 0.9 },
    },
    metadata: { runId: 'run-1', resourceId: 'user-9', threadId: 'thread-42' },
    input: {
      messages: [
        { role: 'system', content: 'You are a test agent' },
        { role: 'user', content: [{ type: 'text', text: 'Calculate 5 + 3' }] },
      ],
    },
    ...overrides,
  };
}

function endedGenerationSpan(overrides = {}) {
  return generationSpan({
    endTime: new Date('2026-07-13T10:00:02.000Z'),
    attributes: {
      model: 'gpt-5-mini',
      provider: 'openai.chat',
      streaming: true,
      parameters: { temperature: 0.2, maxOutputTokens: 512, topP: 0.9 },
      finishReason: 'stop',
      responseId: 'resp-1',
      responseModel: 'gpt-5-mini-2026-01-01',
      completionStartTime: new Date('2026-07-13T10:00:00.500Z'),
      usage: {
        inputTokens: 30,
        outputTokens: 35,
        inputDetails: { text: 20, cacheRead: 7, cacheWrite: 3 },
        outputDetails: { text: 30, reasoning: 5 },
      },
    },
    output: { text: 'The answer is 8', files: [], reasoning: [], sources: [], warnings: [] },
    ...overrides,
  });
}

function toolSpan(overrides = {}) {
  return {
    id: TOOL_SPAN_ID,
    traceId: TRACE_ID,
    name: "tool: 'calculator'",
    type: 'tool_call',
    parentSpanId: GEN_SPAN_ID,
    isRootSpan: false,
    isEvent: false,
    entityType: 'tool',
    entityId: 'calculator',
    entityName: 'calculator',
    startTime: new Date('2026-07-13T10:00:00.700Z'),
    endTime: new Date('2026-07-13T10:00:00.900Z'),
    attributes: { toolDescription: 'Performs calculations', toolType: 'tool', success: true },
    metadata: { runId: 'run-1', threadId: 'thread-42' },
    input: { operation: 'add', a: 5, b: 3 },
    output: { result: 8 },
    ...overrides,
  };
}

async function emitAgentTrace(target) {
  await emit(target, 'span_started', agentRunSpan());
  await emit(target, 'span_started', generationSpan());
  await emit(target, 'span_started', toolSpan({ endTime: undefined }));
  await emit(target, 'span_ended', toolSpan());
  await emit(target, 'span_ended', endedGenerationSpan());
  await emit(target, 'span_ended', agentRunSpan({ endTime: new Date('2026-07-13T10:00:02.100Z') }));
}

test('mastra exporter maps a model generation with agent context', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client, { agentVersion: '1.2.3' });

  await emitAgentTrace(mastraExporter);
  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations.length, 1);
  const generation = exporter.generations[0];

  assert.equal(generation.mode, 'STREAM');
  assert.equal(generation.model.provider, 'openai');
  assert.equal(generation.model.name, 'gpt-5-mini');
  assert.equal(generation.conversationId, 'thread-42');
  assert.equal(generation.userId, 'user-9');
  assert.equal(generation.agentName, 'Test Agent');
  assert.equal(generation.agentVersion, '1.2.3');
  assert.equal(generation.systemPrompt, 'You are a test agent');
  assert.equal(generation.operationName, 'streamText');
  assert.equal(generation.stopReason, 'stop');
  assert.equal(generation.responseId, 'resp-1');
  assert.equal(generation.responseModel, 'gpt-5-mini-2026-01-01');
  assert.deepEqual(generation.usage, {
    inputTokens: 30,
    outputTokens: 35,
    totalTokens: 65,
    cacheReadInputTokens: 7,
    cacheWriteInputTokens: 3,
    reasoningTokens: 5,
  });

  assert.equal(generation.input.length, 1);
  assert.equal(generation.input[0].role, 'user');
  // Tool round-trips are embedded ahead of the final text so the tool shows
  // inside the generation.
  assert.equal(generation.output.length, 3);
  assert.equal(generation.output[0].role, 'assistant');
  assert.equal(generation.output[0].parts[0].type, 'tool_call');
  assert.equal(generation.output[0].parts[0].toolCall.name, 'calculator');
  assert.equal(generation.output[0].parts[0].toolCall.inputJSON, '{"operation":"add","a":5,"b":3}');
  assert.equal(generation.output[1].role, 'tool');
  assert.equal(generation.output[1].parts[0].type, 'tool_result');
  assert.equal(generation.output[1].parts[0].toolResult.contentJSON, '{"result":8}');
  assert.equal(generation.output[1].parts[0].toolResult.toolCallId, generation.output[0].parts[0].toolCall.id);
  assert.equal(generation.output[2].role, 'assistant');
  assert.equal(generation.output[2].content, 'The answer is 8');
  assert.deepEqual(generation.tools, [{ name: 'calculator' }]);

  assert.equal(generation.tags['agento11y.framework.name'], 'mastra');
  assert.equal(generation.tags['agento11y.framework.source'], 'exporter');
  assert.equal(generation.tags['agento11y.framework.language'], 'typescript');
  assert.equal(generation.metadata['agento11y.framework.run_id'], GEN_SPAN_ID);
  assert.equal(generation.metadata['agento11y.framework.parent_run_id'], AGENT_SPAN_ID);
  assert.equal(generation.metadata['agento11y.framework.thread_id'], 'thread-42');
  assert.equal(generation.metadata['agento11y.framework.run_type'], 'llm');
  assert.equal(generation.metadata['agento11y.framework.component_name'], 'Test Agent');
  assert.equal(generation.metadata['agento11y.framework.mastra.span_type'], 'model_generation');
  assert.equal(generation.metadata['agento11y.framework.mastra.provider'], 'openai.chat');
  assert.equal(generation.metadata['agento11y.framework.mastra.metadata'].threadId, 'thread-42');

  assert.equal(new Date(generation.startedAt).toISOString(), '2026-07-13T10:00:00.100Z');
  assert.equal(new Date(generation.completedAt).toISOString(), '2026-07-13T10:00:02.000Z');
});

test('mastra exporter records tool executions with request model context', async () => {
  const { client } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  await emitAgentTrace(mastraExporter);
  const snapshot = client.debugSnapshot();
  await client.shutdown();

  assert.equal(snapshot.toolExecutions.length, 1);
  const toolExecution = snapshot.toolExecutions[0];
  assert.equal(toolExecution.toolName, 'calculator');
  assert.equal(toolExecution.toolType, 'tool');
  assert.equal(toolExecution.toolDescription, 'Performs calculations');
  assert.equal(toolExecution.conversationId, 'thread-42');
  assert.equal(toolExecution.agentName, 'Test Agent');
  assert.equal(toolExecution.requestModel, 'gpt-5-mini');
  assert.equal(toolExecution.requestProvider, 'openai');
  assert.deepEqual(toolExecution.arguments, { operation: 'add', a: 5, b: 3 });
  assert.deepEqual(toolExecution.result, { result: 8 });
  assert.equal(toolExecution.startedAt.toISOString(), '2026-07-13T10:00:00.700Z');
  assert.equal(toolExecution.completedAt.toISOString(), '2026-07-13T10:00:00.900Z');
});

test('mastra exporter exports workflow steps with links and chained parents', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  const runId = 'dddddddddddddd01';
  const step1Id = 'dddddddddddddd02';
  const step2Id = 'dddddddddddddd03';
  const genId = 'dddddddddddddd04';
  const workflowTraceId = 'fedcba9876543210fedcba9876543210';

  const workflowRun = {
    id: runId,
    traceId: workflowTraceId,
    name: "workflow run: 'my-workflow'",
    type: 'workflow_run',
    isRootSpan: true,
    entityType: 'workflow_run',
    entityId: 'my-workflow',
    startTime: new Date('2026-07-13T11:00:00.000Z'),
    attributes: { status: 'success' },
    input: { prompt: 'Hello' },
    tags: ['team-a'],
  };
  const step = (id, name, start, end) => ({
    id,
    traceId: workflowTraceId,
    name: `workflow step: '${name}'`,
    type: 'workflow_step',
    parentSpanId: runId,
    entityType: 'workflow_step',
    entityId: name,
    startTime: new Date(start),
    endTime: new Date(end),
    attributes: { status: 'success' },
    input: { prompt: 'Hello' },
    output: { response: 'done' },
  });
  const stepGeneration = {
    id: genId,
    traceId: workflowTraceId,
    name: "llm: 'gpt-5-mini'",
    type: 'model_generation',
    parentSpanId: step1Id,
    startTime: new Date('2026-07-13T11:00:00.200Z'),
    endTime: new Date('2026-07-13T11:00:00.800Z'),
    attributes: {
      model: 'gpt-5-mini',
      provider: 'openai.chat',
      streaming: true,
      usage: { inputTokens: 5, outputTokens: 6 },
    },
    input: { messages: [{ role: 'user', content: 'Hello' }] },
    output: { text: 'done' },
  };

  await emit(mastraExporter, 'span_started', workflowRun);
  await emit(
    mastraExporter,
    'span_started',
    step(step1Id, 'step-one', '2026-07-13T11:00:00.100Z', '2026-07-13T11:00:01.000Z'),
  );
  await emit(mastraExporter, 'span_started', stepGeneration);
  await emit(mastraExporter, 'span_ended', stepGeneration);
  await emit(
    mastraExporter,
    'span_ended',
    step(step1Id, 'step-one', '2026-07-13T11:00:00.100Z', '2026-07-13T11:00:01.000Z'),
  );
  await emit(
    mastraExporter,
    'span_started',
    step(step2Id, 'step-two', '2026-07-13T11:00:01.000Z', '2026-07-13T11:00:02.000Z'),
  );
  await emit(
    mastraExporter,
    'span_ended',
    step(step2Id, 'step-two', '2026-07-13T11:00:01.000Z', '2026-07-13T11:00:02.000Z'),
  );
  await emit(mastraExporter, 'span_ended', {
    ...workflowRun,
    endTime: new Date('2026-07-13T11:00:02.100Z'),
    output: { response: 'done' },
  });

  await client.flush();
  await client.shutdown();

  assert.equal(exporter.workflowSteps.length, 2);
  const [step1, step2] = exporter.workflowSteps;

  assert.equal(step1.id, `wfs-${step1Id}`);
  assert.equal(step1.stepName, 'step-one');
  assert.equal(step1.framework, 'mastra');
  assert.equal(step1.conversationId, `agento11y:framework:mastra:${workflowTraceId}`);
  assert.equal(step1.traceId, workflowTraceId);
  assert.equal(step1.spanId, step1Id);
  assert.equal(step1.parentStepIds, undefined);
  assert.deepEqual(step1.inputState, { prompt: 'Hello' });
  assert.deepEqual(step1.outputState, { response: 'done' });
  assert.equal(step1.metadata['agento11y.framework.mastra.workflow'], 'my-workflow');
  assert.equal(step1.metadata['agento11y.framework.mastra.status'], 'success');

  assert.equal(step1.linkedGenerationIds.length, 1);
  const generation = exporter.generations[0];
  assert.equal(step1.linkedGenerationIds[0], generation.id);
  assert.equal(generation.conversationId, `agento11y:framework:mastra:${workflowTraceId}`);
  assert.deepEqual(generation.metadata['agento11y.framework.tags'], ['team-a']);

  assert.equal(step2.id, `wfs-${step2Id}`);
  assert.deepEqual(step2.parentStepIds, [`wfs-${step1Id}`]);
  assert.equal(step2.linkedGenerationIds, undefined);
});

test('mastra exporter chains parentGenerationIds within a trace', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  const first = endedGenerationSpan();
  const second = endedGenerationSpan({ id: 'bbbbbbbbbbbbbbb2' });
  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(mastraExporter, 'span_ended', first);
  await emit(mastraExporter, 'span_ended', second);

  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations.length, 2);
  assert.equal(exporter.generations[0].id, GEN_SPAN_ID, 'generation id is the Mastra span id');
  assert.equal(exporter.generations[0].parentGenerationIds, undefined);
  assert.deepEqual(exporter.generations[1].parentGenerationIds, [exporter.generations[0].id]);
});

test('mastra exporter maps errors onto generations', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(
    mastraExporter,
    'span_ended',
    generationSpan({
      endTime: new Date('2026-07-13T10:00:01.000Z'),
      errorInfo: { message: 'rate limited', id: 'RATE_LIMIT', category: 'RATE_LIMIT' },
    }),
  );

  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations.length, 1);
  assert.equal(exporter.generations[0].callError, 'rate limited');
  assert.equal(exporter.generations[0].metadata['agento11y.framework.mastra.error.id'], 'RATE_LIMIT');
  assert.equal(exporter.generations[0].metadata['agento11y.framework.mastra.error.category'], 'RATE_LIMIT');
});

test('mastra exporter captures tool content on spans by default', async () => {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const { client } = newClient({ tracer: tracerProvider.getTracer('agento11y-mastra-test') });
  const mastraExporter = createAgento11yMastra(client);

  await emitAgentTrace(mastraExporter);
  await client.shutdown();

  const toolSpanOut = spanExporter.getFinishedSpans().find((span) => span.name === 'execute_tool calculator');
  await tracerProvider.shutdown();
  assert.ok(toolSpanOut, 'tool span exported');
  assert.equal(toolSpanOut.attributes['gen_ai.tool.call.arguments'], '{"operation":"add","a":5,"b":3}');
  assert.equal(toolSpanOut.attributes['gen_ai.tool.call.result'], '{"result":8}');
});

test('mastra exporter records provider-executed tool calls', async () => {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const { client } = newClient({ tracer: tracerProvider.getTracer('agento11y-mastra-test') });
  const mastraExporter = createAgento11yMastra(client);

  // Mastra reparents `provider_tool_call` onto the nearest `agent_run`, so it
  // arrives with no `model_generation` ancestor — unlike every other tool span.
  const providerTool = () =>
    toolSpan({
      id: '00000000000000c1',
      name: "provider_tool: 'web_search'",
      type: 'provider_tool_call',
      parentSpanId: AGENT_SPAN_ID,
      entityId: 'web_search',
      entityName: 'web_search',
      attributes: {
        toolType: 'provider-tool',
        toolDescription: 'Server-side web search',
        toolCallId: 'srvtoolu_abc123',
        success: true,
      },
      input: { query: 'grafana agento11y' },
      output: { results: ['https://example.test'] },
    });

  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(mastraExporter, 'span_started', providerTool({ endTime: undefined }));
  await emit(mastraExporter, 'span_ended', providerTool());
  await emit(mastraExporter, 'span_ended', agentRunSpan({ endTime: new Date('2026-07-13T10:00:02.100Z') }));
  await client.flush();

  const snapshot = client.debugSnapshot();
  assert.equal(snapshot.toolExecutions.length, 1, 'provider tool recorded as a tool execution');
  const execution = snapshot.toolExecutions[0];
  assert.equal(execution.toolName, 'web_search');
  assert.equal(execution.toolType, 'provider');
  assert.equal(execution.toolCallId, 'srvtoolu_abc123');

  await client.shutdown();
  const toolSpanOut = spanExporter.getFinishedSpans().find((span) => span.name === 'execute_tool web_search');
  await tracerProvider.shutdown();
  assert.ok(toolSpanOut, 'provider tool span exported');
  assert.equal(toolSpanOut.attributes['gen_ai.tool.type'], 'provider');
  assert.equal(toolSpanOut.attributes['gen_ai.tool.call.id'], 'srvtoolu_abc123');
  // Resolved from the `agent_run` ancestor even without a generation ancestor.
  assert.equal(toolSpanOut.attributes['gen_ai.agent.name'], 'Test Agent');
});

// Shape captured from a real @mastra/core 1.58.0 workspace tool run: the span
// is named `workspace:<category>:<operation>`, inherits entityName from the
// enclosing tool call, and carries a summarized output rather than file bytes.
function workspaceActionSpan(overrides = {}) {
  return {
    id: '00000000000000d1',
    traceId: TRACE_ID,
    name: 'workspace:skill:activateSkill',
    type: 'workspace_action',
    parentSpanId: TOOL_SPAN_ID,
    isRootSpan: false,
    isEvent: false,
    entityType: 'tool',
    entityName: 'view',
    startTime: new Date('2026-07-13T10:00:00.750Z'),
    endTime: new Date('2026-07-13T10:00:00.850Z'),
    attributes: {
      category: 'skill',
      workspaceId: 'ws-abc',
      workspaceName: 'workspace-abc',
      filesystemProvider: 'local',
      success: true,
    },
    metadata: {},
    input: { skill: 'code-review' },
    output: { resultCount: 1 },
    ...overrides,
  };
}

test('mastra exporter records workspace actions including skill activations', async () => {
  const { client } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(mastraExporter, 'span_started', generationSpan());
  await emit(mastraExporter, 'span_started', toolSpan({ endTime: undefined }));
  await emit(mastraExporter, 'span_ended', workspaceActionSpan());
  await emit(mastraExporter, 'span_ended', toolSpan());
  await emit(mastraExporter, 'span_ended', endedGenerationSpan());
  await client.flush();

  const snapshot = client.debugSnapshot();
  const skill = snapshot.toolExecutions.find((execution) => execution.toolType === 'workspace:skill');
  assert.ok(skill, 'skill activation recorded');
  assert.equal(skill.toolName, 'activateSkill');
  assert.equal(skill.agentName, 'Test Agent');

  // The outer workspace tool call is still recorded in its own right.
  assert.ok(
    snapshot.toolExecutions.some((execution) => execution.toolName === 'calculator'),
    'enclosing tool call still recorded',
  );

  // The model never emitted this as a tool call, so it must not be replayed
  // into the generation's output messages.
  const generation = snapshot.generations.at(-1);
  const replayed = JSON.stringify(generation?.output ?? []).includes('activateSkill');
  assert.equal(replayed, false, 'workspace action not embedded in generation output');

  await client.shutdown();
});

test('mastra exporter flags failed workspace actions and honors the opt-out', async () => {
  const { client } = newClient();
  const mastraExporter = createAgento11yMastra(client);
  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(
    mastraExporter,
    'span_ended',
    // Mastra reports failure via `success` without attaching error info.
    workspaceActionSpan({
      attributes: { category: 'sandbox', success: false },
      name: 'workspace:sandbox:executeCommand',
    }),
  );
  await client.flush();
  const failed = client.debugSnapshot().toolExecutions.at(-1);
  assert.equal(failed.toolType, 'workspace:sandbox');
  assert.ok(failed.callError, 'failed workspace action carries a call error');
  await client.shutdown();

  const off = newClient();
  const disabled = createAgento11yMastra(off.client, { exportWorkspaceActions: false });
  await emit(disabled, 'span_started', agentRunSpan());
  await emit(disabled, 'span_ended', workspaceActionSpan());
  await off.client.flush();
  assert.equal(off.client.debugSnapshot().toolExecutions.length, 0, 'opt-out suppresses workspace actions');
  await off.client.shutdown();
});

test('mastra exporter does not report tool failures as exporter malfunctions', async () => {
  const warnings = [];
  // The exporter has no logger option: with Mastra's logger absent it falls back
  // to the client's, so capture there or the assertion below is vacuous.
  const { client } = newClient({ logger: { warn: (message) => warnings.push(String(message)) } });
  const mastraExporter = createAgento11yMastra(client);

  // A tool that genuinely failed is normal telemetry, not an exporter problem:
  // `setCallError` doubles as the recorder's own error, so this used to be
  // logged as "failed to record tool execution".
  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(mastraExporter, 'span_started', generationSpan());
  await emit(mastraExporter, 'span_ended', toolSpan({ errorInfo: { message: 'boom' } }));
  await emit(
    mastraExporter,
    'span_ended',
    workspaceActionSpan({ attributes: { category: 'sandbox', success: false } }),
  );
  await client.flush();

  const snapshot = client.debugSnapshot();
  assert.ok(
    snapshot.toolExecutions.every((execution) => execution.callError),
    'both failures recorded as call errors',
  );
  assert.deepEqual(
    warnings.filter((message) => message.includes('failed to record')),
    [],
    'no spurious exporter-failure warnings',
  );
  await client.shutdown();
});

test('mastra exporter resolves providers via aliases, inference, and resolvers', async () => {
  const cases = [
    { attributes: { model: 'gemini-2.5-pro', provider: 'google.generative-ai', streaming: false }, expected: 'gemini' },
    { attributes: { model: 'claude-4-sonnet', provider: '', streaming: false }, expected: 'anthropic' },
    { attributes: { model: 'mystery-model', provider: 'groq.chat', streaming: false }, expected: 'custom' },
  ];

  for (const { attributes, expected } of cases) {
    const { client, exporter } = newClient();
    const mastraExporter = createAgento11yMastra(client);
    await emit(
      mastraExporter,
      'span_ended',
      generationSpan({ isRootSpan: true, parentSpanId: undefined, attributes, endTime: new Date() }),
    );
    await client.flush();
    await client.shutdown();
    assert.equal(exporter.generations[0].model.provider, expected, `provider for ${attributes.provider}`);
  }

  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client, {
    providerResolver: ({ provider }) => (provider === 'groq.chat' ? 'groq' : ''),
  });
  await emit(
    mastraExporter,
    'span_ended',
    generationSpan({
      isRootSpan: true,
      parentSpanId: undefined,
      attributes: { model: 'mystery-model', provider: 'groq.chat', streaming: false },
      endTime: new Date(),
    }),
  );
  await client.flush();
  await client.shutdown();
  assert.equal(exporter.generations[0].model.provider, 'groq');
  assert.equal(exporter.generations[0].mode, 'SYNC');
});

test('mastra generation spans join the mastra trace with span lineage', async () => {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const tracer = tracerProvider.getTracer('agento11y-mastra-test');
  const { client } = newClient({ tracer });
  const mastraExporter = createAgento11yMastra(client);

  await emitAgentTrace(mastraExporter);
  await client.shutdown();

  // Read before tracerProvider.shutdown(): InMemorySpanExporter resets there.
  const spans = spanExporter.getFinishedSpans();
  await tracerProvider.shutdown();
  const generationSpanOut = spans.find((span) => span.name === 'streamText gpt-5-mini');
  const toolSpanOut = spans.find((span) => span.name === 'execute_tool calculator');

  assert.ok(generationSpanOut, 'generation span exported');
  assert.equal(generationSpanOut.spanContext().traceId, TRACE_ID);
  assert.equal(generationSpanOut.parentSpanContext?.spanId, GEN_SPAN_ID);

  assert.ok(toolSpanOut, 'tool span exported');
  assert.equal(toolSpanOut.spanContext().traceId, TRACE_ID);
  assert.equal(toolSpanOut.parentSpanContext?.spanId, TOOL_SPAN_ID);
});

test('mastra exporter reconstructs the interleaved output from step spans', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  const step0 = 'ddddddddddddddd5';
  const step1 = 'ddddddddddddddd6';
  const mkStep = (id, stepIndex, output) => ({
    id,
    traceId: TRACE_ID,
    name: `step: ${stepIndex}`,
    type: 'model_step',
    parentSpanId: GEN_SPAN_ID,
    startTime: new Date(),
    endTime: new Date(),
    attributes: { stepIndex },
    output,
  });
  const mkReasoning = (id, parent, text, seq) => ({
    id,
    traceId: TRACE_ID,
    name: "chunk: 'reasoning'",
    type: 'model_chunk',
    parentSpanId: parent,
    startTime: new Date(),
    endTime: new Date(),
    attributes: { chunkType: 'reasoning', sequenceNumber: seq },
    output: { text },
  });

  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(mastraExporter, 'span_started', generationSpan());
  await emit(mastraExporter, 'span_started', mkStep(step0, 0));
  await emit(mastraExporter, 'span_ended', mkReasoning('ddddddddddddddd7', step0, 'I should use the calculator.', 0));
  await emit(mastraExporter, 'span_ended', toolSpan({ parentSpanId: step0 }));
  await emit(
    mastraExporter,
    'span_ended',
    mkStep(step0, 0, {
      text: 'Let me check.',
      toolCalls: [{ toolCallId: 'call-9', toolName: 'calculator', args: { a: 5, b: 3 } }],
    }),
  );
  await emit(mastraExporter, 'span_started', mkStep(step1, 1));
  await emit(mastraExporter, 'span_ended', mkReasoning('ddddddddddddddd8', step1, 'Now I can answer.', 0));
  await emit(mastraExporter, 'span_ended', mkStep(step1, 1, { text: 'The answer is 8', toolCalls: [] }));
  await emit(mastraExporter, 'span_ended', endedGenerationSpan({ output: { text: 'Let me check.The answer is 8' } }));
  await client.flush();
  await client.shutdown();

  const output = exporter.generations[0].output;
  assert.equal(output.length, 3, 'no duplicated aggregated text');

  assert.equal(output[0].role, 'assistant');
  assert.deepEqual(
    output[0].parts.map((part) => part.type),
    ['thinking', 'text', 'tool_call'],
  );
  assert.equal(output[0].parts[0].thinking, 'I should use the calculator.');
  assert.equal(output[0].parts[1].text, 'Let me check.');
  assert.equal(output[0].parts[2].toolCall.id, 'call-9', 'real toolCallId from the step record');
  assert.equal(output[0].parts[2].toolCall.inputJSON, '{"a":5,"b":3}');

  assert.equal(output[1].role, 'tool');
  assert.equal(output[1].parts[0].toolResult.toolCallId, 'call-9', 'execution paired with the model call');
  assert.equal(output[1].parts[0].toolResult.contentJSON, '{"result":8}');

  assert.equal(output[2].role, 'assistant');
  assert.deepEqual(
    output[2].parts.map((part) => part.type),
    ['thinking', 'text'],
  );
  assert.equal(output[2].parts[1].text, 'The answer is 8');
});

test('mastra exporter does not embed tool messages when disabled or already native', async () => {
  // Disabled via option.
  {
    const { client, exporter } = newClient();
    const mastraExporter = createAgento11yMastra(client, { embedToolMessages: false });
    await emitAgentTrace(mastraExporter);
    await client.flush();
    await client.shutdown();
    assert.equal(exporter.generations[0].output.length, 1, 'only the text output');
  }
  // Native tool parts already present in the framework output: no duplication.
  {
    const { client, exporter } = newClient();
    const mastraExporter = createAgento11yMastra(client);
    await emit(mastraExporter, 'span_started', agentRunSpan());
    await emit(mastraExporter, 'span_started', generationSpan());
    await emit(mastraExporter, 'span_ended', toolSpan());
    await emit(
      mastraExporter,
      'span_ended',
      endedGenerationSpan({
        output: {
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'tool-call', toolCallId: 'native-1', toolName: 'calculator', input: { a: 5 } },
                { type: 'text', text: 'The answer is 8' },
              ],
            },
          ],
        },
      }),
    );
    await client.flush();
    await client.shutdown();
    const parts = exporter.generations[0].output.flatMap((message) => message.parts ?? []);
    assert.equal(parts.filter((part) => part.type === 'tool_call').length, 1, 'no synthesized duplicate');
    assert.equal(parts[0].toolCall.id, 'native-1');
  }
});

test('mastra exporter self-roots spans when joinMastraTrace is disabled', async () => {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const { client } = newClient({ tracer: tracerProvider.getTracer('agento11y-mastra-test') });
  const mastraExporter = createAgento11yMastra(client, { joinMastraTrace: false });

  await emitAgentTrace(mastraExporter);
  await client.shutdown();

  const spans = spanExporter.getFinishedSpans();
  await tracerProvider.shutdown();
  const generationSpanOut = spans.find((span) => span.name === 'streamText gpt-5-mini');
  assert.ok(generationSpanOut, 'generation span exported');
  assert.notEqual(generationSpanOut.spanContext().traceId, TRACE_ID, 'span starts its own trace');
  assert.equal(generationSpanOut.parentSpanContext, undefined, 'span has no phantom parent');
});

test('mastra exporter honors capture flags', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client, { captureInputs: false, captureOutputs: false });

  await emitAgentTrace(mastraExporter);
  const snapshot = client.debugSnapshot();
  await client.flush();
  await client.shutdown();

  const generation = exporter.generations[0];
  assert.equal(generation.input, undefined);
  assert.equal(generation.output, undefined);
  assert.equal(generation.systemPrompt, undefined);
  assert.equal(snapshot.toolExecutions[0].arguments, undefined);
  assert.equal(snapshot.toolExecutions[0].result, undefined);
});

test('mastra exporter ignores malformed events and internal span types', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  await mastraExporter.exportTracingEvent(undefined);
  await mastraExporter.exportTracingEvent({ type: 'span_ended' });
  await mastraExporter.exportTracingEvent({ type: 'span_ended', exportedSpan: { id: '', traceId: '' } });
  await emit(mastraExporter, 'span_ended', {
    id: 'eeeeeeeeeeeeeee1',
    traceId: TRACE_ID,
    name: 'step: 0',
    type: 'model_step',
    attributes: { usage: { inputTokens: 5, outputTokens: 5 } },
    endTime: new Date(),
  });
  await emit(mastraExporter, 'span_ended', {
    id: 'eeeeeeeeeeeeeee2',
    traceId: TRACE_ID,
    name: "chunk: 'text'",
    type: 'model_chunk',
    isEvent: true,
    endTime: new Date(),
  });

  await client.flush();
  await client.shutdown();
  assert.equal(exporter.generations.length, 0);
  assert.equal(exporter.workflowSteps.length, 0);
});

test('mastra exporter builds a fan-in DAG for parallel workflow branches', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  const traceId = 'abcdefabcdefabcdefabcdefabcdefab';
  const runId = 'aaaaaaaaaaaaaa10';
  const parallelId = 'aaaaaaaaaaaaaa11';
  const mkStep = (id, name, parent) => ({
    id,
    traceId,
    name: `workflow step: '${name}'`,
    type: 'workflow_step',
    parentSpanId: parent,
    entityType: 'workflow_step',
    entityId: name,
    startTime: new Date('2026-07-13T12:00:00.000Z'),
    endTime: new Date('2026-07-13T12:00:01.000Z'),
    attributes: { status: 'success' },
  });
  const runSpan = {
    id: runId,
    traceId,
    name: "workflow run: 'wf-par'",
    type: 'workflow_run',
    isRootSpan: true,
    entityType: 'workflow_run',
    entityId: 'wf-par',
    startTime: new Date('2026-07-13T12:00:00.000Z'),
  };
  const parallelSpan = {
    id: parallelId,
    traceId,
    name: 'parallel',
    type: 'workflow_parallel',
    parentSpanId: runId,
    startTime: new Date('2026-07-13T12:00:00.100Z'),
  };

  await emit(mastraExporter, 'span_started', runSpan);
  await emit(mastraExporter, 'span_ended', mkStep('aaaaaaaaaaaaaa12', 'pre', runId));
  await emit(mastraExporter, 'span_started', parallelSpan);
  await emit(mastraExporter, 'span_ended', mkStep('aaaaaaaaaaaaaa13', 'branch-a', parallelId));
  await emit(mastraExporter, 'span_ended', mkStep('aaaaaaaaaaaaaa14', 'branch-b', parallelId));
  await emit(mastraExporter, 'span_ended', { ...parallelSpan, endTime: new Date('2026-07-13T12:00:01.500Z') });
  await emit(mastraExporter, 'span_ended', mkStep('aaaaaaaaaaaaaa15', 'post', runId));
  await emit(mastraExporter, 'span_ended', { ...runSpan, endTime: new Date('2026-07-13T12:00:02.000Z') });

  await client.flush();
  await client.shutdown();

  const byName = Object.fromEntries(exporter.workflowSteps.map((step) => [step.stepName, step]));
  assert.equal(byName.pre.parentStepIds, undefined);
  assert.deepEqual(byName['branch-a'].parentStepIds, [byName.pre.id]);
  assert.deepEqual(byName['branch-b'].parentStepIds, [byName.pre.id]);
  assert.deepEqual(new Set(byName.post.parentStepIds), new Set([byName['branch-a'].id, byName['branch-b'].id]));
});

test('mastra exporter survives hostile metadata without dropping the generation', async () => {
  const { client, exporter } = newClient();
  const circular = { name: 'loop' };
  circular.self = circular;
  const shared = { a: 1 };
  const mastraExporter = createAgento11yMastra(client, {
    extraMetadata: {
      circular,
      repeated: { x: shared, y: shared },
      badDate: new Date(Number.NaN),
      notFinite: Number.POSITIVE_INFINITY,
      fn: () => 'nope',
      ok: 'kept',
    },
  });

  await emit(
    mastraExporter,
    'span_ended',
    generationSpan({
      isRootSpan: true,
      parentSpanId: undefined,
      endTime: new Date(),
      metadata: { threadId: 'thread-42', alsoBad: new Date(Number.NaN) },
    }),
  );
  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations.length, 1, 'generation exported despite hostile metadata');
  const metadata = exporter.generations[0].metadata;
  assert.equal(metadata.ok, 'kept');
  assert.equal(metadata.circular.self, '[circular]');
  assert.deepEqual(metadata.repeated, { x: { a: 1 }, y: { a: 1 } }, 'repeated non-cyclic objects preserved');
  assert.equal(metadata.badDate, undefined);
  assert.equal(metadata.notFinite, undefined);
  assert.equal(metadata.fn, undefined);
  assert.equal(metadata['agento11y.framework.mastra.metadata'].threadId, 'thread-42');
  assert.equal(metadata['agento11y.framework.mastra.metadata'].alsoBad, undefined);
});

test('mastra exporter flush and shutdown never reject after a shared client shuts down', async () => {
  const { client } = newClient();
  const mastraExporter = createAgento11yMastra(client);
  await emit(mastraExporter, 'span_ended', endedGenerationSpan({ isRootSpan: true, parentSpanId: undefined }));
  await client.shutdown();

  // Application shut the shared client down first; Mastra then flushes and
  // shuts the exporter down as part of its own shutdown sequence.
  await mastraExporter.flush();
  await mastraExporter.shutdown();
});

test('agento11y client debug buffers are bounded', async () => {
  const { client } = newClient();
  for (let i = 0; i < 1_050; i++) {
    const recorder = client.startToolExecution({ toolName: `tool-${i}` });
    recorder.end();
  }
  const snapshot = client.debugSnapshot();
  assert.equal(snapshot.toolExecutions.length, 1_000);
  assert.equal(snapshot.toolExecutions[0].toolName, 'tool-50', 'oldest records evicted first');
  await client.shutdown();
});

test('mastra exporter does not leak instructions when hideInput nulls span input', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  await emit(mastraExporter, 'span_started', agentRunSpan());
  // Mastra's hideInput nulls span.input but leaves attributes (instructions)
  // intact; the exporter must not resurrect the system prompt from them.
  await emit(mastraExporter, 'span_ended', endedGenerationSpan({ input: undefined }));
  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations.length, 1);
  assert.equal(exporter.generations[0].systemPrompt, undefined);
});

test('mastra exporter surfaces rolled-up usage from internal model spans', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  // model_generation with internalUsage instead of usage (hidden step spans).
  await emit(
    mastraExporter,
    'span_ended',
    generationSpan({
      isRootSpan: true,
      parentSpanId: undefined,
      endTime: new Date(),
      attributes: {
        model: 'gpt-5-mini',
        provider: 'openai.chat',
        streaming: false,
        internalUsage: { inputTokens: 7, outputTokens: 3 },
      },
    }),
  );
  // agent_run whose model spans were all internal/excluded: only the rollup
  // survives on the agent span.
  await emit(mastraExporter, 'span_ended', {
    ...agentRunSpan({ id: 'aaaaaaaaaaaaaaa2', traceId: 'ffffffffffffffffffffffffffffffff' }),
    endTime: new Date(),
    attributes: {
      conversationId: 'thread-99',
      internalUsage: { inputTokens: 11, outputTokens: 5, outputDetails: { reasoning: 2 } },
    },
  });
  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations.length, 2);
  const [direct, rollup] = exporter.generations;
  assert.deepEqual(direct.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });

  assert.equal(rollup.model.provider, 'custom');
  assert.equal(rollup.model.name, 'unknown');
  assert.equal(rollup.conversationId, 'thread-99');
  assert.deepEqual(rollup.usage, { inputTokens: 11, outputTokens: 5, totalTokens: 16, reasoningTokens: 2 });
  assert.equal(rollup.metadata['agento11y.framework.mastra.usage_rollup'], true);
});

test('mastra exporter maps toolChoice from inference spans and skips truncation sentinels', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  const stepId = 'ddddddddddddddd1';
  const inferenceId = 'ddddddddddddddd2';
  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(mastraExporter, 'span_started', generationSpan());
  await emit(mastraExporter, 'span_started', {
    id: stepId,
    traceId: TRACE_ID,
    name: 'step: 0',
    type: 'model_step',
    parentSpanId: GEN_SPAN_ID,
    startTime: new Date(),
  });
  await emit(mastraExporter, 'span_ended', {
    id: inferenceId,
    traceId: TRACE_ID,
    name: 'inference: 0',
    type: 'model_inference',
    parentSpanId: stepId,
    startTime: new Date(),
    endTime: new Date(),
    attributes: { toolChoice: { type: 'tool', toolName: 'calculator' } },
  });
  await emit(
    mastraExporter,
    'span_ended',
    endedGenerationSpan({
      input: {
        messages: [{ role: 'user', content: 'Calculate 5 + 3' }, '[…12 more items]'],
      },
    }),
  );
  await client.flush();
  await client.shutdown();

  const generation = exporter.generations[0];
  assert.equal(generation.toolChoice, 'calculator');
  assert.equal(generation.input.length, 1, 'truncation sentinel not turned into a message');
});

test('mastra exporter unwraps AI SDK tool-result envelopes and records toolCallId', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client);

  await emit(mastraExporter, 'span_started', agentRunSpan());
  await emit(mastraExporter, 'span_started', generationSpan());
  await emit(mastraExporter, 'span_ended', toolSpan({ attributes: { toolType: 'tool', toolCallId: 'call-77' } }));
  await emit(
    mastraExporter,
    'span_ended',
    endedGenerationSpan({
      output: {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-77',
                toolName: 'calculator',
                output: { type: 'json', value: { result: 8 } },
              },
              {
                type: 'tool-result',
                toolCallId: 'call-78',
                toolName: 'calculator',
                output: { type: 'error-text', value: 'boom' },
              },
            ],
          },
        ],
      },
    }),
  );
  const snapshot = client.debugSnapshot();
  await client.flush();
  await client.shutdown();

  assert.equal(snapshot.toolExecutions[0].toolCallId, 'call-77');

  const message = exporter.generations[0].output[0];
  assert.equal(message.role, 'tool', 'all-tool-result message coerced to tool role');
  assert.equal(message.parts[0].toolResult.contentJSON, '{"result":8}', 'wrapper stripped to the underlying value');
  assert.equal(message.parts[0].toolResult.isError, undefined);
  assert.equal(message.parts[1].toolResult.contentJSON, '"boom"');
  assert.equal(message.parts[1].toolResult.isError, true);
});

test('mastra exporter applies the customizeGeneration hook and survives hook failures', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = createAgento11yMastra(client, {
    agentName: 'base-agent',
    customizeGeneration: (seed, span) => {
      const requestContext = span.requestContext ?? {};
      if (requestContext.promptId === undefined) {
        throw new Error('boom'); // hook errors must not drop the generation
      }
      return {
        ...seed,
        agentName: `${seed.agentName}:${requestContext.promptId}`,
        userId: requestContext.userId,
        operationName: 'custom-op',
        effectiveVersion: `sha256:${'a'.repeat(64)}`,
      };
    },
  });

  await emit(
    mastraExporter,
    'span_ended',
    endedGenerationSpan({
      isRootSpan: true,
      parentSpanId: undefined,
      requestContext: { promptId: 'faq', userId: 'user-1' },
    }),
  );
  await emit(
    mastraExporter,
    'span_ended',
    endedGenerationSpan({ id: 'bbbbbbbbbbbbbbb3', isRootSpan: true, parentSpanId: undefined }),
  );
  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations.length, 2);
  const [customized, fallback] = exporter.generations;
  assert.equal(customized.agentName, 'base-agent:faq');
  assert.equal(customized.userId, 'user-1');
  assert.equal(customized.operationName, 'custom-op');
  assert.equal(customized.effectiveVersion, `sha256:${'a'.repeat(64)}`);
  assert.equal(fallback.agentName, 'base-agent', 'throwing hook falls back to the unmodified seed');
});

test('mastra exporter uses serviceName from init as agent fallback', async () => {
  const { client, exporter } = newClient();
  const mastraExporter = new Agento11yMastraExporter(client);
  mastraExporter.init({ config: { serviceName: 'svc-from-init' } });

  await emit(
    mastraExporter,
    'span_ended',
    generationSpan({ isRootSpan: true, parentSpanId: undefined, endTime: new Date() }),
  );
  await client.flush();
  await client.shutdown();

  assert.equal(exporter.generations[0].agentName, 'svc-from-init');
});

test('mastra exporter shuts down an owned client and flushes a shared one', async () => {
  const { client } = newClient();
  const shared = createAgento11yMastra(client);
  await shared.shutdown();
  // Shared client stays usable after the exporter shuts down.
  client.startToolExecution({ toolName: 'still-open' }).end();
  await client.shutdown();

  const owned = new Agento11yMastraExporter({ shutdownClient: true });
  await owned.shutdown();
  // Exporter is inert after shutdown; events are dropped without throwing.
  await emit(owned, 'span_ended', endedGenerationSpan());
});
