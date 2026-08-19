'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
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
import { listProviders, createProvider, updateProvider, deleteProvider } from '@/lib/api';
import type { Provider } from '@/lib/types';
import { Loader2, Search, ScrollText, PieChart } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/utils';

export default function ProvidersPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Create / Edit dialog
  const [editing, setEditing] = useState<Provider | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', apiType: 'openai' as 'openai' | 'anthropic', baseUrl: '', apiKey: '', estimateFallback: false });
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null);

  const isEditing = editing !== null;
  const showDialog = showCreate || isEditing;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listProviders();
      setProviders(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载服务商列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Front-end filter: providers are loaded in full (no pagination), so filter
  // the in-memory list directly. Case-insensitive across name / baseUrl / apiType.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.baseUrl.toLowerCase().includes(q) ||
      (p.apiType ?? '').toLowerCase().includes(q),
    );
  }, [providers, search]);

  function openCreate() {
    setEditing(null);
    setForm({ name: '', apiType: 'openai', baseUrl: '', apiKey: '', estimateFallback: false });
    setShowCreate(true);
  }

  function openEdit(provider: Provider) {
    setShowCreate(false);
    setEditing(provider);
    setForm({ name: provider.name, apiType: provider.apiType ?? 'openai', baseUrl: provider.baseUrl, apiKey: '', estimateFallback: provider.config?.estimateFallback === true });
  }

  function closeDialog() {
    setShowCreate(false);
    setEditing(null);
    setForm({ name: '', apiType: 'openai', baseUrl: '', apiKey: '', estimateFallback: false });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // Merge the toggle into the provider's existing config object so we
      // don't clobber sibling keys (timeout / maxRetries / ...).
      const config = { ...(editing?.config ?? {}), estimateFallback: form.estimateFallback };
      if (isEditing) {
        const payload: { name: string; apiType: 'openai' | 'anthropic'; baseUrl: string; apiKey?: string; config: Record<string, unknown> } = {
          name: form.name,
          apiType: form.apiType,
          baseUrl: form.baseUrl,
          config,
        };
        if (form.apiKey) payload.apiKey = form.apiKey;
        await updateProvider(editing!.id, payload);
      } else {
        await createProvider({
          name: form.name,
          apiType: form.apiType,
          baseUrl: form.baseUrl,
          apiKey: form.apiKey || undefined,
          config,
        });
      }
      closeDialog();
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存服务商失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(provider: Provider) {
    try {
      await updateProvider(provider.id, { isActive: !provider.isActive });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '切换服务商状态失败');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteProvider(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除服务商失败');
    }
  }

  const columns = [
    {
      key: 'name',
      header: '名称',
      render: (p: Provider) => <span className="font-medium">{p.name}</span>,
    },
    {
      key: 'apiType',
      header: 'API 类型',
      render: (p: Provider) => (
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
          (p.apiType ?? 'openai') === 'openai'
            ? 'bg-emerald-50 text-emerald-700'
            : 'bg-purple-50 text-purple-700'
        }`}>
          {p.apiType === 'anthropic' ? 'Anthropic' : 'OpenAI'}
        </span>
      ),
    },
    {
      key: 'baseUrl',
      header: '接口地址',
      render: (p: Provider) => <span className="font-mono text-sm text-muted-foreground">{p.baseUrl}</span>,
    },
    {
      key: 'status',
      header: '状态',
      render: (p: Provider) => <StatusBadge status={p.isActive ? 'active' : 'disabled'} />,
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (p: Provider) => formatDate(p.createdAt),
    },
    {
      key: 'actions',
      header: '',
      render: (p: Provider) => (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); openEdit(p); }}
          >
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/reports?provider=${encodeURIComponent(p.name)}`); }}
          >
            <PieChart className="mr-1 h-4 w-4" />
            报表
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/logs?provider=${encodeURIComponent(p.name)}`); }}
          >
            <ScrollText className="mr-1 h-4 w-4" />
            日志
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={p.isActive ? 'text-destructive hover:text-destructive' : 'text-green-600 hover:text-green-700'}
            onClick={(e) => { e.stopPropagation(); toggleActive(p); }}
          >
            {p.isActive ? '禁用' : '启用'}
          </Button>
          {!p.isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }}
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
          <Button onClick={openCreate}>添加服务商</Button>
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
            placeholder="搜索名称、接口地址或类型..."
            className="pl-9"
          />
        </div>

        <DataTable
          columns={columns}
          data={filtered}
          loading={loading}
          emptyMessage="暂无服务商配置。"
          keyExtractor={(item) => item.id}
        />

        {/* Create / Edit dialog */}
        <Dialog open={showDialog} onOpenChange={() => closeDialog()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{isEditing ? '编辑服务商' : '添加服务商'}</DialogTitle>
              <DialogDescription>
                {isEditing ? '更新服务商配置。' : '添加新的 LLM 服务商端点。'}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="OpenAI"
                  disabled={isEditing}
                />
              </div>
              <div className="space-y-2">
                <Label>API 类型</Label>
                <Select
                  value={form.apiType}
                  onValueChange={(value) => setForm({ ...form, apiType: value as 'openai' | 'anthropic' })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI 兼容</SelectItem>
                    <SelectItem value="anthropic">Anthropic 兼容</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  选择服务商支持的 API 协议类型
                </p>
              </div>
              <div className="space-y-2">
                <Label>接口地址</Label>
                <Input
                  required
                  type="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div className="space-y-2">
                <Label>API 密钥</Label>
                <Input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder="sk-..."
                />
                {isEditing && (
                  <p className="text-xs text-muted-foreground">留空则保持不变</p>
                )}
              </div>
              <div className="flex items-start space-x-2">
                <input
                  type="checkbox"
                  id="estimateFallback"
                  checked={form.estimateFallback}
                  onChange={(e) => setForm({ ...form, estimateFallback: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                />
                <div className="space-y-0.5">
                  <Label htmlFor="estimateFallback">启用 Token 估算回退</Label>
                  <p className="text-xs text-muted-foreground">
                    上游不返回用量时按字符估算（对英文/代码流量可能偏高）。默认关闭，仅按上游真实用量计费。
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeDialog}>取消</Button>
                <Button type="submit" disabled={saving || !form.name || !form.baseUrl}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {isEditing ? '更新' : '创建'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除服务商</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除此服务商吗？
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
