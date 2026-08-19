'use client';

import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { MermaidBlock } from './mermaid-block';

/** Flatten a react-markdown <code> element's children to plain text — used to
 *  pull the source out of a fenced ```mermaid block. Children are normally a
 *  single string, but we walk arrays / nested elements defensively. */
function codeText(node: ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(codeText).join('');
  if (isValidElement(node)) {
    return codeText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

// Markdown renderer for assistant answers. The dashboard has no Tailwind
// typography plugin (no `prose` class), so we style every element explicitly
// via react-markdown's `components` map. Tables (the agent's primary output
// shape) get borders + horizontal scroll; code blocks get a muted background.
// Fenced ```mermaid blocks are intercepted at <pre> and rendered as SVG by
// MermaidBlock (streaming-friendly; see mermaid-block.tsx).
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold mt-3 mb-1.5">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-0.5">{children}</ol>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          // Inline code and fenced code blocks both render <code>; the muted
          // chip style reads fine inside a <pre> too.
          code: ({ className, children }) => (
            <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]', className)}>
              {children}
            </code>
          ),
          pre: ({ children }) => {
            // react-markdown v10 wraps a fenced block as
            //   <pre><code class="language-mermaid">…</code></pre>
            // The <code> component lost its `inline` prop in v9, so we detect
            // mermaid here by inspecting the child <code> element's className
            // and hand the source to MermaidBlock instead of a plain <pre>.
            const child = Array.isArray(children) ? children[0] : children;
            if (isValidElement(child)) {
              const { className, children: codeChildren } = child.props as {
                className?: string;
                children?: ReactNode;
              };
              if (className && /language-mermaid/.test(className)) {
                return <MermaidBlock chart={codeText(codeChildren)} />;
              }
            }
            return <pre className="my-2 overflow-x-auto rounded bg-muted p-2.5 text-xs">{children}</pre>;
          },
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left font-semibold whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
