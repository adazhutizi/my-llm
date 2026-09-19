'use client';

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout';
import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { listApps, createApp, getAppUsers, updateApp, deleteApp, restoreTarget } from '@/lib/api';
import type { App, AppUser } from '@/lib/types';
import { Loader2, Settings2, Search, ScrollText, PieChart, ShieldBan } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { QuotaConfigDialog } from '@/components/quota-config-dialog';
import { UaPolicyDialog } from '@/components/ua-policy-dialog';
import { QuotaIndicator } from '@/components/quota-indicator';
import { formatDate } from '@/lib/utils';

export default function AppsPage() {
  const router = useRouter();
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);

  // Detail dialog
  const [selectedApp, setSelectedApp] = useState<App | null>(null);
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);

  // Quota config
  const [quotaTarget, setQuotaTarget] = useState<App | null>(null);

  // UA allow/block list
  const [uaTarget, setUaTarget] = useState<App | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listApps({ page, pageSize: 20, search: debouncedSearch || undefined });
      setApps(res.data);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载应用列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  // Debounce the search box; reset to page 1 so the new query shows results from the top.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { load(); }, [load]);

  // Load app users when detail dialog opens
  useEffect(() => {
    if (!selectedApp) {
      setAppUsers([]);
      return;
    }
    let cancelled = false;
    setUsersLoading(true);
    getAppUsers(selectedApp.id)
      .then((users) => { if (!cancelled) setAppUsers(users); })
      .catch(() => { if (!cancelled) setAppUsers([]); })
      .finally(() => { if (!cancelled) setUsersLoading(false); });
    return () => { cancelled = true; };
  }, [selectedApp]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await createApp({
        name: form.name,
        description: form.description || undefined,
      });
      setShowCreate(false);
      setForm({ name: '', description: '' });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建应用失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(app: App) {
    const newStatus = app.status === 'active' ? 'disabled' : 'active';
    try {
      await updateApp(app.id, { status: newStatus });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '更新应用失败');
    }
  }

  async function handleRestore(app: App) {
    try {
      await restoreTarget('apps', app.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '恢复应用失败');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteApp(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除应用失败');
    }
  }

  const columns = [
    {
      key: 'name',
      header: '名称',
      render: (a: App) => <span className="font-medium">{a.name}</span>,
    },
    {
      key: 'description',
      header: '描述',
      render: (a: App) => (
        <span className="text-muted-foreground truncate max-w-[240px] inline-block">
          {a.description ?? '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (a: App) => <StatusBadge status={a.status} />,
    },
    {
      key: 'quota',
      header: '今日配额',
      render: (a: App) => <QuotaIndicator type="apps" id={a.id} />,
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (a: App) => formatDate(a.createdAt),
    },
    {
      key: 'actions',
      header: '',
      render: (a: App) => (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); setQuotaTarget(a); }}
          >
            <Settings2 className="mr-1 h-4 w-4" />
            配额
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); setUaTarget(a); }}
          >
            <ShieldBan className="mr-1 h-4 w-4" />
            UA 名单
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/reports?appId=${a.id}`); }}
          >
            <PieChart className="mr-1 h-4 w-4" />
            报表
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/logs?appId=${a.id}`); }}
          >
            <ScrollText className="mr-1 h-4 w-4" />
            日志
          </Button>
          {a.status !== 'quota_exceeded' && (
            <Button
              variant="ghost"
              size="sm"
              className={a.status === 'active' ? 'text-destructive hover:text-destructive' : 'text-green-600 hover:text-green-700'}
              onClick={(e) => { e.stopPropagation(); toggleStatus(a); }}
            >
              {a.status === 'active' ? '禁用' : '启用'}
            </Button>
          )}
          {a.status === 'quota_exceeded' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-green-600 hover:text-green-700"
              onClick={(e) => { e.stopPropagation(); handleRestore(a); }}
            >
              恢复
            </Button>
          )}
          {a.status === 'disabled' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); setDeleteTarget(a); }}
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
          <Button onClick={() => setShowCreate(true)}>创建应用</Button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称或描述..."
            className="pl-9"
          />
        </div>

        <DataTable
          columns={columns}
          data={apps}
          loading={loading}
          emptyMessage="暂无应用。"
          page={page}
          pageSize={20}
          total={total}
          onPageChange={setPage}
          onRowClick={(app) => setSelectedApp(app)}
          keyExtractor={(item) => item.id}
        />

        {/* Create App Dialog */}
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>创建应用</DialogTitle>
              <DialogDescription>在网关上注册一个新的应用。</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="我的应用"
                />
              </div>
              <div className="space-y-2">
                <Label>描述</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="可选描述信息"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
                <Button type="submit" disabled={saving || !form.name}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {saving ? '创建中...' : '创建'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* App Detail Dialog */}
        <Dialog open={!!selectedApp} onOpenChange={(open) => { if (!open) setSelectedApp(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>应用详情</DialogTitle>
              <DialogDescription>
                {selectedApp ? selectedApp.name : ''}
              </DialogDescription>
            </DialogHeader>

            {selectedApp && (
              <div className="space-y-6">
                {/* App Info */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">状态：</span>
                    <div className="mt-1"><StatusBadge status={selectedApp.status} /></div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">创建时间：</span>
                    <p>{formatDate(selectedApp.createdAt)}</p>
                  </div>
                </div>

                {selectedApp.description && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">描述：</span>
                    <p className="mt-1">{selectedApp.description}</p>
                  </div>
                )}

                {/* App Users */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold">应用用户</h3>
                  {usersLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : appUsers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无应用用户。</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>外部 UID</TableHead>
                          <TableHead>显示名称</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {appUsers.map((u) => (
                          <TableRow key={u.id}>
                            <TableCell className="font-mono text-xs">{u.externalUid}</TableCell>
                            <TableCell>{u.displayName ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除应用</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除应用 &quot;{deleteTarget?.name}&quot; 吗？此操作不可撤销。
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
            type="app"
            id={quotaTarget.id}
            label={`应用: ${quotaTarget.name}`}
          />
        )}

        {/* UA allow/block list */}
        {uaTarget && (
          <UaPolicyDialog
            open={!!uaTarget}
            onOpenChange={(open) => { if (!open) setUaTarget(null); }}
            type="app"
            id={uaTarget.id}
            label={`应用: ${uaTarget.name}`}
          />
        )}
      </div>
    </AppLayout>
  );
}
