import { Hono } from 'hono';
import { getConfig } from '../../config/index.js';
import { getAllSettings, setSetting, SETTING_KEYS } from '../../db/repositories/settings.js';
import { ensureAdminKeyId, DEFAULT_SUMMARY_PROMPT } from '../../services/log-summary.js';
import { DEFAULT_AGENT_SYSTEM_PROMPT } from '../../agents/analysis-agent.js';
import { getLogger } from '../../utils/logger.js';

export const adminSettings = new Hono();

// Build the settings DTO from the raw key→value map, falling back to the
// config defaults when a key has not been saved yet. Shared by GET/PUT so a
// write returns the same shape the page loaded, reflecting saved values.
function settingsDto(all: Record<string, string>): {
  detailsRetentionDays: number;
  logsRetentionDays: number;
  analysisProvider: string;
  analysisModel: string;
  // Admin's custom summary template (raw saved value; '' when never saved).
  analysisPromptTemplate: string;
  // The built-in default template (always DEFAULT_SUMMARY_PROMPT) — read-only
  // reference for the UI and the "恢复默认" button.
  analysisPromptTemplateDefault: string;
  // 智能分析 Agent (separate from log-analysis — needs a tool-capable model).
  analysisAgentProvider: string;
  analysisAgentModel: string;
  analysisAgentSystemPrompt: string;
  analysisAgentSystemPromptDefault: string;
  analysisAgentReasoningEnabled: boolean;
} {
  const cfg = getConfig().log.archive;
  const d = all[SETTING_KEYS.logDetailsRetentionDays];
  const l = all[SETTING_KEYS.logLogsRetentionDays];
  return {
    detailsRetentionDays: d != null && Number.isFinite(Number(d)) ? Number(d) : cfg.maxAgeDays,
    logsRetentionDays: l != null && Number.isFinite(Number(l)) ? Number(l) : cfg.logsRetentionDays,
    analysisProvider: all[SETTING_KEYS.logAnalysisProvider] ?? '',
    analysisModel: all[SETTING_KEYS.logAnalysisModel] ?? '',
    analysisPromptTemplate: all[SETTING_KEYS.logAnalysisPromptTemplate] ?? '',
    analysisPromptTemplateDefault: DEFAULT_SUMMARY_PROMPT,
    analysisAgentProvider: all[SETTING_KEYS.analysisAgentProvider] ?? '',
    analysisAgentModel: all[SETTING_KEYS.analysisAgentModel] ?? '',
    analysisAgentSystemPrompt: all[SETTING_KEYS.analysisAgentSystemPrompt] ?? '',
    analysisAgentSystemPromptDefault: DEFAULT_AGENT_SYSTEM_PROMPT,
    // Default true: only the literal 'false' disables reasoning streaming.
    analysisAgentReasoningEnabled: all[SETTING_KEYS.analysisAgentReasoningEnabled] !== 'false',
  };
}

// GET /admin/settings - runtime-configurable system settings (log retention +
// log-analysis model). Returns a focused DTO.
adminSettings.get('/', async (c) => {
  const all = await getAllSettings();
  return c.json({ data: settingsDto(all) });
});

// PUT /admin/settings - update settings. Partial body is fine — only the
// provided fields are written; retention days must be positive integers when
// present, analysis fields are trimmed strings.
adminSettings.put('/', async (c) => {
  let body: {
    detailsRetentionDays?: number;
    logsRetentionDays?: number;
    analysisProvider?: string;
    analysisModel?: string;
    analysisPromptTemplate?: string;
    analysisAgentProvider?: string;
    analysisAgentModel?: string;
    analysisAgentSystemPrompt?: string;
    analysisAgentReasoningEnabled?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const writes: { key: string; value: string }[] = [];

  if (body.detailsRetentionDays !== undefined) {
    const n = Number(body.detailsRetentionDays);
    if (!Number.isInteger(n) || n <= 0) {
      return c.json({ error: 'detailsRetentionDays must be a positive integer' }, 400);
    }
    writes.push({ key: SETTING_KEYS.logDetailsRetentionDays, value: String(n) });
  }
  if (body.logsRetentionDays !== undefined) {
    const n = Number(body.logsRetentionDays);
    if (!Number.isInteger(n) || n <= 0) {
      return c.json({ error: 'logsRetentionDays must be a positive integer' }, 400);
    }
    writes.push({ key: SETTING_KEYS.logLogsRetentionDays, value: String(n) });
  }
  if (body.analysisProvider !== undefined) {
    writes.push({ key: SETTING_KEYS.logAnalysisProvider, value: String(body.analysisProvider).trim() });
  }
  if (body.analysisModel !== undefined) {
    writes.push({ key: SETTING_KEYS.logAnalysisModel, value: String(body.analysisModel).trim() });
  }
  if (body.analysisPromptTemplate !== undefined) {
    // No trim: a multi-line template may intentionally have leading/trailing
    // blank lines. Blank/whitespace-only values fall back to DEFAULT in
    // generateLogSummary (`tpl.trim() || DEFAULT`).
    writes.push({ key: SETTING_KEYS.logAnalysisPromptTemplate, value: String(body.analysisPromptTemplate) });
  }
  if (body.analysisAgentProvider !== undefined) {
    writes.push({
      key: SETTING_KEYS.analysisAgentProvider,
      value: String(body.analysisAgentProvider).trim(),
    });
  }
  if (body.analysisAgentModel !== undefined) {
    writes.push({
      key: SETTING_KEYS.analysisAgentModel,
      value: String(body.analysisAgentModel).trim(),
    });
  }
  if (body.analysisAgentSystemPrompt !== undefined) {
    // No trim, same rationale as analysisPromptTemplate above. buildAnalysisAgent
    // falls back to DEFAULT_AGENT_SYSTEM_PROMPT when the saved value is blank.
    writes.push({
      key: SETTING_KEYS.analysisAgentSystemPrompt,
      value: String(body.analysisAgentSystemPrompt),
    });
  }
  if (body.analysisAgentReasoningEnabled !== undefined) {
    // Stored as 'true'/'false'. Does NOT trigger ensureAdminKeyId — only the
    // provider/model fields do (reasoning is a display toggle, not a billing key).
    writes.push({
      key: SETTING_KEYS.analysisAgentReasoningEnabled,
      value: String(body.analysisAgentReasoningEnabled === true),
    });
  }

  for (const w of writes) {
    await setSetting(w.key, w.value);
  }

  // When the admin configures the log-analysis model, ensure an admin key
  // exists to bill analysis calls to — auto-create one if missing so production
  // never needs a manual `pnpm db:seed`. Idempotent; failure is non-fatal (the
  // summary endpoint re-ensures on demand). The 智能分析 Agent shares the same
  // billing anchor (ensureAdminKeyId reuses any active admin key), so configuring
  // its provider/model triggers the same ensure.
  if (
    body.analysisProvider !== undefined ||
    body.analysisModel !== undefined ||
    body.analysisAgentProvider !== undefined ||
    body.analysisAgentModel !== undefined
  ) {
    try {
      await ensureAdminKeyId();
    } catch (err) {
      getLogger().error({ err }, 'settings: failed to ensure admin billing key for analysis');
    }
  }

  // Re-read so the response reflects whatever was saved (and defaults for the
  // rest), in the same shape the page loaded.
  const all = await getAllSettings();
  return c.json({ data: settingsDto(all) });
});
