// ESLint flat config. Next.js 16 removed the `next lint` subcommand, so ESLint
// is invoked directly via the `lint` script. We use typescript-eslint +
// eslint-plugin-react-hooks directly rather than `eslint-config-next`: on
// Next.js 16 its `next/core-web-vitals` shareable config (legacy eslintrc
// format) crashes `@eslint/eslintrc`'s FlatCompat with
// "Converting circular structure to JSON" — an open upstream issue
// (vercel/next.js#85679). The Next-specific lint rules are intentionally
// dropped; typescript-eslint + react-hooks cover the code-quality checks that
// matter for this dashboard.
// Run: `pnpm --filter llm-gateway-dashboard lint`
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['.next/**', 'out/**', 'next-env.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
