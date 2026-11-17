'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { InlineCombobox } from '@/components/inline-combobox';
import { Search, BarChart3 } from 'lucide-react';
import type { User, ApiKey, App, UserGroup } from '@/lib/types';

/** 请求日志页过滤器状态形状（logs/page.tsx 持有 state，此组件纯受控）。 */
export interface LogsFilterState {
  model: string;
  provider: string;
  statusCode: string;
  requestPath: string;
  userAgent: string;
  featureId: string;
  appUserId: string;
  userId: string;
  apiKeyId: string;
  appId: string;
  groupId: string;
  hideArchived: boolean;
}

interface LogsFilterFormProps {
  filters: LogsFilterState;
  onFiltersChange: (next: LogsFilterState) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  filterOptions: { models: string[]; providers: string[] };
  users: User[];
  apiKeys: ApiKey[];
  apps: App[];
  groups: UserGroup[];
  onFilter: () => void;
  // 跳转 /reports 并携带当前过滤条件（归并操作已移至系统设置页）。
  onReport: () => void;
  // 「归并」复选框改变即生效（不经「筛选」按钮），父级借此重置页码到 1。
  onHideArchivedChange?: () => void;
}

/**
 * 请求日志过滤条件表单。同一份表单渲染两处：页面顶部原位，以及滚动后固定
 * 在列表上方的折叠条展开态 —— 状态全部由父组件持有，两处共享同一份数据，
 * 不会出现「顶部改了、固定条还是旧条件」的漂移。
 */
export function LogsFilterForm({
  filters,
  onFiltersChange,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  filterOptions,
  users,
  apiKeys,
  apps,
  groups,
  onFilter,
  onReport,
  onHideArchivedChange,
}: LogsFilterFormProps) {
  return (
    <div className="flex flex-wrap gap-4 items-end">
      <div>
        <Label>开始时间</Label>
        <Input type="datetime-local" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)} />
      </div>
      <div>
        <Label>结束时间</Label>
        <Input type="datetime-local" value={dateTo} onChange={(e) => onDateToChange(e.target.value)} />
      </div>
      <div className="w-[200px]">
        <Label>服务商</Label>
        <InlineCombobox
          options={Array.from(new Set([filters.provider, ...filterOptions.providers])).filter(Boolean).map((p) => ({ value: p, label: p }))}
          value={filters.provider}
          onChange={(v) => onFiltersChange({ ...filters, provider: v })}
          placeholder="全部服务商"
          searchPlaceholder="搜索服务商..."
          emptyText="未找到服务商"
          allowClear
          clearLabel="全部服务商"
        />
      </div>
      <div className="w-[200px]">
        <Label>模型</Label>
        <InlineCombobox
          options={Array.from(new Set([filters.model, ...filterOptions.models])).filter(Boolean).map((m) => ({ value: m, label: m }))}
          value={filters.model}
          onChange={(v) => onFiltersChange({ ...filters, model: v })}
          placeholder="全部模型"
          searchPlaceholder="搜索模型..."
          emptyText="未找到模型"
          allowClear
          clearLabel="全部模型"
        />
      </div>
      <div className="w-[200px]">
        <Label>分组</Label>
        <InlineCombobox
          options={groups.map((g) => ({ value: String(g.id), label: g.name }))}
          value={filters.groupId}
          onChange={(v) => onFiltersChange({ ...filters, groupId: v, userId: '', apiKeyId: '' })}
          placeholder="全部分组"
          searchPlaceholder="搜索分组名..."
          emptyText="未找到分组"
          allowClear
          clearLabel="全部分组"
        />
      </div>
      <div className="w-[200px]">
        <Label>用户</Label>
        <InlineCombobox
          options={users.map((u) => ({ value: String(u.id), label: u.username, suffix: u.identifier || `#${u.id}` }))}
          value={filters.userId}
          onChange={(v) => onFiltersChange({ ...filters, userId: v, apiKeyId: '' })}
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
          onChange={(v) => onFiltersChange({ ...filters, apiKeyId: v })}
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
          onChange={(v) => onFiltersChange({ ...filters, appId: v })}
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
          onChange={(e) => onFiltersChange({ ...filters, requestPath: e.target.value })}
        />
      </div>
      <div className="w-[220px]">
        <Label>UA</Label>
        <Input
          placeholder="curl/8"
          value={filters.userAgent}
          onChange={(e) => onFiltersChange({ ...filters, userAgent: e.target.value })}
        />
      </div>
      <div>
        <Label>状态码</Label>
        <Input
          placeholder="200"
          className="w-24"
          value={filters.statusCode}
          onChange={(e) => onFiltersChange({ ...filters, statusCode: e.target.value })}
        />
      </div>
      <div>
        <Label>用户标识</Label>
        <Input
          placeholder="user-123"
          value={filters.appUserId}
          onChange={(e) => onFiltersChange({ ...filters, appUserId: e.target.value })}
        />
      </div>
      <div>
        <Label>功能标识</Label>
        <Input
          placeholder="chat"
          value={filters.featureId}
          onChange={(e) => onFiltersChange({ ...filters, featureId: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor="hideArchived">归并</Label>
        <div className="flex items-center h-9">
          <input
            id="hideArchived"
            type="checkbox"
            checked={filters.hideArchived}
            onChange={(e) => {
              onFiltersChange({ ...filters, hideArchived: e.target.checked });
              onHideArchivedChange?.();
            }}
            className="h-4 w-4 cursor-pointer"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={onFilter}>
          <Search className="h-4 w-4 mr-2" />
          筛选
        </Button>
        <Button variant="outline" onClick={onReport}>
          <BarChart3 className="h-4 w-4 mr-2" />
          报表
        </Button>
      </div>
    </div>
  );
}
