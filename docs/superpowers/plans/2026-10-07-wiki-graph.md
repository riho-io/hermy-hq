# Wiki graaf („Masin") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvise lehele plokk „Masin": wiki (Syncthingiga sünkitud ühine vault) graafina, arvude ja „viimati muudetud" nimekirjaga; värv kategooria või viimase muutja (PC/Argo) järgi.

**Architecture:** Argo skript-cron (`wiki_graph_sync.py`, iga 60 min) loeb `~/wiki`, küsib Syncthingi kohalikust API-st iga faili `modifiedBy`, POSTib `/api/ingest/wiki-graph`. Route valideerib (Zod), normaliseerib ja kirjutab ühe rea `hermyhq.wiki_snapshot` + heartbeat. `/jarvis` loeb rea serveris; graaf joonistatakse kliendis `force-graph`-iga.

**Tech Stack:** Next.js 16.1.6 App Router, React 19, Prisma 6 (skeem `hermyhq`), Zod 4, Tailwind v4, `force-graph` (uus), Python 3.12 stdlib (Argo), `node:test` + `tsx`.

Spec: `docs/superpowers/specs/2026-10-07-wiki-graph-design.md`.

## Global Constraints

- Supabase projekt `ekjvvzlewdafnyiblrbu`, skeem `hermyhq`. Uus tabel → `enable row level security` + poliitikad ainult rollile `hermyhq` **samas migratsioonis**. Skeemi ei lisata PostgRESTi, anon-õigusi ei anta.
- Repo on AVALIK: koodis ei päris e-posti, seadme-ID-d (`OZUULIP`/`OQLFCWC`), IP-d ega võtit.
- Ingest-auth: olemasolev `hasIngestSecret` (`x-ingest-secret` vs `INGEST_SECRET`, konstantse ajaga, fail-closed). Uut võtit ei teki.
- Märkme **sisu** ei lahku Argost — ainult tee, pealkiri, kaust, mtime, lingid, editedBy.
- GSAP keelatud; animatsioonid ainult CSS. Värvid `globals.css` tokenitest (`--up`, `--warn`, `--accent`, `--text-*`, `--line`).
- npm (mitte pnpm). Kood/kommentaarid inglise keeles nagu ülejäänud repo; UI tekst eesti keeles.
- Argo: `ssh rihou@100.68.64.83` (Tailscale). Enne `jobs.json` muutmist varukoopia. Skript-cron (`--no-agent`) võib lisada küsimata.
- Argo vault: `~/wiki`, Syncthingi kaust `wiki`, Syncthingi config `~/.local/state/syncthing/config.xml`.

---

## Failide kaart

| Fail | Vastutus |
|---|---|
| `prisma/schema.prisma` (muuda) | mudel `WikiSnapshot` |
| `src/lib/wiki-graph.ts` (uus) | Zod skeem, normaliseerimine, kokkuvõte (puhas, ilma Prisma/Next-ta → testitav) |
| `src/lib/wiki-graph.test.ts` (uus) | `node:test` testid eelmisele |
| `src/app/api/ingest/wiki-graph/route.ts` (uus) | auth → parse → normalize → transaktsioon |
| `scripts/argo/wiki_graph_sync.py` (uus) | vaulti lugemine, lingid, Syncthing, POST |
| `scripts/argo/test_wiki_graph_sync.py` (uus) | `unittest` puhastele funktsioonidele |
| `src/lib/jarvis.ts` (muuda) | snapshoti lugemine, allikas „Wiki" |
| `src/app/jarvis/wiki-graph.tsx` (uus) | klient: force-graph + lülitid |
| `src/app/jarvis/page.tsx` (muuda) | plokk „Masin" |
| `docs/CURRENT.md`, `.claude/session-handoff.md`, `V:/projects/hermes/docs/cc-server-log.md` | seis |

---

### Task 1: Tabel `hermyhq.wiki_snapshot` + Prisma mudel

**Files:**
- Modify: `prisma/schema.prisma` (lisa `SourceHeartbeat` mudeli järele, ~rida 634)
- DB: Supabase migratsioon `hermyhq_wiki_snapshot`

**Interfaces:**
- Produces: `prisma.wikiSnapshot` väljadega `source: string`, `graph: Prisma.JsonValue`, `noteCount`, `linkCount`, `unresolvedCount`, `orphanCount: number`, `pcLastSeenAt: Date | null`, `generatedAt: Date`.

- [ ] **Step 1: Rakenda migratsioon** (`mcp__claude_ai_Supabase__apply_migration`, project `ekjvvzlewdafnyiblrbu`, name `hermyhq_wiki_snapshot`):

```sql
-- One row per wiki source ('wiki' = the Syncthing-shared vault, pushed by Argo).
-- Whole graph as jsonb; each push replaces the row.
create table hermyhq.wiki_snapshot (
  source            text primary key,
  graph             jsonb not null,
  note_count        integer not null,
  link_count        integer not null,
  unresolved_count  integer not null,
  orphan_count      integer not null,
  pc_last_seen_at   timestamptz,
  generated_at      timestamptz not null default now()
);

alter table hermyhq.wiki_snapshot enable row level security;

grant select, insert, update, delete on hermyhq.wiki_snapshot to hermyhq;

create policy wiki_snapshot_app_select on hermyhq.wiki_snapshot for select to hermyhq using (true);
create policy wiki_snapshot_app_insert on hermyhq.wiki_snapshot for insert to hermyhq with check (true);
create policy wiki_snapshot_app_update on hermyhq.wiki_snapshot for update to hermyhq using (true) with check (true);
create policy wiki_snapshot_app_delete on hermyhq.wiki_snapshot for delete to hermyhq using (true);
```

