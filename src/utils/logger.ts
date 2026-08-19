import pino from 'pino';
import { getConfig } from '../config/index.js';

// 日志时间戳渲染为北京时间（Asia/Shanghai, UTC+8）壁钟字符串。pino 默认的 time
// 字段是 Unix 毫秒时间戳（数字），生产 JSON 输出形如 "time":1719000000000，对人
// 不可读；这里统一输出 "YYYY-MM-DD HH:mm:ss"，dev（pino-pretty）与生产（JSON）一致，
// 无需外部工具转换。用 Intl.DateTimeFormat 按时区取各部分再拼接，不依赖具体 locale
// 的字面量格式（不同 locale 的时间分隔符不同，硬编码 locale 脆弱）。
function beijingTimestamp(date: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

let logger: pino.Logger | null = null;

export function createLogger(name?: string): pino.Logger {
  const config = getConfig();

  const baseLogger = logger || pino({
    level: config.log.level,
    // 用北京时间字符串覆盖默认的毫秒时间戳；pino 的 timestamp 钩子返回值原样拼入
    // JSON 流，故需自带 "time" 键名与引号。
    timestamp: () => `,"time":"${beijingTimestamp()}"`,
    // 把 level 从数字编码（30/40/50…）替换为字符串标签（info/warn/error…），生产
    // JSON 输出更直观；dev 走 pino-pretty 本就渲染彩色 INFO/WARN，不受影响。
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    transport: config.nodeEnv === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
  });

  if (!logger) logger = baseLogger;

  return name ? baseLogger.child({ name }) : baseLogger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    throw new Error('Logger not initialized. Call createLogger() first.');
  }
  return logger;
}

// Request-scoped logger with context
export function createRequestLogger(
  requestId: string,
  context?: Record<string, unknown>
): pino.Logger {
  return getLogger().child({ requestId, ...context });
}
