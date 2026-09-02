'use client';

import { useState, useEffect } from 'react';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { InlineMultiCombobox } from '@/components/inline-multi-combobox';
import type { ComboboxOption } from '@/components/inline-combobox';
import { getQuotaStatus, listModels, updateApiKey } from '@/lib/api';
import { tokensToMillions, millionsToTokens } from '@/lib/utils';
import type { ApiKey, ModelLimit, VirtualModel } from '@/lib/types';

interface ModelPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: ApiKey;
  onSaved: () => void;
}

type PolicyMode = 'all' | 'allow' | 'block';

const MODE_ALL = '__all__';

interface QuotaUsageRow {
  model: string;
  todayTokens: number;
  monthTokens: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Per-key model policy editor: allow/block list + per-model daily/monthly
 * token limits (allow mode only — limits on blocked models are inert since
 * the list check rejects the model first).
 */
export function ModelPolicyDialog({ open, onOpenChange, apiKey, onSaved }: ModelPolicyDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // '__all__' sentinel = no restriction (keeps the Select always populated)
  const [policyMode, setPolicyMode] = useState<string>(MODE_ALL);
  const [selected, setSelected] = useState<string[]>([]);
  // per-model limit inputs in MILLIONS of tokens; '' = unlimited
  const [limitsForm, setLimitsForm] = useState<Record<string, { daily: string; monthly: string }>>({});
  const [modelRows, setModelRows] = useState<VirtualModel[]>([]);
  // per-model usage from the quota endpoint (limits-configured ∪ used this month)
  const [usageRows, setUsageRows] = useState<QuotaUsageRow[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);

    Promise.all([getQuotaStatus('api_keys', apiKey.id), listModels()])
      .then(([status, models]) => {
        if (cancelled) return;

        const policy = status.modelPolicy ?? apiKey.permissions?.modelPolicy ?? null;
        setPolicyMode(policy?.mode ?? MODE_ALL);
        setSelected(policy?.models ?? []);
        const nextLimits: Record<string, { daily: string; monthly: string }> = {};
        const policyLimits = (policy?.limits ?? {}) as Record<string, ModelLimit>;
        for (const [model, limit] of Object.entries(policyLimits)) {
          nextLimits[model] = {
            daily: limit?.dailyTokens != null ? tokensToMillions(limit.dailyTokens) : '',
            monthly: limit?.monthlyTokens != null ? tokensToMillions(limit.monthlyTokens) : '',
          };
        }
        setLimitsForm(nextLimits);
        setModelRows(models);
        setUsageRows(status.models ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setPolicyMode(MODE_ALL);
        setSelected([]);
        setLimitsForm({});
        setUsageRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, apiKey]);

  // Options = all virtual models ∪ names already in the policy (a configured
  // model may since have been deleted — keep it listed so it stays removable).
  const options = (() => {
    const known: ComboboxOption[] = modelRows.map((m) => ({
      value: m.modelId,
      label: m.displayName || m.modelId,
      suffix: m.provider,
    }));
    const knownSet = new Set(known.map((o) => o.value));
    for (const value of selected) {
      if (!knownSet.has(value)) known.push({ value, label: value });
    }
    return known;
  })();

  const mode = policyMode === MODE_ALL ? null : (policyMode as PolicyMode);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // PATCH replaces permissions wholesale — merge so unknown future keys
      // survive; picking "全部可用" drops modelPolicy entirely (the absent key
      // is the unrestricted default).
      const permissions: Record<string, unknown> = { ...(apiKey.permissions ?? {}) };
      if (mode === null) {
        delete permissions.modelPolicy;
      } else {
        const limits: Record<string, ModelLimit> = {};
        if (mode === 'allow') {
          for (const model of selected) {
            const row = limitsForm[model] ?? { daily: '', monthly: '' };
            const dailyTokens = millionsToTokens(row.daily);
            const monthlyTokens = millionsToTokens(row.monthly);
            if (dailyTokens != null || monthlyTokens != null) {
              limits[model] = { dailyTokens: dailyTokens ?? null, monthlyTokens: monthlyTokens ?? null };
            }
          }
        }
        permissions.modelPolicy = { mode, models: selected, limits };
      }
      await updateApiKey(apiKey.id, { permissions });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存模型限制失败');
    } finally {
      setSaving(false);
    }
  }

  function setLimit(model: string, field: 'daily' | 'monthly', value: string) {
    setLimitsForm((prev) => ({
      ...prev,
      [model]: { ...(prev[model] ?? { daily: '', monthly: '' }), [field]: value },
    }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>模型限制</DialogTitle>
          <DialogDescription>{apiKey.name}（{apiKey.keyPrefix}…）</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs">可用模型策略</Label>
              <Select value={policyMode} onValueChange={setPolicyMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MODE_ALL}>全部可用（默认，不限制）</SelectItem>
                  <SelectItem value="allow">仅允许指定模型</SelectItem>
                  <SelectItem value="block">仅禁用指定模型</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                一对一转发密钥不走虚拟模型，此配置对其无效。
              </p>
            </div>

            {mode !== null && (
              <div className="space-y-1">
                <Label className="text-xs">
                  {mode === 'allow' ? '允许的模型（未列出的将被拒绝）' : '禁用的模型（未列出的可用）'}
                </Label>
                <InlineMultiCombobox
                  options={options}
                  values={selected}
                  onChange={setSelected}
                  placeholder="选择模型..."
                  searchPlaceholder="搜索模型..."
                  emptyText="未找到模型"
                />
              </div>
            )}

            {mode === 'allow' && selected.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">
                  按模型用量上限 <span className="font-normal text-muted-foreground/70">（单位 M，留空不限制）</span>
                </p>
                <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-2">
                  {[...selected].sort().map((model) => (
                    <div key={model} className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2">
                      <span className="truncate font-mono text-xs" title={model}>{model}</span>
                      <Input
                        type="number"
                        min="0"
                        step="0.1"
                        value={limitsForm[model]?.daily ?? ''}
                        onChange={(e) => setLimit(model, 'daily', e.target.value)}
                        placeholder="日/M"
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.1"
                        value={limitsForm[model]?.monthly ?? ''}
                        onChange={(e) => setLimit(model, 'monthly', e.target.value)}
                        placeholder="月/M"
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {usageRows.length > 0 && (
              <div className="rounded-lg bg-muted p-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">各模型用量（今日 / 本月）</p>
                <div className="max-h-40 space-y-1 overflow-y-auto text-sm">
                  {usageRows.map((row) => (
                    <div key={row.model} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs" title={row.model}>{row.model}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatTokens(row.todayTokens)} / {formatTokens(row.monthTokens)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saving ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