- [ ] **Step 2: Kontrolli õigusi** (`execute_sql`):

```sql
select has_table_privilege('anon', 'hermyhq.wiki_snapshot', 'select') as anon_select,
       has_table_privilege('authenticated', 'hermyhq.wiki_snapshot', 'select') as auth_select,
       has_table_privilege('hermyhq', 'hermyhq.wiki_snapshot', 'insert') as app_insert,
       (select relrowsecurity from pg_class where oid = 'hermyhq.wiki_snapshot'::regclass) as rls;
```
Expected: `anon_select=false, auth_select=false, app_insert=true, rls=true`. Siis `get_advisors(type: security)` — ükski uus leid ei tohi viidata `wiki_snapshot`-ile.

- [ ] **Step 3: Prisma mudel** — lisa `prisma/schema.prisma`-sse pärast `SourceHeartbeat`:

```prisma
// Jarvis "Masin": the whole wiki graph as one jsonb row per source; Argo replaces it hourly.
model WikiSnapshot {
  source          String    @id // "wiki" = the Syncthing-shared vault
  graph           Json // { notes: WikiNote[], unresolved: { from, target }[] }
  noteCount       Int       @map("note_count")
  linkCount       Int       @map("link_count")
  unresolvedCount Int       @map("unresolved_count")
  orphanCount     Int       @map("orphan_count")
  pcLastSeenAt    DateTime? @map("pc_last_seen_at")
  generatedAt     DateTime  @default(now()) @map("generated_at")

  @@map("wiki_snapshot")
  @@schema("hermyhq")
}
```

- [ ] **Step 4: Genereeri klient**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "jarvis: wiki_snapshot table (RLS, hermyhq-only) + Prisma model"
```

---

### Task 2: `src/lib/wiki-graph.ts` — skeem, normaliseerimine, kokkuvõte

**Files:**
- Create: `src/lib/wiki-graph.ts`
- Test: `src/lib/wiki-graph.test.ts`

**Interfaces:**
- Produces:
  - `WikiPayload` (Zod schema), `type WikiPayloadInput = z.output<typeof WikiPayload>`
  - `interface WikiNote { id: string; title: string; folder: string; mtime: string; links: string[]; editedBy: 'pc' | 'argo' | null }`
  - `interface WikiGraph { notes: WikiNote[]; unresolved: { from: string; target: string }[] }`
  - `normalizeWikiPayload(p: WikiPayloadInput): { graph: WikiGraph; counts: { notes: number; links: number; unresolved: number; orphans: number }; pcLastSeenAt: Date | null }`
  - `summarizeWiki(graph: WikiGraph, now: Date, limit?: number): { recent: WikiNote[]; changedToday: number }`
  - `obsidianUrl(noteId: string): string`

- [ ] **Step 1: Kirjuta failivad testid** `src/lib/wiki-graph.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WikiPayload, normalizeWikiPayload, summarizeWiki, obsidianUrl } from './wiki-graph';

const note = (id: string, links: string[] = [], mtime = '2026-10-07T08:00:00+00:00', editedBy: 'pc' | 'argo' | null = 'pc') => ({
  id,
  title: id.split('/').pop()!.replace(/\.md$/, ''),
  folder: id.includes('/') ? id.split('/')[0] : '',
  mtime,
  links,
  editedBy,
});

const payload = (notes: unknown[], extra: Record<string, unknown> = {}) => ({
  source: 'argo',
  notes,
  unresolved: [],
  pcLastSeenAt: null,
  ...extra,
});

test('accepts a valid payload', () => {
  const r = WikiPayload.safeParse(payload([note('projects/a.md', ['b.md']), note('b.md')]));
  assert.equal(r.success, true);
});

test('rejects path traversal, absolute paths, backslashes and non-md ids', () => {
  for (const id of ['../x.md', 'a/../../x.md', '/etc/x.md', 'a\\b.md', 'a.txt']) {
    assert.equal(WikiPayload.safeParse(payload([note(id)])).success, false, id);
  }
});

test('rejects unknown source and too many notes', () => {
  assert.equal(WikiPayload.safeParse({ ...payload([]), source: 'pc' }).success, false);
  const many = Array.from({ length: 3001 }, (_, i) => note(`n${i}.md`));
  assert.equal(WikiPayload.safeParse(payload(many)).success, false);
});

test('clips long titles instead of rejecting', () => {
  const r = WikiPayload.parse(payload([{ ...note('a.md'), title: 'x'.repeat(500) }]));
  assert.equal(r.notes[0].title.length, 200);
});

