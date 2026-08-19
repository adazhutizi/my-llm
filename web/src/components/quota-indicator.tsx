'use client';

import { useState, useEffect } from 'react';
import { getQuotaStatus } from '@/lib/api';
import type { QuotaStatus } from '@/lib/types';

interface QuotaIndicatorProps {
  type: 'users' | 'apps' | 'api_keys';
  id: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function QuotaIndicator({ type, id }: QuotaIndicatorProps) {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    getQuotaStatus(type, id)
      .then(setQuota)
      .catch(() => setQuota(null));
  }, [type, id]);

  if (!quota) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }

  const dailyTokens = Number(quota.usage.today.tokens);
  const dailyPct = quota.usage.today.percentage;
  const hasLimit = quota.limits.dailyTokens != null || quota.limits.monthlyTokens != null;

  if (!hasLimit) {
    return <span className="text-xs text-muted-foreground">未配置</span>;
  }

  const pct = dailyPct ?? 0;
  const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-16 rounded-full bg-gray-200">
          <div
            className={`h-1.5 rounded-full ${color}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {pct.toFixed(0)}%
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatTokens(dailyTokens)}
        {quota.limits.dailyTokens != null && ` / ${formatTokens(quota.limits.dailyTokens)}`}
        <span className="text-muted-foreground/60"> tokens</span>
      </p>
    </div>
  );
}
