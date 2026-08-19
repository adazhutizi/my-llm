'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/chat/markdown';
import { ToolCard } from '@/components/chat/tool-card';
import { ReasoningCard } from '@/components/chat/reasoning-card';
import { SessionSidebar } from '@/components/chat/session-sidebar';
import { streamAnalysisChat, getAnalysisConfig, type AnalysisConfig } from '@/lib/api';
import type { AnalysisMessage, AnalysisSegment, AnalysisSession, ApiError } from '@/lib/types';
import { cn, createUUID } from '@/lib/utils';
import { Send, Trash2, Loader2, AlertCircle, Sparkles, Settings as SettingsIcon } from 'lucide-react';

const SESSIONS_KEY = 'analysis_sessions';
// Legacy single-session key (a bare messages array). Migrated into one session
// once, then removed.
const LEGACY_KEY = 'analysis_chat_messages';
const MAX_SESSIONS = 50;
const PERSIST_DEBOUNCE_MS = 400;
const EXAMPLES = [
  '最近 7 天哪个模型 token 消耗最多？',
  '今天总共有多少请求、多少错误？',
  '系统里目前有哪些模型和服务商在用？',
];

/** Backfill `segments` on assistant messages loaded from older localStorage
 * rows (which predate the field). Idempotent: rows already carrying segments
 * pass through untouched; user messages are never segmented. The synthesized
 * order — reasoning, then each tool, then the text answer — mirrors the old
 * grouped render, so historical conversations look unchanged. */
function withSegments(m: AnalysisMessage): AnalysisMessage {
  if ('segments' in m) return m;
  if (m.role !== 'assistant') return m;
  const segments: AnalysisSegment[] = [];
  if (m.reasoning) segments.push({ kind: 'reasoning', text: m.reasoning });
  (m.tools ?? []).forEach((t) => segments.push({ kind: 'tool', callId: t.callId }));
  if (m.content) segments.push({ kind: 'text', text: m.content });
  return { ...m, segments };
}

/** Auto-title from the first user message — first ~20 Unicode chars. Used only
 * when the session has no prior user turn, so a manual rename is never clobbered. */
function makeTitle(text: string): string {
  const chars = Array.from(text.trim());
  const t = chars.length > 20 ? chars.slice(0, 20).join('') + '…' : chars.join('');
  return t || '新对话';
}

function createSession(title = '新对话'): AnalysisSession {
  const now = new Date().toISOString();
  return { id: createUUID(), title, messages: [], createdAt: now, updatedAt: now };
}

/** Index of the oldest non-active session, for cap / quota eviction. ISO
 * timestamps compare lexicographically (= chronological for equal formats). */
function findOldestNonActiveIndex(arr: AnalysisSession[], activeId: string): number {
  let idx = -1;
  let oldest = '';
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].id === activeId) continue;
    if (oldest === '' || arr[i].createdAt < oldest) {
      oldest = arr[i].createdAt;
      idx = i;
    }
  }
  return idx;
}

