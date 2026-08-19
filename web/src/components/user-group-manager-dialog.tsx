'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, Plus, Pencil, Trash2 } from 'lucide-react';
import { listUserGroups, createUserGroup, updateUserGroup, deleteUserGroup } from '@/lib/api';
import type { UserGroup } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after any create/update/delete so the parent can refresh its group list & filter. */
  onChanged: () => void;
}

/**
 * Group CRUD dialog. Listed inline (small cardinality): each row shows name,
 * optional description, a member-count badge, and edit/delete buttons. Edit is
 * inline (row swaps to inputs). Delete opens a second confirmation dialog that
 * warns when the group still has members (they get unbound, not deleted).
 */
export function UserGroupManagerDialog({ open, onOpenChange, onChanged }: Props) {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New-group form
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Inline edit
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [busy, setBusy] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<UserGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listUserGroups();
      setGroups(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载分组失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  function notifyChanged() {
    onChanged();
    load();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createUserGroup({ name, description: newDesc.trim() || null });
      setNewName('');
      setNewDesc('');
      notifyChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建分组失败');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(g: UserGroup) {
    setEditId(g.id);
    setEditName(g.name);
    setEditDesc(g.description ?? '');
  }

  async function handleSaveEdit() {
    if (editId == null) return;
    const name = editName.trim();
    if (!name) {
      alert('分组名不能为空');
      return;
    }
    setBusy(true);
    try {
      await updateUserGroup(editId, { name, description: editDesc.trim() || null });
      setEditId(null);
      notifyChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteUserGroup(deleteTarget.id);
      setDeleteTarget(null);
      notifyChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>分组管理</DialogTitle>
            <DialogDescription>
              创建、编辑或删除用户分组。删除分组时，组内成员会被解绑为&ldquo;未归组&rdquo;（不会删除用户）。
            </DialogDescription>
          </DialogHeader>

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <div className="max-h-80 space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : groups.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无分组，在下方新建。</p>
            ) : (
              groups.map((g) => (
                <div key={g.id} className="flex items-center gap-2 rounded-md border p-2">
                  {editId === g.id ? (
                    <>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8 flex-1"
                        placeholder="分组名"
                      />
                      <Input
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        className="h-8 flex-1"
                        placeholder="描述（可选）"
                      />
                      <Button size="sm" variant="ghost" onClick={handleSaveEdit} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : '保存'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditId(null)} disabled={busy}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{g.name}</span>
                          <Badge variant="secondary" className="shrink-0">{g.memberCount ?? 0} 人</Badge>
                        </div>
                        {g.description && (
                          <p className="truncate text-xs text-muted-foreground">{g.description}</p>
                        )}
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => startEdit(g)} disabled={busy}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(g)}
                        disabled={busy}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          <form onSubmit={handleCreate} className="space-y-2 border-t pt-4">
            <Label className="text-sm font-medium">新建分组</Label>
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="分组名"
                className="flex-1"
              />
              <Input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="描述（可选）"
                className="flex-1"
              />
              <Button type="submit" disabled={creating || !newName.trim()}>
                {creating ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-4 w-4" />
                )}
                创建
              </Button>
            </div>
          </form>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — a second Dialog (not nested inside the manager's
          Dialog) so Radix focus traps don't fight. Warns when members exist. */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除分组</DialogTitle>
            <DialogDescription>
              确定要删除分组&ldquo;{deleteTarget?.name}&rdquo;吗？
              {(deleteTarget?.memberCount ?? 0) > 0
                ? `组内 ${deleteTarget?.memberCount} 名成员将被解绑为"未归组"（用户不会被删除）。`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
