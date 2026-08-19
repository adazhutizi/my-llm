'use client';

import { type ReactNode, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

interface Column<T> {
  key: string;
  header: string;
  render?: (item: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onRowClick?: (item: T) => void;
  keyExtractor?: (item: T) => string | number;
  /** Tighten cell padding so more rows fit a page (e.g. 50/page). Off by
   *  default — only pages that opt in are affected. */
  compact?: boolean;
}

export function DataTable<T>({
  columns,
  data,
  loading,
  emptyMessage = '暂无数据',
  page = 1,
  pageSize = 20,
  total,
  onPageChange,
  onRowClick,
  keyExtractor,
  compact,
}: DataTableProps<T>) {
  const totalPages = total ? Math.ceil(total / pageSize) : 1;
  const [jumpValue, setJumpValue] = useState('');

  const commitJump = () => {
    const p = parseInt(jumpValue, 10);
    if (!Number.isNaN(p) && p >= 1 && p <= totalPages && p !== page) {
      onPageChange?.(p);
    }
    setJumpValue('');
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">加载中...</p>
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </CardContent>
      </Card>
    );
  }

  // compact: shrink row height via descendant selectors. `[&_td]:py-1` /
  // `[&_th]:h-8` beat TableCell's `p-2` / TableHead's `h-10` by specificity
  // (.cls td > .p-2), so vertical padding collapses while horizontal stays.
  const tableClassName = compact ? '[&_td]:py-0.5 [&_th]:h-7' : undefined;

  return (
    <Card>
      <div className="overflow-x-auto">
        <Table className={tableClassName}>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.key} data-col-key={col.key} className={col.className}>
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item, idx) => (
              <TableRow
                key={keyExtractor ? keyExtractor(item) : idx}
                data-row-key={keyExtractor ? String(keyExtractor(item)) : undefined}
                className={onRowClick ? 'cursor-pointer' : undefined}
                onClick={() => onRowClick?.(item)}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.className}>
                    {col.render ? col.render(item) : String((item as Record<string, unknown>)[col.key] ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {onPageChange && total != null && totalPages > 1 && (
        <div className="flex items-center justify-between border-t px-6 py-3">
          <p className="text-sm text-muted-foreground">
            显示第 {(page - 1) * pageSize + 1} 到 {Math.min(page * pageSize, total)} 条，共 {total} 条
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
              上一页
            </Button>
            <span className="text-sm text-muted-foreground whitespace-nowrap">第 {page} / {totalPages} 页</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
              下一页
            </Button>
            <div className="flex items-center gap-1 ml-1">
              <span className="text-sm text-muted-foreground">跳至</span>
              <Input
                type="number"
                min={1}
                max={totalPages}
                value={jumpValue}
                onChange={(e) => setJumpValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitJump(); } }}
                onBlur={commitJump}
                className="h-8 w-16"
                placeholder={String(page)}
                aria-label="跳转到指定页"
              />
              <span className="text-sm text-muted-foreground">页</span>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
