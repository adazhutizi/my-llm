'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout';
import { StatCard } from '@/components/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { InlineCombobox } from '@/components/inline-combobox';
import { TrendChart, DistributionCharts, type DistDatum } from '@/components/report-charts';
import {
  getReportOverview,
  getReportTrends,
  getReportByModel,
  getReportByProvider,
  getReportByStatus,
  getLogFilterOptions,
  listUsers,
  listApiKeys,
  listApps,
  listUserGroups,
} from '@/lib/api';
import type {
  ReportOverview,
  ReportTrendPoint,
  ReportDimensionItem,
  ReportStatusItem,
  ReportGranularity,
  ReportFilterParams,
  User,
  ApiKey,
  App,
  UserGroup,
} from '@/lib/types';
import { cn, beijingTodayStart, toBeijingDateTimeLocal } from '@/lib/utils';
import {
  Loader2,
  Search,
  RotateCcw,
  FileText,
  MessageSquare,
  BarChart3,
  Database,
  AlertTriangle,
} from 'lucide-react';

function defaultDates() {
  // Beijing-day boundaries — the backend parses the naive datetime-local
  // string as CST (same basis as /logs). Window is [today-7d 00:00, today 23:59] CST.
  const today = beijingTodayStart();
  const start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const end = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1000);
  return { dateFrom: toBeijingDateTimeLocal(start), dateTo: toBeijingDateTimeLocal(end) };
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

const formatNumber = (n: number) => n.toLocaleString();
const formatPercent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

