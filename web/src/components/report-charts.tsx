'use client';

// Reusable recharts building blocks for the /reports page.
//
// Two exports:
//   <TrendChart>            — dual-axis line chart (requests left / tokens right),
//                              a parameterized copy of the overview page's chart.
//   <DistributionCharts>    — pie (share) + horizontal bar (ranking), sharing one
//                              dataset. The page layer maps ReportDimensionItem /
//                              ReportStatusItem into the label/value shape here so
//                              this component stays dimension-agnostic.
//
// Colors extend the overview page's three-tone system (#6366f1 / #22c55e / #f59e0b)
// so the charts read as the same visual language as the dashboard.

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  Legend,
} from 'recharts';
import type { ReportTrendPoint, ReportGranularity } from '@/lib/types';

// Stable palette — first three tones mirror the overview page, the rest extend
// for multi-category pie/bar charts.
export const REPORT_COLORS = [
  '#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4',
  '#8b5cf6', '#f43f5e', '#84cc16', '#0ea5e9', '#a855f7',
];

// Same thresholds as the overview page's formatTokens so big numbers stay compact.
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

// ── Trend chart ──────────────────────────────────────────────────────────

function formatTick(timeBucket: string, granularity: ReportGranularity): string {
  // timeBucket comes from the backend's DATE_FORMAT(CONVERT_TZ(...)) so it's a
  // Beijing wall-clock string in one of these shapes:
  //   hour  'YYYY-MM-DD HH:00:00' → 'MM-DD HH:00'
  //   day   'YYYY-MM-DD'          → 'MM-DD'
  //   week  'YYYY-WW'             → 'YYYY 第WW周'
  //   month 'YYYY-MM'             → 'YYYY-MM'
  if (granularity === 'hour') return timeBucket.slice(5, 16);
  if (granularity === 'day') return timeBucket.slice(5);
  if (granularity === 'month') return timeBucket;
  return timeBucket; // week 'YYYY-WW' as-is
}

export function TrendChart({ points, granularity }: { points: ReportTrendPoint[]; granularity: ReportGranularity }) {
  const data = points.map((p) => ({
    time: p.timeBucket,
    requests: p.totalRequests,
    tokens: p.totalTokens,
    cacheTokens: p.totalCacheReadTokens + p.totalCacheCreationTokens,
  }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="time"
          tickFormatter={(val: string) => formatTick(val, granularity)}
          minTickGap={16}
        />
        <YAxis yAxisId="left" />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickFormatter={(v: number) => formatTokens(v)}
        />
        <Tooltip
          labelFormatter={(val: string) => formatTick(val, granularity)}
          formatter={(value, name) =>
            name === '请求数'
              ? [formatNumber(Number(value)), name]
              : [formatTokens(Number(value)), name]
          }
        />
        <Legend />
        <Line yAxisId="left" type="monotone" dataKey="requests" stroke={REPORT_COLORS[0]} strokeWidth={2} dot={false} name="请求数" />
        <Line yAxisId="right" type="monotone" dataKey="tokens" stroke={REPORT_COLORS[1]} strokeWidth={2} dot={false} name="Tokens" />
        <Line yAxisId="right" type="monotone" dataKey="cacheTokens" stroke={REPORT_COLORS[2]} strokeWidth={2} dot={false} name="缓存 Tokens" />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Distribution charts (pie + bar) ──────────────────────────────────────

export interface DistDatum {
  label: string;
  value: number;
}

export function DistributionCharts({
  data,
  metricLabel,
  compact = true,
  emptyHint = '当前筛选下暂无数据',
}: {
  data: DistDatum[];
  /** Axis/tooltip unit, e.g. "Tokens" or "请求数". */
  metricLabel: string;
  /**
   * Compact large values with M suffix (e.g. "1.2M")? Defaults to true so token
   * dimensions stay compact. Set false for request-count dimensions to match
   * the overview page's full-digit (toLocaleString) rendering.
   */
  compact?: boolean;
  emptyHint?: string;
}) {
  const fmt = compact ? formatTokens : formatNumber;
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  // Rank by value desc for the bar chart; the pie is share-based so order is
  // cosmetic, but reusing the ranked order keeps the two charts visually aligned.
  const ranked = [...data].sort((a, b) => b.value - a.value);
  const colorFor = (i: number) => REPORT_COLORS[i % REPORT_COLORS.length];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* 占比 */}
      <div>
        <h4 className="text-sm font-medium text-muted-foreground mb-2">占比分布</h4>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={ranked}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              outerRadius={95}
              innerRadius={45}
              paddingAngle={ranked.length > 1 ? 2 : 0}
              label={({ name, percent }) =>
                `${name} ${(Number(percent) * 100).toFixed(0)}%`
              }
              labelLine={false}
            >
              {ranked.map((_, i) => (
                <Cell key={i} fill={colorFor(i)} />
              ))}
            </Pie>
            <Tooltip formatter={(value) => [fmt(Number(value)), metricLabel]} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* 排名 */}
      <div>
        <h4 className="text-sm font-medium text-muted-foreground mb-2">排名（{metricLabel}）</h4>
        <ResponsiveContainer width="100%" height={Math.max(300, ranked.length * 36)}>
          <BarChart data={ranked} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tickFormatter={(v: number) => fmt(v)} />
            <YAxis
              type="category"
              dataKey="label"
              width={130}
              tickFormatter={(v: string) => (v.length > 12 ? `${v.slice(0, 12)}…` : v)}
            />
            <Tooltip formatter={(value) => [fmt(Number(value)), metricLabel]} />
            <Bar dataKey="value" radius={[0, 4, 4, 0]}>
              {ranked.map((_, i) => (
                <Cell key={i} fill={colorFor(i)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
