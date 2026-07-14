import type { Message, MessagePart, TokenUsage, ToolDefinition } from '../../types.js';
import type { MastraExportedSpan, MastraProviderResolverFn } from './types.js';

type AnyRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): AnyRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function coerceDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;

export function isValidOtelTraceId(traceId: string): boolean {
  return traceIdPattern.test(traceId) && traceId !== '0'.repeat(32);
}

export function isValidOtelSpanId(spanId: string): boolean {
  return spanIdPattern.test(spanId) && spanId !== '0'.repeat(16);
}

const knownProviders = new Set(['openai', 'anthropic', 'gemini']);
const providerAliases: Record<string, string> = {
  google: 'gemini',
  'google-generative-ai': 'gemini',
  'google-vertex': 'gemini',
};

function inferProviderFromModelName(modelName: string): string {
  const normalized = modelName.trim().toLowerCase();
  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  ) {
    return 'openai';
  }
  if (normalized.startsWith('claude-')) {
    return 'anthropic';
  }
  if (normalized.startsWith('gemini-')) {
    return 'gemini';
  }
  return 'custom';
}

/**
 * Resolves a Sigil provider name from Mastra's provider string (an AI SDK
 * identifier like `openai.chat`, `anthropic.messages`, or
 * `google.generative-ai`). Mirrors the normalization used by the shared
 * framework handler: explicit override, custom resolver, provider string,
 * then model-name inference.
 */
export function resolveMastraProvider(
  explicitProvider: string | undefined,
  resolver: 'auto' | MastraProviderResolverFn,
  rawProvider: string,
  modelName: string,
): string {
  if (explicitProvider !== undefined && explicitProvider.trim().length > 0) {
    return explicitProvider.trim();
  }
  if (typeof resolver === 'function') {
    const resolved = resolver({ provider: rawProvider, modelName });
    if (typeof resolved === 'string' && resolved.trim().length > 0) {
      return resolved.trim();
    }
  }
  const normalized = rawProvider.trim().toLowerCase();
  if (normalized.length > 0) {
    const head = normalized.split('.')[0] ?? '';
    const aliased = providerAliases[head] ?? providerAliases[normalized] ?? head;
    if (knownProviders.has(aliased)) {
      return aliased;
    }
  }
  const inferred = inferProviderFromModelName(modelName);
  if (inferred !== 'custom') {
    return inferred;
  }
  return 'custom';
}

/** Maps Mastra `UsageStats` to Sigil {@link TokenUsage}. */
export function mapMastraUsage(rawUsage: unknown): TokenUsage | undefined {
  const usage = asRecord(rawUsage);
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = asFiniteNumber(usage.inputTokens);
  const outputTokens = asFiniteNumber(usage.outputTokens);
  const inputDetails = asRecord(usage.inputDetails);
  const outputDetails = asRecord(usage.outputDetails);
  const cacheReadInputTokens = asFiniteNumber(inputDetails?.cacheRead);
  const cacheWriteInputTokens = asFiniteNumber(inputDetails?.cacheWrite);
  const reasoningTokens = asFiniteNumber(outputDetails?.reasoning);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheWriteInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  const mapped: TokenUsage = {};
  if (inputTokens !== undefined) {
    mapped.inputTokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    mapped.outputTokens = outputTokens;
  }
  if (inputTokens !== undefined || outputTokens !== undefined) {
    mapped.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  if (cacheReadInputTokens !== undefined) {
    mapped.cacheReadInputTokens = cacheReadInputTokens;
  }
  if (cacheWriteInputTokens !== undefined) {
    mapped.cacheWriteInputTokens = cacheWriteInputTokens;
  }
  if (reasoningTokens !== undefined) {
    mapped.reasoningTokens = reasoningTokens;
  }
  return mapped;
}

export function safeJSONStringify(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded : undefined;
  } catch {
    return undefined;
  }
}