test('normalize drops dangling/self/duplicate links, dedupes notes, counts orphans', () => {
  const p = WikiPayload.parse(
    payload(
      [
        note('a.md', ['b.md', 'b.md', 'a.md', 'missing.md']),
        note('b.md'),
        note('c.md'),
        note('a.md', ['c.md']),
      ],
      { unresolved: [{ from: 'a.md', target: 'Ghost' }, { from: 'gone.md', target: 'X' }] },
    ),
  );
  const { graph, counts } = normalizeWikiPayload(p);
  assert.deepEqual(graph.notes.map((n) => n.id), ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(graph.notes[0].links, ['b.md']);
  assert.deepEqual(graph.unresolved, [{ from: 'a.md', target: 'Ghost' }]);
  assert.deepEqual(counts, { notes: 3, links: 1, unresolved: 1, orphans: 1 });
});

test('summarize sorts recent by mtime and counts today in Tallinn time', () => {
  const g = normalizeWikiPayload(
    WikiPayload.parse(
      payload([
        note('old.md', [], '2026-10-05T10:00:00+00:00'),
        note('late-yesterday-utc.md', [], '2026-10-06T21:30:00+00:00'), // 00:30 on 7.10 in Tallinn
        note('today.md', [], '2026-10-07T09:00:00+00:00'),
      ]),
    ),
  ).graph;
  const s = summarizeWiki(g, new Date('2026-10-07T12:00:00Z'), 2);
  assert.deepEqual(s.recent.map((n) => n.id), ['today.md', 'late-yesterday-utc.md']);
  assert.equal(s.changedToday, 2);
});

test('obsidianUrl strips .md and encodes the path', () => {
  assert.equal(obsidianUrl('projects/Õpe ja töö.md'), 'obsidian://open?vault=wiki&file=projects%2F%C3%95pe%20ja%20t%C3%B6%C3%B6');
});
```

- [ ] **Step 2: Jooksuta, kontrolli et kukub**

Run: `npx tsx --test src/lib/wiki-graph.test.ts`
Expected: FAIL — `Cannot find module './wiki-graph'`

- [ ] **Step 3: Kirjuta `src/lib/wiki-graph.ts`**:

```ts
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
```

- [ ] **Step 4: Jooksuta testid**

Run: `npx tsx --test src/lib/wiki-graph.test.ts`
Expected: `# pass 7`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/lib/wiki-graph.ts src/lib/wiki-graph.test.ts
git commit -m "jarvis: wiki graph payload schema, normalizer and summary (tested)"
```

---

### Task 3: `POST /api/ingest/wiki-graph`

**Files:**
- Create: `src/app/api/ingest/wiki-graph/route.ts`

**Interfaces:**
- Consumes: `WikiPayload`, `normalizeWikiPayload` (Task 2); `prisma.wikiSnapshot` (Task 1); `hasIngestSecret` (`@/lib/internal-secret`).
- Produces: HTTP contract — `POST` JSON `WikiPayloadInput` with header `x-ingest-secret`; responses `200 {ok, notes, links}`, `401`, `413`, `400 {error, issues?}`, `500 {error:'Write failed'}`. Heartbeat row `source='wiki'`, `expectedEveryMin=180`.

- [ ] **Step 1: Kirjuta route**:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasIngestSecret } from '@/lib/internal-secret';
import { WikiPayload, normalizeWikiPayload } from '@/lib/wiki-graph';

// Argo's wiki_graph_sync.py pushes the whole Syncthing-shared wiki graph once an hour.
// The source is fixed by the ingest key (only Argo holds it); the row is replaced on every push.

const MAX_BODY_BYTES = 2_000_000;
// Hourly cron; "wiki" counts as stale after ~3 missed pushes.
const WIKI_EXPECTED_EVERY_MIN = 180;

export async function POST(req: NextRequest) {
  if (!hasIngestSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = WikiPayload.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }
  const { graph, counts, pcLastSeenAt } = normalizeWikiPayload(parsed.data);
  const now = new Date();
  const row = {
    graph: graph as unknown as Prisma.InputJsonValue,
    noteCount: counts.notes,
    linkCount: counts.links,
    unresolvedCount: counts.unresolved,
    orphanCount: counts.orphans,
    pcLastSeenAt,
    generatedAt: now,
  };

  try {
    await prisma.$transaction([
      prisma.wikiSnapshot.upsert({ where: { source: 'wiki' }, create: { source: 'wiki', ...row }, update: row }),
      prisma.sourceHeartbeat.upsert({
        where: { source: 'wiki' },
        create: {
          source: 'wiki',
          lastAttemptAt: now,
          lastOkAt: now,
          ok: true,
          detail: `${counts.notes} märget`,
          expectedEveryMin: WIKI_EXPECTED_EVERY_MIN,
        },
        update: { lastAttemptAt: now, lastOkAt: now, ok: true, detail: `${counts.notes} märget` },
      }),
    ]);
  } catch (err) {
    // Details go to the server log only; the caller gets no DB internals.
    console.error('ingest/wiki-graph failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, notes: counts.notes, links: counts.links });
}
```

- [ ] **Step 2: Tüübikontroll**

Run: `npx tsc --noEmit -p .`
Expected: väljund tühi (või ainult enne olemas olnud vead — võrdle `git stash`-iga, kui kahtled).

- [ ] **Step 3: Negatiivsed testid kohapeal.** Käivita `npm run dev` taustal (`.env.local`-is peab olema `INGEST_SECRET`; kontrolli `Select-String -Path .env.local -Pattern '^INGEST_SECRET=' -Quiet`, väärtust ei prindi). Siis PowerShellis:

```powershell
$u = 'http://localhost:3000/api/ingest/wiki-graph'
$ok = (Get-Content .env.local | Where-Object { $_ -match '^INGEST_SECRET=' }) -replace '^INGEST_SECRET=','' -replace '"',''
function T($h, $b) { try { (Invoke-WebRequest $u -Method Post -Headers $h -Body $b -ContentType 'application/json' -SkipHttpErrorCheck).StatusCode } catch { $_.Exception.Message } }
T @{} '{}'                                                     # 401
T @{ 'x-ingest-secret' = 'wrong' } '{}'                        # 401
T @{ 'x-ingest-secret' = $ok } 'not json'                      # 400
T @{ 'x-ingest-secret' = $ok } '{"source":"argo","notes":[{"id":"../x.md","title":"x","folder":"","mtime":"2026-10-07T08:00:00Z","links":[],"editedBy":null}],"unresolved":[],"pcLastSeenAt":null}'  # 400
T @{ 'x-ingest-secret' = $ok } '{"source":"pc","notes":[],"unresolved":[],"pcLastSeenAt":null}'  # 400
```
Expected: `401 401 400 400 400`. Positiivne test (200) tehakse Task 4-s päris andmetega. **Ära jooksuta positiivset testi kohapeal prod-DB vastu enne Task 4** — see kirjutaks prod-tabelisse testrea.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/ingest/wiki-graph/route.ts
git commit -m "jarvis: POST /api/ingest/wiki-graph (ingest key, Zod, 2 MB cap)"
```

---

### Task 4: `scripts/argo/wiki_graph_sync.py`

**Files:**
- Create: `scripts/argo/wiki_graph_sync.py`
- Test: `scripts/argo/test_wiki_graph_sync.py`

**Interfaces:**
- Consumes: HTTP contract from Task 3.
- Produces (Python): `extract_links(text: str) -> list[str]`, `Resolver(ids: list[str]).resolve(target: str) -> str | None`, `list_notes(vault: Path) -> list[str]`, `build_graph(vault: Path, edited_by: dict[str, str | None]) -> dict`; CLI `--dry-run`.

- [ ] **Step 1: Kirjuta failivad testid** `scripts/argo/test_wiki_graph_sync.py`:

```python
import tempfile
import unittest
from pathlib import Path

import wiki_graph_sync as w


class ExtractLinks(unittest.TestCase):
    def test_forms(self):
        text = "[[A]] [[b|alias]] [[C#Heading]] [[dir/D]] [[A]] [[img.png]]"
        self.assertEqual(w.extract_links(text), ["A", "b", "C", "dir/D"])

    def test_skips_code(self):
        text = "x\n```\n[[InFence]]\n```\n`[[Inline]]` [[Real]]"
        self.assertEqual(w.extract_links(text), ["Real"])


class Resolve(unittest.TestCase):
    ids = ["projects/aim/aim.md", "aim.md", "concepts/RLS.md", "deep/x/RLS.md"]

    def test_exact_path_wins(self):
        self.assertEqual(w.Resolver(self.ids).resolve("projects/aim/aim"), "projects/aim/aim.md")

    def test_basename_shortest_path(self):
        self.assertEqual(w.Resolver(self.ids).resolve("aim"), "aim.md")
        self.assertEqual(w.Resolver(self.ids).resolve("rls"), "concepts/RLS.md")

    def test_partial_path_suffix(self):
        self.assertEqual(w.Resolver(self.ids).resolve("x/RLS"), "deep/x/RLS.md")

    def test_missing(self):
        self.assertIsNone(w.Resolver(self.ids).resolve("Nope"))


class BuildGraph(unittest.TestCase):
    def test_vault(self):
        with tempfile.TemporaryDirectory() as d:
            v = Path(d)
            (v / "projects").mkdir()
            (v / ".stversions").mkdir()
            (v / "projects" / "p.md").write_text("[[root]] [[Ghost]]", encoding="utf-8")
            (v / "root.md").write_text("[[p]]", encoding="utf-8")
            (v / ".stversions" / "old.md").write_text("[[root]]", encoding="utf-8")
            (v / "NEXT.md.bak").write_text("[[root]]", encoding="utf-8")
            g = w.build_graph(v, {"root.md": "argo"})
        ids = [n["id"] for n in g["notes"]]
        self.assertEqual(sorted(ids), ["projects/p.md", "root.md"])
        p = next(n for n in g["notes"] if n["id"] == "projects/p.md")
        self.assertEqual(p["folder"], "projects")
        self.assertEqual(p["title"], "p")
        self.assertEqual(p["links"], ["root.md"])
        self.assertIsNone(p["editedBy"])
        root = next(n for n in g["notes"] if n["id"] == "root.md")
        self.assertEqual(root["folder"], "")
        self.assertEqual(root["editedBy"], "argo")
        self.assertEqual(g["unresolved"], [{"from": "projects/p.md", "target": "Ghost"}])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Jooksuta, kontrolli et kukub**

Run: `cd scripts/argo; python -m unittest test_wiki_graph_sync -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'wiki_graph_sync'`

- [ ] **Step 3: Kirjuta `scripts/argo/wiki_graph_sync.py`**:

```python
#!/usr/bin/env python3
"""Push the Syncthing-shared wiki graph from Argo to hermy-hq (Jarvis "Masin").

Runs as a no-agent Hermes cron every 60 min. Reads, never writes, the vault:
  ~/wiki/**/*.md  -> path, title, top folder, mtime, resolved [[links]]  (never note content)
  Syncthing REST (127.0.0.1:8384) -> per file: which device modified it last; when PC was last seen.
POSTs to {HERMY_HQ_URL}/api/ingest/wiki-graph with header x-ingest-secret.

Device mapping: Syncthing's own device = Argo; any other device = PC (the vault has exactly two).
Secret: INGEST_SECRET (Doppler hermes/prd), else ~/.config/hermy-hq/ingest_secret (chmod 600).
Env: HERMY_HQ_URL, WIKI_VAULT (optional).

Stdout is delivered by Hermes, so it prints ONLY when sync state flips. --dry-run prints counts, sends nothing.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

VAULT = Path(os.environ.get("WIKI_VAULT", str(Path.home() / "wiki"))).expanduser()
STATE_FILE = Path.home() / ".hermes" / "cron" / "wiki_graph_sync_state.json"
SECRET_FILE = Path.home() / ".config" / "hermy-hq" / "ingest_secret"
SYNCTHING_CONFIG = Path.home() / ".local" / "state" / "syncthing" / "config.xml"
SYNCTHING_URL = "http://127.0.0.1:8384"
URL = os.environ.get("HERMY_HQ_URL", "https://hermy-hq-tau.vercel.app").rstrip("/") + "/api/ingest/wiki-graph"
SKIP_DIRS = {".stversions", ".git", ".obsidian", ".trash", ".skills"}
MAX_NOTES = 3000          # must match the route's limit
MAX_LINKS_PER_NOTE = 500  # must match the route's limit
TIMEOUT_S = 30

FENCE_RE = re.compile(r"^```.*?^```", re.S | re.M)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
LINK_RE = re.compile(r"\[\[([^\]\|#\n]+)(?:#[^\]\|\n]*)?(?:\|[^\]\n]*)?\]\]")
ATTACHMENT_RE = re.compile(r"\.(png|jpe?g|gif|svg|webp|pdf|canvas|base|mp4|mp3)$", re.I)


def extract_links(text):
    """[[Target]], [[Target|alias]], [[Target#h]] -> 'Target'; code and attachments skipped; order kept, deduped."""
    text = INLINE_CODE_RE.sub("", FENCE_RE.sub("", text))
    out = []
    for m in LINK_RE.finditer(text):
        t = m.group(1).strip()
        if t and not ATTACHMENT_RE.search(t) and t not in out:
            out.append(t)
    return out


class Resolver:
    """Obsidian-style: exact vault path first, else filename (shortest path wins). Case-insensitive."""

    def __init__(self, ids):
        self.exact = {i[:-3].lower(): i for i in ids}
        self.by_name = {}
        for i in sorted(ids, key=lambda s: (s.count("/"), len(s), s)):
            self.by_name.setdefault(i[:-3].rsplit("/", 1)[-1].lower(), []).append(i)

    def resolve(self, target):
        key = target.strip().replace("\\", "/").lstrip("/")
        if key.lower().endswith(".md"):
            key = key[:-3]
        key = key.lower()
        if key in self.exact:
            return self.exact[key]
        candidates = self.by_name.get(key.rsplit("/", 1)[-1], [])
        if "/" in key:
            candidates = [c for c in candidates if c[:-3].lower().endswith("/" + key)]
        return candidates[0] if candidates else None


def list_notes(vault):
    ids = []
    for p in vault.rglob("*.md"):
        rel = p.relative_to(vault)
        if any(part in SKIP_DIRS for part in rel.parts[:-1]) or ".bak" in p.name:
            continue
        ids.append(rel.as_posix())
    return sorted(ids)


def build_graph(vault, edited_by):
    ids = list_notes(vault)[:MAX_NOTES]
    resolver = Resolver(ids)
    notes, unresolved = [], []
    for i in ids:
        path = vault / i
        text = path.read_text(encoding="utf-8", errors="replace")
        links = []
        for t in extract_links(text):
            r = resolver.resolve(t)
            if r is None:
                unresolved.append({"from": i, "target": t[:200]})
            elif r != i and r not in links:
                links.append(r)
        notes.append({
            "id": i,
            "title": i.rsplit("/", 1)[-1][:-3],
            "folder": i.split("/", 1)[0] if "/" in i else "",
            "mtime": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            "links": links[:MAX_LINKS_PER_NOTE],
            "editedBy": edited_by.get(i),
        })
    return {"notes": notes, "unresolved": unresolved[:10_000]}


def syncthing_info(ids):
    """({note_id: 'pc'|'argo'|None}, pc_last_seen_iso|None). Any Syncthing failure -> ({}, None); sync goes on."""
    try:
        root = ET.parse(SYNCTHING_CONFIG).getroot()
        key = root.findtext("gui/apikey")
        folder = next(
            f.get("id") for f in root.iter("folder")
            if Path(f.get("path", "")).expanduser().resolve() == VAULT.resolve()
        )

        def get(path):
            req = urllib.request.Request(SYNCTHING_URL + path, headers={"X-API-Key": key})
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.load(r)

        me = get("/rest/system/status")["myID"]
        edited = {}
        for i in ids:
            q = urllib.parse.urlencode({"folder": folder, "file": i})
            by = get(f"/rest/db/file?{q}").get("global", {}).get("modifiedBy", "")
            edited[i] = None if not by else ("argo" if me.startswith(by) else "pc")

        conns = get("/rest/system/connections").get("connections", {})
        stats = get("/rest/stats/device")
        others = [d for d in stats if d != me]
        if any(conns.get(d, {}).get("connected") for d in others):
            pc_seen = datetime.now(timezone.utc).isoformat()
        else:
            seen = sorted(stats[d].get("lastSeen", "") for d in others)
            pc_seen = seen[-1] if seen and not seen[-1].startswith("1970") else None
        return edited, pc_seen
    except Exception:  # noqa: BLE001 — Syncthing is optional colour info, never a reason to skip the sync
        return {}, None


def read_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_state(ok, detail):
    STATE_FILE.write_text(json.dumps({"ok": ok, "detail": detail, "at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")


def read_secret():
    secret = os.environ.get("INGEST_SECRET")
    if secret:
        return secret.strip()
    try:
        return SECRET_FILE.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def push(payload, secret):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST", headers={"Content-Type": "application/json", "x-ingest-secret": secret})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        r.read()


def make_payload():
    ids = list_notes(VAULT)
    edited, pc_seen = syncthing_info(ids)
    graph = build_graph(VAULT, edited)
    return {"source": "argo", **graph, "pcLastSeenAt": pc_seen}


def main():
    if "--dry-run" in sys.argv:
        p = make_payload()
        links = sum(len(n["links"]) for n in p["notes"])
        by = {k: sum(1 for n in p["notes"] if n["editedBy"] == k) for k in ("pc", "argo", None)}
        print(f"notes={len(p['notes'])} links={links} unresolved={len(p['unresolved'])} editedBy={by} pcLastSeen={p['pcLastSeenAt']} bytes={len(json.dumps(p))}")
        return 0

    secret = read_secret()
    prev = read_state()
    try:
        if not secret:
            raise RuntimeError("INGEST_SECRET puudub")
        push(make_payload(), secret)
        ok, detail = True, None
    except urllib.error.HTTPError as e:
        ok, detail = False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — any failure is reported once, never the secret
        ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}"

    if ok != prev.get("ok", True):
        print("wiki graafi sünk taastus" if ok else f"wiki graafi sünk katki: {detail}")
    write_state(ok, detail)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Jooksuta testid**

Run: `cd scripts/argo; python -m unittest test_wiki_graph_sync -v`
Expected: `Ran 7 tests ... OK`

- [ ] **Step 5: Dry-run PC wiki vastu** (Syncthingi configi PC-s sellel teel pole → editedBy kõik `None`, see on oodatud):

Run: `$env:WIKI_VAULT='V:/projects/wiki'; python scripts/argo/wiki_graph_sync.py --dry-run`
Expected: `notes=` ≈ 453 (± tänased muudatused), `links=` sadades, `bytes=` < 2 000 000.
Kontroll käsitsi: vali 2 märget (nt `projects/hermy-hq*.md`), ava failis lingid ja veendu, et `--dry-run` väljundi asemel ajutine `python -c "import json,wiki_graph_sync as w; ..."` annab nende `links` õigesti. Pane tulemus kirja.

- [ ] **Step 6: Commit**

```bash
git add scripts/argo/wiki_graph_sync.py scripts/argo/test_wiki_graph_sync.py
git commit -m "jarvis: Argo wiki graph sync script (links, Syncthing modifiedBy)"
```

---

### Task 5: Deploy route + paigalda Argosse + cron

**Interfaces:**
- Consumes: Task 3 route prodis, Task 4 skript.
- Produces: elus rida `hermyhq.wiki_snapshot` (`source='wiki'`), heartbeat `wiki`, cron „hermy-hq wiki graaf (Jarvis)".

- [ ] **Step 1: Push ja oota Vercel deploy'd**

```bash
git push origin main
```
Kontrolli Vercel MCP-ga (`list_deployments`, projekt `prj_0UHUMlRLguqOUboc170p7P7gT9tJ`), et viimane deploy on `READY`. Kiirkontroll: `Invoke-WebRequest https://hermy-hq-tau.vercel.app/api/ingest/wiki-graph -Method Post -Body '{}' -SkipHttpErrorCheck` → `401`.

- [ ] **Step 2: Kopeeri skript Argosse**

```bash
scp scripts/argo/wiki_graph_sync.py rihou@100.68.64.83:~/.hermes/scripts/wiki_graph_sync.py
ssh rihou@100.68.64.83 'chmod 700 ~/.hermes/scripts/wiki_graph_sync.py'
```

- [ ] **Step 3: Dry-run Argos**

```bash
ssh rihou@100.68.64.83 "bash -lc 'python3 ~/.hermes/scripts/wiki_graph_sync.py --dry-run; find ~/wiki -name \"*.md\" -not -path \"*/.stversions/*\" -not -path \"*/.git/*\" -not -path \"*/.obsidian/*\" -not -path \"*/.trash/*\" -not -path \"*/.skills/*\" -not -name \"*.bak*\" | wc -l'"
```
Expected: `notes=` võrdub `wc -l` arvuga; `editedBy` näitab nii `pc` kui `argo` > 0; `pcLastSeen` ei ole `None`.

- [ ] **Step 4: Päris push Doppleri võtmega**

```bash
ssh rihou@100.68.64.83 "bash -lc 'doppler run -p hermes -c prd -- python3 ~/.hermes/scripts/wiki_graph_sync.py; echo EXIT=\$?'"
```
Expected: `EXIT=0`, väljundit pole. Kui Doppleri CLI süntaks erineb, vaata kuidas `hermy_cron_sync` cron saladused saab (`hermes cron list` → „Command helper: applied N secrets") ja jooksuta läbi `hermes cron run` asemel Step 5 järel.

- [ ] **Step 5: Kontrolli DB-d** (`execute_sql`):

```sql
select note_count, link_count, unresolved_count, orphan_count, pc_last_seen_at, generated_at,
       jsonb_array_length(graph->'notes') as notes_in_json
from hermyhq.wiki_snapshot where source = 'wiki';
select source, ok, detail, last_ok_at from hermyhq.source_heartbeat where source = 'wiki';
```
Expected: `note_count = notes_in_json` = Step 3 arv; heartbeat `ok=true`.

- [ ] **Step 6: Loo cron** (varukoopia enne):

```bash
ssh rihou@100.68.64.83 "bash -lc 'cp ~/.hermes/cron/jobs.json ~/.hermes/cron/jobs.json.bak-2026-10-07-wiki && hermes cron create \"every 60m\" --name \"hermy-hq wiki graaf (Jarvis)\" --script wiki_graph_sync.py --no-agent --deliver telegram:8113335732 --failure-deliver local'"
```
Expected: väljundis uus job id. Pane see kirja.

- [ ] **Step 7: Oota esimest ajastatud jooksu** (≤ 60 min) ja kontrolli: `hermes cron list` → uus töö `Last run ... ok`; Step 5 päring näitab uut `generated_at`. Telegrami ei tohi midagi tulla.

- [ ] **Step 8: Logi server-muudatus** — lisa `V:/projects/hermes/docs/cc-server-log.md` lõppu:

```markdown
## 2026-10-07 — hermy-hq Jarvis etapp 3: wiki graafi sünk

- Uus fail `~/.hermes/scripts/wiki_graph_sync.py` (700), allikas `riho-io/hermy-hq` `scripts/argo/`. Loeb `~/wiki` (ainult teed, pealkirjad, lingid, mtime — sisu ei saadeta) + Syncthingi kohalik API (`modifiedBy`, PC viimati nähtud). POST → `/api/ingest/wiki-graph`.
- Uus cron `<id>` „hermy-hq wiki graaf (Jarvis)": `every 60m`, `--no-agent`, `--failure-deliver local`. Olekufail `~/.hermes/cron/wiki_graph_sync_state.json`.
- Varukoopia: `~/.hermes/cron/jobs.json.bak-2026-10-07-wiki`.
- Kontroll: <arvud Step 3/5-st>.
```

---

### Task 6: Jarvise plokk „Masin"

**Files:**
- Modify: `package.json` / `package-lock.json` (`npm install force-graph`)
- Modify: `src/lib/jarvis.ts`
- Create: `src/app/jarvis/wiki-graph.tsx`
- Modify: `src/app/jarvis/page.tsx`

**Interfaces:**
- Consumes: `prisma.wikiSnapshot` (Task 1); `WikiGraph`, `WikiNote`, `summarizeWiki`, `obsidianUrl` (Task 2).
- Produces: `JarvisData.wiki: null | { graph: WikiGraph; counts: { notes: number; links: number; unresolved: number; orphans: number }; recent: WikiNote[]; changedToday: number; generatedAt: Date; pcLastSeenAt: Date | null }`; client component `WikiGraphView({ graph }: { graph: WikiGraph })`.

- [ ] **Step 1: Paigalda pakett** (Riho kinnitas 07.10)

Run: `npm install force-graph`
Expected: `package.json` dependencies-is `"force-graph": "^1.x"`. Kontrolli `node_modules/force-graph/package.json` → `"types"` olemas (pakett tuleb oma tüüpidega).

- [ ] **Step 2: `src/lib/jarvis.ts` — andmed.** Lisa import faili algusesse:

```ts
import { summarizeWiki, type WikiGraph, type WikiNote } from '@/lib/wiki-graph';
```

Lisa `JarvisData` liidesesse (pärast `hermes: {...}`):

```ts
  wiki: null | {
    graph: WikiGraph;
    counts: { notes: number; links: number; unresolved: number; orphans: number };
    recent: WikiNote[];
    changedToday: number;
    generatedAt: Date;
    pcLastSeenAt: Date | null;
  };
```

`getJarvisData` `Promise.all`-i lisa kaks päringut ja destruktureeri need:

```ts
  const [heartbeat, jobs, runs, konto, sites, pmlRows, wikiRow, wikiBeat] = await Promise.all([
    // ...olemasolevad kuus päringut muutmata...
    prisma.wikiSnapshot.findUnique({ where: { source: 'wiki' } }),
    prisma.sourceHeartbeat.findUnique({ where: { source: 'wiki' } }),
  ]);
```

Enne `const sources` lisa:

```ts
  const wikiGraph = (wikiRow?.graph ?? null) as WikiGraph | null;
  const wiki = wikiRow && wikiGraph
    ? {
        graph: wikiGraph,
        counts: {
          notes: wikiRow.noteCount,
          links: wikiRow.linkCount,
          unresolved: wikiRow.unresolvedCount,
          orphans: wikiRow.orphanCount,
        },
        ...summarizeWiki(wikiGraph, now),
        generatedAt: wikiRow.generatedAt,
        pcLastSeenAt: wikiRow.pcLastSeenAt,
      }
    : null;
```

Asenda `sources` massiivis kaks rida (`wiki-pc`, `wiki-argo`) ühega:

```ts
    {
      key: 'wiki',
      label: 'Wiki',
      // Argo pushes hourly; the window allows ~3 missed runs.
      state: wikiBeat ? windowState(wikiBeat.lastOkAt, wikiBeat.expectedEveryMin, now) : 'off',
      lastOkAt: wikiBeat?.lastOkAt ?? null,
      note: wiki
        ? `${wiki.counts.notes} märget · PC ${wiki.pcLastSeenAt ? `sünkis ${fmtAgoShort(wiki.pcLastSeenAt, now)}` : 'pole näha'}`
        : 'ühendamata',
    },
```

ja lisa faili lõppu väike abifunktsioon (lib ei impordi `app/jarvis/format.ts`-i, et kiht ei läheks tagurpidi):

```ts
function fmtAgoShort(d: Date, now: Date): string {
  const min = Math.round((now.getTime() - d.getTime()) / MIN);
  if (min < 60) return `${Math.max(min, 0)} min tagasi`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h tagasi` : `${Math.round(h / 24)} p tagasi`;
}
```

`return`-objekti lisa `wiki,`.

- [ ] **Step 3: `src/app/jarvis/wiki-graph.tsx`** — kliendikomponent:

```tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WikiGraph } from '@/lib/wiki-graph';
import { obsidianUrl } from '@/lib/wiki-graph';

