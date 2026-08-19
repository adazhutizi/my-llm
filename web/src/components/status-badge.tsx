'use client';

import { Badge } from '@/components/ui/badge';

const colorMap: Record<string, string> = {
  active: 'bg-green-50 text-green-700 border-green-200',
  disabled: 'bg-gray-50 text-gray-600 border-gray-200',
  revoked: 'bg-red-50 text-red-700 border-red-200',
  expired: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  quota_exceeded: 'bg-orange-50 text-orange-700 border-orange-200',
};

export function StatusBadge({ status }: { status: string }) {
  const colors = colorMap[status] || 'bg-gray-50 text-gray-600 border-gray-200';
  return (
    <Badge variant="outline" className={`${colors} font-medium`}>
      {status}
    </Badge>
  );
}
