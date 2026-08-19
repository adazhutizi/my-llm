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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { getEntityRateLimit, setEntityRateLimit, getQuotaStatus } from '@/lib/api';
import { tokensToMillions, millionsToTokens } from '@/lib/utils';
import type { QuotaStatus } from '@/lib/types';

interface QuotaConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'app' | 'user' | 'api_key';
  id: number;
  label: string;
}

const TYPE_MAP = { app: 'apps', user: 'users', api_key: 'api_keys' } as const;

export function QuotaConfigDialog({ open, onOpenChange, type, id, label }: QuotaConfigDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    rpm: '',
    qps: '',
    dailyTokens: '',
    monthlyTokens: '',
  });
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getEntityRateLimit(type, id),
      getQuotaStatus(TYPE_MAP[type], id),
    ])
      .then(([config, status]) => {
        if (cancelled) return;
        if (config) {
          setForm({
            rpm: config.rpm ? String(config.rpm) : '',
            qps: config.qps ? String(config.qps) : '',
            dailyTokens: config.dailyTokens ? tokensToMillions(config.dailyTokens) : '',
            monthlyTokens: config.monthlyTokens ? tokensToMillions(config.monthlyTokens) : '',
          });
        } else {
          setForm({ rpm: '', qps: '', dailyTokens: '', monthlyTokens: '' });
        }
        setQuota(status);
      })
      .catch(() => {
        if (!cancelled) {
          setForm({ rpm: '', qps: '', dailyTokens: '', monthlyTokens: '' });
          setQuota(null);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, type, id]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const data: Record<string, number | null> = {};
      if (form.rpm) data.rpm = parseInt(form.rpm);
      if (form.qps) data.qps = parseInt(form.qps);
      const dailyTokens = millionsToTokens(form.dailyTokens);
      if (dailyTokens != null) data.dailyTokens = dailyTokens;
      const monthlyTokens = millionsToTokens(form.monthlyTokens);
      if (monthlyTokens != null) data.monthlyTokens = monthlyTokens;
      await setEntityRateLimit(type, id, data);
      onOpenChange(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存配额失败');
    } finally {
      setSaving(false);
    }
  }

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>配额设置</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            {/* Current usage */}
            {quota && (
              <div className="rounded-lg bg-muted p-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">当前用量</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">今日 Tokens：</span>
                    <span className="font-medium">{formatTokens(Number(quota.usage.today.tokens))}</span>
                    {quota.usage.today.percentage != null && (
                      <span className="ml-1 text-xs text-muted-foreground">({quota.usage.today.percentage}%)</span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">本月 Tokens：</span>
                    <span className="font-medium">{formatTokens(Number(quota.usage.month.tokens))}</span>
                    {quota.usage.month.percentage != null && (
                      <span className="ml-1 text-xs text-muted-foreground">({quota.usage.month.percentage}%)</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Rate limits */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground">频率限制</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">RPM（每分钟请求数）</Label>
                  <Input type="number" min="0" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} placeholder="不限制" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">QPS（每秒请求数）</Label>
                  <Input type="number" min="0" value={form.qps} onChange={(e) => setForm({ ...form, qps: e.target.value })} placeholder="不限制" />
                </div>
              </div>
            </div>

            {/* Token limits */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground">
                Token 上限 <span className="font-normal text-muted-foreground/70">（单位 M，1M = 100万 tokens）</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">每日 Tokens</Label>
                  <Input type="number" min="0" step="0.1" value={form.dailyTokens} onChange={(e) => setForm({ ...form, dailyTokens: e.target.value })} placeholder="不限制" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">每月 Tokens</Label>
                  <Input type="number" min="0" step="0.1" value={form.monthlyTokens} onChange={(e) => setForm({ ...form, monthlyTokens: e.target.value })} placeholder="不限制" />
                </div>
              </div>
            </div>

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
