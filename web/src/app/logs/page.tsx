'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppLayout } from '@/components/layout';
import { DataTable } from '@/components/data-table';
import { MergeArrowsOverlay } from '@/components/logs-merge-arrows';
import { LogsFilterForm, LogsFilterState } from '@/components/logs-filter-form';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { listLogs, getLogDetail, getLogFilterOptions, listUsers, listApiKeys, listApps, listUserGroups, archiveLogs, generateLogSummary } from '@/lib/api';
import { RequestLog, RequestDetail, User, ApiKey, App, UserGroup, ApiError, LogSummaryMeta } from '@/lib/types';
import { Loader2, Filter, ChevronDown, ChevronUp } from 'lucide-react';
import { formatDateTime, beijingTodayStart, toBeijingDateTimeLocal } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

function defaultDates() {
  // Beijing-day boundaries: the backend parses the naive datetime-local
  // string as CST, so defaults must be Beijing wall-clock (not the browser's
  // local time). Window is [today-7d 00:00, today 23:59] CST.
  const today = beijingTodayStart();
  const start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const end = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1000);
  return { dateFrom: toBeijingDateTimeLocal(start), dateTo: toBeijingDateTimeLocal(end) };
}

function LogsPageContent() {
  // Read preset filters from the URL (?userId / ?apiKeyId) so deep links from
  // other pages land on a pre-filtered view. useSearchParams forces this route
  // to render client-side under static export, hence the <Suspense> boundary in
  // the default export below.
  const searchParams = useSearchParams();
  const defaults = defaultDates();
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<LogsFilterState>({
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
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 详情加载失败（绝大多数是 404 — dedicated 日志的 request_details 未持久化，
  // 或已超过详情保留期被清理）。非空时对话框改展示列表行概要 + 不可用提示，
  // 而非空白/抛 unhandledRejection。见 CLAUDE.md「请求日志」的孤儿 logs 说明。
  const [detailError, setDetailError] = useState<string | null>(null);
  // AI summary state — seeded from detail.aiSummary (cache) on open, updated on
  // generate/regenerate. Null until the admin generates one for this request.
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryMeta, setSummaryMeta] = useState<LogSummaryMeta | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [filterOptions, setFilterOptions] = useState<{ models: string[]; providers: string[] }>({ models: [], providers: [] });
  const [users, setUsers] = useState<User[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveMsg, setArchiveMsg] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [includeToday, setIncludeToday] = useState(false);

  // —— 滚动固定过滤器（sticky 折叠条）——
  // 浏览下方日志时过滤器滚出视口，回顶改条件太慢：过滤器滚出后，在列表上方
  // 显示一条 sticky 折叠条（当前条件摘要 + 展开完整过滤器）。IO 观察原过滤器
  // 区，`top < 0 && !isIntersecting` = 已向上滚出视口（滚到页面底部以下时
  // top > 0，不弹条）。滚动容器是 AppLayout 的 <main>（overflow-y-auto），
  // sticky top-0 恰好贴在页头下方。
  const filterSectionRef = useRef<HTMLDivElement>(null);
  const [filterStuck, setFilterStuck] = useState(false);
  const [stickyExpanded, setStickyExpanded] = useState(false);

  useEffect(() => {
    const el = filterSectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setFilterStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // 滚回顶部、折叠条消失时重置展开态，下次弹出仍是折叠摘要。
  useEffect(() => {
    if (!filterStuck) setStickyExpanded(false);
  }, [filterStuck]);

  // 折叠条上的条件摘要（时间 + 各维度 chips），实体类维度解析成名称显示。
  const filterChips = useMemo(() => {
    const chips: string[] = [];
    const fmtDT = (v: string) => (v ? v.replace('T', ' ').slice(5, 16) : '');
    if (dateFrom || dateTo) chips.push(`${fmtDT(dateFrom) || '…'} ~ ${fmtDT(dateTo) || '…'}`);
    if (filters.model) chips.push(`模型：${filters.model}`);
    if (filters.provider) chips.push(`服务商：${filters.provider}`);
    if (filters.groupId) chips.push(`分组：${groups.find((g) => String(g.id) === filters.groupId)?.name ?? `#${filters.groupId}`}`);
    if (filters.userId) chips.push(`用户：${users.find((u) => String(u.id) === filters.userId)?.username ?? `#${filters.userId}`}`);
    if (filters.apiKeyId) chips.push(`密钥：${apiKeys.find((k) => String(k.id) === filters.apiKeyId)?.name ?? `#${filters.apiKeyId}`}`);
    if (filters.appId) chips.push(`应用：${apps.find((a) => String(a.id) === filters.appId)?.name ?? `#${filters.appId}`}`);
    if (filters.statusCode) chips.push(`状态：${filters.statusCode}`);
    if (filters.requestPath) chips.push(`路径：${filters.requestPath}`);
    if (filters.userAgent) chips.push(`UA：${filters.userAgent}`);
    if (filters.appUserId) chips.push(`用户标识：${filters.appUserId}`);
    if (filters.featureId) chips.push(`功能：${filters.featureId}`);
    if (filters.hideArchived) chips.push('仅未归并');
    return chips;
  }, [filters, dateFrom, dateTo, groups, users, apiKeys, apps]);

  useEffect(() => {
    getLogFilterOptions().then(setFilterOptions).catch(() => {});
    // pageSize is generous so the searchable combobox covers the common case;
    // entities beyond this are simply not listed (admin can still filter from
    // the entity's own page). Users and API keys are loaded separately (scoped
    // by the selected group/user — see the dedicated effects below).
    listApps({ pageSize: 200 }).then((res) => setApps(res.data)).catch(() => {});
    listUserGroups().then(setGroups).catch(() => {});
  }, []);

  // User options are scoped by the selected group: when a group is picked, only
  // its members are fetched so the combobox can't offer an out-of-group user
  // (and picking a group clears any prior user — see the Select's onValueChange
  // below). Runs on mount (no group → all users) and again on group change.
  useEffect(() => {
    const groupId = filters.groupId ? Number(filters.groupId) : undefined;
    listUsers({ pageSize: 200, groupId })
      .then((res) => setUsers(res.data))
      .catch(() => setUsers([]));
  }, [filters.groupId]);

  // API key options are scoped by the selected group/user: a user lists only
  // that user's keys, a group lists only that group's members' keys (user takes
  // precedence as the more specific filter). The backend's userId/groupId
  // filter excludes app/admin keys (no user_id) — they don't belong to any
  // user group. Switching group/user also clears any previously picked key
  // (handled in the Select/Combobox onChange handlers below).
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
  // another entity's page with a different ?userId). Resets to page 1 so the
  // new filter shows results from the top.
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
    setPage(1);
  }, [searchParams]);

  const load = useCallback(async () => {
    const params: { page: number; pageSize: number; model?: string; provider?: string; statusCode?: number; featureId?: string; appUserId?: string; userId?: number; apiKeyId?: number; appId?: number; groupId?: number; requestPath?: string; userAgent?: string; from?: string; to?: string; hideArchived?: boolean } = { page, pageSize: 50 };
    if (filters.model) params.model = filters.model;
    if (filters.provider) params.provider = filters.provider;
    if (filters.statusCode) params.statusCode = parseInt(filters.statusCode);
    if (filters.featureId) params.featureId = filters.featureId;
    if (filters.appUserId) params.appUserId = filters.appUserId;
    if (filters.userId) params.userId = parseInt(filters.userId);
    if (filters.apiKeyId) params.apiKeyId = parseInt(filters.apiKeyId);
    if (filters.appId) params.appId = parseInt(filters.appId);
    if (filters.groupId) params.groupId = parseInt(filters.groupId);
    if (filters.requestPath) params.requestPath = filters.requestPath;
    if (filters.userAgent) params.userAgent = filters.userAgent;
    if (filters.hideArchived) params.hideArchived = true;
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    const res = await listLogs(params);
    setLogs(res.data);
    setTotal(res.total);
  }, [page, filters, dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFilter = () => {
    setPage(1);
    load();
  };

  const openDetail = async (log: RequestLog) => {
    setSelectedLog(log);
    setDetail(null);
    setDetailError(null);
    setSummary(null);
    setSummaryMeta(null);
    setDetailLoading(true);
    try {
      const data = await getLogDetail(log.requestId);
      setDetail(data);
      setSummary(data.aiSummary?.summary ?? null);
      setSummaryMeta(data.aiSummary?.meta ?? null);
    } catch (err) {
      // ApiError is an interface (thrown as a plain object), so duck-type it.
      const apiErr = err as { message?: string; status?: number };
      setDetail(null);
      setDetailError(
        apiErr?.status === 404 ? '该日志的完整详情不可用' : apiErr?.message ?? '无法加载该日志的详情',
      );
    } finally {
      setDetailLoading(false);
    }
  };

  // Jump from a merged (mid-session) row to its complete successor without
  // changing the parent list row the dialog is anchored to.
  const jumpToDetail = async (requestId: string) => {
    setDetail(null);
    setDetailError(null);
    setSummary(null);
    setSummaryMeta(null);
    setDetailLoading(true);
    try {
      let current = await getLogDetail(requestId);
      // Follow mergedInto to the chain tail (the complete record). Each
      // archived row points to its immediate successor; after multiple archive
      // runs the chain can be several hops long, so walk it to the end in one
      // go. Cap hops defensively against a (theoretically impossible) cycle.
      let hops = 0;
      while (current.mergedInto && hops < 50) {
        let next: RequestDetail | null = null;
        try {
          next = await getLogDetail(current.mergedInto);
        } catch {
          break; // 跳转目标详情不可用 — 停在当前最完整的记录
        }
        if (!next) break;  // dangling pointer — show the last good row
        current = next;
        hops++;
      }
      setDetail(current);
      setSummary(current.aiSummary?.summary ?? null);
      setSummaryMeta(current.aiSummary?.meta ?? null);
    } catch (err) {
      const apiErr = err as { message?: string; status?: number };
      setDetail(null);
      setDetailError(
        apiErr?.status === 404 ? '该日志的完整详情不可用' : apiErr?.message ?? '无法加载该日志的详情',
      );
    } finally {
      setDetailLoading(false);
    }
  };

  // Generate or regenerate the AI summary for the open request. force=true when
  // a summary already exists (the button reads "重新生成"), bypassing the cache.
  const handleGenerateSummary = async (force: boolean) => {
    if (!selectedLog) return;
    setSummaryLoading(true);
    try {
      const result = await generateLogSummary(selectedLog.requestId, force);
      setSummary(result.summary);
      setSummaryMeta(result.meta);
    } catch (e) {
      alert((e as ApiError).message);
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleArchive = async () => {
    setArchiving(true);
    try {
      const stats = await archiveLogs(includeToday ? { retentionDays: 0 } : {});
      setArchiveMsg({
        text: `扫描 ${stats.scanned} 条，清理 ${stats.cleaned} 条冗余，保留 ${stats.kept} 条`,
        kind: 'success',
      });
      setConfirmOpen(false);
      load();
    } catch (e) {
      setArchiveMsg({ text: `归并失败：${(e as ApiError).message}`, kind: 'error' });
      setConfirmOpen(false);
    } finally {
      setArchiving(false);
    }
  };

  const columns = [
    {
      key: 'requestId',
      header: '请求 ID',
      render: (log: RequestLog) => (
        <span className="font-mono text-xs">
          {log.requestId.length > 16 ? log.requestId.slice(0, 16) + '...' : log.requestId}
        </span>
      ),
    },
    { key: 'model', header: '模型', render: (log: RequestLog) => log.model || '-' },
    { key: 'provider', header: '服务商', render: (log: RequestLog) => log.provider || '-' },
    {
      key: 'requestPath',
      header: '请求路径',
      render: (log: RequestLog) =>
        log.requestPath ? (
          <span className="font-mono text-xs break-all">{log.requestPath}</span>
        ) : '-',
    },
    {
      key: 'userAgent',
      header: 'UA',
      className: 'max-w-[200px]',
      render: (log: RequestLog) =>
        log.userAgent ? (
          <span className="font-mono text-xs block truncate" title={log.userAgent}>
            {log.userAgent}
          </span>
        ) : '-',
    },
    {
      key: 'statusCode',
      header: '状态',
      render: (log: RequestLog) =>
        log.statusCode != null ? <StatusBadge status={String(log.statusCode)} /> : '-',
    },
    {
      key: 'latencyMs',
      header: '延迟',
      render: (log: RequestLog) => (log.latencyMs != null ? `${log.latencyMs}ms` : '-'),
    },
    {
      key: 'tokens',
      header: 'Token 数',
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
      key: 'isStream',
      header: '类型',
      render: (log: RequestLog) => (log.isStream ? '流式' : '普通'),
    },
    {
      key: 'archived',
      header: '归档',
      render: (log: RequestLog) => (
        // data-merge-anchor wraps the badge on every row (invisible placeholder
        // when not archived) so the arrow trunk x is identical across source
        // and target rows — both anchor to the badge's right edge.
        <span data-merge-anchor className="inline-flex">
          <Badge variant="secondary" className={`text-xs ${log.archivedAt ? '' : 'invisible'}`}>
            已归并
          </Badge>
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: '时间',
      render: (log: RequestLog) => formatDateTime(log.createdAt),
    },
  ];

  return (
    <div className="space-y-4">
        <div ref={filterSectionRef}>
          <LogsFilterForm
            filters={filters}
            onFiltersChange={setFilters}
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
            filterOptions={filterOptions}
            users={users}
            apiKeys={apiKeys}
            apps={apps}
            groups={groups}
            onFilter={handleFilter}
            onArchive={() => setConfirmOpen(true)}
            onHideArchivedChange={() => setPage(1)}
          />
        </div>
            {archiveMsg && (
              <div className={`text-sm ${archiveMsg.kind === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {archiveMsg.text}
              </div>
            )}
        {filterStuck && (
          // z-20：盖住表格滚动内容，同时低于移动端 sidebar 遮罩（z-30）/侧栏
          //（z-40）；表单内 Radix 弹层（z-50）仍在最上，下拉正常弹出。
          <div className="sticky top-0 z-20 rounded-lg border bg-background/95 p-2 shadow-md backdrop-blur">
            {stickyExpanded ? (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    过滤条件
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setStickyExpanded(false)}>
                    <ChevronUp className="h-4 w-4" />
                    收起
                  </Button>
                </div>
                <div className="max-h-[55vh] overflow-y-auto pr-1">
                  <LogsFilterForm
                    filters={filters}
                    onFiltersChange={setFilters}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onDateFromChange={setDateFrom}
                    onDateToChange={setDateTo}
                    filterOptions={filterOptions}
                    users={users}
                    apiKeys={apiKeys}
                    apps={apps}
                    groups={groups}
                    onFilter={() => {
                      // 应用后收起，让出视野直接看过滤结果。
                      handleFilter();
                      setStickyExpanded(false);
                    }}
                    onArchive={() => setConfirmOpen(true)}
                    onHideArchivedChange={() => setPage(1)}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {filterChips.length === 0 ? (
                    <span className="text-sm text-muted-foreground">未设置过滤条件</span>
                  ) : (
                    <>
                      {filterChips.slice(0, 5).map((chip) => (
                        <Badge key={chip} variant="secondary" className="max-w-[260px] truncate font-normal">
                          {chip}
                        </Badge>
                      ))}
                      {filterChips.length > 5 && (
                        <Badge variant="outline">+{filterChips.length - 5}</Badge>
                      )}
                    </>
                  )}
                </div>
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => setStickyExpanded(true)}>
                  展开过滤器
                  <ChevronDown className="ml-1 h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}
        <MergeArrowsOverlay logs={logs}>
          <DataTable
            columns={columns}
            data={logs}
            page={page}
            pageSize={50}
            total={total}
            onPageChange={setPage}
            onRowClick={openDetail}
            keyExtractor={(log) => log.id}
            compact
          />
        </MergeArrowsOverlay>

        <Dialog open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
          <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>请求详情</DialogTitle>
              <DialogDescription>请求日志详情</DialogDescription>
            </DialogHeader>
            {detailLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : detail ? (
              <div className="space-y-4 overflow-y-auto flex-1 min-h-0">
                {detail.mergedInto && (
                  <div className="rounded border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 flex items-center justify-between gap-3">
                    <span>
                      本请求为会话中间步骤，完整记录见{' '}
                      <span className="font-mono">{detail.mergedInto.slice(0, 8)}...</span>
                    </span>
                    <Button variant="outline" onClick={() => jumpToDetail(detail.mergedInto!)}>
                      查看完整记录
                    </Button>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div><span className="font-medium">请求 ID：</span> {detail.requestId}</div>
                  <div><span className="font-medium">请求方法：</span> {detail.requestMethod}</div>
                  <div><span className="font-medium">路径：</span> {detail.requestPath}</div>
                  <div><span className="font-medium">状态：</span> {detail.responseStatus}</div>
                  <div><span className="font-medium">延迟：</span> {detail.latencyMs}ms</div>
                  <div><span className="font-medium">客户端 IP：</span> {detail.clientIp}</div>
                  <div className="col-span-2 flex flex-wrap gap-x-6 gap-y-1">
                    <span><span className="font-medium">功能标识：</span> {selectedLog?.featureId || '-'}</span>
                    <span><span className="font-medium">用户标识：</span> {selectedLog?.appUserId || '-'}</span>
                    <span>
                      <span className="font-medium">API 密钥：</span>{' '}
                      {selectedLog
                        ? apiKeys.find((k) => k.id === selectedLog.apiKeyId)?.name ?? `密钥 #${selectedLog.apiKeyId}`
                        : '-'}
                    </span>
                  </div>
                </div>
                {detail.requestBody != null && (
                  <div className="rounded border p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium">AI 小结</h4>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleGenerateSummary(!!summary)}
                        disabled={summaryLoading}
                      >
                        {summaryLoading && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                        {summary ? '重新生成' : '生成小结'}
                      </Button>
                    </div>
                    {summary ? (
                      <>
                        <div className="text-sm whitespace-pre-wrap">{summary}</div>
                        {summaryMeta && (
                          <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                            <span>模型：{summaryMeta.model}</span>
                            <span>
                              Token：{(summaryMeta.promptTokens + summaryMeta.completionTokens).toLocaleString()}
                            </span>
                            {summaryMeta.sharded && <span>分片：{summaryMeta.shardCount} 片</span>}
                            <span>{formatDateTime(summaryMeta.generatedAt)}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        点击「生成小结」用大模型分析这条请求在做什么。小结按需生成并缓存 30 天，重复打开不会重复消耗 token。
                      </div>
                    )}
                  </div>
                )}
                <div>
                  <h4 className="font-medium mb-2">请求内容</h4>
                  <pre className="rounded bg-muted p-4 max-h-60 overflow-auto text-xs break-all">
                    {JSON.stringify(detail.requestBody, null, 2)}
                  </pre>
                </div>
                <div>
                  <h4 className="font-medium mb-2">
                    响应内容
                    {!detail.responseBody && detail.streamChunks && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        （流式 chunks，{detail.streamChunkCount ?? 0} 段）
                      </span>
                    )}
                  </h4>
                  <pre className="rounded bg-muted p-4 max-h-60 overflow-auto text-xs break-all">
                    {detail.responseBody
                      ? JSON.stringify(detail.responseBody, null, 2)
                      : detail.streamChunks ?? 'null'}
                  </pre>
                </div>
                <div>
                  <h4 className="font-medium mb-2">请求头</h4>
                  <pre className="rounded bg-muted p-4 max-h-60 overflow-auto text-xs break-all">
                    {detail.requestHeaders && Object.keys(detail.requestHeaders).length > 0
                      ? JSON.stringify(detail.requestHeaders, null, 2)
                      : '无'}
                  </pre>
                </div>
                <div>
                  <h4 className="font-medium mb-2">响应头</h4>
                  <pre className="rounded bg-muted p-4 max-h-60 overflow-auto text-xs break-all">
                    {detail.responseHeaders && Object.keys(detail.responseHeaders).length > 0
                      ? JSON.stringify(detail.responseHeaders, null, 2)
                      : '无'}
                  </pre>
                </div>
                {selectedLog?.errorMessage && (
                  <div className="rounded border border-destructive p-4 text-destructive">
                    {selectedLog.errorMessage}
                  </div>
                )}
              </div>
            ) : detailError ? (
              <div className="space-y-4 overflow-y-auto flex-1 min-h-0">
                <div className="rounded border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                  <div className="font-medium mb-1">{detailError}</div>
                  <div className="text-xs leading-relaxed">
                    专用密钥（dedicated）日志的请求/响应大字段可能因请求体过大在写入时失败，或已超过详情保留期被清理。下方为列表行保留的概要信息。
                  </div>
                </div>
                {selectedLog && (
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="col-span-2"><span className="font-medium">请求 ID：</span> <span className="font-mono text-xs break-all">{selectedLog.requestId}</span></div>
                    <div><span className="font-medium">模型：</span> {selectedLog.model ?? '-'}</div>
                    <div><span className="font-medium">服务商：</span> {selectedLog.provider ?? '-'}</div>
                    <div><span className="font-medium">状态码：</span> {selectedLog.statusCode ?? '-'}</div>
                    <div><span className="font-medium">延迟：</span> {selectedLog.latencyMs != null ? `${selectedLog.latencyMs}ms` : '-'}</div>
                    <div><span className="font-medium">流式：</span> {selectedLog.isStream ? '是' : '否'}</div>
                    <div><span className="font-medium">输入 Token：</span> {selectedLog.promptTokens ?? '-'}</div>
                    <div><span className="font-medium">输出 Token：</span> {selectedLog.completionTokens ?? '-'}</div>
                    {(selectedLog.cacheReadTokens != null || selectedLog.cacheCreationTokens != null) && (
                      <div><span className="font-medium">缓存读取 Token：</span> {selectedLog.cacheReadTokens ?? 0}</div>
                    )}
                    <div className="col-span-2"><span className="font-medium">创建时间：</span> {formatDateTime(selectedLog.createdAt)}</div>
                    <div className="col-span-2 flex flex-wrap gap-x-6 gap-y-1">
                      <span><span className="font-medium">功能标识：</span> {selectedLog.featureId || '-'}</span>
                      <span><span className="font-medium">用户标识：</span> {selectedLog.appUserId || '-'}</span>
                      <span>
                        <span className="font-medium">API 密钥：</span>{' '}
                        {apiKeys.find((k) => k.id === selectedLog.apiKeyId)?.name ?? `密钥 #${selectedLog.apiKeyId}`}
                      </span>
                    </div>
                  </div>
                )}
                {selectedLog?.errorMessage && (
                  <div className="rounded border border-destructive p-4 text-destructive">
                    {selectedLog.errorMessage}
                  </div>
                )}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        <AlertDialog open={confirmOpen} onOpenChange={(open) => !archiving && setConfirmOpen(open)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>归并冗余请求详情？</AlertDialogTitle>
              <AlertDialogDescription>
                将归并较早的 loop 会话：每个会话只保留最完整的请求详情，被包含的前序请求体/响应体将被清空，用量统计不受影响。此操作不可撤销。
                <br />
                {includeToday
                  ? '已勾选「包含当天」，将归并截止此刻的全部记录。'
                  : '默认仅归并 1 天前的记录，当天数据保留。'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none py-1">
              <input
                id="includeToday"
                type="checkbox"
                checked={includeToday}
                onChange={(e) => setIncludeToday(e.target.checked)}
                disabled={archiving}
                className="h-4 w-4"
              />
              <span>包含当天数据（归并截止此刻的全部记录）</span>
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={archiving}>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleArchive();
                }}
                disabled={archiving}
              >
                {archiving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                确认归并
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
  );
}

export default function LogsPage() {
  return (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <LogsPageContent />
      </Suspense>
    </AppLayout>
  );
}
