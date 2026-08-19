import { v4 as uuidv4 } from 'uuid';
import {
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type AgentInputItem,
} from '@openai/agents';
import type {
  InternalRequest,
  InternalResponse,
  InternalMessage,
  ContentBlock,
} from '../types/internal.js';
import type { ProviderAdapter } from '../providers/base.js';
import { Errors } from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// GatewayModel — bridges the OpenAI Agents SDK Model/ModelProvider interfaces
// onto the gateway's own Provider pipeline (BaseProvider.send/stream).
//
// The SDK drives the tool-calling loop (Runner): each turn it calls
// getResponse()/getStreamedResponse() with the conversation so far, we translate
// that to InternalRequest, run it through the configured provider, and hand back
// a ModelResponse whose output[] may contain `function_call` items. The Runner
// executes the matching tool, appends a `function_call_result` to the input, and
// calls us again — until the model stops requesting tools.
//
// REAL streaming: getStreamedResponse() drives provider.stream() and forwards
// text deltas token-by-token. The SDK Runner only reads function_call items from
// the final response_done.response.output (run.js:794-801) — it does NOT consume
// incremental tool-call deltas — so a tool turn streams its (short) preamble
// text, then backfills the complete function_call via a non-streamed
// getResponse() at the end. Pure-text answer turns need no extra request.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutable usage sink. getResponse() adds each turn's tokens here so the route
 * layer can bill the whole run after it completes (the SDK's own `result.usage`
 * aggregates the same way, but reading our accumulator avoids coupling billing
 * to SDK internals).
 */
export interface UsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

export function createUsageAccumulator(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheCreation: 0 };
}

export interface GatewayModelOptions {
  provider: ProviderAdapter;
  /** Real upstream model name (already resolved from virtual_models / settings). */
  realModel: string;
  /** Accumulator shared across all turns of one run. */
  usage: UsageAccumulator;
}

export class GatewayModel implements Model {
  constructor(private readonly opts: GatewayModelOptions) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const internalReq = modelRequestToInternal(request, this.opts.realModel);
    const upstreamReq = this.opts.provider.transformRequest(internalReq);
    const upstreamRes = await this.opts.provider.send(upstreamReq);

    if (upstreamRes.status >= 400) {
      throw Errors.providerError(
        `分析模型上游错误 (${upstreamRes.status}): ${JSON.stringify(upstreamRes.body).slice(0, 500)}`,
      );
    }

    const internalRes = this.opts.provider.transformResponse(upstreamRes);

    // Accumulate per-turn usage into the shared sink. promptTokens is the NON-
    // cached input (Anthropic style, unified across providers by the pipeline);
    // cacheRead/cacheCreation are folded in for the gross input the SDK reports.
    this.opts.usage.promptTokens += internalRes.usage.promptTokens;
    this.opts.usage.completionTokens += internalRes.usage.completionTokens;
    this.opts.usage.cacheRead += internalRes.usage.cacheRead ?? 0;
    this.opts.usage.cacheCreation += internalRes.usage.cacheCreation ?? 0;

    return internalResToModelResponse(internalRes);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const internalReq = modelRequestToInternal(request, this.opts.realModel, true);
    const upstreamReq = this.opts.provider.transformRequest(internalReq);

    yield { type: 'response_started' };

    // Real streaming + single-phase authoritative output. Forward text deltas
    // token-by-token for progressive display (first-byte latency ≈ model TTFT),
    // AND assemble the authoritative output from the stream itself — text via
    // output_text.delta, each function_call via response.output_item.done (surfaced
    // as a tool_call chunk by transformStreamChunk). No non-streamed backfill, so
    // exactly one upstream request per turn. Reasoning deltas forward for display only.
    let sPrompt = 0;
    let sCompletion = 0;
    let sCacheRead = 0;
    let sCacheCreation = 0;
    let sawAnything = false;
    // Accumulators for the authoritative output built from stream chunks alone.
    let textBuf = '';
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    for await (const chunk of this.opts.provider.stream(upstreamReq)) {
      const ic = this.opts.provider.transformStreamChunk(chunk);
      if (!ic) continue;
      sawAnything = true;
      if (ic.type === 'content' && ic.content?.type === 'text') {
        textBuf += ic.content.text;
        yield { type: 'output_text_delta', delta: ic.content.text };
      } else if (ic.type === 'reasoning' && typeof ic.reasoning === 'string') {
        // Forward reasoning deltas via the SDK's {type:'model', event:any} escape
        // hatch (StreamEventGenericItem) — Runner re-emits it verbatim as a
        // raw_model_stream_event, which the analysis route recognises. Reasoning
        // is pure-display: never enters textBuf or the usage sink.
        yield { type: 'model', event: { type: 'reasoning_delta', delta: ic.reasoning } };
      } else if (ic.type === 'tool_call' && ic.toolCall) {
        // Collect complete function_call items (OpenAI's response.output_item.done)
        // to populate response_done.output below — the SDK Runner drives the tool
        // loop from these. The whole item arrives at once (no incremental arg
        // streaming needed), which is why no non-streamed backfill is required.
        toolCalls.push(ic.toolCall);
      } else if (ic.type === 'usage' && ic.usage) {
        // Overwrite (take latest non-zero): OpenAI response.completed gives the
        // full breakdown once; Anthropic splits input (message_start) / output
        // (message_delta). Accumulating would double-count re-emitted fields.
        if (ic.usage.promptTokens) {
          sPrompt = ic.usage.promptTokens;
          sCacheRead = ic.usage.cacheRead ?? sCacheRead;
          sCacheCreation = ic.usage.cacheCreation ?? sCacheCreation;
        }
        if (ic.usage.completionTokens) sCompletion = ic.usage.completionTokens;
      } else if (ic.type === 'stop') {
        if (ic.usage?.completionTokens) sCompletion = ic.usage.completionTokens;
      } else if (ic.type === 'error') {
        throw Errors.providerError(`分析模型流式错误: ${ic.error ?? '未知错误'}`);
      }
    }

