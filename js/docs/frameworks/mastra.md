# Mastra Exporter (`@grafana/agento11y/mastra`)

Use `createAgento11yMastra(...)` to instrument [Mastra](https://mastra.ai) agents and workflows with Agento11y generation export, spans, metrics, tool execution spans, workflow steps, and streaming TTFT.

Unlike the callback-based adapters, this integration plugs into Mastra's observability exporter mechanism (`@mastra/core` >= 1.16): Mastra emits typed tracing events for every agent run, model generation, tool call, and workflow step, and the exporter maps them onto the Agento11y data model.

Works with plain `Mastra` instances and with [`AgentController`](#agentcontroller) — see that section for its separate wiring.

## Install

```bash
pnpm add @grafana/agento11y @mastra/core @mastra/observability
```

## Quickstart

```ts
import { Mastra } from '@mastra/core/mastra';
import { Observability } from '@mastra/observability';
import { Agento11yClient } from '@grafana/agento11y';
import { createAgento11yMastra } from '@grafana/agento11y/mastra';

const agento11y = new Agento11yClient(); // reads AGENTO11Y_* environment variables

export const mastra = new Mastra({
  agents: { myAgent },
  workflows: { myWorkflow },
  observability: new Observability({
    configs: {
      agento11y: {
        serviceName: 'my-service',
        exporters: [createAgento11yMastra(agento11y, { agentVersion: '1.0.0' })],
      },
    },
  }),
});
```

Omit the client to let the exporter construct one from `AGENTO11Y_*` environment variables; the exporter then owns the client and shuts it down when Mastra shuts down:

```ts
exporters: [createAgento11yMastra({ agentVersion: '1.0.0' })],
```

## What gets exported

| Mastra span | Agento11y record |
|-------------|--------------|
| `model_generation` | Generation (input/output messages, usage incl. cache + reasoning tokens, stop reason, response id/model, TTFT) + `generateText`/`streamText` OTel span + `gen_ai.client.*` metrics |
| `tool_call`, `mcp_tool_call`, `client_tool_call`, `provider_tool_call` | `execute_tool` OTel span (arguments/results follow the client content-capture mode) + embedded `tool_call`/`tool_result` message parts in the owning generation's output (`embedToolMessages: false` to disable; skipped when the framework output already carries tool parts) |
| `model_step`, `model_chunk` (reasoning) | Used to reconstruct the generation's real interleaving: per model round an assistant message (thinking → text → tool calls, with the model's `toolCallId`s) followed by that round's tool results, instead of a flat "all tools, then answer" |
| `workflow_step` | Workflow step with `linkedGenerationIds` and sequential `parentStepIds` |
| `agent_run` | Context source: agent name/version, conversation id, system instructions, available tools |

Generation ids are the originating Mastra span ids, so re-exported spans are idempotent and applications can reference a generation wherever the span id is known. Successive generations in one trace are chained through `parentGenerationIds` for the Dependencies view; use `customizeGeneration` to override the linking scheme (e.g. point a turn's generations at their shared `agent_run` span via `span.parentSpanId`). Workflow steps form a true DAG: steps inside `.parallel()`/`.branch()` blocks share the preceding step as parent, and the step after the block fans in from all branches.

When Mastra hides model spans (`TracingPolicy` internal spans or `excludeSpanTypes`), their token usage still reaches Agento11y: the rollup Mastra places on the exported ancestor (`internalUsage`) is exported as a usage-only generation (marked `agento11y.framework.mastra.usage_rollup`), so cost dashboards stay correct. Mastra's `hideInput`/`hideOutput` tracing options are honored — hidden inputs are not reconstructed from span attributes such as agent instructions.

## AgentController

[`AgentController`](https://mastra.ai/docs/agent-controller/overview) (`@mastra/core/agent-controller`, named `AgentController` since `@mastra/core` 1.47; previously `Harness`) wraps an `Agent` with session, mode, approval, and subagent management. It does **not** take a `Mastra` instance, so it does not pick up `new Mastra({ observability })` — wire it one of two ways.

**Pass `observability` to the constructor.** AgentController forwards it to the internal Mastra it builds during `init()` (requires `@mastra/core` >= 1.29):

```ts
import { AgentController } from '@mastra/core/agent-controller';
import { Observability } from '@mastra/observability';

const observability = new Observability({
  configs: { agento11y: { serviceName: 'my-service', exporters: [createAgento11yMastra(agento11y)] } },
});

const controller = new AgentController({
  agent,
  storage,        // required — see below
  observability,
  modes: [{ id: 'default', instructions: '…' }],
});
await controller.init();
```

> **`storage` is required for this path.** AgentController only builds its internal Mastra when `storage` is set. Without it, `observability` is **silently discarded** — no spans, no error.

**Or register the controller on a Mastra you already own**, and it inherits that instance's observability (its own `observability` option is then ignored):

```ts
const mastra = new Mastra({
  agentControllers: { myController: controller },
  observability,
});
```

### What is and isn't traced

AgentController emits no spans of its own — it forwards tracing context into the underlying agent, so what you get is the normal agent/model/tool span set covered above:

| Surface | Traced |
|---|---|
| Agent turns, model calls, tools | Yes — the standard mapping above |
| Subagents (`session.subagents`) | Yes — the subagent tool's `tool_call` plus the child's `agent_run`, nested in the same trace |
| Tool approvals (`session.approval`) | Partly — the approval *gate* emits no span, since it suspends before the tool runs. On resume Mastra opens a second `agent_run` named `… (resumed)` in the same trace; generations under it chain onto the pre-approval ones |
| Mode switches, session create/resume | No — these are session event-bus events (`session.subscribe(...)`), not spans |
| Workspace/skill actions | Not yet mapped — the enclosing `tool_call` is captured, but the nested `workspace_action` detail (category, provider, success) is dropped |
| Observational memory (`session.om`) | Not yet mapped — OM emits `generic` spans (`om.observer`, `om.reflector`), which this exporter ignores. Any model calls beneath them are still captured as generations, and usage from internal spans still rolls up |

## Conversation ID

Precedence:

1. `resolveConversationId(span)` option
2. the `agent_run` span's `conversationId` attribute (the Mastra memory thread id)
3. span metadata `threadId`, `sessionId`, or `conversationId` (walking up the trace)
4. fallback `agento11y:framework:mastra:<trace_id>`

The Mastra span metadata `userId` (or `resourceId`) becomes the Agento11y `user.id`.

## Trace correlation

Agento11y spans are parented on the originating Mastra span context (Mastra ids are OTel-compatible). Pair this exporter with [`@mastra/otel-exporter`](https://mastra.ai/docs/observability/tracing/exporters) pointed at your Grafana OTLP gateway and both span sets land in the same trace:

```ts
configs: {
  agento11y: {
    serviceName: 'my-service',
    exporters: [
      createAgento11yMastra(agento11y),
      new OtelExporter({ provider: { custom: { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT } } }),
    ],
  },
},
```

Without an OTLP channel the generation records still carry the Mastra `trace_id`, so Grafana joins generations, workflow steps, and any Agento11y-emitted spans consistently.

If you export the Agento11y client's spans over OTLP but do **not** export Mastra's spans (no `@mastra/otel-exporter`/bridge), set `joinMastraTrace: false` — otherwise every Agento11y span is parented on a Mastra span that never reaches the trace store, leaving headless traces that break trace-derived views such as per-generation latency:

```ts
createAgento11yMastra(agento11y, { joinMastraTrace: false });
```

## Metadata

Tags:

- `agento11y.framework.name=mastra`
- `agento11y.framework.source=exporter`
- `agento11y.framework.language=typescript`

Metadata includes:

- `agento11y.framework.run_id` (the Mastra span id)
- `agento11y.framework.parent_run_id`
- `agento11y.framework.thread_id`
- `agento11y.framework.component_name` (agent/tool/step entity name)
- `agento11y.framework.run_type`
- `agento11y.framework.mastra.span_type` (the raw Mastra span type)
- `agento11y.framework.mastra.provider` (the raw AI SDK provider string when it was normalized, e.g. `openai.chat`)
- `agento11y.framework.mastra.metadata` (the Mastra span metadata, depth-limited)
- `agento11y.framework.mastra.error.id` / `.category` / `.domain` (Mastra's own error classification, when a span failed)
- `agento11y.framework.tags` (Mastra root-span tags)

Workflow steps carry `agento11y.framework.mastra.span_type`, `.status`, `.workflow`, and the same error classification keys.

## Per-generation customization

`customizeGeneration(seed, span)` runs last before a generation is recorded — override identity fields per span (the Mastra `requestContext` and `metadata` are available on the span):

```ts
createAgento11yMastra(agento11y, {
  agentName: 'my-agent',
  customizeGeneration: (seed, span) => ({
    ...seed,
    agentName: `${seed.agentName}:${span.requestContext?.promptId ?? 'default'}`,
    userId: span.requestContext?.userId,
  }),
});
```

Hook errors are logged and the unmodified seed is used.

## Privacy Controls

Disable model/tool payload capture:

```ts
createAgento11yMastra(agento11y, {
  captureInputs: false,
  captureOutputs: false,
});
```

While either capture flag is on (the default), tool arguments/results are captured on `execute_tool` spans, matching the other framework adapters; a per-client `contentCapture: 'metadata_only'` or `'full_with_metadata_spans'` mode still strips them. Mastra's `SensitiveDataFilter` span processor runs before the exporter, so its redactions apply to everything Agento11y receives.

## Notes

- Only ended spans are exported; Mastra internal spans (`model_step`, `model_inference`, `model_chunk`) are never mapped to generations, so token usage is not double counted.
- Mastra executes generations through its streaming loop, so generations are typically recorded in `STREAM` mode with `completionStartTime` mapped to time-to-first-token.
- The exporter never throws into the Mastra event bus; mapping failures are logged through the Mastra logger.
- Call `mastra.shutdown()` (or `await exporter.shutdown()`) to flush queued generation export before process exit.
