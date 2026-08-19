import { v4 as uuidv4 } from 'uuid';
import type { Context } from 'hono';
import { getDb } from '../db/index.js';
import { requestLogs, requestDetails } from '../db/schema.js';
import { trackUsage } from '../middleware/usage-track.js';
import { getClientIp } from '../middleware/request-log.js';
import type { UsageData } from '../middleware/usage-track.js';
import type { AuthContext } from '../middleware/auth.js';
import { ensureAdminKeyId } from './log-summary.js';
import { getLogger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Billing for the "智能分析" agent page.
//
// Mirrors accountAnalysisCall in log-summary.ts: bill the run to the shared
// admin key with feature_id=gateway-analysis so the feature-usage page isolates
// analysis cost from real traffic. trackUsage is reused for usage_records; the
// request_logs/request_details rows are written by hand (NOT via
// persistRequestLog) so we can NULL request_headers — the call is triggered by
// an admin JWT, and persisting the raw Authorization header would leak that JWT
// into request_details. See CLAUDE.md "明文 apiKey" / log-summary notes.
// ─────────────────────────────────────────────────────────────────────────────

export const GATEWAY_ANALYSIS_FEATURE_ID = 'gateway-analysis';

// Cap the persisted finalOutput so a runaway agent answer doesn't bloat
// request_details (which already struggles with size — see log-archive notes).
const MAX_PERSISTED_OUTPUT_CHARS = 16 * 1024;

export interface GatewayAnalysisBillingArgs {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Stable id for this conversation turn (echoed in meta, used to group rows). */
  conversationId: string;
  /** Concatenated assistant text across all message_output_created events. */
  finalOutput: string;
  /** Number of upstream model turns (result.rawResponses.length). */
  modelCalls: number;
  startTime: number;
}

export async function accountGatewayAnalysisCall(
  c: Context,
  args: GatewayAnalysisBillingArgs,
): Promise<void> {
  const adminKeyId = await ensureAdminKeyId();

  const usage: UsageData = {
    model: args.model,
    provider: args.provider,
    promptTokens: args.promptTokens,
    completionTokens: args.completionTokens,
    cacheReadTokens: args.cacheReadTokens,
    cacheCreationTokens: args.cacheCreationTokens,
    isError: false,
  };

  // trackUsage reads c.get('auth'); install a synthetic admin-key context for it.
  const syntheticAuth: AuthContext = {
    mode: 'admin',
    keyId: adminKeyId,
    authMethod: 'api_key',
    featureId: GATEWAY_ANALYSIS_FEATURE_ID,
  };
  c.set('auth', syntheticAuth);

  const analysisRequestId = uuidv4();
  const latencyMs = Date.now() - args.startTime;
  const truncatedOutput =
    args.finalOutput.length > MAX_PERSISTED_OUTPUT_CHARS
      ? args.finalOutput.slice(0, MAX_PERSISTED_OUTPUT_CHARS) + '…[截断]'
      : args.finalOutput;

  try {
    await trackUsage(c, usage);

    const db = getDb();
    await db.insert(requestLogs).values({
      requestId: analysisRequestId,
      apiKeyId: adminKeyId,
      appId: null,
      userId: null,
      appUserId: null,
      featureId: GATEWAY_ANALYSIS_FEATURE_ID,
      model: args.model,
      provider: args.provider,
      statusCode: 200,
      latencyMs,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      cacheReadTokens: args.cacheReadTokens,
      cacheCreationTokens: args.cacheCreationTokens,
      isStream: true,
      errorMessage: null,
    });
    await db.insert(requestDetails).values({
      requestId: analysisRequestId,
      apiKeyId: adminKeyId,
      requestMethod: c.req.method,
      requestPath: c.req.path,
      // NULL on purpose: c.req.raw.headers carries the admin JWT (Authorization),
      // which must not be persisted. The conversation anchor is in requestBody.
      requestHeaders: null,
      requestBody: {
        type: 'gateway-analysis',
        conversationId: args.conversationId,
        modelCalls: args.modelCalls,
      },
      responseStatus: 200,
      responseHeaders: null,
      responseBody: { finalOutput: truncatedOutput },
      streamChunks: null,
      streamChunkCount: null,
      clientIp: getClientIp(c),
      userAgent: c.req.header('user-agent') || null,
      latencyMs,
    });
  } catch (err) {
    // Billing failure must not fail the user-facing answer (already streamed).
    getLogger().error({ err }, 'gateway-analysis: failed to account call');
  }
}
