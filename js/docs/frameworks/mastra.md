# Mastra Exporter (`@grafana/sigil-sdk-js/mastra`)

Use `createSigilMastraExporter(...)` to instrument [Mastra](https://mastra.ai) agents and workflows with Sigil generation export, spans, metrics, tool execution spans, workflow steps, and streaming TTFT.

Unlike the callback-based adapters, this integration plugs into Mastra's observability exporter mechanism (`@mastra/core` >= 1.16): Mastra emits typed tracing events for every agent run, model generation, tool call, and workflow step, and the exporter maps them onto the Sigil data model.

## Install

```bash
pnpm add @grafana/sigil-sdk-js @mastra/core @mastra/observability
```

## Quickstart

```ts
import { Mastra } from '@mastra/core/mastra';
import { Observability } from '@mastra/observability';
import { SigilClient } from '@grafana/sigil-sdk-js';
import { createSigilMastraExporter } from '@grafana/sigil-sdk-js/mastra';

const sigil = new SigilClient(); // reads SIGIL_* environment variables

export const mastra = new Mastra({
  agents: { myAgent },
  workflows: { myWorkflow },
  observability: new Observability({
    configs: {
      sigil: {
        serviceName: 'my-service',
        exporters: [createSigilMastraExporter(sigil, { agentVersion: '1.0.0' })],
      },
    },
  }),
});
```

Omit the client to let the exporter construct one from `SIGIL_*` environment variables; the exporter then owns the client and shuts it down when Mastra shuts down:

```ts
exporters: [createSigilMastraExporter({ agentVersion: '1.0.0' })],
```

## What gets exported

| Mastra span | Sigil record |
|-------------|--------------|
| `model_generation` | Generation (input/output messages, usage incl. cache + reasoning tokens, stop reason, response id/model, TTFT) + `generateText`/`streamText` OTel span + `gen_ai.client.*` metrics |
| `tool_call`, `mcp_tool_call`, `client_tool_call` | `execute_tool` OTel span (arguments/results follow the client content-capture mode) |
| `workflow_step` | Workflow step with `linkedGenerationIds` and sequential `parentStepIds` |
| `agent_run` | Context source: agent name/version, conversation id, system instructions, available tools |

Generation ids are the originating Mastra span ids, so re-exported spans are idempotent and applications can reference a generation wherever the span id is known. Successive generations in one trace are chained through `parentGenerationIds` for the Dependencies view; use `customizeGeneration` to override the linking scheme (e.g. point a turn's generations at their shared `agent_run` span via `span.parentSpanId`). Workflow steps form a true DAG: steps inside `.parallel()`/`.branch()` blocks share the preceding step as parent, and the step after the block fans in from all branches.

When Mastra hides model spans (`TracingPolicy` internal spans or `excludeSpanTypes`), their token usage still reaches Sigil: the rollup Mastra places on the exported ancestor (`internalUsage`) is exported as a usage-only generation (marked `sigil.framework.mastra.usage_rollup`), so cost dashboards stay correct. Mastra's `hideInput`/`hideOutput` tracing options are honored — hidden inputs are not reconstructed from span attributes such as agent instructions.

## Conversation ID

Precedence:

1. `resolveConversationId(span)` option
2. the `agent_run` span's `conversationId` attribute (the Mastra memory thread id)
3. span metadata `threadId`, `sessionId`, or `conversationId` (walking up the trace)
4. fallback `sigil:framework:mastra:<trace_id>`

The Mastra span metadata `userId` (or `resourceId`) becomes the Sigil `user.id`.

## Trace correlation

Sigil spans are parented on the originating Mastra span context (Mastra ids are OTel-compatible). Pair this exporter with [`@mastra/otel-exporter`](https://mastra.ai/docs/observability/tracing/exporters) pointed at your Grafana OTLP gateway and both span sets land in the same trace:

```ts
configs: {
  sigil: {
    serviceName: 'my-service',
    exporters: [
      createSigilMastraExporter(sigil),
      new OtelExporter({ provider: { custom: { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT } } }),
    ],
  },
},
```

Without an OTLP channel the generation records still carry the Mastra `trace_id`, so Grafana joins generations, workflow steps, and any Sigil-emitted spans consistently.

If you export the Sigil client's spans over OTLP but do **not** export Mastra's spans (no `@mastra/otel-exporter`/bridge), set `joinMastraTrace: false` — otherwise every Sigil span is parented on a Mastra span that never reaches the trace store, leaving headless traces that break trace-derived views such as per-generation latency:

```ts
createSigilMastraExporter(sigil, { joinMastraTrace: false });
```

## Metadata

Tags:

- `sigil.framework.name=mastra`
- `sigil.framework.source=exporter`
- `sigil.framework.language=typescript`

Metadata includes:

- `sigil.framework.run_id` (the Mastra span id)
- `sigil.framework.parent_run_id`
- `sigil.framework.thread_id`
- `sigil.framework.component_name` (agent/tool/step entity name)
- `sigil.framework.run_type`
- `sigil.framework.mastra.span_type` (the raw Mastra span type)
- `sigil.framework.mastra.provider` (the raw AI SDK provider string when it was normalized, e.g. `openai.chat`)
- `sigil.framework.mastra.metadata` (the Mastra span metadata, depth-limited)
- `sigil.framework.mastra.error.id` / `.category` / `.domain` (Mastra's own error classification, when a span failed)
- `sigil.framework.tags` (Mastra root-span tags)

Workflow steps carry `sigil.framework.mastra.span_type`, `.status`, `.workflow`, and the same error classification keys.

## Per-generation customization

`customizeGeneration(seed, span)` runs last before a generation is recorded — override identity fields per span (the Mastra `requestContext` and `metadata` are available on the span):

```ts
createSigilMastraExporter(sigil, {
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
createSigilMastraExporter(sigil, {
  captureInputs: false,
  captureOutputs: false,
});
```

While either capture flag is on (the default), tool arguments/results are captured on `execute_tool` spans, matching the other framework adapters; a per-client `contentCapture: 'metadata_only'` or `'full_with_metadata_spans'` mode still strips them. Mastra's `SensitiveDataFilter` span processor runs before the exporter, so its redactions apply to everything Sigil receives.

## Notes

- Only ended spans are exported; Mastra internal spans (`model_step`, `model_inference`, `model_chunk`) are never mapped to generations, so token usage is not double counted.
- Mastra executes generations through its streaming loop, so generations are typically recorded in `STREAM` mode with `completionStartTime` mapped to time-to-first-token.
- The exporter never throws into the Mastra event bus; mapping failures are logged through the Mastra logger.
- Call `mastra.shutdown()` (or `await exporter.shutdown()`) to flush queued generation export before process exit.
