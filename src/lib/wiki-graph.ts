import { z } from 'zod';

// Jarvis "Masin": the Syncthing-shared wiki as a graph. Pure helpers (no Prisma/Next) so they are unit-testable.
// Argo's wiki_graph_sync.py sends paths, titles, links and mtimes — never note content.

export const MAX_NOTES = 3000;
const MAX_UNRESOLVED = 10_000;
const MAX_LINKS_PER_NOTE = 500;
const VAULT_NAME = 'wiki';
const TZ = 'Europe/Tallinn';

// A vault-relative POSIX path to a .md file; anything that could escape the vault is rejected.
const noteId = z
  .string()
  .min(4)
  .max(300)
  .refine(
    (s) => s.endsWith('.md') && !s.startsWith('/') && !s.includes('\\') && !s.split('/').includes('..'),
    'invalid note id',
  );
const ts = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
// Long free text is clipped, not rejected, so one odd filename can't block the whole sync.
const clipped = (max: number) => z.string().max(2000).transform((s) => s.slice(0, max));

const Note = z.object({
  id: noteId,
  title: clipped(200),
  folder: clipped(100),
  mtime: ts,
  links: z.array(noteId).max(MAX_LINKS_PER_NOTE),
  editedBy: z.enum(['pc', 'argo']).nullable(),
});

export const WikiPayload = z.object({
  source: z.literal('argo'),
  notes: z.array(Note).max(MAX_NOTES),
  unresolved: z.array(z.object({ from: noteId, target: clipped(200) })).max(MAX_UNRESOLVED),
  pcLastSeenAt: ts.nullable(),
});

export type WikiPayloadInput = z.output<typeof WikiPayload>;

export interface WikiNote {
  id: string;
  title: string;
  folder: string;
  mtime: string;
  links: string[];
  editedBy: 'pc' | 'argo' | null;
}

export interface WikiGraph {
  notes: WikiNote[];
  unresolved: { from: string; target: string }[];
}

/** Dedupe notes, keep only links between sent notes, count what the page shows. */
export function normalizeWikiPayload(p: WikiPayloadInput) {
  const seen = new Set<string>();
  const notes: WikiNote[] = [];
  for (const n of p.notes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    notes.push({ ...n, mtime: new Date(n.mtime).toISOString() });
  }

  const linked = new Set<string>();
  let links = 0;
  for (const n of notes) {
    n.links = [...new Set(n.links)].filter((t) => t !== n.id && seen.has(t));
    links += n.links.length;
    if (n.links.length) linked.add(n.id);
    for (const t of n.links) linked.add(t);
  }

  const unresolved = p.unresolved.filter((u) => seen.has(u.from));
  const graph: WikiGraph = { notes, unresolved };
  return {
    graph,
    counts: {
      notes: notes.length,
      links,
      unresolved: unresolved.length,
      orphans: notes.filter((n) => !linked.has(n.id)).length,
    },
    pcLastSeenAt: p.pcLastSeenAt ? new Date(p.pcLastSeenAt) : null,
  };
}

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Most recently modified notes and how many changed today (Tallinn calendar day). */
export function summarizeWiki(graph: WikiGraph, now: Date, limit = 10) {
  const today = dayKey.format(now);
  const sorted = [...graph.notes].sort((a, b) => b.mtime.localeCompare(a.mtime));
  return {
    recent: sorted.slice(0, limit),
    changedToday: graph.notes.filter((n) => dayKey.format(new Date(n.mtime)) === today).length,
  };
}

/** Deep link that opens the note in the local Obsidian vault (PC has every note via Syncthing). */
export function obsidianUrl(noteId: string): string {
  return `obsidian://open?vault=${VAULT_NAME}&file=${encodeURIComponent(noteId.replace(/\.md$/, ''))}`;
}
