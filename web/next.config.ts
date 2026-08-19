import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: '/dashboard',
  // 生产 build 时静态导出到 out/(供后端 serveStatic 托管)。
  // dev 时不设 output: 'export' —— 否则 Next.js 不会应用 rewrites(),
  // 导致前端调 /admin/* 无法代理到后端 :3000。
  ...(process.env.NODE_ENV === 'production' ? { output: 'export', distDir: 'out' } : {}),
  async rewrites() {
    return [
      {
        source: '/admin/:path*',
        destination: 'http://localhost:3000/admin/:path*',
      },
      {
        source: '/health',
        destination: 'http://localhost:3000/health',
      },
    ];
  },
};

export default nextConfig;
