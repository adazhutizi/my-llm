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
import { listApiKeys, createApiKey, updateApiKey, revokeApiKey, deleteApiKey, restoreTarget, revealApiKey, listUsers, listApps, listProviders } from '@/lib/api';
import type { ApiKey, CreateApiKeyResponse, UpdateApiKeyRequest, User, App, Provider } from '@/lib/types';
import { Loader2, Copy, Check, Settings2, Eye, EyeOff, ScrollText, PieChart, Search, Pencil, Boxes, ShieldBan } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { InlineCombobox } from '@/components/inline-combobox';
import { QuotaConfigDialog } from '@/components/quota-config-dialog';
import { QuotaIndicator } from '@/components/quota-indicator';
import { ModelPolicyDialog } from '@/components/model-policy-dialog';
import { UaPolicyDialog } from '@/components/ua-policy-dialog';
import { formatDate, toBeijingDateTimeLocal } from '@/lib/utils';

export default function ApiKeysPage() {
  const router = useRouter();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'user' | 'app' | 'admin' | 'dedicated' | null>(null);
  const [filterStatus, setFilterStatus] = useState<'active' | 'revoked' | 'expired' | 'quota_exceeded' | null>(null);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ mode: 'user' as 'user' | 'app' | 'admin' | 'dedicated', name: '', userId: '', appId: '', expiresAt: '', providerId: '', upstreamApiKey: '' });
  const [saving, setSaving] = useState(false);

  // Combobox data
  const [users, setUsers] = useState<User[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [providerList, setProviderList] = useState<Provider[]>([]);

  // Created key display
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reveal key state
  const [revealedKey, setRevealedKey] = useState<{ id: number; secret: string } | null>(null);
  const [revealingId, setRevealingId] = useState<number | null>(null);
  const [copiedRevealId, setCopiedRevealId] = useState<number | null>(null);

  // Revoke confirmation
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);

  // Quota config
  const [quotaTarget, setQuotaTarget] = useState<ApiKey | null>(null);

  // Model policy (allow/block list + per-model limits)
  const [modelPolicyTarget, setModelPolicyTarget] = useState<ApiKey | null>(null);

  // UA allow/block list (applies to ALL key modes including dedicated — unlike
  // modelPolicy, which is inert for dedicated transparent-proxy keys)
  const [uaTarget, setUaTarget] = useState<ApiKey | null>(null);

  // Edit dialog
  const [editTarget, setEditTarget] = useState<ApiKey | null>(null);
  const [editForm, setEditForm] = useState({ name: '', expiresAt: '', providerId: '', upstreamApiKey: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listApiKeys({
        page,
        pageSize: 20,
        search: debouncedSearch || undefined,
        mode: filterMode ?? undefined,
        status: filterStatus ?? undefined,
      });
      setKeys(res.data);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 API 密钥失败');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, filterMode, filterStatus]);

  // Debounce the search box; reset to page 1 so the new query shows results from the top.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { load(); }, [load]);

  // Load users and apps when create dialog opens
  useEffect(() => {
    if (showCreate) {
      listUsers({ pageSize: 200 }).then(res => setUsers(res.data)).catch(() => {});
      listApps({ pageSize: 200 }).then(res => setApps(res.data)).catch(() => {});
      listProviders().then(data => setProviderList(data)).catch(() => {});
    }
  }, [showCreate]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const data: { mode: 'user' | 'app' | 'admin' | 'dedicated'; name: string; userId?: number; appId?: number; expiresAt?: string; providerId?: number; upstreamApiKey?: string } = {
        mode: form.mode,
        name: form.name,
      };
      if (form.mode === 'user' && form.userId) data.userId = parseInt(form.userId);
      if (form.mode === 'app' && form.appId) data.appId = parseInt(form.appId);
      if (form.mode === 'dedicated') {
        if (!form.providerId || !form.upstreamApiKey) {
          alert('一对一转发密钥需要选择服务商并填写上游 API 密钥');
          setSaving(false);
          return;
        }
        data.providerId = parseInt(form.providerId);
        data.upstreamApiKey = form.upstreamApiKey;
        if (form.userId) data.userId = parseInt(form.userId);
      }
      if (form.expiresAt) data.expiresAt = form.expiresAt + '+08:00';

      const res: CreateApiKeyResponse = await createApiKey(data);
      setCreatedKey(res.plainText);
      setShowCreate(false);
      setForm({ mode: 'user', name: '', userId: '', appId: '', expiresAt: '', providerId: '', upstreamApiKey: '' });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建 API 密钥失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    try {
      await revokeApiKey(revokeTarget.id);
      setRevokeTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '撤销 API 密钥失败');
    }
  }

  async function handleRestore(key: ApiKey) {
    try {
      await restoreTarget('api_keys', key.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '恢复 API 密钥失败');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteApiKey(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除 API 密钥失败');
    }
  }

  function handleCopy() {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  async function handleReveal(key: ApiKey) {
    if (revealedKey && revealedKey.id === key.id) {
      setRevealedKey(null);
      return;
    }
    setRevealingId(key.id);
    try {
      const res = await revealApiKey(key.id);
      setRevealedKey({ id: res.id, secret: res.keySecret });
    } catch (err) {
      alert(err instanceof Error ? err.message : '获取密钥失败');
    } finally {
      setRevealingId(null);
    }
  }

  function handleCopyRevealed(keyId: number, secret: string) {
    navigator.clipboard.writeText(secret);
    setCopiedRevealId(keyId);
    setTimeout(() => setCopiedRevealId(null), 2000);
  }

  function openEdit(key: ApiKey) {
    setEditTarget(key);
    setEditForm({
      name: key.name,
      expiresAt: key.expiresAt ? toBeijingDateTimeLocal(new Date(key.expiresAt)) : '',
      providerId: key.providerId ? String(key.providerId) : '',
      upstreamApiKey: '',
    });
    if (key.mode === 'dedicated') {
      listProviders().then((data) => setProviderList(data)).catch(() => {});
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    if (editTarget.mode === 'dedicated' && !editForm.providerId) {
      alert('一对一转发密钥需要选择服务商');
      return;
    }
    setSavingEdit(true);
    try {
      const payload: UpdateApiKeyRequest = {
        name: editForm.name,
        // 留空表示永不过期；与创建对话框一致按北京时间提交
        expiresAt: editForm.expiresAt ? editForm.expiresAt + '+08:00' : null,
      };
      if (editTarget.mode === 'dedicated') {
        payload.providerId = parseInt(editForm.providerId);
        // 上游密钥留空不传 → 后端保持不变
        if (editForm.upstreamApiKey) payload.upstreamApiKey = editForm.upstreamApiKey;
      }
      await updateApiKey(editTarget.id, payload);
      setEditTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingEdit(false);
    }
  }

  const columns = [
    {
      key: 'name',
      header: '名称',
      render: (key: ApiKey) => (
        <div>
          <p className="font-medium">{key.name}</p>
          {revealedKey && revealedKey.id === key.id ? (
            <div className="flex items-center gap-2 mt-1">
              <code className="text-xs font-mono break-all bg-muted px-2 py-0.5 rounded">{revealedKey.secret}</code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                onClick={(e) => { e.stopPropagation(); handleCopyRevealed(key.id, revealedKey.secret); }}
              >
                {copiedRevealId === key.id ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                onClick={(e) => { e.stopPropagation(); setRevealedKey(null); }}
              >
                <EyeOff className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground font-mono">{key.keyPrefix}...</p>
          )}
        </div>
      ),
    },
    {
      key: 'mode',
      header: '模式',
      render: (key: ApiKey) => (
        <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
          key.mode === 'admin' ? 'bg-purple-50 text-purple-700 ring-purple-600/20' :
          key.mode === 'app' ? 'bg-blue-50 text-blue-700 ring-blue-600/20' :
          key.mode === 'dedicated' ? 'bg-amber-50 text-amber-700 ring-amber-600/20' :
          'bg-gray-50 text-gray-600 ring-gray-500/20'
        }`}>
          {key.mode === 'dedicated' ? '一对一' : key.mode}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (key: ApiKey) => <StatusBadge status={key.status} />,
    },
    {
      key: 'quota',
      header: '今日配额',
      render: (key: ApiKey) => <QuotaIndicator type="api_keys" id={key.id} />,
    },
    {
      key: 'modelPolicy',
      header: '模型限制',
      render: (key: ApiKey) => {
        // Dedicated keys bypass virtual-model routing entirely
        if (key.mode === 'dedicated') {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        const policy = key.permissions?.modelPolicy;
        if (!policy || policy.mode === 'all') {
          return (
            <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset bg-gray-50 text-gray-600 ring-gray-500/20">全部</span>
          );
        }
        if (policy.mode === 'allow') {
          return (
            <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset bg-green-50 text-green-700 ring-green-600/20">允许 {policy.models.length}</span>
          );
        }
        return (
          <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset bg-red-50 text-red-700 ring-red-600/20">禁用 {policy.models.length}</span>
        );
      },
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (key: ApiKey) => formatDate(key.createdAt),
    },
    {
      key: 'expiresAt',
      header: '过期时间',
      render: (key: ApiKey) => key.expiresAt ? formatDate(key.expiresAt) : <span className="text-muted-foreground">永不过期</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (key: ApiKey) => (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={revealingId === key.id}
            onClick={(e) => { e.stopPropagation(); handleReveal(key); }}
          >
            {revealingId === key.id ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : revealedKey && revealedKey.id === key.id ? (
              <EyeOff className="mr-1 h-4 w-4" />
            ) : (
              <Eye className="mr-1 h-4 w-4" />
            )}
            {revealedKey && revealedKey.id === key.id ? '隐藏' : '查看'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); openEdit(key); }}
          >
            <Pencil className="mr-1 h-4 w-4" />
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); setQuotaTarget(key); }}
          >
            <Settings2 className="mr-1 h-4 w-4" />
            配额
          </Button>
          {key.mode !== 'dedicated' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); setModelPolicyTarget(key); }}
            >
              <Boxes className="mr-1 h-4 w-4" />
              模型
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); setUaTarget(key); }}
          >
            <ShieldBan className="mr-1 h-4 w-4" />
            UA 名单
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/reports?apiKeyId=${key.id}`); }}
          >
            <PieChart className="mr-1 h-4 w-4" />
            报表
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/logs?apiKeyId=${key.id}`); }}
          >
            <ScrollText className="mr-1 h-4 w-4" />
            日志
          </Button>
          {key.status === 'active' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); setRevokeTarget(key); }}
            >
              撤销
            </Button>
          )}
          {key.status === 'quota_exceeded' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-green-600 hover:text-green-700"
              onClick={(e) => { e.stopPropagation(); handleRestore(key); }}
            >
              恢复
            </Button>
          )}
          {(key.status === 'revoked' || key.status === 'expired') && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); setDeleteTarget(key); }}
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
          <Button onClick={() => setShowCreate(true)}>创建密钥</Button>
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
              placeholder="搜索名称或密钥前缀..."
              className="pl-9"
            />
          </div>
          <Select
            value={filterMode ?? 'all'}
            onValueChange={(v) => { setFilterMode(v === 'all' ? null : v as 'user' | 'app' | 'admin' | 'dedicated'); setPage(1); }}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="app">App</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="dedicated">一对一转发</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filterStatus ?? 'all'}
            onValueChange={(v) => { setFilterStatus(v === 'all' ? null : v as 'active' | 'revoked' | 'expired' | 'quota_exceeded'); setPage(1); }}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="active">激活</SelectItem>
              <SelectItem value="revoked">已撤销</SelectItem>
              <SelectItem value="expired">已过期</SelectItem>
              <SelectItem value="quota_exceeded">配额超限</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <DataTable
          columns={columns}
          data={keys}
          loading={loading}
          emptyMessage="暂无 API 密钥，点击上方按钮创建。"
          page={page}
          pageSize={20}
          total={total}
          onPageChange={setPage}
          keyExtractor={(item) => item.id}
        />

        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>创建 API 密钥</DialogTitle>
              <DialogDescription>创建一个新的 API 密钥用于身份验证。</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>模式</Label>
                <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as 'user' | 'app' | 'admin' | 'dedicated' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="app">App</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="dedicated">一对一转发</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>名称</Label>
                <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="我的 API 密钥" />
              </div>
              <div className="space-y-2">
                <Label>过期时间（可选，不填则永不过期）</Label>
                <Input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
              </div>
              {form.mode === 'user' && (
                <div className="space-y-2">
                  <Label>用户（可选）</Label>
                  <InlineCombobox
                    options={users.map((u) => ({ value: String(u.id), label: u.username, suffix: `#${u.id}` }))}
                    value={form.userId}
                    onChange={(v) => setForm({ ...form, userId: v })}
                    placeholder="选择用户..."
                    searchPlaceholder="搜索用户名..."
                    emptyText="未找到用户"
                    allowClear
                    clearLabel="不绑定用户"
                  />
                </div>
              )}
              {form.mode === 'app' && (
                <div className="space-y-2">
                  <Label>应用（可选）</Label>
                  <InlineCombobox
                    options={apps.map((a) => ({ value: String(a.id), label: a.name, suffix: `#${a.id}` }))}
                    value={form.appId}
                    onChange={(v) => setForm({ ...form, appId: v })}
                    placeholder="选择应用..."
                    searchPlaceholder="搜索应用名..."
                    emptyText="未找到应用"
                    allowClear
                    clearLabel="不绑定应用"
                  />
                </div>
              )}
              {form.mode === 'dedicated' && (
                <>
                  <div className="space-y-2">
                    <Label>服务商 *</Label>
                    <InlineCombobox
                      options={providerList.filter((p) => p.isActive).map((p) => ({
                        value: String(p.id),
                        label: p.name,
                        suffix: p.apiType === 'anthropic' ? 'Anthropic' : 'OpenAI',
                      }))}
                      value={form.providerId}
                      onChange={(v) => setForm({ ...form, providerId: v })}
                      placeholder="选择服务商..."
                      searchPlaceholder="搜索服务商..."
                      emptyText="未找到服务商"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>上游 API 密钥 *</Label>
                    <Input
                      required
                      type="password"
                      value={form.upstreamApiKey}
                      onChange={(e) => setForm({ ...form, upstreamApiKey: e.target.value })}
                      placeholder="sk-..."
                    />
                    <p className="text-xs text-muted-foreground">此密钥将在请求时替换用户的一对一密钥，转发到上游服务商</p>
                  </div>
                  <div className="space-y-2">
                    <Label>用户（可选）</Label>
                    <InlineCombobox
                      options={users.map((u) => ({ value: String(u.id), label: u.username, suffix: `#${u.id}` }))}
                      value={form.userId}
                      onChange={(v) => setForm({ ...form, userId: v })}
                      placeholder="选择用户..."
                      searchPlaceholder="搜索用户名..."
                      emptyText="未找到用户"
                      allowClear
                      clearLabel="不绑定用户"
                    />
                  </div>
                </>
              )}
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

        {/* Created key dialog */}
        <Dialog open={!!createdKey} onOpenChange={() => setCreatedKey(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>API 密钥已创建</DialogTitle>
              <DialogDescription>请复制此密钥。您也可以随时在密钥列表中点击「查看」来查看。</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-lg bg-muted p-4">
                <code className="text-sm break-all">{createdKey}</code>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCopy}>
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {copied ? '已复制！' : '复制到剪贴板'}
                </Button>
                <Button onClick={() => setCreatedKey(null)}>完成</Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        {/* Revoke confirmation */}
        <AlertDialog open={!!revokeTarget} onOpenChange={() => setRevokeTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>撤销 API 密钥</AlertDialogTitle>
              <AlertDialogDescription>
                确定要撤销 &quot;{revokeTarget?.name}&quot; 吗？此操作无法撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handleRevoke} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                撤销
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除 API 密钥</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除 &quot;{deleteTarget?.name}&quot; 吗？此操作不可撤销。
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
            type="api_key"
            id={quotaTarget.id}
            label={`API 密钥: ${quotaTarget.name} (#${quotaTarget.id})`}
          />
        )}

        {/* Model policy config */}
        {modelPolicyTarget && (
          <ModelPolicyDialog
            open={!!modelPolicyTarget}
            onOpenChange={(open) => { if (!open) setModelPolicyTarget(null); }}
            apiKey={modelPolicyTarget}
            onSaved={load}
          />
        )}

        {/* UA allow/block list */}
        {uaTarget && (
          <UaPolicyDialog
            open={!!uaTarget}
            onOpenChange={(open) => { if (!open) setUaTarget(null); }}
            type="api_key"
            id={uaTarget.id}
            label={`API 密钥: ${uaTarget.name} (#${uaTarget.id})`}
          />
        )}

        {/* Edit dialog */}
        <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑 API 密钥</DialogTitle>
              <DialogDescription>
                修改密钥的名称与过期时间{editTarget?.mode === 'dedicated' ? '，或重新绑定服务商 / 轮换上游密钥' : ''}。
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleEdit} className="space-y-4">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input required value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="我的 API 密钥" />
              </div>
              <div className="space-y-2">
                <Label>过期时间（可选，留空则永不过期）</Label>
                <Input type="datetime-local" value={editForm.expiresAt} onChange={(e) => setEditForm({ ...editForm, expiresAt: e.target.value })} />
              </div>
              {editTarget?.mode === 'dedicated' && (
                <>
                  <div className="space-y-2">
                    <Label>服务商 *</Label>
                    <InlineCombobox
                      options={providerList.filter((p) => p.isActive).map((p) => ({
                        value: String(p.id),
                        label: p.name,
                        suffix: p.apiType === 'anthropic' ? 'Anthropic' : 'OpenAI',
                      }))}
                      value={editForm.providerId}
                      onChange={(v) => setEditForm({ ...editForm, providerId: v })}
                      placeholder="选择服务商..."
                      searchPlaceholder="搜索服务商..."
                      emptyText="未找到服务商"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>上游 API 密钥</Label>
                    <Input
                      type="password"
                      value={editForm.upstreamApiKey}
                      onChange={(e) => setEditForm({ ...editForm, upstreamApiKey: e.target.value })}
                      placeholder="留空保持不变；输入新值则替换"
                    />
                    <p className="text-xs text-muted-foreground">一对一转发使用的上游凭证，留空不修改</p>
                  </div>
                </>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>取消</Button>
                <Button type="submit" disabled={savingEdit || !editForm.name}>
                  {savingEdit && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {savingEdit ? '保存中...' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
