'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  ChartIcon,
  KeyIcon,
  UsersIcon,
  AppIcon,
  ModelIcon,
  ProviderIcon,
  LogIcon,
  SettingsIcon,
  MenuIcon,
  CloseIcon,
  UserChartIcon,
  TagIcon,
  AdminIcon,
  AnalysisIcon,
  ReportIcon,
} from '@/components/icons';
import { LogOut, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const navItems: { href: string; label: string; icon: LucideIcon; superAdminOnly?: boolean }[] = [
  { href: '/', label: '概览', icon: ChartIcon },
  { href: '/providers', label: '服务商', icon: ProviderIcon },
  { href: '/users', label: '用户管理', icon: UsersIcon },
  { href: '/api-keys', label: 'API 密钥', icon: KeyIcon },
  { href: '/models', label: '虚拟模型', icon: ModelIcon },
  { href: '/apps', label: '应用管理', icon: AppIcon },
  { href: '/app-users-usage', label: '用户用量', icon: UserChartIcon },
  { href: '/feature-usage', label: '功能用量', icon: TagIcon },
  { href: '/logs', label: '请求日志', icon: LogIcon },
  { href: '/reports', label: '报表分析', icon: ReportIcon },
  { href: '/analysis', label: '智能分析', icon: AnalysisIcon },
  { href: '/settings', label: '系统设置', icon: SettingsIcon },
  { href: '/admins', label: '管理账户', icon: AdminIcon, superAdminOnly: true },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  // Auth guard: redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  // Strip basePath prefix for matching
  const currentPath = pathname.replace(/^\/dashboard/, '') || '/';

  const currentPage = navItems.find((item) => {
    if (item.href === '/') return currentPath === '/';
    return currentPath.startsWith(item.href);
  });

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  // Show loading state while checking auth
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Don't render content if not authenticated (will redirect)
  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-gray-900 transition-transform duration-200 lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center gap-2 px-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
            L
          </div>
          <span className="text-lg font-semibold text-white">LLM Gateway</span>
        </div>

        <nav className="mt-4 flex-1 space-y-1 px-3">
          {navItems.map((item) => {
            if (item.superAdminOnly && user?.role !== 'super_admin') return null;

            const isActive = item.href === '/'
              ? currentPath === '/'
              : currentPath.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200',
                )}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <Separator className="bg-gray-800" />
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary text-sm font-medium">
              {user?.username?.charAt(0).toUpperCase() || 'A'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-200 truncate">{user?.username || 'Admin'}</p>
              <p className="text-xs text-gray-500">{user?.role === 'super_admin' ? '超级管理员' : '管理员'}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-16 items-center justify-between border-b bg-white px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
          </Button>

          <h1 className="text-lg font-semibold">{currentPage?.label || '控制台'}</h1>

          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-medium">
              {user?.username?.charAt(0).toUpperCase() || 'A'}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
