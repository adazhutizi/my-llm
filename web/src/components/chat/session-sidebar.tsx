'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { AnalysisSession } from '@/lib/types';
import { Plus, Pencil, Trash2, MessageSquare, Loader2 } from 'lucide-react';

interface SessionSidebarProps {
  sessions: AnalysisSession[];
  activeSessionId: string;
  streaming: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

/** Left history sidebar for the /analysis page: a "new chat" button, the
 * scrollable session list, inline rename, and a delete confirmation dialog.
 * Rename state is hoisted here (not per-item) so only one session edits at a
 * time. */
export function SessionSidebar({
  sessions,
  activeSessionId,
  streaming,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SessionSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  // Esc sets this so the blur that follows is treated as a cancel, not a commit.
  const cancelledRef = useRef(false);

  function startEdit(id: string, current: string) {
    cancelledRef.current = false;
    setEditingId(id);
    setDraftTitle(current);
  }

  function cancelEdit() {
    cancelledRef.current = true;
    setEditingId(null);
  }

  function commitEdit(id: string) {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setEditingId(null);
      return;
    }
    const trimmed = draftTitle.trim();
    setEditingId(null);
    // Empty draft keeps the original title (no-op).
    if (trimmed) onRename(id, trimmed);
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/30">
      <div className="shrink-0 p-2">
        <Button variant="outline" size="sm" className="w-full justify-start gap-1.5" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          新建对话
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 pb-2">
        {sessions.map((s) => (
          <SessionItem
            key={s.id}
            session={s}
            active={s.id === activeSessionId}
            streaming={streaming}
            isEditing={editingId === s.id}
            draft={draftTitle}
            onDraftChange={setDraftTitle}
            onStartEdit={startEdit}
            onCommit={commitEdit}
            onCancel={cancelEdit}
            onSelect={onSelect}
            onRequestDelete={(id) => setDeleteTargetId(id)}
          />
        ))}
      </div>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除此会话？</AlertDialogTitle>
            <AlertDialogDescription>
              该会话的全部消息将从前端本地存储中删除，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTargetId) onDelete(deleteTargetId);
                setDeleteTargetId(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

interface SessionItemProps {
  session: AnalysisSession;
  active: boolean;
  streaming: boolean;
  isEditing: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onStartEdit: (id: string, current: string) => void;
  onCommit: (id: string) => void;
  onCancel: () => void;
  onSelect: (id: string) => void;
  onRequestDelete: (id: string) => void;
}

function SessionItem({
  session,
  active,
  streaming,
  isEditing,
  draft,
  onDraftChange,
  onStartEdit,
  onCommit,
  onCancel,
  onSelect,
  onRequestDelete,
}: SessionItemProps) {
  if (isEditing) {
    return (
      <div className="px-1 py-1">
        <Input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommit(session.id);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => onCommit(session.id)}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          className="h-8 text-sm"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
      onClick={() => onSelect(session.id)}
    >
      <MessageSquare className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <span className="block truncate leading-snug">{session.title || '新对话'}</span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
          {formatRelativeTime(session.updatedAt)}
        </span>
      </div>
      {active && streaming && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
      <button
        type="button"
        title="重命名"
        onClick={(e) => {
          e.stopPropagation();
          onStartEdit(session.id, session.title);
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        title="删除"
        onClick={(e) => {
          e.stopPropagation();
          onRequestDelete(session.id);
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
