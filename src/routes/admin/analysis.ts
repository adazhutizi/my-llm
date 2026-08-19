import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@openai/agents';
import type { AgentInputItem, RunItem, RunItemStreamEvent } from '@openai/agents';
import { getStringSetting, SETTING_KEYS } from '../../db/repositories/settings.js';
import { getProviderConfig, createProvider } from '../../services/model-router.js';
import { buildAnalysisAgent, DEFAULT_AGENT_SYSTEM_PROMPT } from '../../agents/analysis-agent.js';
import type { UsageAccumulator } from '../../agents/gateway-model.js';
import {
  accountGatewayAnalysisCall,
  GATEWAY_ANALYSIS_FEATURE_ID,
} from '../../services/agent-billing.js';
import { getLogger } from '../../utils/logger.js';

export const adminAnalysis = new Hono();

// Cap the agent loop. After the strict:false + cleanInt fix (see
// analysis-tools.ts) a simple data-analysis answer completes in 1-2 tool
// round-trips, but multi-step exploration (list → query → refine → join →
// re-query) legitimately needs more. 12 covers a couple of refine cycles while
// still bounding the double-upstream-request cost per turn (gateway-model.ts
// two-phase: streaming + non-streaming backfill).
const MAX_TURNS = 12;
// Bound the replayed history so a long session can't push the request past the
// model window. The frontend keeps the full local history; we only send the tail.
const MAX_HISTORY = 20;
// Cap the tool-output summary we stream to the UI. The model still receives the
// full tool result (the Runner injects it internally); this only limits the SSE
// card so a huge query result doesn't flood the browser.
const TOOL_SUMMARY_MAX_CHARS = 2000;

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── GET /config — current Agent configuration for the frontend ───────────────
adminAnalysis.get('/config', async (c) => {
  const provider = await getStringSetting(SETTING_KEYS.analysisAgentProvider, '');
  const model = await getStringSetting(SETTING_KEYS.analysisAgentModel, '');
  const systemPrompt = await getStringSetting(SETTING_KEYS.analysisAgentSystemPrompt, '');
  const reasoningEnabled =
    (await getStringSetting(SETTING_KEYS.analysisAgentReasoningEnabled, 'true')) !== 'false';
  return c.json({
    data: {
      provider,
      model,
      // Effective prompt (saved custom or '' when never saved) + the built-in
      // default, mirroring the log-analysis DTO shape (analysisPromptTemplate +
      // analysisPromptTemplateDefault) so the settings card can reuse the pattern.
      systemPrompt,
      systemPromptDefault: DEFAULT_AGENT_SYSTEM_PROMPT,
      reasoningEnabled,
      featureId: GATEWAY_ANALYSIS_FEATURE_ID,
    },
  });
});

