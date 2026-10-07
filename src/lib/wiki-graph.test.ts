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

test('title is clipped by code point, never leaving a lone surrogate', () => {
  const n = { ...note('a.md'), title: 'x'.repeat(199) + '😀' + 'tail' };
  const t = WikiPayload.parse(payload([n])).notes[0].title;
  assert.equal([...t].length, 200);
  assert.ok(t.isWellFormed());
});

test('title loses NUL and lone surrogates so jsonb accepts it', () => {
  const n = { ...note('a.md'), title: 'a\u0000b\uD800c' };
  const t = WikiPayload.parse(payload([n])).notes[0].title;
  assert.equal(t, 'ab�c');
  assert.ok(t.isWellFormed());
  assert.ok(!t.includes('\u0000'));
});

test('note id containing NUL is rejected', () => {
  assert.throws(() => WikiPayload.parse(payload([note('a\u0000b.md')])));
});
