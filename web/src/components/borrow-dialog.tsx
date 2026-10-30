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
import { Loader2, ArrowLeftRight, Undo2 } from 'lucide-react';
import { InlineCombobox } from '@/components/inline-combobox';
import { listApiKeys, listProviders, borrowUpstreamKey, restoreUpstreamKey } from '@/lib/api';
import { formatDateTime, toBeijingDateTimeLocal } from '@/lib/utils';
import type { ApiKey, Provider } from '@/lib/types';

interface BorrowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: ApiKey;
  onSaved: () => void;
}

type SourceMode = 'source' | 'manual';

/** 到期时间快捷档位：从开始时间（缺省=现在）起算。 */
const QUICK_DURATIONS: { label: string; ms: number }[] = [
  { label: '1小时', ms: 3_600_000 },
  { label: '2小时', ms: 7_200_000 },
  { label: '4小时', ms: 14_400_000 },
  { label: '8小时', ms: 28_800_000 },
  { label: '1天', ms: 86_400_000 },
  { label: '2天', ms: 172_800_000 },
  { label: '3天', ms: 259_200_000 },
  { label: '1周', ms: 604_800_000 },
];

/**
 * 一对一 key 的上游借调编辑器：原上游 key 额度耗尽时临时借用其他上游凭证。
 * 支持从其他一对一密钥借（复制其当前生效凭证快照）或手动指定服务商 + key；
 * 开始时间默认立即、可预约未来；到期时间支持快捷档位（从开始时间起算）或
 * 手动填写，可空（不限期，直到手动还原）。已处于借调中时显示状态卡 + 立即还原。
 */
