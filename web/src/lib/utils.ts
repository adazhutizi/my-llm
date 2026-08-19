import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a date/time value for display (date + time), fixed to Beijing time.
 * Backend timestamps arrive as UTC ISO strings (with trailing 'Z'); parse as
 * UTC and render in Asia/Shanghai regardless of the viewer's browser timezone
 * (the dashboard is a Beijing-time admin console). Do NOT strip the 'Z' —
 * that was a workaround for the old UTC container and skews 8h. */
export function formatDateTime(value: string | Date | number | undefined | null): string {
  if (!value) return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** Format a date/time value for display (date only). See formatDateTime. */
export function formatDate(value: string | Date | number | undefined | null): string {
  if (!value) return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// ── Token quota unit helpers ──────────────────────────────────────────────
// Quota inputs are entered in "millions" (M) for friendliness; the backend
// still stores the raw token count. 1M = 1,000,000 tokens.

/** Raw token count → "millions" string for filling an input (e.g. 1,500,000 → "1.5"). */
export function tokensToMillions(tokens: number): string {
  const m = tokens / 1_000_000;
  // toFixed(6) keeps per-token precision (0.000001M); Number() trims trailing zeros.
  return String(Number(m.toFixed(6)));
}

/** "Millions" string → raw token count. Returns null when empty/invalid (= no limit). */
export function millionsToTokens(value: string): number | null {
  if (!value.trim()) return null;
  const m = parseFloat(value);
  return isNaN(m) ? null : Math.round(m * 1_000_000);
}

// ── Beijing-day (UTC+8) date helpers ──────────────────────────────────────
// usage_records.record_time is stored as a UTC wall-clock literal (drizzle
// serializes Date params to UTC for the datetime column), and quota "today"
// is defined by the backend getDayStart() in Beijing time. Dashboard "today"
// stats must use the SAME Beijing-day boundary, otherwise requests made
// 00:00–08:00 CST get counted as yesterday. This helper mirrors the backend
// getDayStart() exactly and ignores the browser's local timezone.

/** Start of the current Beijing day (00:00 CST) as a UTC Date. */
export function beijingTodayStart(): Date {
  const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
  const bj = new Date(Date.now() + BJ_OFFSET_MS); // wall-clock in Beijing
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BJ_OFFSET_MS);
}

// ── Beijing wall-clock formatters ─────────────────────────────────────────
// Default date-range inputs on the logs / usage pages are submitted to the
// backend as naive 'YYYY-MM-DDTHH:mm' strings, parsed there via new Date() in
// the process timezone (Asia/Shanghai, +0800). So the defaults must be Beijing
// wall-clock strings (not the browser's local wall-clock), built from a UTC
// instant by shifting +8h then reading UTC fields — independent of the
// browser's timezone. The backend then converts to a UTC literal
// (formatUtcDateTime) bound against its UTC-pinned session.

/** Format a UTC instant as a Beijing wall-clock datetime-local string (YYYY-MM-DDTHH:mm). */
export function toBeijingDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}T${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

/** Format a UTC instant as a Beijing wall-clock date string (YYYY-MM-DD). */
export function toBeijingDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`;
}

// ── Relative time (analysis session list) ─────────────────────────────────
// Used under each session title in the /analysis sidebar. Mirrors the backend
// Beijing-day boundary (pure UTC+8 shift, like toBeijingDate above) so a
// session updated 00:00–08:00 CST still reads as "today". Browser timezone
// independent. Bands:
//   today     → HH:mm
//   yesterday → 昨天 HH:mm
//   2–6 days  → N天前
//   ≥ 7 days  → M月D日
export function formatRelativeTime(iso: string): string {
  const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');

  // Beijing wall-clock fields for the timestamp and for "now".
  const bjD = new Date(d.getTime() + BJ_OFFSET_MS);
  const bjNow = new Date(Date.now() + BJ_OFFSET_MS);
  const hh = pad(bjD.getUTCHours());
  const mm = pad(bjD.getUTCMinutes());

  // Calendar-day delta in Beijing time. Both instants are floored to their
  // Beijing midnight (UTC ms), so the difference is an exact multiple of 24h.
  const dayD = Date.UTC(bjD.getUTCFullYear(), bjD.getUTCMonth(), bjD.getUTCDate());
  const dayNow = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate());
  const dayDiff = Math.round((dayNow - dayD) / 86_400_000);

  if (dayDiff <= 0) return `${hh}:${mm}`; // today (negative = clock skew, treat as today)
  if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
  if (dayDiff <= 6) return `${dayDiff}天前`;
  return `${bjD.getUTCMonth() + 1}月${bjD.getUTCDate()}日`;
}

// ── UUID v4（非安全上下文安全）─────────────────────────────────────────────
// crypto.randomUUID() 受安全上下文门控（仅 HTTPS 或 localhost 可用）。通过
// 普通 http + 局域网/服务器 IP 打开后台时它是 undefined，调用即抛
// "crypto.randomUUID is not a function"——曾导致 /analysis 创建会话即崩。
// crypto.getRandomValues() 不受安全上下文限制，用它手搓 RFC 4122 v4 UUID 作
// 回退。仅用于客户端 ID（如 analysis 会话 id），非密钥。
export function createUUID(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
  }
  // 连 WebCrypto 都没有的极老环境的最后兜底。
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