type ColorMode = 'folder' | 'editor';
type GNode = { id: string; title: string; folder: string; editedBy: 'pc' | 'argo' | null; ghost: boolean; deg: number };

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

export function WikiGraphView({ graph }: { graph: WikiGraph }) {
  const box = useRef<HTMLDivElement>(null);
  const fg = useRef<any>(null);
  const [mode, setMode] = useState<ColorMode>('folder');
  const [showSessions, setShowSessions] = useState(false);
  const [ready, setReady] = useState(false);

  // Nodes + links for the current filter; unresolved targets become small grey "ghost" nodes.
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
    return { nodes, links };
  }, [graph, showSessions]);

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
      const g = new ForceGraph(box.current)
        .backgroundColor('rgba(0,0,0,0)')
        .nodeId('id')
        .nodeLabel((n: any) => (n.ghost ? `${n.title} — lahendamata` : `${n.title} · ${n.folder || 'juur'}`))
        .nodeVal((n: any) => (n.ghost ? 0.4 : 1 + Math.sqrt(n.deg)))
        .linkColor(() => 'rgba(255,255,255,0.08)')
        .linkWidth(0.5)
        .cooldownTicks(200)
        .onNodeClick((n: any) => {
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
    };
  }, []);

  // Data and colour changes reuse the same canvas; `ready` flips once the lazy import has created it.
  useEffect(() => {
    if (ready) fg.current?.graphData(data).nodeColor(colorOf);
  }, [ready, data, colorOf]);

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
```

- [ ] **Step 4: `src/app/jarvis/page.tsx` — plokk.** Lisa importidesse:

```tsx
import { obsidianUrl } from '@/lib/wiki-graph';
import { WikiGraphView } from './wiki-graph';
```

Lisa pärast AGENT `</section>`-it (enne lõpetavat `</div>`):

```tsx
      {/* MASIN — the Syncthing-shared wiki: size, health, what changed and who changed it */}
      <section aria-labelledby="wiki-h" className="hq-rise mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <h2 id="wiki-h" className="eyebrow">Masin · wiki</h2>
          <p className="text-[11.5px] text-[var(--text-3)]">
            {d.wiki ? `seis ${fmtAgo(d.wiki.generatedAt, now)} · klõps avab Obsidianis` : 'Argo pole wikit veel saatnud'}
          </p>
        </div>
        {d.wiki ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
            <Panel className="p-5 min-w-0">
              <dl className="grid grid-cols-3 sm:grid-cols-5 gap-4 mb-5">
                <WikiStat label="märget" value={d.wiki.counts.notes} />
                <WikiStat label="linki" value={d.wiki.counts.links} />
                <WikiStat label="lahendamata" value={d.wiki.counts.unresolved} />
                <WikiStat label="üksikud" value={d.wiki.counts.orphans} />
                <WikiStat label="täna muudetud" value={d.wiki.changedToday} />
              </dl>
              <WikiGraphView graph={d.wiki.graph} />
            </Panel>
            <Panel className="p-5">
              <Eyebrow>Viimati muudetud</Eyebrow>
              <ul className="mt-3 space-y-2.5">
                {d.wiki.recent.map((n) => (
                  <li key={n.id}>
                    <a href={obsidianUrl(n.id)} className="group block rounded focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
                      <p className="truncate text-[13px] font-medium text-[var(--text)] group-hover:text-[var(--accent)]">{n.title}</p>
                      <p className="text-[11.5px] num text-[var(--text-3)]">
                        {n.folder || 'juur'} · {fmtWhen(new Date(n.mtime), now)}
                        {n.editedBy && ` · ${n.editedBy === 'pc' ? 'PC' : 'Argo'}`}
                      </p>
                    </a>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        ) : (
          <Panel className="p-5">
            <p className="py-6 text-center text-[13px] text-[var(--text-3)]">
              Ühendamata. Kontrolli croni „hermy-hq wiki graaf (Jarvis)” serveris.
            </p>
          </Panel>
        )}
      </section>
```

ja faili lõppu:

```tsx
function WikiStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="num text-[22px] font-semibold leading-none tracking-[-0.02em] text-[var(--text)]">{value}</dd>
      <dt className="mt-1 text-[11.5px] text-[var(--text-3)]">{label}</dt>
    </div>
  );
}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build õnnestub, `/jarvis` nimekirjas `ƒ` (dynamic). Kui `force-graph` tüübid annavad vea `new ForceGraph(el)` peal, kasuta `new (ForceGraph as any)(box.current)` ja jäta kommentaar miks.