export default function AnalysisPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<AnalysisSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<AnalysisConfig | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived — must come before the effects that reference `messages` (JS const
  // TDZ: an effect's dependency array is evaluated when the hook runs, so the
  // const must already be initialized by that point in the render).
  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const messages = active?.messages ?? [];
  const configured = !!config?.provider && !!config?.model;
  const isEmpty = messages.length === 0;

  /** Immutably patch one session by id. */
  const patchSession = useCallback(
    (id: string, patcher: (s: AnalysisSession) => AnalysisSession) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? patcher(s) : s)));
    },
    [],
  );

  /** Write sessions to localStorage, debounced by the caller (see persist
   * effect). Caps to MAX_SESSIONS and evicts the oldest non-active session on
   * quota errors. Idempotent — safe to call from a setState updater. */
  const persistSessions = useCallback(
    (next: AnalysisSession[]) => {
      let attempt = next;
      while (attempt.length > MAX_SESSIONS) {
        const idx = findOldestNonActiveIndex(attempt, activeSessionId);
        if (idx < 0) break;
        attempt = attempt.filter((_, i) => i !== idx);
      }
      for (let tries = 0; tries < 5; tries++) {
        try {
          localStorage.setItem(SESSIONS_KEY, JSON.stringify(attempt));
          return;
        } catch (err) {
          const quota =
            err instanceof DOMException &&
            (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
          if (quota && attempt.length > 1) {
            const idx = findOldestNonActiveIndex(attempt, activeSessionId);
            if (idx < 0) return;
            attempt = attempt.filter((_, i) => i !== idx);
            continue;
          }
          return; // give up silently; in-memory state is unaffected
        }
      }
    },
    [activeSessionId],
  );

  // Hydrate sessions from localStorage on mount (client-only — localStorage is
  // unavailable during static export prerender). New `analysis_sessions` key is
  // authoritative; the legacy `analysis_chat_messages` (a bare messages array)
  // is migrated into a single session once, then removed.
  useEffect(() => {
    let loaded: AnalysisSession[] | null = null;
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as AnalysisSession[];
        if (Array.isArray(parsed)) loaded = parsed;
      }
    } catch {
      // corrupt new key — fall through to legacy / fresh start
    }
    if (loaded === null) {
      try {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy) {
          const msgs = JSON.parse(legacy) as AnalysisMessage[];
          if (Array.isArray(msgs) && msgs.length > 0) {
            const firstUser = msgs.find((m) => m.role === 'user');
            loaded = [
              {
                id: createUUID(),
                title: firstUser ? makeTitle(firstUser.content) : '新对话',
                messages: msgs.map(withSegments),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ];
            try {
              localStorage.setItem(SESSIONS_KEY, JSON.stringify(loaded));
            } catch {
              // ignore — in-memory is the source of truth for this session
            }
          }
        }
      } catch {
        // ignore corrupt legacy key
      }
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // ignore
      }
    }
    const finalSessions = loaded && loaded.length > 0 ? loaded : [createSession()];
    setSessions(finalSessions);
    setActiveSessionId(finalSessions[0].id);
    getAnalysisConfig().then(setConfig).catch(() => {});
  }, []);

  // Persist sessions, debounced — streaming mutates `sessions` on every token,
  // and stringifying the whole history each time would jank. The completed turn
  // is also hard-flushed in send()'s finally so it survives a tab close.
  useEffect(() => {
    if (sessions.length === 0) return; // pre-mount; nothing to persist
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => persistSessions(sessions), PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [sessions, persistSessions]);

  // Invariant repair: activeSessionId must always point to a real session
  // (handles delete of the active session, and the pre-mount empty state).
  useEffect(() => {
    if (sessions.length === 0) return;
    if (!sessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions, activeSessionId]);

  // Autoscroll to the newest content as it streams in (or on session switch).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages]);

  const send = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || streaming) return;

      // Lock the target session for the whole run: if the user switches / starts
      // a new chat mid-stream, updates still land in the session they began in.
      const targetId = activeSessionId;
      const priorMessages = active?.messages ?? [];

      setError(null);
      setInput('');

      const userMsg: AnalysisMessage = { role: 'user', content: text };
      const assistantMsg: AnalysisMessage = { role: 'assistant', content: '', tools: [], segments: [] };

      // History sent to the backend = prior turns only (NOT this new user turn).
      // Drop errored assistant turns — their content is a failure notice that
      // would mislead the model on the next round.
      const history = priorMessages
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content }));

      // Auto-title only if this session has had no user message yet — so a
      // manual rename survives subsequent sends.
      const isFirstUser = priorMessages.every((m) => m.role !== 'user');
      const now = new Date().toISOString();
      patchSession(targetId, (s) => ({
        ...s,
        title: isFirstUser ? makeTitle(text) : s.title,
        messages: [...priorMessages, userMsg, assistantMsg],
        updatedAt: now,
      }));
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamAnalysisChat({
          message: text,
          history,
          signal: controller.signal,
          onEvent: (ev) => {
            patchSession(targetId, (s) => {
              if (s.messages.length === 0) return s;
              const msgs = [...s.messages];
              const last = { ...msgs[msgs.length - 1] };
              // Deep-ish clone the tools + segments arrays so we don't mutate
              // shared state when pushing/growing them below.
              last.tools = last.tools ? last.tools.map((t) => ({ ...t })) : [];
              last.segments = (last.segments ?? []).map((seg) => ({ ...seg }));

              switch (ev.event) {
                case 'tool_started':
                  last.tools.push({
                    callId: ev.data.callId,
                    toolName: ev.data.toolName,
                    args: ev.data.args,
                    status: 'running',
                  });
                  last.segments.push({ kind: 'tool', callId: ev.data.callId });
                  break;
                case 'tool_result': {
                  const i = last.tools.findIndex((t) => t.callId === ev.data.callId);
                  if (i >= 0) {
                    last.tools[i] = {
                      ...last.tools[i],
                      summary: ev.data.summary,
                      truncated: ev.data.truncated,
                      status: 'done',
                    };
                  }
                  break;
                }
                case 'reasoning_delta': {
                  // Grow the tail if it's already a reasoning segment (same turn's
                  // delta stream), otherwise start a new one — this preserves the
                  // real interleaving of reasoning across multiple tool turns.
                  const segs = last.segments;
                  const tail = segs[segs.length - 1];
                  if (tail && tail.kind === 'reasoning') {
                    segs[segs.length - 1] = { kind: 'reasoning', text: tail.text + ev.data.delta };
                  } else {
                    segs.push({ kind: 'reasoning', text: ev.data.delta });
                  }
                  break;
                }
                case 'text_delta': {
                  last.content += ev.data.delta;
                  const segs = last.segments;
                  const tail = segs[segs.length - 1];
                  if (tail && tail.kind === 'text') {
                    segs[segs.length - 1] = { kind: 'text', text: tail.text + ev.data.delta };
                  } else {
                    segs.push({ kind: 'text', text: ev.data.delta });
                  }
                  break;
                }
                case 'error':
                  last.error = true;
                  last.content = last.content || ev.data.message;
                  last.segments.push({ kind: 'text', text: ev.data.message });
                  break;
                case 'done':
                  last.usage = {
                    promptTokens: ev.data.usage.promptTokens,
                    completionTokens: ev.data.usage.completionTokens,
                    modelCalls: ev.data.modelCalls,
                    durationMs: ev.data.durationMs,
                  };
                  break;
                case 'meta':
                  break;
              }
              msgs[msgs.length - 1] = last;
              return { ...s, messages: msgs, updatedAt: new Date().toISOString() };
            });
          },
        });
      } catch (err) {
        const aborted = controller.signal.aborted;
        // Abort (user switched / new chat / delete / clear) is a deliberate
        // cancel — don't surface it as an error, and don't pollute whatever
        // session is now active.
        if (!aborted) {
          const msg = (err as ApiError)?.message || '请求失败，请重试';
          setError(msg);
        }
        // If the assistant placeholder is still empty, drop it; otherwise leave
        // whatever streamed. (Targeted at the locked session, not the active one.)
        patchSession(targetId, (s) => {
          if (s.messages.length === 0) return s;
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (
            last.role === 'assistant' &&
            !last.content &&
            (!last.tools || last.tools.length === 0) &&
            (!last.segments || last.segments.length === 0)
          ) {
            msgs.pop();
            return { ...s, messages: msgs };
          }
          return s;
        });
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // Hard-flush the completed turn now (not waiting for the 400ms debounce)
        // so it survives a tab close. Reading via the updater gives the freshest
        // state; persistSessions is idempotent so StrictMode's double-invoke is safe.
        setSessions((prev) => {
          persistSessions(prev);
          return prev;
        });
      }
    },
    [input, streaming, activeSessionId, sessions, active, patchSession, persistSessions],
  );

  // "清空对话" = clear the active session's messages (keep the session shell).
  function clearChat() {
    if (streaming) {
      abortRef.current?.abort();
    }
    patchSession(activeSessionId, (s) => ({ ...s, messages: [], updatedAt: new Date().toISOString() }));
    setError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function handleCreate() {
    if (streaming) abortRef.current?.abort();
    const s = createSession();
    setSessions((prev) => [s, ...prev]);
    setActiveSessionId(s.id);
    setError(null);
  }

  function handleSelect(id: string) {
    if (id === activeSessionId) return;
    if (streaming) abortRef.current?.abort();
    setActiveSessionId(id);
    setError(null);
  }

  function handleRename(id: string, title: string) {
    patchSession(id, (s) => ({ ...s, title, updatedAt: new Date().toISOString() }));
  }

  function handleDelete(id: string) {
    if (streaming) abortRef.current?.abort();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      // Never leave zero sessions — create a fresh one. The active-session
      // repair effect re-points activeSessionId if we just removed it.
      return next.length === 0 ? [createSession()] : next;
    });
    setError(null);
  }

  return (
    <AppLayout>
      <div className="flex h-full">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          streaming={streaming}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onRename={handleRename}
          onDelete={handleDelete}
        />
        <div className="flex flex-1 flex-col">
          <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
            {/* Header: model badge + clear */}
            <div className="flex shrink-0 items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-primary" />
                {configured ? (
                  <span className="text-muted-foreground">
                    模型 <span className="font-medium text-foreground">{config?.model}</span>
                    <span className="mx-1 text-muted-foreground/50">·</span>
                    {config?.provider}
                  </span>
                ) : (
                  <button
                    onClick={() => router.push('/settings')}
                    className="inline-flex items-center gap-1 text-amber-600 hover:underline"
                  >
                    <SettingsIcon className="h-3.5 w-3.5" />
                    未配置分析模型，点击前往系统设置
                  </button>
                )}
              </div>
              {!isEmpty && (
                <Button variant="ghost" size="sm" onClick={clearChat} disabled={streaming}>
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  清空对话
                </Button>
              )}
            </div>

            {/* Messages */}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
              {isEmpty ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                  <h2 className="mb-1 text-lg font-semibold">智能数据分析</h2>
                  <p className="mb-6 max-w-md text-sm text-muted-foreground">
                    用自然语言提问，Agent 会自主调用只读查询工具获取网关运营数据，并用中文 + 表格回答。
                  </p>
                  <div className="grid w-full max-w-lg gap-2">
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        onClick={() => send(ex)}
                        disabled={streaming}
                        className="rounded-lg border bg-background px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m, i) => (
                  <MessageBubble key={i} message={m} streaming={streaming && i === messages.length - 1} />
                ))
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="shrink-0 border-t pt-3">
              {error && (
                <div className="mb-2 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入你的分析问题…（Enter 发送，Shift+Enter 换行）"
                  rows={2}
                  disabled={streaming}
                  className="min-h-[44px] resize-none"
                />
                <Button onClick={() => send()} disabled={streaming || !input.trim()}>
                  {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function MessageBubble({ message, streaming }: { message: AnalysisMessage; streaming: boolean }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  const showThinking = streaming && (!message.segments || message.segments.length === 0);

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          'max-w-[90%] space-y-2 rounded-lg border bg-muted/40 px-3.5 py-2.5',
          message.error && 'border-destructive/40 bg-destructive/5',
        )}
      >
        {/* Segments rendered in arrival order: each reasoning turn, tool call,
            and the final answer appear exactly where the agent produced them —
            interleaved, not grouped by type. */}
        {showThinking ? (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在思考…
          </div>
        ) : (
          <div className="space-y-1.5">
            {(message.segments ?? []).map((seg, idx) => {
              if (seg.kind === 'reasoning') {
                return (
                  <ReasoningCard
                    key={idx}
                    reasoning={seg.text}
                    streaming={streaming && idx === (message.segments?.length ?? 0) - 1}
                  />
                );
              }
              if (seg.kind === 'tool') {
                const tool = message.tools?.find((t) => t.callId === seg.callId);
                return tool ? <ToolCard key={idx} tool={tool} /> : null;
              }
              return <Markdown key={idx}>{seg.text}</Markdown>;
            })}
          </div>
        )}

        {/* Usage badge */}
        {message.usage && !message.error && (
          <div className="border-t pt-1.5 text-[11px] text-muted-foreground">
            {message.usage.modelCalls} 次模型调用 ·{' '}
            {(message.usage.promptTokens + message.usage.completionTokens).toLocaleString()} tokens ·{' '}
            {(message.usage.durationMs / 1000).toFixed(1)}s
          </div>
        )}
      </div>
    </div>
  );
}
