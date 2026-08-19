'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppLayout } from '@/components/layout';
import { DataTable } from '@/components/data-table';
import { StatCard } from '@/components/stat-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listApps, getFeatureUsage, listFeatures, updateFeature } from '@/lib/api';
import type { App, Feature, FeatureUsage } from '@/lib/types';
import { Tag, Zap, Send, Loader2, Pencil, Check, X, ScrollText, PieChart } from 'lucide-react';
import { cn, beijingTodayStart, toBeijingDate } from '@/lib/utils';

function defaultDates() {
  // Beijing-day boundaries: the backend parses the naive date string as CST,
  // so defaults must be Beijing wall-clock dates. Window is the last 7
  // Beijing days.
  const today = beijingTodayStart();
  const start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    startDate: toBeijingDate(start),
    endDate: toBeijingDate(today),
  };
}

function FeatureUsageContent() {
  const router = useRouter();
  // Read preset search from the URL (?featureId=) so deep links from other
  // pages land pre-filtered. useSearchParams forces client-side rendering under
  // static export, hence the <Suspense> boundary in the default export below.
  const searchParams = useSearchParams();
  const defaults = defaultDates();
  // App selection
  const [apps, setApps] = useState<App[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string>('');

  // Feature selection (loaded per app)
  const [appFeatures, setAppFeatures] = useState<Feature[]>([]);

  // All features across apps (for display name lookup when no app selected)
  const [allFeaturesMap, setAllFeaturesMap] = useState<Map<string, { displayName: string | null; appId: number }>>(new Map());

  // Filters
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [appUserId, setAppUserId] = useState('');
  const [search, setSearch] = useState(searchParams.get('featureId') ?? '');

  // Data
  const [usageData, setUsageData] = useState<FeatureUsage[]>([]);
  const [summary, setSummary] = useState<{ totalTokens: number; totalRequests: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Inline editing state
  const [editingKey, setEditingKey] = useState<string | null>(null); // "appId:featureId"
  const [editValue, setEditValue] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Load apps on mount
  useEffect(() => {
    listApps({ pageSize: 100 })
      .then(async (res) => {
        setApps(res.data);
        // Load features for all apps to build a global name map
        const map = new Map<string, { displayName: string | null; appId: number }>();
        for (const app of res.data) {
          try {
            const features = await listFeatures(app.id);
            for (const f of features) {
              map.set(`${app.id}:${f.featureId}`, { displayName: f.displayName, appId: app.id });
            }
          } catch {
            // skip failed app
          }
        }
        setAllFeaturesMap(map);
      })
      .catch(() => setError('加载应用列表失败'));
  }, []);

  // Load features when app selection changes
  const loadFeatures = useCallback(async () => {
    if (selectedAppId) {
      try {
        const res = await listFeatures(Number(selectedAppId));
        setAppFeatures(res);
      } catch {
        setAppFeatures([]);
      }
    } else {
      setAppFeatures([]);
    }
  }, [selectedAppId]);

  useEffect(() => {
    loadFeatures();
  }, [selectedAppId, loadFeatures]);

  // Build display name lookup: when app selected use appFeatures, otherwise use allFeaturesMap
  const getDisplayName = useCallback((appId: number | undefined, featureId: string): string | null => {
    if (selectedAppId) {
      return appFeatures.find((f) => f.featureId === featureId)?.displayName ?? null;
    }
    if (appId) {
      return allFeaturesMap.get(`${appId}:${featureId}`)?.displayName ?? null;
    }
    return null;
  }, [selectedAppId, appFeatures, allFeaturesMap]);

  // Load usage data when filters change
  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getFeatureUsage({
        appId: selectedAppId ? Number(selectedAppId) : undefined,
        appUserId: appUserId || undefined,
        search: search || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        page,
        pageSize: 20,
      });
      setUsageData(result.data);
      setTotal(result.total);
      if (result.summary) {
        setSummary({ totalTokens: result.summary.totalTokens, totalRequests: result.summary.totalRequests });
      } else {
        setSummary(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载用量数据失败');
    } finally {
      setLoading(false);
    }
  }, [selectedAppId, appUserId, search, startDate, endDate, page]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [selectedAppId, appUserId, search, startDate, endDate]);

  // Reload features map after edit
  const reloadFeatureNames = useCallback(async () => {
    if (selectedAppId) {
      await loadFeatures();
    }
    // Also refresh the global map for the edited app
    const map = new Map(allFeaturesMap);
    // Rebuild from all apps (simpler than partial update)
    for (const app of apps) {
      try {
        const features = await listFeatures(app.id);
        for (const f of features) {
          map.set(`${app.id}:${f.featureId}`, { displayName: f.displayName, appId: app.id });
        }
      } catch {
        // skip
      }
    }
    setAllFeaturesMap(map);
  }, [selectedAppId, loadFeatures, allFeaturesMap, apps]);

  function formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toLocaleString();
  }

  async function handleSaveNote(appId: number | undefined, featureId: string) {
    if (!appId) return;
    setEditSaving(true);
    try {
      await updateFeature(appId, featureId, editValue || null);
      setEditingKey(null);
      setEditValue('');
      await reloadFeatureNames();
    } catch {
      // Keep editing open on error
    } finally {
      setEditSaving(false);
    }
  }

  function startEditing(appId: number | undefined, featureId: string, currentName: string | null) {
    if (!appId) return;
    setEditingKey(`${appId}:${featureId}`);
    setEditValue(currentName || '');
  }

  const appNameMap = new Map(apps.map((a) => [a.id, a.name]));
  const showAppColumn = !selectedAppId;

  const columns = [
    {
      key: 'featureId',
      header: '功能标识',
      render: (item: FeatureUsage) => {
        const displayName = getDisplayName(item.appId, item.featureId);
        const editKey = item.appId ? `${item.appId}:${item.featureId}` : null;
        // editKey is null for rows without an appId (e.g. the gateway-internal
        // log-analysis feature billed to an admin key). The initial editingKey
        // is also null, so a bare `editingKey === editKey` makes every appId-less
        // row match and render in the inline-edit state on load. Guard with
        // editKey !== null so only a real edit key can be active.
        const isEditing = editKey !== null && editingKey === editKey;

        if (isEditing) {
          return (
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <Input
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                placeholder="输入备注名..."
                className="h-7 w-[140px] text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveNote(item.appId, item.featureId);
                  if (e.key === 'Escape') setEditingKey(null);
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={editSaving}
                onClick={() => handleSaveNote(item.appId, item.featureId)}
              >
                {editSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 text-green-600" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={editSaving}
                onClick={() => setEditingKey(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        }

        return (
          <div>
            {displayName ? (
              <div>
                <span className="font-medium text-sm">{displayName}</span>
                <span className="text-xs text-muted-foreground font-mono ml-1.5">({item.featureId})</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-sm bg-muted px-1.5 py-0.5 rounded">{item.featureId}</span>
                {item.appId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                    onClick={(e) => { e.stopPropagation(); startEditing(item.appId, item.featureId, null); }}
                  >
                    <Pencil className="h-3 w-3 mr-0.5" />
                    添加备注
                  </Button>
                )}
              </div>
            )}
            {displayName && item.appId && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-xs text-muted-foreground hover:text-foreground mt-0.5"
                onClick={(e) => { e.stopPropagation(); startEditing(item.appId, item.featureId, displayName); }}
              >
                <Pencil className="h-3 w-3 mr-0.5" />
                编辑
              </Button>
            )}
          </div>
        );
      },
    },
    ...(showAppColumn
      ? [
          {
            key: 'appId',
            header: '应用',
            render: (item: FeatureUsage) => (
              <span className="text-sm">{item.appId ? (appNameMap.get(item.appId) ?? `#${item.appId}`) : '-'}</span>
            ),
          },
        ]
      : []),
    {
      key: 'totalPromptTokens',
      header: 'Prompt Tokens',
      render: (item: FeatureUsage) => formatNumber(item.totalPromptTokens),
    },
    {
      key: 'totalCompletionTokens',
      header: 'Completion Tokens',
      render: (item: FeatureUsage) => formatNumber(item.totalCompletionTokens),
    },
    {
      key: 'totalCacheTokens',
      header: '缓存 Tokens',
      render: (item: FeatureUsage) => {
        const cache = (item.totalCacheReadTokens ?? 0) + (item.totalCacheCreationTokens ?? 0);
        return cache > 0 ? (
          <span className="text-amber-600 font-medium">{formatNumber(cache)}</span>
        ) : (
          '-'
        );
      },
    },
    {
      key: 'totalTokens',
      header: '总 Tokens',
      render: (item: FeatureUsage) => (
        <span className="font-semibold">{formatNumber(item.totalTokens)}</span>
      ),
    },
    {
      key: 'totalRequests',
      header: '请求次数',
      render: (item: FeatureUsage) => formatNumber(item.totalRequests),
    },
    {
      key: 'actions',
      header: '',
      render: (item: FeatureUsage) => (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/reports?featureId=${encodeURIComponent(item.featureId)}`); }}
          >
            <PieChart className="mr-1 h-4 w-4" />
            报表
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); router.push(`/logs?featureId=${encodeURIComponent(item.featureId)}`); }}
          >
            <ScrollText className="mr-1 h-4 w-4" />
            日志
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label>应用</Label>
          <Select value={selectedAppId || '__all__'} onValueChange={(v) => setSelectedAppId(v === '__all__' ? '' : v)}>
            <SelectTrigger className={cn('w-[200px]', !selectedAppId && 'text-muted-foreground')}>
              <SelectValue placeholder="全部应用" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部应用</SelectItem>
              {apps.map((app) => (
                <SelectItem key={app.id} value={String(app.id)}>
                  {app.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>用户标识</Label>
          <Input
            placeholder="user-123"
            value={appUserId}
            onChange={(e) => setAppUserId(e.target.value)}
            className="w-[160px]"
          />
        </div>

        <div className="space-y-2">
          <Label>功能标识或备注</Label>
          <Input
            placeholder="chat 或备注名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-[180px]"
          />
        </div>

        <div className="space-y-2">
          <Label>开始日期</Label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-[160px]"
          />
        </div>

        <div className="space-y-2">
          <Label>结束日期</Label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-[160px]"
          />
        </div>

        {(startDate || endDate) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setStartDate('');
              setEndDate('');
            }}
          >
            清除日期
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="功能数"
          value={total}
          icon={<Tag className="h-6 w-6" />}
        />
        <StatCard
          title="总 Tokens"
          value={formatNumber(summary?.totalTokens ?? 0)}
          icon={<Zap className="h-6 w-6" />}
        />
        <StatCard
          title="总请求数"
          value={formatNumber(summary?.totalRequests ?? 0)}
          icon={<Send className="h-6 w-6" />}
        />
      </div>

      {/* Usage Table */}
      <DataTable
        columns={columns}
        data={usageData}
        loading={loading}
        emptyMessage="暂无功能用量数据。请确保请求使用了 X-Feature-Id 请求头。"
        page={page}
        pageSize={20}
        total={total}
        onPageChange={setPage}
        keyExtractor={(item) => `${item.appId ?? 'x'}-${item.featureId}`}
      />
    </div>
  );
}

export default function FeatureUsagePage() {
  return (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <FeatureUsageContent />
      </Suspense>
    </AppLayout>
  );
}
