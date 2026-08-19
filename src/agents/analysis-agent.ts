import { Agent } from '@openai/agents';
import { GatewayModel, createUsageAccumulator, type UsageAccumulator } from './gateway-model.js';
import { buildAnalysisTools } from './analysis-tools.js';
import type { ProviderAdapter } from '../providers/base.js';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis agent assembly.
//
// Built fresh per request (buildAnalysisAgent is cheap): it reads the live
// provider/model/system-prompt from 系统设置, constructs a GatewayModel pinned to
// the resolved provider, and attaches it DIRECTLY to agent.model. We do NOT pass
// a modelProvider via run() options — SharedRunOptions doesn't include it (only
// RunConfig does, via `new Runner(config)`), so the reliable wiring is the
// instance on the agent. See gateway-model.ts wiring note.
//
// The UsageAccumulator is returned alongside the agent so the route layer can
// read the cross-turn totals for billing once the run completes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in default system prompt for the analysis agent. Exported so the admin
 * settings DTO can surface it read-only + power a "恢复默认" button, and used as
 * the fallback when the admin has not saved a custom prompt (or saved a blank /
 * whitespace-only one). Mirrors DEFAULT_SUMMARY_PROMPT in log-summary.ts.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = `你是本 LLM 网关的运营数据分析助手。用户（网关管理员）会用中文向你提问关于网关自身运营数据的问题，例如 token 用量、请求数、错误率、按模型 / 服务商 / 用户 / 应用维度的分布等。

工作方式：
1. 不确定有哪些可选维度时，先用 list_dimensions 查看当前网关中出现过的模型与服务商；
2. 根据问题选择合适的查询工具：get_usage_overview 做汇总、get_usage_trends 做时间序列、get_usage_by_model 做模型维度 Top；
3. 这些专用工具覆盖不到时，先用 list_queryable_tables 了解可查询的表与列，再用 query_table 做自定义查询（选表 / 列 / 筛选 / 分组 / 排序）；需要跨表关联时 query_table 支持 INNER/LEFT JOIN，关联路径调用 list_queryable_tables 查看（joinPaths 列出的才是白名单允许的关联），JOIN 时每个列都要指定所属表（形如 { table, column }）；
4. 用中文回答。数据较多时用 Markdown 表格呈现，关键数字用 **加粗**。
5. 当数据适合可视化时，可用 Mermaid 图表呈现——在回答中输出以 mermaid 为语言标记的围栏代码块（fenced code block），常用 pie（饼图，适合各模型 / 服务商的 token 占比）、flowchart（流程 / 结构关系，如请求链路）、sequenceDiagram（时序图）。能用文字或表格简洁说清时优先用文字 / 表格，不要为画图而画图；注意 token 数值是累计绝对值，饼图比例应基于所选维度的 token 总量计算。

注意事项：
- 工具的时间参数请传 ISO 8601 UTC 字符串（例如 2025-06-01T00:00:00Z）；用户说的“最近 N 天”指从当前时刻往前推 N 天；
- 返回的 token 数值均为累计绝对值（已含缓存读取 / 写入），单位是 token；
- query_table 的敏感字段（API 密钥、上游 key、请求 / 响应头、客户端 IP 等）会被工具直接拒绝查询，不要反复尝试；若用户索要这些内容，请说明属于敏感数据、无法提供；
- 若工具返回 { error: ... }，请如实告诉用户查询失败的原因，不要编造数据；
- 回答聚焦用户问题，简洁明了。`;

export interface BuildAnalysisAgentOptions {
  provider: ProviderAdapter;
  /** Real upstream model name (resolved from 系统设置 by the route). */
  realModel: string;
  /** System prompt; falls back to DEFAULT_AGENT_SYSTEM_PROMPT when blank. */
  systemPrompt?: string;
  /** Enable reasoning summary streaming (Agent.modelSettings.reasoning.summary).
   * Only valid for reasoning models (o-series / gpt-5); non-reasoning models
   * reject the reasoning param. Default true (opt-out via 系统设置). */
  reasoningEnabled?: boolean;
}

export interface BuiltAnalysisAgent {
  agent: Agent;
  usage: UsageAccumulator;
}

export function buildAnalysisAgent(opts: BuildAnalysisAgentOptions): BuiltAnalysisAgent {
  const usage = createUsageAccumulator();
  const model = new GatewayModel({
    provider: opts.provider,
    realModel: opts.realModel,
    usage,
  });
  const instructions =
    (opts.systemPrompt ?? '').trim() || DEFAULT_AGENT_SYSTEM_PROMPT;

  const agent = new Agent({
    name: 'gateway-analysis',
    instructions,
    model,
    tools: buildAnalysisTools(),
    // {summary:'auto'} makes reasoning models stream reasoning summary deltas
    // (response.reasoning_summary_text.delta), surfaced to the UI via the
    // {type:'model'} StreamEvent escape hatch. effort left to the model default.
    modelSettings: opts.reasoningEnabled === false ? undefined : { reasoning: { summary: 'auto' } },
  });

  return { agent, usage };
}
