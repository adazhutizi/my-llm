'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  getDashboardStats,
  getUsageTrend,
  listLogs,
  listApiKeys,
  listUsers,
  listApps,
  listUserGroups,
  getQuotaStatus,
} from '@/lib/api';
import type { DashboardStats, UsagePoint, RequestLog, QuotaStatus, UserGroup } from '@/lib/types';
import { AppLayout } from '@/components/layout';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { formatDateTime } from '@/lib/utils';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  BarChart3,
  MessageSquare,
  AlertTriangle,
  Database,
  Loader2,
  RefreshCw,
} from 'lucide-react';

// ── Quota card helper ────────────────────────────────────────────────────

interface QuotaCardItem {
  name: string;
  type: string;
  quota: QuotaStatus;
  // User-type cards only: the user's group, shown as a badge next to the name
  // and used by the group filter. undefined for api_key/app cards (no group).
  groupId?: number | null;
  groupName?: string | null;
}

function quotaTone(pct: number): { bar: string; text: string } {
  if (pct >= 100) return { bar: 'bg-gradient-to-r from-rose-400 to-rose-500', text: 'text-rose-600' };
  if (pct >= 80) return { bar: 'bg-gradient-to-r from-amber-400 to-amber-500', text: 'text-amber-600' };
  return { bar: 'bg-gradient-to-r from-emerald-400 to-emerald-500', text: 'text-emerald-600' };
}