    // Reachable now only when the upstream returned 200/SSE but every event was
    // unrecognized (none of output_text/reasoning/tool_call/completed). A non-2xx
    // response is already surfaced as a thrown error inside stream(), so this
    // guard no longer swallows the real cause — it only catches a 200 stream
    // whose shape OpenAIProvider.transformStreamChunk doesn't understand (e.g. a
    // new reasoning event format the provider hasn't been taught).
    if (!sawAnything) {
      throw Errors.providerError('分析模型流式响应为空：上游返回了流式响应但未识别到任何内容事件（output_text/reasoning/completed），可能模型输出格式不被兼容');
    }

    // Bill the streamed request's consumption — one upstream request per turn now
    // (no non-streamed backfill).
    this.opts.usage.promptTokens += sPrompt;
    this.opts.usage.completionTokens += sCompletion;
    this.opts.usage.cacheRead += sCacheRead;
    this.opts.usage.cacheCreation += sCacheCreation;

    // Single phase: the stream already carried every output item — text via
    // output_text.delta, each function_call via response.output_item.done (surfaced
    // as a tool_call chunk by transformStreamChunk). Assemble the authoritative
    // InternalResponse from the accumulated text + toolCalls and convert it to the
    // SDK's ModelResponse. The Runner drives the tool loop from function_call items
    // in response_done.output, so a tool turn yields those here directly — no second
    // non-streamed request, no double billing.
    const internalRes: InternalResponse = {
      id: newResponseId(),
      model: this.opts.realModel,
      content: [
        ...(textBuf ? [{ type: 'text' as const, text: textBuf }] : []),
        ...toolCalls.map((tc) => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
      ],
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        promptTokens: sPrompt,
        completionTokens: sCompletion,
        totalTokens: sPrompt + sCompletion,
        cacheRead: sCacheRead,
        cacheCreation: sCacheCreation,
      },
    };
    const finalResponse = internalResToModelResponse(internalRes);

    yield {
      type: 'response_done',
      response: {
        id: finalResponse.responseId ?? newResponseId(),
        usage: {
          inputTokens: finalResponse.usage.inputTokens,
          outputTokens: finalResponse.usage.outputTokens,
          totalTokens: finalResponse.usage.totalTokens,
        },
        output: finalResponse.output as ResponseDoneEvent['response']['output'],
      },
    };
  }
}

// NOTE on wiring: the SDK's `run(agent, input, options)` takes SharedRunOptions,
// which does NOT include `modelProvider`/`model`/`tracingDisabled` — those live on
// RunConfig and only take effect via `new Runner(config)`. The simplest reliable
// wiring is to attach the GatewayModel INSTANCE directly to `agent.model`. That
// bypasses model-name resolution entirely (which would otherwise fall back to the
// default OpenAI provider and demand OPENAI_API_KEY). buildAnalysisAgent pins a
// fresh instance per request, so a modelProvider abstraction is unnecessary.

// ── ModelRequest → InternalRequest ───────────────────────────────────────────

/**
 * Translate the SDK's ModelRequest into the gateway's InternalRequest. Only the
 * item shapes reachable in a data-analysis run are handled (messages,
 * function_call, function_call_result); computer/shell/apply_patch/tool_search/
 * reasoning are ignored (return null from inputItemToMessage). Tools become the
 * pipeline's Tool[] — the SDK already serialises Zod params to JSON Schema, which
 * is exactly what input_schema expects.
 */
