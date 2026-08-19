'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';

// Collapsible card showing the model's streamed reasoning/thinking summary
// inside an assistant message bubble. Mirrors tool-card.tsx's pattern (internal
// open state, chevron + status badge) but renders the accumulated reasoning
// delta as Markdown — reasoning summaries often carry lists / inline code.
// Default collapsed so it doesn't crowd the answer; the badge animates while
// streaming so the user knows new thoughts are arriving, and they can expand
// to watch them arrive live.
export function ReasoningCard({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);

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
        <Brain className={cn('h-3 w-3 shrink-0', streaming && 'animate-pulse text-violet-500')} />
        <span className="font-medium">思考过程</span>
        <span className="ml-auto shrink-0">
          {streaming ? <span className="text-violet-600">思考中…</span> : <span className="text-muted-foreground">已完成</span>}
        </span>
      </button>
      {open && (
        <div className="border-t px-2 py-2">
          <Markdown>{reasoning}</Markdown>
        </div>
      )}
    </div>
  );
}
