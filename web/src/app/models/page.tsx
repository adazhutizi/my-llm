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
import { listModels, createModel, updateModel, deleteModel, listProviders } from '@/lib/api';
import type { VirtualModel, Provider } from '@/lib/types';
import { Loader2, Search, ScrollText, PieChart } from 'lucide-react';
import { useRouter } from 'next/navigation';

const emptyForm = {
  modelId: '',
  displayName: '',
  provider: '',
  realModel: '',
  fallbacks: '',
  isActive: true,
};

export default function ModelsPage() {
  const router = useRouter();
  const [models, setModels] = useState<VirtualModel[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Dialog state
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<VirtualModel | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<VirtualModel | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [modelData, providerData] = await Promise.all([
        listModels(),
        listProviders(),
      ]);
      setModels(modelData);
      setProviders(providerData.filter((p) => p.isActive));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载模型列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Front-end filter: models are loaded in full (no pagination), so filter the
  // in-memory list directly. Matching is case-insensitive across the visible text fields.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) =>
      m.modelId.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      m.realModel.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q),
    );
  }, [models, search]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setShowDialog(true);
  }

  function openEdit(model: VirtualModel) {
    setEditing(model);
    setForm({
      modelId: model.modelId,
      displayName: model.displayName,
      provider: model.provider,
      realModel: model.realModel,
      fallbacks: model.fallbacks?.join(', ') ?? '',
      isActive: model.isActive,
    });
    setShowDialog(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const fallbacks = form.fallbacks
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const payload = {
        modelId: form.modelId,
        displayName: form.displayName,
        provider: form.provider,
        realModel: form.realModel,
        fallbacks: fallbacks.length > 0 ? fallbacks : null,
        isActive: form.isActive,
      };

      if (editing) {
        await updateModel(editing.id, payload);
      } else {
        await createModel(payload);
      }

      setShowDialog(false);
      setEditing(null);
      setForm(emptyForm);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存模型失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteModel(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除模型失败');
    }
  }

  async function toggleActive(model: VirtualModel) {
    try {
      await updateModel(model.id, { isActive: !model.isActive });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : '切换模型状态失败');
    }
  }

  const columns = [
    {
      key: 'modelId',
      header: '模型 ID',
      render: (m: VirtualModel) => <span className="font-mono">{m.modelId}</span>,
    },
    {
      key: 'displayName',
      header: '显示名称',
    },
    {
      key: 'provider',
      header: '服务商',
      render: (m: VirtualModel) => <span className="font-medium">{m.provider}</span>,
    },
    {
      key: 'realModel',
      header: '实际模型',
      render: (m: VirtualModel) => <span className="font-mono text-sm">{m.realModel}</span>,
    },
    {
      key: 'status',
      header: '状态',
      render: (m: VirtualModel) => (
        <StatusBadge status={m.isActive ? 'active' : 'disabled'} />
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (m: VirtualModel) => (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); openEdit(m); }}
          >
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/reports?model=${encodeURIComponent(m.modelId)}`); }}
          >
            <PieChart className="mr-1 h-4 w-4" />
            报表
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/logs?model=${encodeURIComponent(m.modelId)}`); }}
          >
            <ScrollText className="mr-1 h-4 w-4" />
            日志
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={m.isActive ? 'text-destructive hover:text-destructive' : 'text-green-600 hover:text-green-700'}
            onClick={(e) => { e.stopPropagation(); toggleActive(m); }}
          >
            {m.isActive ? '禁用' : '启用'}
          </Button>
          {!m.isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); setDeleteTarget(m); }}
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
          <Button onClick={openCreate}>添加模型</Button>
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
            placeholder="搜索模型 ID、名称、实际模型或服务商..."
            className="pl-9"
          />
        </div>

        <DataTable
          columns={columns}
          data={filtered}
          loading={loading}
          emptyMessage="暂无虚拟模型配置。"
          keyExtractor={(item) => item.id}
        />

        {/* Create / Edit dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? '编辑模型' : '添加模型'}</DialogTitle>
              <DialogDescription>
                {editing ? '更新虚拟模型配置。' : '添加新的虚拟模型映射。'}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="modelId">模型 ID</Label>
                <Input
                  id="modelId"
                  required
                  disabled={!!editing}
                  value={form.modelId}
                  onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                  placeholder="gpt-4o"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="displayName">显示名称</Label>
                <Input
                  id="displayName"
                  required
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                  placeholder="GPT-4o"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="provider">服务商</Label>
                  <Select
                    value={form.provider}
                    onValueChange={(value) => setForm({ ...form, provider: value })}
                  >
                    <SelectTrigger id="provider">
                      <SelectValue placeholder="选择服务商" />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={p.name}>
                          <span className="flex items-center gap-2">
                            {p.name}
                            <span className={`text-xs ${p.apiType === 'anthropic' ? 'text-purple-500' : 'text-emerald-500'}`}>
                              ({p.apiType === 'anthropic' ? 'Anthropic' : 'OpenAI'})
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="realModel">实际模型</Label>
                  <Input
                    id="realModel"
                    required
                    value={form.realModel}
                    onChange={(e) => setForm({ ...form, realModel: e.target.value })}
                    placeholder="gpt-4o-2024-05-13"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fallbacks">备选模型（逗号分隔）</Label>
                <Input
                  id="fallbacks"
                  value={form.fallbacks}
                  onChange={(e) => setForm({ ...form, fallbacks: e.target.value })}
                  placeholder="claude-3-sonnet, gemini-pro"
                />
                <p className="text-xs text-muted-foreground">备选模型 ID 列表，用逗号分隔</p>
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="isActive">启用</Label>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
                <Button type="submit" disabled={saving || !form.modelId || !form.displayName || !form.provider || !form.realModel}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {editing ? '更新' : '创建'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除模型</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除此虚拟模型吗？
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
