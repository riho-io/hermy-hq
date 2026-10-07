'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type ForceGraphInstance from 'force-graph';
import type { NodeObject } from 'force-graph';
import type { WikiGraph } from '@/lib/wiki-graph';
import { obsidianUrl } from '@/lib/wiki-graph';

type ColorMode = 'folder' | 'editor';
type GNode = NodeObject & { id: string; title: string; folder: string; editedBy: 'pc' | 'argo' | null; ghost: boolean; deg: number };

// Fixed palette so a folder keeps its colour between visits; unknown folders fall back to grey.
const FOLDER_COLORS: Record<string, string> = {
  projects: '#6ea8fe',
  sessions: '#8b8f98',
  skills: '#5fd0a0',
  references: '#c792ea',
  concepts: '#f5c451',
  business: '#f28b82',
  _raw: '#4b4e54',
  handoffs: '#7fdbca',
  entities: '#ffb86c',
  daily: '#82aaff',
};
const EDITOR_COLORS = { pc: '#6ea8fe', argo: '#f5c451', none: '#4b4e54' };
const GHOST = '#3a3d42';

export function WikiGraphView({ graph, version }: { graph: WikiGraph; version: string }) {
  const box = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraphInstance<GNode> | null>(null);
  // Last node objects handed to force-graph (it mutates x/y/vx/vy in place), so a rebuilt graph can start from them.
  const prevNodes = useRef<GNode[]>([]);
  const [mode, setMode] = useState<ColorMode>('folder');
  const [showSessions, setShowSessions] = useState(false);
  const [ready, setReady] = useState(false);

  // Nodes + links for the current filter; unresolved targets become small grey "ghost" nodes.
  // Keyed on `version` (snapshot timestamp), not `graph`: the 60 s router.refresh() hands over a new but identical
  // object each time, which would restart the layout.
  const data = useMemo(() => {
    const keep = graph.notes.filter((n) => showSessions || n.folder !== 'sessions');
    const ids = new Set(keep.map((n) => n.id));
    const deg = new Map<string, number>();
    const links: { source: string; target: string }[] = [];
    for (const n of keep) {
      for (const t of n.links) {
        if (!ids.has(t)) continue;
        links.push({ source: n.id, target: t });
        deg.set(n.id, (deg.get(n.id) ?? 0) + 1);
        deg.set(t, (deg.get(t) ?? 0) + 1);
      }
    }
    const ghosts = new Map<string, GNode>();
    for (const u of graph.unresolved) {
      if (!ids.has(u.from)) continue;
      const gid = `ghost:${u.target.toLowerCase()}`;
      if (!ghosts.has(gid)) ghosts.set(gid, { id: gid, title: u.target, folder: '', editedBy: null, ghost: true, deg: 0 });
      links.push({ source: u.from, target: gid });
    }
    const nodes: GNode[] = [
      ...keep.map((n) => ({ id: n.id, title: n.title, folder: n.folder, editedBy: n.editedBy, ghost: false, deg: deg.get(n.id) ?? 0 })),
      ...ghosts.values(),
    ];
    // Carry positions over by id so a new snapshot or the sessions/ toggle doesn't scatter nodes that already have one.
    const prev = new Map(prevNodes.current.map((n) => [n.id, n]));
    for (const n of nodes) {
      const p = prev.get(n.id);
      if (p) Object.assign(n, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
    }
    prevNodes.current = nodes;
    return { nodes, links };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `graph` is read only when `version` (its snapshot id) changes
  }, [version, showSessions]);

  const colorOf = useMemo(
    () => (n: GNode) => {
      if (n.ghost) return GHOST;
      if (mode === 'editor') return EDITOR_COLORS[n.editedBy ?? 'none'];
      return FOLDER_COLORS[n.folder] ?? '#8b8f98';
    },
    [mode],
  );

  // Create the canvas once; force-graph is browser-only, so it is imported inside the effect.
  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | undefined;
    import('force-graph').then(({ default: ForceGraph }) => {
      if (cancelled || !box.current) return;
      const g = new ForceGraph<GNode>(box.current)
        .backgroundColor('rgba(0,0,0,0)')
        .nodeId('id')
        .nodeLabel((n) => (n.ghost ? `${n.title} — lahendamata` : `${n.title} · ${n.folder || 'juur'}`))
        .nodeVal((n) => (n.ghost ? 0.4 : 1 + Math.sqrt(n.deg)))
        .linkColor(() => 'rgba(255,255,255,0.08)')
        .linkWidth(0.5)
        .cooldownTicks(200)
        .onNodeClick((n) => {
          if (!n.ghost) window.location.href = obsidianUrl(n.id);
        })
        .width(box.current.clientWidth)
        .height(box.current.clientHeight);
      fg.current = g;
      setReady(true);
      ro = new ResizeObserver(([e]) => g.width(e.contentRect.width).height(e.contentRect.height));
      ro.observe(box.current);
    });
    return () => {
      cancelled = true;
      ro?.disconnect();
      fg.current?._destructor?.();
      fg.current = null;
      // The destructor leaves the old canvas in the DOM; clear it so a re-run (StrictMode, Fast Refresh) starts clean.
      box.current?.replaceChildren();
      setReady(false);
    };
  }, []);

  // Data and colour changes reuse the same canvas; `ready` flips once the lazy import has created it.
  useEffect(() => {
    if (ready) fg.current?.graphData(data);
  }, [ready, data]);

  // Separate so a colour toggle only repaints and doesn't re-heat the simulation.
  useEffect(() => {
    if (ready) fg.current?.nodeColor(colorOf);
  }, [ready, colorOf]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-[11.5px]">
        <Toggle on={mode === 'folder'} onClick={() => setMode('folder')}>Värv: kategooria</Toggle>
        <Toggle on={mode === 'editor'} onClick={() => setMode('editor')}>Värv: kes muutis</Toggle>
        <span className="mx-1 h-3 w-px bg-[var(--line)]" aria-hidden />
        <Toggle on={showSessions} onClick={() => setShowSessions((v) => !v)}>sessions/</Toggle>
        {mode === 'editor' && (
          <span className="ml-auto flex gap-3 text-[var(--text-3)]">
            <Dot color={EDITOR_COLORS.pc} label="PC" /> <Dot color={EDITOR_COLORS.argo} label="Argo" />{' '}
            <Dot color={EDITOR_COLORS.none} label="teadmata" />
          </span>
        )}
      </div>
      <div ref={box} className="h-[320px] lg:h-[460px] w-full overflow-hidden rounded-[10px] border border-[var(--line)]" />
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-2.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
        on ? 'border-[var(--line-strong)] bg-[var(--surface-2)] text-[var(--text)]' : 'border-[var(--line)] text-[var(--text-3)] hover:text-[var(--text-2)]'
      }`}
    >
      {children}
    </button>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}