export function modelRequestToInternal(request: ModelRequest, realModel: string, stream = false): InternalRequest {
  const messages: InternalMessage[] = [];

  if (request.systemInstructions) {
    messages.push({ role: 'system', content: [{ type: 'text', text: request.systemInstructions }] });
  }

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: request.input }] });
  } else if (Array.isArray(request.input)) {
    for (const item of request.input) {
      const msg = inputItemToMessage(item);
      if (msg) messages.push(msg);
    }
  }

  const tools = request.tools
    .filter((t): t is Extract<typeof t, { type: 'function' }> => t.type === 'function')
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

  const settings = request.modelSettings;
  // SDK's ModelSettings.reasoning (ModelSettingsReasoning: {effort?, summary?}).
  // Forwarded to the provider so OpenAI Responses can enable reasoning summary
  // streaming. Cast through a minimal shape — ModelSettings is a broad union.
  const reasoning = (settings as { reasoning?: { summary?: string; effort?: string } }).reasoning;
  return {
    model: realModel,
    messages,
    parameters: {
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      topP: settings.topP,
      tools: tools.length > 0 ? tools : undefined,
      stream,
      reasoning: reasoning
        ? {
            summary: reasoning.summary as 'auto' | 'concise' | 'detailed' | undefined,
            effort: reasoning.effort,
          }
        : undefined,
    },
  };
}

function inputItemToMessage(item: AgentInputItem): InternalMessage | null {
  // function_call: a prior assistant tool invocation (required-literal `type`).
  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: item.callId, name: item.name, input: safeJsonParse(item.arguments) },
      ],
    };
  }

  // function_call_result: the tool's output, fed back by the Runner.
  if (item.type === 'function_call_result') {
    return {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: item.callId, content: outputToText(item.output) }],
    };
  }

  // Message items are discriminated by `role` (their `type` field is optional
  // 'message' and may be absent), so check for role last.
  if ('role' in item) {
    return roleMessageToInternal(item);
  }

  return null;
}

function roleMessageToInternal(
  item: Extract<AgentInputItem, { role: string }>,
): InternalMessage {
  const role = item.role as InternalMessage['role'];
  const content = item.content;

  if (typeof content === 'string') {
    return { role, content: [{ type: 'text', text: content }] };
  }

  const blocks: ContentBlock[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    const t = part.type;
    if (t === 'input_text' || t === 'output_text' || t === 'text') {
      blocks.push({ type: 'text', text: String(part.text ?? '') });
    }
    // Images / files / audio are intentionally ignored — the analysis agent is
    // text-only and the underlying tools return JSON, never multimodal parts.
  }

  return { role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] };
}

// ── InternalResponse → ModelResponse ─────────────────────────────────────────

/**
 * Translate the gateway's InternalResponse into the SDK's ModelResponse. Text
 * blocks are grouped into one assistant message; each tool_use becomes a
 * function_call item. The SDK's Usage reports gross input (prompt + cacheRead)
 * so the Runner's aggregated total reflects true consumption; our own billing
 * reads the per-field accumulator, not this object.
 */
export function internalResToModelResponse(
  internalRes: ReturnType<ProviderAdapter['transformResponse']>,
): ModelResponse {
  // ModelResponse.output is the SDK's OUTPUT item union (assistant message +
  // function_call + ... — notably NOT user/system messages). Declaring the
  // accumulator as that precise type catches mismatched item shapes at the push
  // site instead of relying on a cast at return.
  const output: ModelResponse['output'] = [];

  const textParts: Array<{ type: 'output_text'; text: string }> = [];
  for (const block of internalRes.content) {
    if (block.type === 'text') {
      textParts.push({ type: 'output_text', text: block.text });
    }
  }
  if (textParts.length > 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: textParts,
    });
  }

  for (const block of internalRes.content) {
    if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        callId: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: 'completed',
      });
    }
  }

  const promptTokens = internalRes.usage.promptTokens;
  const cacheRead = internalRes.usage.cacheRead ?? 0;
  const completionTokens = internalRes.usage.completionTokens;
  const grossInput = promptTokens + cacheRead + (internalRes.usage.cacheCreation ?? 0);

  const usage = new Usage({
    inputTokens: grossInput,
    outputTokens: completionTokens,
    totalTokens: grossInput + completionTokens,
  });

  return {
    usage,
    output,
    responseId: internalRes.id,
  };
}

// The SDK's own types disagree on the output-item union width: ModelResponse
// types output as AgentOutputItem[] (broad — includes user/system message
// items), but StreamEventResponseCompleted.response.output is the narrower
// OutputModelItem[] (output items only). A ModelResponse's `.output` therefore
// carries the broad static type even when it only ever holds output items, so
// threading it into the response_done event needs a cast to the narrow type.
type ResponseDoneEvent = Extract<StreamEvent, { type: 'response_done' }>;

// ── small helpers ────────────────────────────────────────────────────────────

function safeJsonParse(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return '';
  }
}

function newResponseId(): string {
  return `resp_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
}
