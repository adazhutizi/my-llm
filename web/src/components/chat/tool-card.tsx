'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AnalysisToolCall } from '@/lib/types';

// Chinese labels for known tools — the raw tool name is the snake_case
// identifier; this maps it to something a non-technical admin reads faster.
const TOOL_LABELS: Record<string, string> = {
  get_usage_overview: '用量总览',
  get_usage_trends: '用量趋势',
  get_usage_by_model: '模型用量 Top',
  list_dimensions: '枚举可选维度',
};

/** Collapsible card showing one tool call inside an assistant message bubble:
 *  name + status on the collapsed header, args + result when expanded. */
export function ToolCard({ tool }: { tool: AnalysisToolCall }) {
  const [open, setOpen] = useState(false);
  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName;
  const running = tool.status === 'running';

  return (
    <div className="rounded-md border bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Wrench className={cn('h-3 w-3 shrink-0', running && 'animate-pulse text-amber-500')} />
        <span className="font-mono">{tool.toolName}</span>
        <span className="text-muted-foreground">· {label}</span>
        <span className="ml-auto shrink-0">
          {running && <span className="text-amber-600">运行中…</span>}
          {tool.status === 'done' && <span className="text-green-600">完成</span>}
          {tool.status === 'error' && <span className="text-destructive">出错</span>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-2 py-2">
          {tool.args != null && tool.args !== '' && (
            <div>
              <p className="mb-0.5 font-medium text-muted-foreground">参数</p>
              <pre className="overflow-x-auto rounded bg-background p-1.5 font-mono text-[11px]">
                {tool.args}
              </pre>
            </div>
          )}
          {tool.summary != null && (
            <div>
              <p className="mb-0.5 font-medium text-muted-foreground">
                结果{tool.truncated ? '（已截断）' : ''}
              </p>
              <pre className="max-h-60 overflow-auto rounded bg-background p-1.5 font-mono text-[11px]">
                {tool.summary}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