function ProgressBar({ percentage, tone }: { percentage: number; tone: { bar: string; text: string } }) {
  const clamped = Math.min(percentage, 100);
  return (
    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
      <div
        className={`h-2 rounded-full ${tone.bar} transition-[width] duration-300`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function formatTokens(n: number): string {
  const m = n / 1_000_000;
  if (m >= 100) return `${m.toFixed(0)}M`;
  if (m >= 10) return `${m.toFixed(1)}M`;
  if (m >= 1) return `${m.toFixed(2)}M`;
  if (m >= 0.01) return `${m.toFixed(2)}M`;
  if (n > 0) return '<0.01M';
  return '0';
}

function QuotaCard({ name, type, quota, rank, groupName }: QuotaCardItem & { rank: number }) {
  const dailyPct = quota.usage.today.percentage ?? 0;
  const monthlyPct = quota.usage.month.percentage ?? 0;
  const dailyTokens = Number(quota.usage.today.tokens);
  const monthlyTokens = Number(quota.usage.month.tokens);
  const lastMonthTokens = Number(quota.usage.lastMonth.tokens);
  const dailyTone = quotaTone(dailyPct);
  const monthlyTone = quotaTone(monthlyPct);
  // 上月按当月月限额算占比（与本月同口径 Math.round），用于环比对比；
  // 无月限额时为 0，与本月块在无限额时的表现一致。
  const lastMonthPct =
    quota.limits.monthlyTokens != null && quota.limits.monthlyTokens > 0
      ? Math.round((lastMonthTokens / quota.limits.monthlyTokens) * 100)
      : 0;
  const lastMonthTone = quotaTone(lastMonthPct);

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium truncate flex items-center gap-2">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-700 text-xs font-bold align-middle">
              {rank}
            </span>
            <span className="truncate">{name}</span>
            {type === 'user' && groupName && (
              <Badge variant="outline" className="shrink-0 text-xs font-normal text-muted-foreground">
                {groupName}
              </Badge>
            )}
          </div>
          <Badge variant="secondary" className="text-xs capitalize">
            {type}
          </Badge>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>今日 tokens</span>
            <span className={`font-medium ${dailyTone.text}`}>{dailyPct.toFixed(1)}%</span>
          </div>
          <ProgressBar percentage={dailyPct} tone={dailyTone} />
          <p className="text-xs text-muted-foreground">
            {formatTokens(dailyTokens)}
            {quota.limits.dailyTokens != null && ` / ${formatTokens(quota.limits.dailyTokens)}`}
            <span className="text-muted-foreground/60"> tokens</span>
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>本月 tokens</span>
            <span className={`font-medium ${monthlyTone.text}`}>{monthlyPct.toFixed(1)}%</span>
          </div>
          <ProgressBar percentage={monthlyPct} tone={monthlyTone} />
          <p className="text-xs text-muted-foreground">
            {formatTokens(monthlyTokens)}
            {quota.limits.monthlyTokens != null && ` / ${formatTokens(quota.limits.monthlyTokens)}`}
            <span className="text-muted-foreground/60"> tokens</span>
          </p>
        </div>

        {/* 上月 tokens — 占比按当月月限额算（与本月同口径），用于环比对比 */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>上月 tokens</span>
            <span className={`font-medium ${lastMonthTone.text}`}>{lastMonthPct.toFixed(1)}%</span>
          </div>
          <ProgressBar percentage={lastMonthPct} tone={lastMonthTone} />
          <p className="text-xs text-muted-foreground">
            {formatTokens(lastMonthTokens)}
            {quota.limits.monthlyTokens != null && ` / ${formatTokens(quota.limits.monthlyTokens)}`}
            <span className="text-muted-foreground/60"> tokens</span>
          </p>
        </div>

        <div className="text-xs text-muted-foreground pt-1 border-t">
          限额：{' '}
          {quota.limits.dailyTokens
            ? `日限额：${formatTokens(quota.limits.dailyTokens)} tokens`
            : '日限额：无限制'}
          {' / '}
          {quota.limits.monthlyTokens
            ? `月限额：${formatTokens(quota.limits.monthlyTokens)} tokens`
            : '月限额：无限制'}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Recent logs columns ──────────────────────────────────────────────────

const logColumns = [
  {
    key: 'requestId',
    header: '请求 ID',
    render: (log: RequestLog) => (
      <span className="font-mono text-xs">{log.requestId.slice(0, 8)}...</span>
    ),
  },
  {
    key: 'model',
    header: '模型',
    render: (log: RequestLog) => log.model ?? '-',
  },
  {
    key: 'statusCode',
    header: '状态',
    render: (log: RequestLog) => {
      const code = log.statusCode;
      if (!code) return '-';
      const color =
        code >= 200 && code < 300
          ? 'text-green-600'
          : code >= 400 && code < 500
            ? 'text-yellow-600'
            : 'text-red-600';
      return <span className={`font-medium ${color}`}>{code}</span>;
    },
  },
  {
    key: 'latencyMs',
    header: '延迟',
    render: (log: RequestLog) =>
      log.latencyMs != null ? `${log.latencyMs}ms` : '-',
  },
  {
    key: 'promptTokens',
    header: 'Tokens',
    render: (log: RequestLog) => {
      const total =
        (log.promptTokens ?? 0) +
        (log.completionTokens ?? 0) +
        (log.cacheReadTokens ?? 0) +
        (log.cacheCreationTokens ?? 0);
      return total > 0 ? total.toLocaleString() : '-';
    },
  },
  {
    key: 'cacheTokens',
    header: '缓存',
    render: (log: RequestLog) => {
      const cache = (log.cacheReadTokens ?? 0) + (log.cacheCreationTokens ?? 0);
      return cache > 0 ? (
        <span className="text-amber-600 font-medium">{cache.toLocaleString()}</span>
      ) : (
        '-'
      );
    },
  },
  {
    key: 'createdAt',
    header: '时间',
    render: (log: RequestLog) => formatDateTime(log.createdAt),
  },
];

// ── Page component ───────────────────────────────────────────────────────

export default function OverviewPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 拦截自动刷新 interval 与手动刷新按钮的并发，避免旧请求晚 resolve 覆盖新数据
  const refreshingRef = useRef(false);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trend, setTrend] = useState<UsagePoint[]>([]);
  const [recentLogs, setRecentLogs] = useState<RequestLog[]>([]);
  const [quotaCards, setQuotaCards] = useState<QuotaCardItem[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  // 统一配额筛选（单下拉，各选项互斥）：
  //   'all' = 全部; 'users' = 只看用户; 'apps' = 只看应用; 'api_keys' = 只看密钥;
  //   'none' = 未归组用户; `group:${id}` = 指定分组的用户
  const [filter, setFilter] = useState<string>('all');

  // 加载数据。initial=true（首次/重试）走全屏 loading；initial=false（自动/手动刷新）
  // 只转刷新按钮图标、不卸载页面内容，从而保留 filter 与滚动位置。
  // 刷新失败静默（保留已显示的旧数据）；仅首次加载失败才设 fatal error。
  // refreshingRef 拦截 interval 与手动刷新的并发，避免旧请求晚 resolve 覆盖新数据。
  const load = useCallback(async (initial: boolean) => {
    if (initial) {
      setLoading(true);
      setError(null);
    } else {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshing(true);
    }
    try {
      const results = await Promise.allSettled([
        getDashboardStats(),
        getUsageTrend({ period: '7d' }),
        listLogs({ page: 1, pageSize: 10 }),
        listApiKeys({ page: 1, pageSize: 50 }),
        listUsers({ page: 1, pageSize: 50 }),
        listApps({ page: 1, pageSize: 50 }),
        listUserGroups(),
      ]);

      // Stats
      if (results[0].status === 'fulfilled') {
        setStats(results[0].value);
      }

      // Trend
      if (results[1].status === 'fulfilled') {
        setTrend(results[1].value);
      }

      // Recent logs
      if (results[2].status === 'fulfilled') {
        setRecentLogs(results[2].value.data);
      }

      // Quota status for top entities
      const quotaItems: QuotaCardItem[] = [];

      const apiKeys =
        results[3].status === 'fulfilled' ? results[3].value.data : [];
      const users =
        results[4].status === 'fulfilled' ? results[4].value.data : [];
      const apps =
        results[5].status === 'fulfilled' ? results[5].value.data : [];
      const groupList =
        results[6].status === 'fulfilled' ? results[6].value : [];
      setGroups(groupList);

      const quotaPromises: Promise<void>[] = [];

      for (const key of apiKeys) {
        quotaPromises.push(
          getQuotaStatus('api_keys', key.id).then((q) => {
            quotaItems.push({ name: key.name, type: 'api_key', quota: q });
          }),
        );
      }
      for (const user of users) {
        quotaPromises.push(
          getQuotaStatus('users', user.id).then((q) => {
            const groupName =
              user.groupId != null
                ? groupList.find((g) => g.id === user.groupId)?.name ?? null
                : null;
            quotaItems.push({
              name: user.username,
              type: 'user',
              quota: q,
              groupId: user.groupId ?? null,
              groupName,
            });
          }),
        );
      }
      for (const app of apps) {
        quotaPromises.push(
          getQuotaStatus('apps', app.id).then((q) => {
            quotaItems.push({ name: app.name, type: 'app', quota: q });
          }),
        );
      }

      await Promise.allSettled(quotaPromises);
      // Only show entities that have at least one quota limit configured,
      // sorted by usage descending (monthly tokens → daily tokens → name)
      setQuotaCards(
        quotaItems
          .filter(
            (item) =>
              item.quota.limits.dailyTokens != null ||
              item.quota.limits.monthlyTokens != null,
          )
          .sort((a, b) => {
            const aMonth = Number(a.quota.usage.month.tokens) || 0;
            const bMonth = Number(b.quota.usage.month.tokens) || 0;
            if (aMonth !== bMonth) return bMonth - aMonth;
            const aToday = Number(a.quota.usage.today.tokens) || 0;
            const bToday = Number(b.quota.usage.today.tokens) || 0;
            if (aToday !== bToday) return bToday - aToday;
            return a.name.localeCompare(b.name, 'zh');
          }),
      );

      // Set error only if critical data failed —— 仅首次加载；刷新失败保留旧数据
      if (initial && results[0].status === 'rejected') {
        setError('加载面板数据失败');
      }
    } catch {
      if (initial) setError('请确认管理 API 已启动且可访问。');
    } finally {
      if (initial) setLoading(false);
      else {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load(true);
    // 每 10 分钟自动刷新一次（与手动刷新按钮共用 load(false)，并发由 refreshingRef 拦截）
    const id = setInterval(() => load(false), 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  // 单一筛选器作用于配额卡片，各选项互斥（下拉同时只能选中一个）：
  //   类型维度('apps'/'api_keys')只保留对应类型；
  //   分组维度('none'/`group:${id}`)只对 user 生效（app/api_key 无分组）。
  // NOTE: this useMemo must stay ABOVE the `loading`/`error` early returns —
  // a hook called after a conditional return violates the Rules of Hooks
  // (previous render had loading=true → return, so useMemo never ran; next
  // render runs it → React sees a changed hook order and throws).
  const visibleCards = useMemo(() => {
    if (filter === 'all') return quotaCards;
    if (filter === 'users') return quotaCards.filter((item) => item.type === 'user');
    if (filter === 'apps') return quotaCards.filter((item) => item.type === 'app');
    if (filter === 'api_keys') return quotaCards.filter((item) => item.type === 'api_key');
    const gid = filter === 'none' ? null : Number(filter.slice('group:'.length));
    return quotaCards.filter((item) => {
      if (item.type !== 'user') return false;
      return (item.groupId ?? null) === gid;
    });
  }, [quotaCards, filter]);

  // 类型过滤选项仅在有对应类型配额卡片时出现，避免选出空列表
  const hasUsers = quotaCards.some((item) => item.type === 'user');
  const hasApps = quotaCards.some((item) => item.type === 'app');
  const hasKeys = quotaCards.some((item) => item.type === 'api_key');

  // ── Loading state ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────

  if (error && !stats) {
    return (
      <AppLayout>
        <Card className="border-red-200">
          <CardContent className="flex items-center gap-3 p-6">
            <AlertTriangle className="h-5 w-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-600">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto shrink-0"
              onClick={() => load(true)}
              disabled={loading}
            >
              {loading && <Loader2 className="animate-spin" />}
              重试
            </Button>
          </CardContent>
        </Card>
      </AppLayout>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const formatNumber = (n: number) => n.toLocaleString();
  const formatPercent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="总请求数"
            value={stats ? formatNumber(stats.totalRequests) : '0'}
            subtitle={stats ? `近 30 天 · 今日：${formatNumber(stats.requestsToday)}` : undefined}
            icon={<MessageSquare className="h-6 w-6" />}
          />
          <StatCard
            title="总 Token 数"
            value={stats ? formatTokens(stats.totalTokens) : '0'}
            subtitle={stats ? `近 30 天 · 今日：${formatTokens(stats.tokensToday)}` : undefined}
            icon={<BarChart3 className="h-6 w-6" />}
          />
          <StatCard
            title="缓存命中 Token"
            value={stats ? formatTokens(stats.cacheTokens30d ?? 0) : '0'}
            subtitle={
              stats
                ? `近 30 天 · 今日：${formatTokens(stats.cacheTokensToday ?? 0)}` +
                  (stats.totalTokens > 0
                    ? ` · 占比 ${(((stats.cacheTokens30d ?? 0) / stats.totalTokens) * 100).toFixed(1)}%`
                    : '')
                : undefined
            }
            icon={<Database className="h-6 w-6" />}
          />
          <StatCard
            title="错误率"
            value={stats ? formatPercent(stats.errorRate) : '0%'}
            subtitle={
              stats ? `近 30 天 · 今日：${formatPercent(stats.errorRateToday ?? 0)}` : undefined
            }
            icon={<AlertTriangle className="h-6 w-6" />}
          />
        </div>

        {/* Usage trend chart */}
        <Card>
          <CardHeader>
            <CardTitle>用量趋势（7 天）</CardTitle>
          </CardHeader>
          <CardContent>
            {trend.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  暂无用量数据
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={(val: string) =>
                      new Date(val.replace(/Z$/, '')).toLocaleDateString('zh-CN', {
                        month: 'short',
                        day: 'numeric',
                      })
                    }
                  />
                  <YAxis yAxisId="left" />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickFormatter={(v: number) => formatTokens(v)}
                  />
                  <Tooltip
                    labelFormatter={(val: string) =>
                      new Date(val.replace(/Z$/, '')).toLocaleDateString('zh-CN')
                    }
                    formatter={(value, name) =>
                      name === '请求数'
                        ? [Number(value).toLocaleString(), name]
                        : [formatTokens(Number(value)), name]
                    }
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="requests"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={false}
                    name="请求数"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="tokens"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot={false}
                    name="Tokens"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cacheTokens"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    name="缓存 Tokens"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Quota status cards */}
        {quotaCards.length > 0 && (
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">配额状态</h2>
              <div className="flex items-center gap-2">
                {(groups.length > 0 || hasUsers || hasApps || hasKeys) && (
                  <Select value={filter} onValueChange={setFilter}>
                    <SelectTrigger className="h-8 w-[180px]">
                      <SelectValue placeholder="全部" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      {hasUsers && <SelectItem value="users">全部用户</SelectItem>}
                      {hasApps && <SelectItem value="apps">全部应用</SelectItem>}
                      {hasKeys && <SelectItem value="api_keys">全部密钥</SelectItem>}
                      {groups.length > 0 && <SelectItem value="none">未归组</SelectItem>}
                      {groups.map((g) => (
                        <SelectItem key={g.id} value={`group:${g.id}`}>
                          {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => load(false)}
                  disabled={refreshing}
                >
                  <RefreshCw className={refreshing ? 'animate-spin' : ''} />
                  刷新
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleCards.map((item, idx) => (
                <QuotaCard key={`${item.type}-${idx}`} {...item} rank={idx + 1} />
              ))}
            </div>
            {visibleCards.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                该筛选下暂无配额项。
              </p>
            )}
          </div>
        )}

        {/* Recent requests table */}
        <div>
          <h2 className="text-lg font-semibold mb-3">最近请求</h2>
          <DataTable
            columns={logColumns}
            data={recentLogs}
            keyExtractor={(log) => log.id}
            emptyMessage="暂无请求记录"
          />
        </div>
      </div>
    </AppLayout>
  );
}