function mapContentPart(part: AnyRecord): MessagePart | undefined {
  const type = asString(part.type);
  switch (type) {
    case 'text': {
      const text = asString(part.text);
      return text.length > 0 ? { type: 'text', text } : undefined;
    }
    case 'reasoning': {
      const thinking = asString(part.text);
      return thinking.length > 0 ? { type: 'thinking', thinking } : undefined;
    }
    case 'tool-call': {
      const name = asString(part.toolName);
      if (name.length === 0) {
        return undefined;
      }
      const input = part.input ?? part.args;
      return {
        type: 'tool_call',
        toolCall: {
          id: asStringOrUndefined(part.toolCallId),
          name,
          inputJSON: input === undefined ? undefined : safeJSONStringify(input),
        },
      };
    }
    case 'tool-result': {
      let output = part.output ?? part.result;
      let isError = part.isError === true;
      // AI SDK v5 wraps tool results in a typed envelope
      // `{ type: 'json'|'text'|'error-json'|'error-text'|…, value }` —
      // export the underlying value, not the wrapper.
      const wrapper = asRecord(output);
      if (wrapper !== undefined && typeof wrapper.type === 'string' && 'value' in wrapper) {
        output = wrapper.value;
        isError = isError || wrapper.type.startsWith('error');
      }
      return {
        type: 'tool_result',
        toolResult: {
          toolCallId: asStringOrUndefined(part.toolCallId),
          name: asStringOrUndefined(part.toolName),
          contentJSON: output === undefined ? undefined : safeJSONStringify(output),
          isError: isError ? true : undefined,
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * Mastra's serializer truncates long arrays and appends a string sentinel
 * (`[…N more items]`); it must not become a message of its own.
 */
const truncationSentinelPattern = /^\[…\d+ more items\]$/;

function mapOneMessage(raw: unknown, defaultRole: string): Message | undefined {
  if (typeof raw === 'string') {
    if (raw.length === 0 || truncationSentinelPattern.test(raw)) {
      return undefined;
    }
    return { role: defaultRole, content: raw };
  }
  const message = asRecord(raw);
  if (message === undefined) {
    return undefined;
  }
  const role = asString(message.role) || defaultRole;
  const content = message.content;
  if (typeof content === 'string') {
    return { role, content };
  }
  if (Array.isArray(content)) {
    const parts: MessagePart[] = [];
    for (const item of content) {
      const record = asRecord(item);
      if (record === undefined) {
        continue;
      }
      const part = mapContentPart(record);
      if (part !== undefined) {
        parts.push(part);
      }
    }
    if (parts.length > 0) {
      // Sigil only accepts tool_result parts on tool-role messages; some
      // frameworks attach results to assistant messages instead.
      const effectiveRole = parts.every((part) => part.type === 'tool_result') ? 'tool' : role;
      return { role: effectiveRole, parts };
    }
    const fallback = safeJSONStringify(content);
    return fallback === undefined ? undefined : { role, content: fallback };
  }
  const fallback = safeJSONStringify(message);
  return fallback === undefined ? undefined : { role, content: fallback };
}

/**
 * Maps a Mastra generation input (`{ messages: [...] }`, a message list, or a
 * plain prompt string) to Sigil messages. The AI SDK v5 message shape
 * (`content` as a string or a typed part array) is handled part-by-part.
 */
export function mapMastraInputMessages(input: unknown): Message[] {
  if (typeof input === 'string') {
    return input.length > 0 ? [{ role: 'user', content: input }] : [];
  }
  const record = asRecord(input);
  const list = Array.isArray(input) ? input : Array.isArray(record?.messages) ? record.messages : undefined;
  if (list === undefined) {
    if (record !== undefined) {
      const fallback = safeJSONStringify(record);
      return fallback === undefined ? [] : [{ role: 'user', content: fallback }];
    }
    return [];
  }
  const messages: Message[] = [];
  for (const item of list) {
    const mapped = mapOneMessage(item, 'user');
    if (mapped !== undefined) {
      messages.push(mapped);
    }
  }
  return messages;
}

/**
 * Maps a Mastra generation output (`{ text, toolCalls?, object?, ... }`, a
 * message list, or a plain string) to Sigil assistant messages.
 */
export function mapMastraOutputMessages(output: unknown): Message[] {
  if (typeof output === 'string') {
    return output.length > 0 ? [{ role: 'assistant', content: output }] : [];
  }
  const record = asRecord(output);
  if (record === undefined) {
    if (Array.isArray(output)) {
      const messages: Message[] = [];
      for (const item of output) {
        const mapped = mapOneMessage(item, 'assistant');
        if (mapped !== undefined) {
          messages.push(mapped);
        }
      }
      return messages;
    }
    return [];
  }
  if (Array.isArray(record.messages)) {
    const messages: Message[] = [];
    for (const item of record.messages) {
      const mapped = mapOneMessage(item, 'assistant');
      if (mapped !== undefined) {
        messages.push(mapped);
      }
    }
    if (messages.length > 0) {
      return messages;
    }
  }

  const parts: MessagePart[] = [];
  const reasoningText = record.reasoningText;
  if (typeof reasoningText === 'string' && reasoningText.trim().length > 0) {
    parts.push({ type: 'thinking', thinking: reasoningText });
  }
  const text = record.text;
  if (typeof text === 'string' && text.length > 0) {
    parts.push({ type: 'text', text });
  }
  if (Array.isArray(record.toolCalls)) {
    for (const item of record.toolCalls) {
      const call = asRecord(item);
      if (call === undefined) {
        continue;
      }
      const mapped = mapContentPart({ ...call, type: 'tool-call' });
      if (mapped !== undefined) {
        parts.push(mapped);
      }
    }
  }
  if (parts.length === 0 && record.object !== undefined) {
    const encoded = safeJSONStringify(record.object);
    if (encoded !== undefined) {
      parts.push({ type: 'text', text: encoded });
    }
  }
  if (parts.length === 0) {
    return [];
  }
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return [{ role: 'assistant', content: parts[0].text }];
  }
  return [{ role: 'assistant', parts }];
}

/**
 * Splits system messages out of a mapped input list; Sigil carries the system
 * prompt as a dedicated generation field.
 */
export function splitSystemPrompt(messages: Message[]): { systemPrompt: string | undefined; messages: Message[] } {
  const systemTexts: string[] = [];
  const rest: Message[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text =
        message.content ??
        (message.parts ?? [])
          .map((part) => (part.type === 'text' ? part.text : ''))
          .filter((text) => text.length > 0)
          .join('\n');
      if (text !== undefined && text.length > 0) {
        systemTexts.push(text);
      }
      continue;
    }
    rest.push(message);
  }
  return {
    systemPrompt: systemTexts.length > 0 ? systemTexts.join('\n') : undefined,
    messages: rest,
  };
}

/** Extracts the error message from a Mastra `SpanErrorInfo`. */
export function mapMastraError(errorInfo: unknown): string | undefined {
  const record = asRecord(errorInfo);
  if (record === undefined) {
    return undefined;
  }
  const message = asString(record.message);
  if (message.length > 0) {
    return message;
  }
  return safeJSONStringify(record);
}

/**
 * Extracts Mastra's own error classification (`SpanErrorInfo.id/category/
 * domain`) so it survives as metadata beside the Sigil-derived
 * `error.category` heuristic.
 */
export function mapMastraErrorClassification(errorInfo: unknown): Record<string, string> | undefined {
  const record = asRecord(errorInfo);
  if (record === undefined) {
    return undefined;
  }
  const classification: Record<string, string> = {};
  const id = asStringOrUndefined(record.id);
  if (id !== undefined) {
    classification['sigil.framework.mastra.error.id'] = id;
  }
  const category = asStringOrUndefined(record.category);
  if (category !== undefined) {
    classification['sigil.framework.mastra.error.category'] = category;
  }
  const domain = asStringOrUndefined(record.domain);
  if (domain !== undefined) {
    classification['sigil.framework.mastra.error.domain'] = domain;
  }
  return Object.keys(classification).length > 0 ? classification : undefined;
}

/**
 * Maps Mastra's `toolChoice` (`'auto' | 'none' | 'required' |
 * { type: 'tool'; toolName }`) to Sigil's string field.
 */
export function mapToolChoice(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return asStringOrUndefined(asRecord(value)?.toolName);
}

/**
 * Best-effort thinking/reasoning detection: Mastra marks reasoning intent via
 * `ModelGenerationAttributes.resultType` and provider-specific request
 * options (e.g. `providerOptions.anthropic.thinking`).
 */
export function detectThinkingEnabled(
  generationAttributes: Record<string, unknown>,
  inferenceAttributes: Record<string, unknown> | undefined,
): boolean | undefined {
  if (asString(generationAttributes.resultType) === 'reasoning') {
    return true;
  }
  const providerOptions = asRecord(inferenceAttributes?.providerOptions);
  if (providerOptions !== undefined) {
    for (const value of Object.values(providerOptions)) {
      const record = asRecord(value);
      if (record !== undefined && ('thinking' in record || 'reasoning' in record || 'reasoningEffort' in record)) {
        return true;
      }
    }
  }
  return undefined;
}

/** Maps `agent_run` `availableTools` names to Sigil tool definitions. */
export function mapAvailableTools(availableTools: unknown): ToolDefinition[] | undefined {
  const names = asStringArray(availableTools);
  if (names.length === 0) {
    return undefined;
  }
  return names.map((name) => ({ name }));
}

/** Wraps a non-record value so it fits Sigil's workflow-step state fields. */
export function toStateRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  if (record !== undefined) {
    return record;
  }
  return { value };
}

const maxMetadataDepth = 5;

/**
 * Normalizes a metadata record to JSON-safe values with the same semantics as
 * the shared framework handler: bounded depth, invalid Dates and non-finite
 * numbers dropped, functions/symbols/bigints dropped, cyclic references
 * marked `[circular]` (repeated non-cyclic references are preserved).
 */
export function normalizeMetadataRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = key.trim();
    if (normalizedKey.length === 0) {
      continue;
    }
    const normalizedValue = normalizeMetadataValue(value, 0, seen);
    if (normalizedValue !== undefined) {
      out[normalizedKey] = normalizedValue;
    }
  }
  return out;
}

/** See {@link normalizeMetadataRecord}; `undefined` means "drop this value". */
export function normalizeMetadataValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > maxMetadataDepth || value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeMetadataValue(item, depth + 1, seen)).filter((item) => item !== undefined);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);
  try {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.trim();
      if (normalizedKey.length === 0) {
        continue;
      }
      const normalizedItem = normalizeMetadataValue(item, depth + 1, seen);
      if (normalizedItem !== undefined) {
        normalized[normalizedKey] = normalizedItem;
      }
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

/** Reads a string metadata value from a Mastra span. */
export function spanMetadataString(span: MastraExportedSpan, key: string): string | undefined {
  const metadata = asRecord(span.metadata);
  if (metadata === undefined) {
    return undefined;
  }
  return asStringOrUndefined(metadata[key]);
}

/** Reads a string attribute value from a Mastra span. */
export function spanAttributeString(span: MastraExportedSpan, key: string): string | undefined {
  const attributes = asRecord(span.attributes);
  if (attributes === undefined) {
    return undefined;
  }
  return asStringOrUndefined(attributes[key]);
}