// ── POST /chat — streaming agent conversation (SSE) ──────────────────────────
adminAnalysis.post('/chat', async (c) => {
  let body: { message?: unknown; history?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return c.json({ error: 'message 不能为空' }, 400);
  }

  // Normalise history: keep only valid user/assistant string turns, newest tail.
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: HistoryMessage[] = [];
  for (const m of rawHistory) {
    if (
      m &&
      typeof m === 'object' &&
      (m as { role?: string }).role === 'user' &&
      typeof (m as { content?: unknown }).content === 'string'
    ) {
      history.push({ role: 'user', content: (m as { content: string }).content });
    } else if (
      m &&
      typeof m === 'object' &&
      (m as { role?: string }).role === 'assistant' &&
      typeof (m as { content?: unknown }).content === 'string'
    ) {
      history.push({ role: 'assistant', content: (m as { content: string }).content });
    }
  }
  const trimmedHistory = history.slice(-MAX_HISTORY);

  // Resolve the configured analysis agent model + prompt (set on 系统设置).
  const providerName = await getStringSetting(SETTING_KEYS.analysisAgentProvider, '');
  const realModel = await getStringSetting(SETTING_KEYS.analysisAgentModel, '');
  if (!providerName || !realModel) {
    return c.json(
      { error: '未配置智能分析 Agent 模型，请先在系统设置中选择服务商与模型' },
      400,
    );
  }
  const systemPrompt = await getStringSetting(SETTING_KEYS.analysisAgentSystemPrompt, '');
  // Default true: only the literal 'false' disables reasoning summary streaming.
  const reasoningEnabled =
    (await getStringSetting(SETTING_KEYS.analysisAgentReasoningEnabled, 'true')) !== 'false';

  const startTime = Date.now();
  const conversationId = uuidv4();

  return streamSSE(c, async (stream) => {
    const emit = async (event: string, data: unknown): Promise<void> => {
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    };

    await emit('meta', { conversationId, model: realModel, provider: providerName });

    // Bill exactly once per request, even if the run errors mid-way (tokens may
    // already have been spent). `billed` guards against the double-bill path
    // where both the run catch and a later error fire.
    let billed = false;
    let finalOutput = '';
    let modelCalls = 0;
    // Capture usage outside the try so the catch can still bill partial consumption.
    let usageAcc: UsageAccumulator | null = null;

    const bill = async (isError: boolean): Promise<void> => {
      if (billed) return;
      billed = true;
      // UsageAccumulator uses cacheRead/cacheCreation; the billing args + UsageData
      // use cacheReadTokens/cacheCreationTokens — map here.
      const u = usageAcc ?? { promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheCreation: 0 };
      // isError rows still record usage if any tokens were spent; accountGatewayAnalysisCall
      // always writes a row so the feature-usage page reflects the attempt.
      await accountGatewayAnalysisCall(c, {
        model: realModel,
        provider: providerName,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        cacheReadTokens: u.cacheRead,
        cacheCreationTokens: u.cacheCreation,
        conversationId,
        finalOutput: isError ? '' : finalOutput,
        modelCalls,
        startTime,
      }).catch((err) => getLogger().error({ err }, 'analysis: billing threw'));
    };

    // SSE 心跳:Agent 跑 tool 调用、GatewayModel 的非流式 backfill、模型切换的轮次
    // 间,这条流会有数十秒无数据的静默期。生产 k8s ingress(nginx 默认
    // proxy_read_timeout 60s)会把这种空闲 SSE 当僵尸切断,前端 reader.read() 随即
    // 抛 TypeError(显示为 "network error")。定期发一个 SSE 注释帧(: 开头)保活——
    // 注释帧不含 event:/data:,前端 parseSSEFrame 会忽略,不产生任何 UI 事件。
    const heartbeat = setInterval(() => {
      if (stream.aborted) return;
      void stream.write(': ping\n\n').catch(() => {
        /* 连接已断,write 失败无碍——run 的 catch / finally 会收尾 */
      });
    }, 15_000);

    try {
      const providerCfg = await getProviderConfig(providerName);
      const provider = createProvider(providerName, providerCfg, providerCfg.apiType);
      const { agent, usage } = buildAnalysisAgent({ provider, realModel, systemPrompt, reasoningEnabled });
      usageAcc = usage;

      // Build the SDK input: replay history as message items, then the new turn.
      // UserMessageItem.content accepts a plain string, so no need to wrap in
      // input_text parts.
      const input: AgentInputItem[] = trimmedHistory.map((m) => ({
        type: 'message',
        role: m.role,
        content: m.content,
      })) as AgentInputItem[];
      input.push({ type: 'message', role: 'user', content: message } as AgentInputItem);

      const result = await run(agent, input, { stream: true, maxTurns: MAX_TURNS });

      for await (const event of result) {
        if (event.type === 'raw_model_stream_event') {
          // Real streaming: forward per-token text deltas as soon as the model
          // emits them. The SDK wraps each StreamEvent from our GatewayModel
          // here; only output_text_delta carries text the UI needs.
          const se = (
            event as { data: { type: string; delta?: unknown; event?: { type?: string; delta?: unknown } } }
          ).data;
          if (se.type === 'output_text_delta' && typeof se.delta === 'string') {
            finalOutput += se.delta;
            await emit('text_delta', { delta: se.delta });
          } else if (
            se.type === 'model' &&
            se.event?.type === 'reasoning_delta' &&
            typeof se.event.delta === 'string'
          ) {
            // Reasoning deltas arrive via the SDK's {type:'model', event} escape
            // hatch (GatewayModel yields them). Forward as their own SSE event so
            // the frontend renders a collapsible "思考过程" card.
            await emit('reasoning_delta', { delta: se.event.delta });
          }
        } else if (event.type === 'run_item_stream_event') {
          const rie = event as RunItemStreamEvent;
          const item = rie.item;
          if (rie.name === 'tool_called') {
            const { callId, toolName, args } = extractToolCall(item);
            await emit('tool_started', { callId, toolName, args });
          } else if (rie.name === 'tool_output') {
            const { callId, summary, truncated } = extractToolOutput(item);
            await emit('tool_result', { callId, summary, truncated });
          }
          // message_output_created is intentionally NOT forwarded as text_delta:
          // its text is exactly the concatenation of the output_text_delta events
          // we already streamed token-by-token above, so forwarding both would
          // duplicate every character. tool_called/tool_output are the only
          // run_item events we surface (tool cards in the UI).
        }
      }

      modelCalls = result.rawResponses.length;

      await emit('done', {
        usage,
        modelCalls,
        durationMs: Date.now() - startTime,
      });
      await bill(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Agent 运行失败';
      getLogger().error({ err, conversationId }, 'analysis: agent run failed');
      await emit('error', { message: msg }).catch(() => void 0);
      await bill(true);
    } finally {
      clearInterval(heartbeat);
    }
  });
});

// ── RunItem field extractors ─────────────────────────────────────────────────
// RunItem is a broad class union; narrowing it per subclass pulls in the giant
// rawItem unions and fights the type checker. Each item class exposes simple
// getters (toolName/callId), so we cast through a minimal shape.

function extractToolCall(item: RunItem): { callId: string; toolName: string; args: string } {
  const ri = (item as { rawItem?: { callId?: string; name?: string; arguments?: string } }).rawItem ?? {};
  const callId = asString(readGetter(item, 'callId')) || ri.callId || '';
  const toolName = asString(readGetter(item, 'toolName')) || ri.name || '';
  const args = ri.arguments ?? '';
  return { callId, toolName, args };
}

function extractToolOutput(item: RunItem): {
  callId: string;
  summary: string;
  truncated: boolean;
} {
  const callId = asString(readGetter(item, 'callId'));
  const rawOutput = (item as { output?: unknown }).output;
  const full = typeof rawOutput === 'string' ? rawOutput : safeStringify(rawOutput);
  const truncated = full.length > TOOL_SUMMARY_MAX_CHARS;
  return {
    callId,
    summary: truncated ? full.slice(0, TOOL_SUMMARY_MAX_CHARS) + '…' : full,
    truncated,
  };
}

// Read a getter that may or may not exist on the given RunItem subclass without
// triggering a union-narrow error. Returns undefined when the property is absent
// or holds a non-string value (the getters we read all return string|undefined).
function readGetter(item: RunItem, name: 'callId' | 'toolName'): unknown {
  // Cast through unknown: RunItem is a class union with no shared index
  // signature, so a direct `as Record<string, unknown>` is rejected by TS.
  const v = (item as unknown as Record<string, unknown>)[name];
  return typeof v === 'function' ? undefined : v;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function safeStringify(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