- [ ] **Step 6: Vaata kohapeal** — `npm run dev` (`DEV_AUTH_BYPASS=true` `.env.local`-is), ava `http://localhost:3000/jarvis` Playwrightiga, desktop (1440) ja mobiil (390) kuvatõmmis. Kontrolli: arvud = DB rida; graaf joonistub; lülitid muudavad värvi / sessions sõlmed ilmuvad; hover näitab pealkirja; „Viimati muudetud" lingid algavad `obsidian://open?vault=wiki&file=`; ühendatud allikates üks „Wiki" roheline.

- [ ] **Step 7: Testid uuesti + commit**

```bash
npx tsx --test src/lib/wiki-graph.test.ts
git add package.json package-lock.json src/lib/jarvis.ts src/app/jarvis/wiki-graph.tsx src/app/jarvis/page.tsx
git commit -m "Jarvis stage 3: Masin wiki graph block"
```

- [ ] **Step 8: Push + prodi kontroll** — `git push origin main`, oota Vercel `READY`, ava https://hermy-hq-tau.vercel.app/jarvis (sisselogitud), korda Step 6 kontrolli prodis. Klõpsa ühte märget PC-s → Obsidian avab õige faili.

---

### Task 7: Dokumentatsioon

**Files:**
- Modify: `docs/CURRENT.md` (lisa „## Etapp 3 — VALMIS 07.10" sektsioon: commitid, cron id, arvud, mis prodis kontrolliti; uuenda „Järgmine")
- Modify: `.claude/session-handoff.md` (Tehtud / Järgmine samm)
- Modify: `AGENTS.md` sektsioon „Andmebaas" — lisa rida: `wiki_snapshot` (Argo `wiki_graph_sync.py`, iga 60 min).

- [ ] **Step 1: Kirjuta kolm faili** päris arvude ja id-dega Task 5–6-st (mitte kohatäitjatega).
- [ ] **Step 2: Commit + push**

```bash
git add docs/CURRENT.md .claude/session-handoff.md AGENTS.md
git commit -m "docs: Jarvis stage 3 done"
git push origin main
```