function ReportsPageContent() {
  // Read preset filters from the URL (?userId / ?apiKeyId / …) so deep links
  // from other pages land on a pre-filtered view — same field names as /logs,
  // so the 7 jump buttons share one query shape. useSearchParams forces this
  // route client-side under static export, hence the <Suspense> boundary below.
  const searchParams = useSearchParams();
  const router = useRouter();
  const defaults = defaultDates();

  const [filters, setFilters] = useState({
    model: searchParams.get('model') ?? '',
    provider: searchParams.get('provider') ?? '',
    statusCode: '',
    requestPath: '',
    userAgent: '',
    featureId: searchParams.get('featureId') ?? '',
    appUserId: searchParams.get('appUserId') ?? '',
    userId: searchParams.get('userId') ?? '',
    apiKeyId: searchParams.get('apiKeyId') ?? '',
    appId: searchParams.get('appId') ?? '',
    groupId: '',
    hideArchived: false,
  });
  const [dateFrom, setDateFrom] = useState(defaults.dateFrom);
  const [dateTo, setDateTo] = useState(defaults.dateTo);
  const [granularity, setGranularity] = useState<ReportGranularity>('day');

  const [filterOptions, setFilterOptions] = useState<{ models: string[]; providers: string[] }>({ models: [], providers: [] });
  const [users, setUsers] = useState<User[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);

  const [overview, setOverview] = useState<ReportOverview | null>(null);
  const [trends, setTrends] = useState<ReportTrendPoint[]>([]);
  const [byModel, setByModel] = useState<ReportDimensionItem[]>([]);
  const [byProvider, setByProvider] = useState<ReportDimensionItem[]>([]);
  const [byStatus, setByStatus] = useState<ReportStatusItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Filter option loading (mirrors /logs) ─────────────────────────────────
  useEffect(() => {
    getLogFilterOptions().then(setFilterOptions).catch(() => {});
    listApps({ pageSize: 200 }).then((res) => setApps(res.data)).catch(() => {});
    listUserGroups().then(setGroups).catch(() => {});
  }, []);

  // Users scoped by group (group pick clears the user pick — see Select onChange).
  useEffect(() => {
    const groupId = filters.groupId ? Number(filters.groupId) : undefined;
    listUsers({ pageSize: 200, groupId })
      .then((res) => setUsers(res.data))
      .catch(() => setUsers([]));
  }, [filters.groupId]);

  // API keys scoped by group/user (user takes precedence as the more specific filter).
  useEffect(() => {
    const params: { pageSize: number; userId?: number; groupId?: number } = { pageSize: 200 };
    if (filters.userId) {
      params.userId = Number(filters.userId);
    } else if (filters.groupId) {
      params.groupId = Number(filters.groupId);
    }
    listApiKeys(params).then((res) => setApiKeys(res.data)).catch(() => setApiKeys([]));
  }, [filters.groupId, filters.userId]);

  // Keep filters in sync when the URL query changes (e.g. jumping here from
  // another entity's page with a different ?userId).
  useEffect(() => {
    const userId = searchParams.get('userId') ?? '';
    const apiKeyId = searchParams.get('apiKeyId') ?? '';
    const appUserId = searchParams.get('appUserId') ?? '';
    const featureId = searchParams.get('featureId') ?? '';
    const model = searchParams.get('model') ?? '';
    const appId = searchParams.get('appId') ?? '';
    const provider = searchParams.get('provider') ?? '';
    setFilters((prev) =>
      prev.userId === userId && prev.apiKeyId === apiKeyId && prev.appUserId === appUserId && prev.featureId === featureId && prev.model === model && prev.appId === appId && prev.provider === provider
        ? prev
        : { ...prev, userId, apiKeyId, appUserId, featureId, model, appId, provider },
    );
  }, [searchParams]);

  // Build the backend filter params from the current draft. Mirrors how /logs
  // composes its params (numbers via parseInt, hideArchived as boolean→'true',
  // naive datetime-local strings carried straight through).
  const buildParams = useCallback((): ReportFilterParams => {
    const p: ReportFilterParams = {};
    if (filters.model) p.model = filters.model;
    if (filters.provider) p.provider = filters.provider;
    if (filters.statusCode) p.statusCode = parseInt(filters.statusCode);
    if (filters.featureId) p.featureId = filters.featureId;
    if (filters.appUserId) p.appUserId = filters.appUserId;
    if (filters.userId) p.userId = parseInt(filters.userId);
    if (filters.apiKeyId) p.apiKeyId = parseInt(filters.apiKeyId);
    if (filters.appId) p.appId = parseInt(filters.appId);
    if (filters.groupId) p.groupId = parseInt(filters.groupId);
    if (filters.requestPath) p.requestPath = filters.requestPath;
    if (filters.userAgent) p.userAgent = filters.userAgent;
    if (filters.hideArchived) p.hideArchived = true;
    if (dateFrom) p.startDate = dateFrom;
    if (dateTo) p.endDate = dateTo;
    return p;
  }, [filters, dateFrom, dateTo]);

  const load = useCallback(async () => {
    const params = buildParams();
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled([
        getReportOverview(params),
        getReportTrends({ ...params, granularity }),
        getReportByModel(params),
        getReportByProvider(params),
        getReportByStatus(params),
      ]);
      if (results[0].status === 'fulfilled') setOverview(results[0].value);
      if (results[1].status === 'fulfilled') setTrends(results[1].value);
      if (results[2].status === 'fulfilled') setByModel(results[2].value);
      if (results[3].status === 'fulfilled') setByProvider(results[3].value);
      if (results[4].status === 'fulfilled') setByStatus(results[4].value);
      // Only fatal if every endpoint rejected (partial failures keep the charts
      // that did load, mirroring the overview page's tolerant policy).
      if (results.every((r) => r.status === 'rejected')) {
        setError('加载报表数据失败，请确认管理 API 已启动');
      }
    } catch {
      setError('加载报表数据失败，请确认管理 API 已启动');
    } finally {
      setLoading(false);
    }
  }, [buildParams, granularity]);

  useEffect(() => {
    load();
  }, [load]);

  const handleReset = () => {
    const d = defaultDates();
    setFilters({
      model: '', provider: '', statusCode: '', requestPath: '', userAgent: '',
      featureId: '', appUserId: '', userId: '', apiKeyId: '', appId: '', groupId: '',
      hideArchived: false,
    });
    setDateFrom(d.dateFrom);
    setDateTo(d.dateTo);
  };

  // Deep-link to /logs carrying the fields /logs reads from the URL (entity
  // filters — date/status/groupId/path/UA are NOT read by /logs's URL preset,
  // so omitting them matches what /logs would actually apply).
  const buildLogQuery = () => {
    const p: Record<string, string> = {};
    if (filters.model) p.model = filters.model;
    if (filters.provider) p.provider = filters.provider;
    if (filters.userId) p.userId = filters.userId;
    if (filters.apiKeyId) p.apiKeyId = filters.apiKeyId;
    if (filters.appId) p.appId = filters.appId;
    if (filters.appUserId) p.appUserId = filters.appUserId;
    if (filters.featureId) p.featureId = filters.featureId;
    return new URLSearchParams(p).toString();
  };

  // Map dimension payloads into the label/value shape DistributionCharts wants.
  const modelData: DistDatum[] = byModel.map((i) => ({ label: i.key ?? '未知', value: i.totalTokens }));
  const providerData: DistDatum[] = byProvider.map((i) => ({ label: i.key ?? '未知', value: i.totalTokens }));
  const statusData: DistDatum[] = byStatus.map((i) => ({
    label: i.statusClass == null ? '未知' : `${i.statusClass}`,
    value: i.totalRequests,
  }));

  const cacheTokens = overview
    ? overview.totalCacheReadTokens + overview.totalCacheCreationTokens
    : 0;

  return (
    <div className="space-y-6">
      {/* ── Filter bar (mirrors /logs, minus the archive button) ─────────────── */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <Label>开始时间</Label>
          <Input type="datetime-local" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <Label>结束时间</Label>
          <Input type="datetime-local" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div>
          <Label>服务商</Label>
          <Select value={filters.provider || '__all__'} onValueChange={(v) => setFilters({ ...filters, provider: v === '__all__' ? '' : v })}>
            <SelectTrigger className={cn('w-[180px]', !filters.provider && 'text-muted-foreground')}><SelectValue placeholder="全部" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部</SelectItem>
              {Array.from(new Set([filters.provider, ...filterOptions.providers])).filter(Boolean).map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>模型</Label>
          <Select value={filters.model || '__all__'} onValueChange={(v) => setFilters({ ...filters, model: v === '__all__' ? '' : v })}>
            <SelectTrigger className={cn('w-[180px]', !filters.model && 'text-muted-foreground')}><SelectValue placeholder="全部" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部</SelectItem>
              {Array.from(new Set([filters.model, ...filterOptions.models])).filter(Boolean).map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>分组</Label>
          <Select
            value={filters.groupId || '__all__'}
            onValueChange={(v) => setFilters((prev) => ({ ...prev, groupId: v === '__all__' ? '' : v, userId: '', apiKeyId: '' }))}
          >
            <SelectTrigger className={cn('w-[180px]', !filters.groupId && 'text-muted-foreground')}><SelectValue placeholder="全部分组" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部分组</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-[200px]">
          <Label>用户</Label>
          <InlineCombobox
            options={users.map((u) => ({ value: String(u.id), label: u.username, suffix: u.identifier || `#${u.id}` }))}
            value={filters.userId}
            onChange={(v) => setFilters({ ...filters, userId: v, apiKeyId: '' })}
            placeholder="全部用户"
            searchPlaceholder="搜索用户名..."
            emptyText="未找到用户"
            allowClear
            clearLabel="全部用户"
          />
        </div>
        <div className="w-[220px]">
          <Label>API 密钥</Label>
          <InlineCombobox
            options={apiKeys.map((k) => ({ value: String(k.id), label: k.name, suffix: k.keyPrefix }))}
            value={filters.apiKeyId}
            onChange={(v) => setFilters({ ...filters, apiKeyId: v })}
            placeholder="全部密钥"
            searchPlaceholder="搜索密钥名..."
            emptyText="未找到密钥"
            allowClear
            clearLabel="全部密钥"
          />
        </div>
        <div className="w-[200px]">
          <Label>应用</Label>
          <InlineCombobox
            options={apps.map((a) => ({ value: String(a.id), label: a.name }))}
            value={filters.appId}
            onChange={(v) => setFilters({ ...filters, appId: v })}
            placeholder="全部应用"
            searchPlaceholder="搜索应用名..."
            emptyText="未找到应用"
            allowClear
            clearLabel="全部应用"
          />
        </div>
        <div className="w-[220px]">
          <Label>请求路径</Label>
          <Input
            placeholder="/v1/chat/completions"
            value={filters.requestPath}
            onChange={(e) => setFilters({ ...filters, requestPath: e.target.value })}
          />
        </div>
        <div className="w-[220px]">
          <Label>UA</Label>
          <Input
            placeholder="curl/8"
            value={filters.userAgent}
            onChange={(e) => setFilters({ ...filters, userAgent: e.target.value })}
          />
        </div>
        <div>
          <Label>状态码</Label>
          <Input
            placeholder="200"
            className="w-24"
            value={filters.statusCode}
            onChange={(e) => setFilters({ ...filters, statusCode: e.target.value })}
          />
        </div>
        <div>
          <Label>用户标识</Label>
          <Input
            placeholder="user-123"
            value={filters.appUserId}
            onChange={(e) => setFilters({ ...filters, appUserId: e.target.value })}
          />
        </div>
        <div>
          <Label>功能标识</Label>
          <Input
            placeholder="chat"
            value={filters.featureId}
            onChange={(e) => setFilters({ ...filters, featureId: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="hideArchived">归并</Label>
          <div className="flex items-center h-9">
            <input
              id="hideArchived"
              type="checkbox"
              checked={filters.hideArchived}
              onChange={(e) => setFilters({ ...filters, hideArchived: e.target.checked })}
              className="h-4 w-4 cursor-pointer"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => load()}>
            <Search className="h-4 w-4 mr-2" />
            筛选
          </Button>
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="h-4 w-4 mr-2" />
            重置
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-red-200">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className="h-5 w-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-600">{error}</p>
            <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => load()} disabled={loading}>
              重试
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="总请求数"
          value={overview ? formatNumber(overview.totalRequests) : '0'}
          subtitle={overview ? `错误 ${formatNumber(overview.totalErrors)} · 平均延迟 ${Math.round(overview.avgLatencyMs)}ms` : undefined}
          icon={<MessageSquare className="h-6 w-6" />}
        />
        <StatCard
          title="总 Token 数"
          value={overview ? formatTokens(overview.totalTokens) : '0'}
          subtitle={overview ? `输入 ${formatTokens(overview.totalPromptTokens)} · 输出 ${formatTokens(overview.totalCompletionTokens)}` : undefined}
          icon={<BarChart3 className="h-6 w-6" />}
        />
        <StatCard
          title="缓存 Token"
          value={overview ? formatTokens(cacheTokens) : '0'}
          subtitle={
            overview && overview.totalTokens > 0
              ? `占比 ${((cacheTokens / overview.totalTokens) * 100).toFixed(1)}%`
              : '读取 + 写入'
          }
          icon={<Database className="h-6 w-6" />}
        />
        <StatCard
          title="错误率"
          value={overview ? formatPercent(overview.errorRate) : '0%'}
          subtitle={`${dateFrom ? dateFrom.slice(0, 10) : ''} ~ ${dateTo ? dateTo.slice(0, 10) : ''}`}
          icon={<AlertTriangle className="h-6 w-6" />}
        />
      </div>

      {/* ── Charts ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>报表分析</CardTitle>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="trends">
            <TabsList>
              <TabsTrigger value="trends">趋势</TabsTrigger>
              <TabsTrigger value="model">模型分布</TabsTrigger>
              <TabsTrigger value="provider">服务商分布</TabsTrigger>
              <TabsTrigger value="status">状态码分布</TabsTrigger>
            </TabsList>

            <TabsContent value="trends" className="mt-4">
              <div className="flex justify-end mb-3">
                <Select value={granularity} onValueChange={(v) => setGranularity(v as ReportGranularity)}>
                  <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hour">按小时</SelectItem>
                    <SelectItem value="day">按天</SelectItem>
                    <SelectItem value="week">按周</SelectItem>
                    <SelectItem value="month">按月</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {trends.length === 0 ? (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">当前筛选下暂无趋势数据</p>
                </div>
              ) : (
                <TrendChart points={trends} granularity={granularity} />
              )}
            </TabsContent>

            <TabsContent value="model" className="mt-4">
              <DistributionCharts data={modelData} metricLabel="Tokens" emptyHint="当前筛选下暂无模型数据" />
            </TabsContent>

            <TabsContent value="provider" className="mt-4">
              <DistributionCharts data={providerData} metricLabel="Tokens" emptyHint="当前筛选下暂无服务商数据" />
            </TabsContent>

            <TabsContent value="status" className="mt-4">
              <DistributionCharts data={statusData} metricLabel="请求数" compact={false} emptyHint="当前筛选下暂无状态码数据" />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Drill-down: carry the entity filters to /logs for row-level inspection. */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => router.push(`/logs?${buildLogQuery()}`)}>
          <FileText className="h-4 w-4 mr-2" />
          在日志中查看明细
        </Button>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <ReportsPageContent />
      </Suspense>
    </AppLayout>
  );
}
