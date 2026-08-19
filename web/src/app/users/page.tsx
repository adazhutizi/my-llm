'use client';

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout';
import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
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
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { listUsers, createUser, updateUser, deleteUser, restoreTarget, listUserGroups } from '@/lib/api';
import type { User, UserGroup } from '@/lib/types';
import { Loader2, Settings2, ScrollText, PieChart, Search, Layers } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { QuotaConfigDialog } from '@/components/quota-config-dialog';
import { QuotaIndicator } from '@/components/quota-indicator';
import { UserGroupManagerDialog } from '@/components/user-group-manager-dialog';
import { formatDate } from '@/lib/utils';

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Groups feed three consumers: the top filter dropdown, the create-form
  // dropdown, and the per-row "move to group" menu. Refreshed on mount and
  // after the group-manager dialog mutates anything (member counts change).
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [filterGroupId, setFilterGroupId] = useState<number | null>(null);
  const [showGroupManager, setShowGroupManager] = useState(false);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ username: string; identifier: string; groupId: number | null }>({
    username: '',
    identifier: '',
    groupId: null,
  });
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);

  // Quota config
  const [quotaTarget, setQuotaTarget] = useState<User | null>(null);

  const loadGroups = useCallback(async () => {
    try {
      const data = await listUserGroups();
      setGroups(data);
    } catch {
      // Best-effort — the filter/options just stay empty.
    }
  }, []);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listUsers({
        page,
        pageSize: 20,
        search: debouncedSearch || undefined,
        groupId: filterGroupId ?? undefined,
      });
      setUsers(res.data);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载用户列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, filterGroupId]);

  // Debounce the search box; reset to page 1 so the new query shows results from the top.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { load(); }, [load]);

  function groupName(id: number | null): string | null {
    if (id == null) return null;
    return groups.find((g) => g.id === id)?.name ?? null;
  }

  async function moveUser(userId: number, groupId: number | null) {
    try {
      await updateUser(userId, { groupId });
      // 乐观更新这一行的 groupId，不调 load() 全量重载——load() 会把
      // loading 切到 true，DataTable 整张表塌陷成 loading 卡片，浏览器
      // 滚动锚定失效，页面就滚回顶端。分组成员计数另由 loadGroups 刷新。
      setUsers((prev) => {
        // 当前正按某分组过滤时，被移出该分组的行应从列表消失，否则会出现
        // "刚把人移走，他还在列表里"的错位（行还在但 groupId 已变）。
        if (filterGroupId != null && groupId !== filterGroupId) {
          return prev.filter((u) => u.id !== userId);
        }
        return prev.map((u) => (u.id === userId ? { ...u, groupId } : u));
      });
      if (filterGroupId != null && groupId !== filterGroupId) {
        setTotal((t) => Math.max(0, t - 1));
      }
      loadGroups(); // member counts changed
    } catch (err) {
      alert(err instanceof Error ? err.message : '移动失败');
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await createUser({ username: form.username, identifier: form.identifier, groupId: form.groupId });
      setShowCreate(false);
      setForm({ username: '', identifier: '', groupId: null });
      load();
      loadGroups();
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建用户失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(user: User) {
    const newStatus = user.status === 'active' ? 'disabled' : 'active';
    try {
      await updateUser(user.id, { status: newStatus });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '更新用户失败');
    }
  }

  async function handleRestore(user: User) {
    try {
      await restoreTarget('users', user.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '恢复用户失败');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteUser(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除用户失败');
    }
  }

  const columns = [
    {
      key: 'username',
      header: '用户名',
      render: (u: User) => <span className="font-medium">{u.username}</span>,
    },
    {
      key: 'identifier',
      header: '标识',
      render: (u: User) => <span className="text-muted-foreground font-mono text-sm">{u.identifier}</span>,
    },
    {
      key: 'group',
      header: '分组',
      render: (u: User) => {
        const current = groupName(u.groupId);
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className={
                  current
                    ? 'inline-flex items-center rounded-md border border-transparent bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground hover:bg-secondary/80'
                    : 'inline-flex items-center rounded-md border border-dashed border-input px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent'
                }
              >
                {current ?? '未归组'}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>移到分组</DropdownMenuLabel>
              {groups.length === 0 ? (
                <DropdownMenuItem disabled>请先创建分组</DropdownMenuItem>
              ) : (
                groups.map((g) => (
                  <DropdownMenuItem
                    key={g.id}
                    onClick={(e) => { e.stopPropagation(); moveUser(u.id, g.id); }}
                  >
                    {g.name}
                  </DropdownMenuItem>
                ))
              )}
              {u.groupId != null && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={(e) => { e.stopPropagation(); moveUser(u.id, null); }}
                  >
                    移出分组
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
    {
      key: 'status',
      header: '状态',
      render: (u: User) => <StatusBadge status={u.status} />,
    },
    {
      key: 'quota',
      header: '今日配额',
      render: (u: User) => <QuotaIndicator type="users" id={u.id} />,
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (u: User) => formatDate(u.createdAt),
    },
    {
      key: 'actions',
      header: '',
      render: (u: User) => (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); setQuotaTarget(u); }}
          >
            <Settings2 className="mr-1 h-4 w-4" />
            配额
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/reports?userId=${u.id}`); }}
          >
            <PieChart className="mr-1 h-4 w-4" />
            报表
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/logs?userId=${u.id}`); }}
          >
            <ScrollText className="mr-1 h-4 w-4" />
            日志
          </Button>
          {u.status !== 'quota_exceeded' && (
            <Button
              variant="ghost"
              size="sm"
              className={u.status === 'active' ? 'text-destructive hover:text-destructive' : 'text-green-600 hover:text-green-700'}
              onClick={(e) => { e.stopPropagation(); toggleStatus(u); }}
            >
              {u.status === 'active' ? '禁用' : '启用'}
            </Button>
          )}
          {u.status === 'quota_exceeded' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-green-600 hover:text-green-700"
              onClick={(e) => { e.stopPropagation(); handleRestore(u); }}
            >
              恢复
            </Button>
          )}
          {u.status === 'disabled' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); setDeleteTarget(u); }}
            >
              删除
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex justify-end">
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setShowGroupManager(true)}>
              <Layers className="mr-1 h-4 w-4" />
              分组管理
            </Button>
            <Button onClick={() => setShowCreate(true)}>创建用户</Button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索用户名或标识..."
              className="pl-9"
            />
          </div>
          <Select
            value={filterGroupId == null ? 'all' : String(filterGroupId)}
            onValueChange={(v) => { setFilterGroupId(v === 'all' ? null : Number(v)); setPage(1); }}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="全部分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分组</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DataTable
          columns={columns}
          data={users}
          loading={loading}
          emptyMessage="暂无用户。"
          page={page}
          pageSize={20}
          total={total}
          onPageChange={setPage}
          keyExtractor={(item) => item.id}
        />

        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>创建用户</DialogTitle>
              <DialogDescription>添加新的网关用户。</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>用户名</Label>
                <Input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="用户名" />
              </div>
              <div className="space-y-2">
                <Label>用户标识</Label>
                <Input required value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} placeholder="例如：user-123、abc456" />
                <p className="text-xs text-muted-foreground">唯一标识符，可为任意字符和数字组合</p>
              </div>
              <div className="space-y-2">
                <Label>分组</Label>
                <Select
                  value={form.groupId == null ? 'none' : String(form.groupId)}
                  onValueChange={(v) => setForm({ ...form, groupId: v === 'none' ? null : Number(v) })}
                >
                  <SelectTrigger><SelectValue placeholder="未归组" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未归组</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
                <Button type="submit" disabled={saving || !form.username || !form.identifier}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {saving ? '创建中...' : '创建'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除用户</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除用户 &quot;{deleteTarget?.username}&quot; 吗？此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Quota config */}
        {quotaTarget && (
          <QuotaConfigDialog
            open={!!quotaTarget}
            onOpenChange={(open) => { if (!open) { setQuotaTarget(null); load(); } }}
            type="user"
            id={quotaTarget.id}
            label={`用户: ${quotaTarget.username}`}
          />
        )}

        {/* Group management — onChanged refreshes both groups (filter/menu) and the list */}
        <UserGroupManagerDialog
          open={showGroupManager}
          onOpenChange={setShowGroupManager}
          onChanged={() => { loadGroups(); load(); }}
        />
      </div>
    </AppLayout>
  );
}
