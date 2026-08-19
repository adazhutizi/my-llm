import { getDb } from '../index.js';
import { systemSettings } from '../schema.js';
import { eq } from 'drizzle-orm';

// Keys used by this app. Centralised so readers/writers share the literal and a
// typo would surface as a reference error rather than a silent miss.
export const SETTING_KEYS = {
  // Retention (days) for request_details — the heavy request/response payload
  // table. Overrides config log.archive.maxAgeDays (the fallback default).
  logDetailsRetentionDays: 'log.detailsRetentionDays',
  // Retention (days) for request_logs — the lightweight list/stats table.
  // Overrides config log.archive.logsRetentionDays (the fallback default).
  logLogsRetentionDays: 'log.logsRetentionDays',
  // Log analysis: provider name + real model name used by the "AI 小结" feature
  // to summarise request logs (a 1M-window small model). Empty until the admin
  // configures it on the 系统设置 page; the summary endpoint refuses with 400
  // while unset.
  logAnalysisProvider: 'log.analysisProvider',
  logAnalysisModel: 'log.analysisModel',
  // 用户自定义的日志小结总结模板（system prompt）。空 / 未设置时，
  // generateLogSummary 回退到 DEFAULT_SUMMARY_PROMPT（services/log-summary.ts）。
  logAnalysisPromptTemplate: 'log.analysisPromptTemplate',
  // 智能分析 Agent（「智能分析」对话页）：provider + real model + system prompt。
  // 与日志分析三件套独立——Agent 需要 tool-capable 模型，且走 OpenAI Agents SDK
  // 桥接层（src/agents/）。空时「智能分析」页拒绝提问并提示去系统设置配置。
  analysisAgentProvider: 'analysis.agentProvider',
  analysisAgentModel: 'analysis.agentModel',
  analysisAgentSystemPrompt: 'analysis.agentSystemPrompt',
  // Whether the analysis agent enables reasoning summary streaming (o-series /
  // gpt-5). Default 'true'; only the literal 'false' disables it. Non-reasoning
  // models error when reasoning is sent, so the admin can opt out on 系统设置.
  analysisAgentReasoningEnabled: 'analysis.agentReasoningEnabled',
} as const;

/**
 * Read a numeric system setting by key. Returns `fallback` when the key is
 * absent or the stored value is not a finite number — so callers (e.g.
 * runLogArchive) always get a usable value even on a fresh DB before the admin
 * has saved anything.
 */
export async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read a string system setting by key. Returns `fallback` when the key is
 * absent. Used by the log-analysis feature to pick up the configured provider
 * and model name.
 */
export async function getStringSetting(key: string, fallback: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return row?.value ?? fallback;
}

/**
 * Read all settings as a key→string map in one query (used by the admin
 * settings page to populate the form without a round-trip per key).
 */
export async function getAllSettings(): Promise<Record<string, string>> {
  const db = getDb();
  const rows = await db
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * Upsert a setting by key (select-then-update-or-insert, same shape as the
 * rate-limits PUT handler). Values are stored as strings — callers stringify.
 */
export async function setSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  const [existing] = await db
    .select({ id: systemSettings.id })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  if (existing) {
    await db.update(systemSettings).set({ value }).where(eq(systemSettings.id, existing.id));
  } else {
    await db.insert(systemSettings).values({ key, value });
  }
}