export function BorrowDialog({ open, onOpenChange, apiKey, onSaved }: BorrowDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('source');
  const [sourceKeyId, setSourceKeyId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [upstreamApiKey, setUpstreamApiKey] = useState('');
  const [startAt, setStartAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [allowCross, setAllowCross] = useState(false);
  const [dedicatedKeys, setDedicatedKeys] = useState<ApiKey[]>([]);
  const [providerList, setProviderList] = useState<Provider[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSourceMode('source');
    setSourceKeyId('');
    setProviderId('');
    setUpstreamApiKey('');
    setStartAt('');
    setExpiresAt('');
    setNote('');
    setAllowCross(false);

    Promise.all([
      listApiKeys({ mode: 'dedicated', pageSize: 200 }),
      listProviders(),
    ])
      .then(([keysRes, providers]) => {
        if (cancelled) return;
        setDedicatedKeys(keysRes.data.filter((k) => k.id !== apiKey.id));
        setProviderList(providers);
      })
      .catch(() => {
        if (cancelled) return;
        setDedicatedKeys([]);
        setProviderList([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, apiKey.id]);

  /** 快捷档位基准：开始时间（datetime-local 是北京墙上钟）缺省=现在。 */
  function applyQuickDuration(ms: number) {
    const base = startAt ? new Date(startAt + '+08:00') : new Date();
    setExpiresAt(toBeijingDateTimeLocal(new Date(base.getTime() + ms)));
  }

  async function handleRestore() {
    setRestoring(true);
    try {
      await restoreUpstreamKey(apiKey.id);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : '还原失败');
    } finally {
      setRestoring(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const data: {
      sourceKeyId?: number;
      allowCrossProvider?: boolean;
      providerId?: number;
      upstreamApiKey?: string;
      startAt?: string | null;
      expiresAt?: string | null;
      note?: string;
    } = {};
    if (sourceMode === 'source') {
      if (!sourceKeyId) {
        alert('请选择要借用的一对一密钥');
        return;
      }
      data.sourceKeyId = parseInt(sourceKeyId);
      if (allowCross) data.allowCrossProvider = true;
    } else {
      if (!providerId) {
        alert('手动借调需要选择服务商');
        return;
      }
      if (!providerHasDefaultKey && !upstreamApiKey) {
        alert('该服务商未配置默认上游密钥，请填写上游 API 密钥');
        return;
      }
      data.providerId = parseInt(providerId);
      // 密钥留空 → 后端取该服务商的默认密钥
      if (upstreamApiKey) data.upstreamApiKey = upstreamApiKey;
    }
    // 与创建/编辑密钥一致：datetime-local 按北京时间提交；留空分别表示立即开始 / 不限期
    if (startAt) data.startAt = startAt + '+08:00';
    if (expiresAt) data.expiresAt = expiresAt + '+08:00';
    if (note.trim()) data.note = note.trim();

    setSaving(true);
    try {
      await borrowUpstreamKey(apiKey.id, data);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : '设置借调失败');
    } finally {
      setSaving(false);
    }
  }

  const borrow = apiKey.borrow ?? null;

  // 手动模式：所选服务商是否配了默认密钥（providers.api_key_enc）。没配的
  // 服务商密钥必填——留空提交会被后端 400「该服务商未配置默认上游密钥」。
  const selectedProvider = providerList.find((p) => String(p.id) === providerId);
  const providerHasDefaultKey = !!selectedProvider?.apiKeyEnc;

  // 来源下拉默认只列「借出时生效服务商与当前密钥相同」的密钥（防呆：跨服务商
  // 透传请求体协议不匹配）。勾选开关后才显示全部。
  const visibleSourceKeys = allowCross
    ? dedicatedKeys
    : dedicatedKeys.filter((k) => (k.borrow?.active ? k.borrow.providerId : k.providerId) === apiKey.providerId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>上游借调</DialogTitle>
          <DialogDescription>
            {apiKey.name}（#{apiKey.id}）当前绑定服务商：{apiKey.provider?.name ?? '—'}
            。借调期间请求改用借来的凭证，原密钥不受影响，可随时还原。
          </DialogDescription>
        </DialogHeader>

        {borrow && (
          <div className={`rounded-lg border p-3 space-y-1.5 ${borrow.active ? 'border-amber-300 bg-amber-50' : 'border-muted bg-muted'}`}>
            <p className="text-sm font-medium">
              {borrow.active ? '借调中' : borrow.scheduled ? '已预约借调' : '借调已过期'} → {borrow.providerName ?? `服务商 #${borrow.providerId}`}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                （{borrow.mode === 'provider' ? '网关协议转换' : '原样透传'}）
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {borrow.fromKeyId != null
                ? <>借自 {borrow.fromKeyName ?? `密钥 #${borrow.fromKeyId}`}；</>
                : <>手动指定；</>}
              {borrow.startedAt && <>{borrow.scheduled ? '将于' : '开始于'} {formatDateTime(borrow.startedAt)}；</>}
              {borrow.expiresAt
                ? <>到期 {formatDateTime(borrow.expiresAt)}{borrow.active ? '，到期自动还原' : borrow.scheduled ? '，到期后自动还原' : '，将在下次请求时自动还原'}</>
                : '不限期，直到手动还原'}
            </p>
            {borrow.note && <p className="text-xs text-muted-foreground">备注：{borrow.note}</p>}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1"
              disabled={restoring}
              onClick={handleRestore}
            >
              {restoring ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Undo2 className="mr-1 h-4 w-4" />}
              立即还原为原密钥
            </Button>
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label>借调来源</Label>
            <Select value={sourceMode} onValueChange={(v) => setSourceMode(v as SourceMode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="source">从其他一对一密钥借用</SelectItem>
                <SelectItem value="manual">手动指定服务商与密钥</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {sourceMode === 'source' ? (
            <div className="space-y-2">
              <Label>来源密钥 *</Label>
              <p className="text-xs text-muted-foreground -mt-1">
                原样透传（一对一模式不变）：按客户端实际调用原样转发（路径、请求体均照旧，与原绑定服务商无关），跨服务商时客户端调用方式与借来上游的兼容性需自行确认（需协议转换请用「手动指定服务商」）
              </p>
              <InlineCombobox
                options={visibleSourceKeys.map((k) => {
                  const effProviderId = k.borrow?.active ? k.borrow.providerId : k.providerId;
                  const effProviderName = k.borrow?.active
                    ? (k.borrow.providerName ?? `#${k.borrow.providerId}`)
                    : (k.provider?.name ?? '未绑定');
                  return {
                    value: String(k.id),
                    label: k.name,
                    suffix:
                      effProviderId !== apiKey.providerId
                        ? `#${k.id} · ${effProviderName} · 跨服务商`
                        : `#${k.id} · ${effProviderName}`,
                  };
                })}
                value={sourceKeyId}
                onChange={setSourceKeyId}
                placeholder="选择要借用的一对一密钥..."
                searchPlaceholder="搜索密钥名..."
                emptyText={allowCross ? '没有其他一对一密钥' : '没有同服务商的其他一对一密钥，可勾选下方跨服务商'}
              />
              <p className="text-xs text-muted-foreground">
                借用该密钥当前生效的上游凭证快照（若其自身也在借调中，借出的是它正在用的凭证）
              </p>
              <div className="flex items-center gap-2 pt-1">
                <input
                  id="allowCrossProvider"
                  type="checkbox"
                  checked={allowCross}
                  onChange={(e) => {
                    setAllowCross(e.target.checked);
                    // 关闭开关时清掉已选的跨服务商来源，避免提交被后端 400
                    if (!e.target.checked && sourceKeyId) {
                      const sel = dedicatedKeys.find((k) => k.id === parseInt(sourceKeyId));
                      const selProvider = sel?.borrow?.active ? sel.borrow.providerId : sel?.providerId;
                      if (selProvider !== apiKey.providerId) setSourceKeyId('');
                    }
                  }}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                <Label htmlFor="allowCrossProvider" className="cursor-pointer text-sm font-normal">
                  允许选择不同服务商的密钥
                </Label>
              </div>
              {allowCross && (
                <p className="text-xs text-amber-700">
                  跨服务商借用仍走原样透传（一对一模式不变）：按客户端实际调用原样转发（与原绑定服务商无关），客户端的调用方式需与借来上游兼容，否则会被拒（如 OpenAI 协议请求打到 Anthropic 端点会 4xx）；如需网关自动协议转换，请改用「手动指定服务商」方式借调
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>服务商 *</Label>
                <p className="text-xs text-muted-foreground -mt-1">
                  走网关协议转换（同普通密钥）：请求路径须为 /openai/v1/* 或 /anthropic/v1/messages，model 须为该服务商已登记的虚拟模型，跨协议由网关自动转换
                </p>
                <InlineCombobox
                  options={providerList.filter((p) => p.isActive).map((p) => ({
                    value: String(p.id),
                    label: p.name,
                    suffix: p.apiType === 'anthropic' ? 'Anthropic' : 'OpenAI',
                  }))}
                  value={providerId}
                  onChange={setProviderId}
                  placeholder="选择服务商..."
                  searchPlaceholder="搜索服务商..."
                  emptyText="未找到服务商"
                />
              </div>
              <div className="space-y-2">
                <Label>
                  上游 API 密钥{providerId && !providerHasDefaultKey ? ' *' : '（留空则使用该服务商的默认密钥）'}
                </Label>
                <Input
                  required={!!providerId && !providerHasDefaultKey}
                  type="password"
                  value={upstreamApiKey}
                  onChange={(e) => setUpstreamApiKey(e.target.value)}
                  placeholder={
                    providerId && !providerHasDefaultKey
                      ? 'sk-...（该服务商未配置默认密钥，必填）'
                      : 'sk-...（留空使用服务商默认密钥）'
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {providerId && !providerHasDefaultKey
                    ? '该服务商未配置默认密钥，此处必填'
                    : '借用开始时取服务商当前配置的默认密钥快照，之后轮换不影响进行中的借调'}
                </p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label>开始时间（可选，不填则立即开始）</Label>
            <Input
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              可提前预约：未到开始时间前请求仍走原上游密钥，到点后自动切换
            </p>
          </div>

          <div className="space-y-2">
            <Label>到期时间（可选，不填则直到手动还原）</Label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_DURATIONS.map((d) => (
                <Button
                  key={d.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => applyQuickDuration(d.ms)}
                >
                  {d.label}
                </Button>
              ))}
            </div>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              快捷档位按开始时间起算填充；到期后该密钥自动恢复使用原上游凭证（最迟在下次请求时生效）
            </p>
          </div>

          <div className="space-y-2">
            <Label>备注（可选）</Label>
            <Input
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如：向张三借用到月底"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={saving || loading}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowLeftRight className="mr-2 h-4 w-4" />}
              {borrow?.active || borrow?.scheduled ? '替换借调' : '开始借调'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
