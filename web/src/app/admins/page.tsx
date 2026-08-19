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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { listAdmins, createAdmin, updateAdmin, resetAdminPassword, deleteAdmin } from '@/lib/api';
import type { AdminUser } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { Loader2, Copy, Check, Search, KeyRound, Trash2, UserCog, Ban } from 'lucide-react';
import { formatDate } from '@/lib/utils';

export default function AdminsPage() {
  const { user } = useAuth();
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', role: 'admin' as 'admin' | 'super_admin' });
  const [saving, setSaving] = useState(false);

  // Credential reveal (shown once after create / reset)
  const [credential, setCredential] = useState<{ title: string; username?: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Confirmations
  const [roleTarget, setRoleTarget] = useState<AdminUser | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAdmins({ page, pageSize: 20, search: debouncedSearch || undefined });
      setAdmins(res.data);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载管理员列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await createAdmin({
        username: form.username,
        password: form.password || undefined,
        role: form.role,
      });
      setShowCreate(false);
      setForm({ username: '', password: '', role: 'admin' });
      setCredential({
        title: '管理员已创建',
        username: res.username,
        password: res.plainPassword ?? '（您设置的密码）',
      });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus(admin: AdminUser) {
    setBusyId(admin.id);
    try {
      await updateAdmin(admin.id, { status: admin.status === 'active' ? 'disabled' : 'active' });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleRole() {
    if (!roleTarget) return;
    const newRole = roleTarget.role === 'super_admin' ? 'admin' : 'super_admin';
    setBusyId(roleTarget.id);
    try {
      await updateAdmin(roleTarget.id, { role: newRole });
      setRoleTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReset() {
    if (!resetTarget) return;
    setBusyId(resetTarget.id);
    try {
      const res = await resetAdminPassword(resetTarget.id);
      setResetTarget(null);
      setCredential({ title: '密码已重置', username: resetTarget.username, password: res.plainPassword });
    } catch (err) {
      alert(err instanceof Error ? err.message : '重置失败');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await deleteAdmin(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  }

  function handleCopyCredential() {
    if (credential) {
      navigator.clipboard.writeText(credential.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const columns = [
    {
      key: 'username',
      header: '用户名',
      render: (a: AdminUser) => (
        <div>
          <p className="font-medium">
            {a.username}
            {a.id === user?.id && <span className="ml-2 text-xs text-muted-foreground">（当前登录）</span>}
          </p>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色',
      render: (a: AdminUser) => (
        <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
          a.role === 'super_admin' ? 'bg-purple-50 text-purple-700 ring-purple-600/20' : 'bg-gray-50 text-gray-600 ring-gray-500/20'
        }`}>
          {a.role === 'super_admin' ? '超级管理员' : '管理员'}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (a: AdminUser) => <StatusBadge status={a.status} />,
    },
    {
      key: 'lastLoginAt',
      header: '最后登录',
      render: (a: AdminUser) => (a.lastLoginAt ? formatDate(a.lastLoginAt) : <span className="text-muted-foreground">从未登录</span>),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (a: AdminUser) => formatDate(a.createdAt),
    },
    {
      key: 'actions',
      header: '',
      render: (a: AdminUser) => {
        const isSelf = a.id === user?.id;
        return (
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={isSelf || busyId === a.id}
              title={isSelf ? '不能操作当前登录账号' : undefined}
              onClick={(e) => { e.stopPropagation(); handleToggleStatus(a); }}
            >
              {a.status === 'active' ? <><Ban className="mr-1 h-4 w-4" />禁用</> : <><Check className="mr-1 h-4 w-4" />启用</>}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isSelf || busyId === a.id}
              title={isSelf ? '不能操作当前登录账号' : undefined}
              onClick={(e) => { e.stopPropagation(); setRoleTarget(a); }}
            >
              <UserCog className="mr-1 h-4 w-4" />
              {a.role === 'super_admin' ? '降为管理员' : '升为超管'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isSelf || busyId === a.id}
              title={isSelf ? '不能操作当前登录账号' : undefined}
              onClick={(e) => { e.stopPropagation(); setResetTarget(a); }}
            >
              <KeyRound className="mr-1 h-4 w-4" />
              重置密码
            </Button>
            {a.status === 'disabled' && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={isSelf || busyId === a.id}
                title={isSelf ? '不能操作当前登录账号' : undefined}
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(a); }}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                删除
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  if (user?.role !== 'super_admin') {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center">
            <p className="text-lg font-semibold">无权限</p>
            <p className="mt-1 text-sm text-muted-foreground">仅超级管理员可访问此页面。</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button onClick={() => setShowCreate(true)}>添加管理员</Button>
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
            placeholder="搜索用户名..."
            className="pl-9"
          />
        </div>

        <DataTable
          columns={columns}
          data={admins}
          loading={loading}
          emptyMessage="暂无管理员。"
          page={page}
          pageSize={20}
          total={total}
          onPageChange={setPage}
          keyExtractor={(item) => item.id}
        />

        {/* Create dialog */}
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>添加管理员</DialogTitle>
              <DialogDescription>创建一个新的后台管理员账号。密码留空将自动生成。</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>用户名 *</Label>
                <Input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="例如：admin2" />
              </div>
              <div className="space-y-2">
                <Label>角色</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as 'admin' | 'super_admin' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">管理员</SelectItem>
                    <SelectItem value="super_admin">超级管理员</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">超级管理员可管理其他管理员；普通管理员无法访问本页。</p>
              </div>
              <div className="space-y-2">
                <Label>密码（可选）</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="留空自动生成" />
                <p className="text-xs text-muted-foreground">留空将在创建后生成随机密码并显示一次。</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
                <Button type="submit" disabled={saving || !form.username}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {saving ? '创建中...' : '创建'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Credential reveal (after create / reset) */}
        <Dialog open={!!credential} onOpenChange={() => setCredential(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{credential?.title}</DialogTitle>
              <DialogDescription>请立即复制并妥善保存，关闭后将不再显示。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {credential?.username && (
                <div>
                  <p className="text-xs text-muted-foreground">用户名</p>
                  <p className="font-medium">{credential.username}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">密码</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 text-sm">{credential?.password}</code>
                  <Button variant="outline" size="sm" onClick={handleCopyCredential}>
                    {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setCredential(null)}>已完成</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Role switch confirmation */}
        <AlertDialog open={!!roleTarget} onOpenChange={() => setRoleTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{roleTarget?.role === 'super_admin' ? '降为普通管理员' : '升为超级管理员'}</AlertDialogTitle>
              <AlertDialogDescription>
                确定要将 &quot;{roleTarget?.username}&quot; {roleTarget?.role === 'super_admin' ? '降为普通管理员' : '升为超级管理员'}吗？
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handleToggleRole}>确认</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Reset password confirmation */}
        <AlertDialog open={!!resetTarget} onOpenChange={() => setResetTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>重置密码</AlertDialogTitle>
              <AlertDialogDescription>
                确定要重置 &quot;{resetTarget?.username}&quot; 的密码吗？将生成新的随机密码，原密码立即失效。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handleReset}>重置</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除管理员</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除 &quot;{deleteTarget?.username}&quot; 吗？此操作不可撤销。
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
      </div>
    </AppLayout>
  );
}
