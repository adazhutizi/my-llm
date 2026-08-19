'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { RequestLog } from '@/lib/types';

// The arrow trunk anchors to the "已归并" badge itself: each row's 归档 cell
// renders a data-merge-anchor span wrapping the badge (or an invisible
// placeholder when the row has no badge), so every row's anchor sits at the
// same x = badge right edge. The arrow leaves the source badge, bows right
// into the column's empty space, and re-enters the target badge.
//
// Color: one color per destination (colorFor(dstId)). All sources merging into
// the same target share a color, so a converging cluster reads as one group;
// at 50 rows/page many arrows cross and a single color would tangle, so
// per-destination coloring keeps them separable.
const PALETTE = [
  '#16a34a', // green-600
  '#2563eb', // blue-600
  '#9333ea', // purple-600
  '#dc2626', // red-600
  '#ea580c', // orange-600
  '#0891b2', // cyan-600
  '#ca8a04', // yellow-600
  '#db2777', // pink-600
];

function colorFor(dstId: string): string {
  let h = 0;
  for (let i = 0; i < dstId.length; i++) h = (h * 31 + dstId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function markerIdFor(color: string): string {
  return `logs-merge-head-${color.slice(1)}`;
}

// Bezier control-point right offset → curve depth. Both control points at
// (trunkX + SWING) bow the arc to the right. Crank up for a more pronounced bow.
const SWING = 22;

interface Arrow {
  srcId: string;
  dstId: string;
  // When several sources merge into one target, fan their trunks out across x
  // so they don't stack on the same line.
  offsetIndex: number;
  offsetTotal: number;
}

interface PathSpec {
  id: string;
  d: string;
  color: string;
}

/**
 * Pick the arrows to draw: one per archived row whose `mergedInto` target is
 * also on the current page. Targets outside the page are dropped here (the
 * detail dialog's `jumpToDetail` already handles cross-page jumps). Chains
 * (A→B→C, all on page) fall out naturally — A and B each carry their own
 * `mergedInto`, so A→B and B→C are two independent arrows.
 */
function deriveArrows(logs: RequestLog[]): Arrow[] {
  // Rows are keyed by their DB id (the logs page's keyExtractor), NOT by
  // requestId — historical logs contain duplicate request_ids (pre-fix clients
  // reused X-Request-ID), so requestId is not a unique row handle and would
  // collide as a DOM anchor. mergedInto still stores the successor's requestId
  // string (archive semantics), so resolve each edge's target to its row id via
  // this map to locate it by data-row-key. If two rows share a requestId the
  // later one wins in the map — that only picks which duplicate the arrow points
  // at, never affects list correctness.
  const idByRequestId = new Map(logs.map((l) => [l.requestId, l.id]));
  const onPage = (requestId: string) => idByRequestId.has(requestId);
  const sources = logs.filter(
    (l) => l.archivedAt && l.mergedInto && onPage(l.mergedInto),
  );

  const countByDst = new Map<string, number>();
  for (const l of sources) {
    const dst = l.mergedInto!;
    countByDst.set(dst, (countByDst.get(dst) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return sources.map((l) => {
    const dstReqId = l.mergedInto!;
    const idx = seen.get(dstReqId) ?? 0;
    seen.set(dstReqId, idx + 1);
    return {
      srcId: String(l.id),
      dstId: String(idByRequestId.get(dstReqId)!),
      offsetIndex: idx,
      offsetTotal: countByDst.get(dstReqId)!,
    };
  });
}

/**
 * Symmetric cubic bezier: leaves the source horizontally to the right, bows
 * right, re-enters the target horizontally. The vertical span between rows
 * gives the arrow its length; SWING gives the curve. `trunkX` fans
 * shared-destination arrows apart.
 */
function arcPath(trunkX: number, ySrc: number, yDst: number): string {
  const cx = trunkX + SWING;
  return `M ${trunkX} ${ySrc} C ${cx} ${ySrc}, ${cx} ${yDst}, ${trunkX} ${yDst}`;
}

/**
 * Group page-local requestIds into chains via union-find over the mergedInto
 * edges, so every arrow in a chain a→b→c→d resolves to the same component
 * root and thus the same color. Merges are linear chains in practice (no two
 * sources share a target), so each component is exactly one chain; arrows of
 * different chains get different roots → different colors.
 */
function chainOf(arrows: Arrow[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const nxt = parent.get(cur)!;
      parent.set(cur, root);
      cur = nxt;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const a of arrows) {
    if (!parent.has(a.srcId)) parent.set(a.srcId, a.srcId);
    if (!parent.has(a.dstId)) parent.set(a.dstId, a.dstId);
    union(a.srcId, a.dstId);
  }
  const chain = new Map<string, string>();
  for (const id of parent.keys()) chain.set(id, find(id));
  return chain;
}

interface MergeArrowsOverlayProps {
  logs: RequestLog[];
  children: ReactNode;
}

export function MergeArrowsOverlay({ logs, children }: MergeArrowsOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<PathSpec[]>([]);

  const arrows = useMemo(() => deriveArrows(logs), [logs]);
  // Cluster arrows into chains (connected components via mergedInto) so a
  // whole chain a→b→c→d shares one color; different chains differ.
  const chain = useMemo(() => chainOf(arrows), [arrows]);
  // measure is stable (reads the ref), so the layout effects don't re-bind.
  const arrowsRef = useRef(arrows);
  arrowsRef.current = arrows;
  const chainRef = useRef(chain);
  chainRef.current = chain;

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    if (cRect.width === 0) return; // not laid out yet (SSR / hidden tab)

    // Anchor to each row's "已归并" badge: data-merge-anchor wraps the badge
    // (or an invisible placeholder) so x is identical whether or not a badge is
    // shown. Trunk x = badge right edge; y = badge vertical midpoint.
    const anchorPos = (id: string): { x: number; y: number } | null => {
      const tr = container.querySelector<HTMLElement>(
        `tr[data-row-key="${CSS.escape(id)}"]`,
      );
      if (!tr) return null;
      const anchor = tr.querySelector<HTMLElement>('[data-merge-anchor]');
      if (!anchor) return null;
      const r = anchor.getBoundingClientRect();
      return { x: r.right - cRect.left, y: r.top - cRect.top + r.height / 2 };
    };

    const out: PathSpec[] = [];
    for (const a of arrowsRef.current) {
      const src = anchorPos(a.srcId);
      const dst = anchorPos(a.dstId);
      if (!src || !dst) continue;
      const trunkX = src.x + (a.offsetIndex - (a.offsetTotal - 1) / 2) * 4;
      out.push({
        id: `${a.srcId}->${a.dstId}`,
        d: arcPath(trunkX, src.y, dst.y),
        color: colorFor(chainRef.current.get(a.dstId) ?? a.dstId),
      });
    }
    setPaths(out);
  }, []);

  // Recompute when the page/filter/data swaps the derived arrows.
  useLayoutEffect(() => {
    measure();
  }, [arrows, measure]);

  // Recompute on container resize (row-height reflow), on horizontal scroll
  // (the 归档 column's x shifts within the scroll viewport — scroll doesn't
  // bubble, so capture it from the inner overflow container), and once fonts
  // settle (the mono font can tweak row height after first paint).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    // rAF-coalesce scroll bursts so a drag doesn't measure dozens of times.
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    el.addEventListener('scroll', onScroll, true);
    let cancelled = false;
    const fonts = document.fonts;
    if (fonts) {
      fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('scroll', onScroll, true);
    };
  }, [measure]);

  return (
    <div ref={containerRef} className="relative">
      {paths.length > 0 && (
        <svg
          className="pointer-events-none absolute inset-0 z-10 overflow-visible"
          width="100%"
          height="100%"
          aria-hidden="true"
        >
          <defs>
            {PALETTE.map((c) => (
              <marker
                key={c}
                id={markerIdFor(c)}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
              </marker>
            ))}
          </defs>
          {paths.map((p) => (
            <path
              key={p.id}
              d={p.d}
              fill="none"
              stroke={p.color}
              strokeWidth={1.5}
              markerEnd={`url(#${markerIdFor(p.color)})`}
            />
          ))}
        </svg>
      )}
      {children}
    </div>
  );
}
