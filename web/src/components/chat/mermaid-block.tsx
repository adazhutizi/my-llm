'use client';

import { useEffect, useId, useState } from 'react';

// Mermaid is ~1MB+ and only used to render the agent's fenced ```mermaid
// blocks, so it's dynamically imported on first use — code-split out of the
// static-export bundle rather than shipped on first paint. mermaid.initialize()
// is global config on the singleton, so we run it exactly once per page load.
type Mermaid = typeof import('mermaid')['default'];
let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      // securityLevel 'loose' allows rich HTML labels inside nodes (<br>,
      // formatting, click bindings). Intentional trade-off: the agent's reply
      // can reflect the user's prompt, but the audience is gateway admins in
      // their own console — accepted for richer diagrams. theme 'default'
      // matches the dashboard's fixed light palette (no dark-mode toggle).
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        fontFamily: 'inherit',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** Renders one ```mermaid fenced code block as an SVG.
 *
 *  Streaming-aware: the agent's answer arrives token by token (see the
 *  text_delta branch in analysis/page.tsx), so the chart text is incomplete
 *  mid-stream and mermaid.render() throws. We debounce by 250ms — while tokens
 *  keep arriving the render keeps getting rescheduled, so it only fires once
 *  the chart stabilizes (≈ stream end). On failure (still streaming, or a
 *  genuine syntax error) we silently fall back to the raw source instead of
 *  flashing an error, so the user watches the source grow and then sees it
 *  snap into a diagram once complete. */
export function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const rawId = useId();
  // useId() yields ids containing ':' (e.g. ':r1:'), illegal as DOM ids and
  // unsafe inside mermaid's SVG selector handling — strip to alphanumerics.
  // useId is SSR-stable, so prerender and hydration agree on the first render.
  const id = 'mmd-' + rawId.replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    const text = chart.trim();
    if (!text) {
      setSvg(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      loadMermaid()
        .then((m) => m.render(id, text))
        .then((res) => {
          if (!cancelled) setSvg(res.svg);
        })
        .catch(() => {
          // Incomplete (mid-stream) or malformed — fall through to source.
          if (!cancelled) setSvg(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chart, id]);

  if (svg) {
    return (
      <div
        className="my-2 overflow-x-auto rounded border bg-background p-2 [&_svg]:max-w-full [&_svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  // Not yet rendered / failed → show the source so the user can watch the
  // agent produce it (and diagnose a real syntax error once streaming ends).
  // Matches the normal <pre> code-block style so the fallback is unobtrusive.
  return (
    <pre className="my-2 overflow-x-auto rounded bg-muted p-2.5 text-xs">
      <code className="font-mono">{chart.trim() || '正在生成图表…'}</code>
    </pre>
  );
}
