import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { markdownAdapter, statusOf, titleAndStatus } from '../adapters/plan/markdown';
import { compareIds } from '../adapters/plan/text';
import { ProjectFile } from '../model/adapter';
import { PlanGraph, checkPlanGraph } from '../model/plan';

// The planning-markdown adapter over a small hand-made project
// (src/test/fixtures/adapters/markdown/: a plan-shaped document, a roadmap read
// by heading, and a README that is not a plan), and over this project's own docs/.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test; the repository root is two levels up.
  const root = path.resolve(__dirname, '..', '..');
  const file = (p: string, text: string): ProjectFile => ({ path: p, text, bytes: text.length });
  const read = (dir: string, rel: string) => file(rel, fs.readFileSync(path.join(dir, rel), 'utf8'));
  const fixtureDir = path.join(root, 'src', 'test', 'fixtures', 'adapters', 'markdown');
  const fixture = () => ['README.md', 'plans/release.md', 'plans/roadmap.md'].map((p) => read(fixtureDir, p));
  const docs = () => fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).sort().map((f) => read(root, `docs/${f}`));
  const NOW = '2026-11-13T12:00:00Z';
  const opts = { name: 'factory-clock', now: NOW };
  const R = 'plans/release.md';
  const M = 'plans/roadmap.md';
  const by = (g: PlanGraph) => new Map(g.items.map((i) => [i.id, i]));
  const has = (g: PlanGraph, from: string, kind: string, to: string) => g.links.some((l) => l.from === from && l.to === to && l.kind === kind);
  const linksOf = (g: PlanGraph, kind: string) => g.links.filter((l) => l.kind === kind);

  test('detects plan-shaped markdown, and not a README of prose', () => {
    assert.strictEqual(markdownAdapter.id, 'markdown');
    assert.strictEqual(markdownAdapter.subject, 'plans');
    assert.ok(markdownAdapter.detect(fixture()));
    assert.ok(!markdownAdapter.detect([read(fixtureDir, 'README.md')]), 'a usage list under "Plan adapters" is not a plan');
    assert.ok(markdownAdapter.detect([file('x.md', '# Notes\n\n- [ ] one\n')]), 'a checkbox');
    assert.ok(markdownAdapter.detect([file('x.md', '| Item | State |\n| --- | --- |\n| a | done |\n')]), 'a status table');
    assert.ok(markdownAdapter.detect([file('x.md', '## Next steps\n\n- write it\n')]), 'a steps section');
    assert.ok(!markdownAdapter.detect([file('x.md', '```\n- [ ] in code\n```\n')]), 'not inside a code fence');
    assert.ok(!markdownAdapter.detect([file('x.txt', '- [ ] not markdown')]));
    assert.ok(!markdownAdapter.detect([file('x.md', '## Steps\n\nNo list here.\n')]), 'an empty steps section');
    assert.ok(!markdownAdapter.detect([]));
  });

  test('a document with a Steps section is one epic of steps', () => {
    const g = markdownAdapter.read(fixture(), opts);
    const ids = g.items.filter((i) => i.id.startsWith(R)).map((i) => i.id);
    assert.deepStrictEqual(ids, [
      R,
      ...[1, 2, '2.1', '2.2', '2.2.1', 3, 4, 5, 6, 7, 8].map((n) => `${R}#step-${n}`),
      `${R}#decision-format`,
      `${R}#decision-hosting`,
      `${R}#question-1`,
      `${R}#question-2`,
    ]);
    const b = by(g);
    assert.strictEqual(b.get(R)!.kind, 'epic');
    assert.strictEqual(b.get(R)!.title, 'Release plan');
    assert.deepStrictEqual(b.get(R)!.refs, { paths: [R] });
    assert.ok(!ids.some((id) => id.includes('background')), 'a list outside the plan section is not read');
    assert.deepStrictEqual([1, 2, 3, 4, 5, 8].map((n) => b.get(`${R}#step-${n}`)!.kind), ['step', 'step', 'step', 'step', 'step', 'step']);
    assert.deepStrictEqual([1, 2, 3, 4, 5].map((n) => b.get(`${R}#step-${n}`)!.title), ['Parser', 'Checker', 'Exporter', 'Docs', 'Release notes']);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.strictEqual(b.get(`${R}#step-${n}`)!.parent, R);
    assert.ok(has(g, `${R}#step-1`, 'parent', R), 'parent links run child → parent');
  });

  test('nested lists are children', () => {
    const b = by(markdownAdapter.read(fixture(), opts));
    assert.strictEqual(b.get(`${R}#step-2.1`)!.parent, `${R}#step-2`);
    assert.strictEqual(b.get(`${R}#step-2.2`)!.parent, `${R}#step-2`);
    assert.strictEqual(b.get(`${R}#step-2.2.1`)!.parent, `${R}#step-2.2`);
    assert.strictEqual(b.get(`${R}#step-2.2.1`)!.title, 'A nested rule');
  });

  test('statuses: words in the lead are inferred, checkboxes observed', () => {
    const b = by(markdownAdapter.read(fixture(), opts));
    const st = (n: number) => [b.get(`${R}#step-${n}`)!.status, b.get(`${R}#step-${n}`)!.confidence];
    assert.deepStrictEqual(st(1), ['done', 'inferred']);
    assert.deepStrictEqual(st(2), ['open', 'inferred']);
    assert.deepStrictEqual(st(3), ['in_progress', 'inferred']);
    assert.deepStrictEqual(st(6), ['done', 'observed']);
    assert.deepStrictEqual(st(7), ['open', 'observed']);
    assert.deepStrictEqual(st(8), ['deferred', 'inferred']);
    assert.strictEqual(b.get(`${R}#step-6`)!.kind, 'task');
    assert.strictEqual(b.get(`${R}#step-6`)!.title, 'Tag the release');
    assert.strictEqual(b.get(R)!.status, 'in_progress', 'the epic: some done, some not');
  });

  test('follows from list order, at every level', () => {
    const g = markdownAdapter.read(fixture(), opts);
    for (let n = 2; n <= 8; n++) assert.ok(has(g, `${R}#step-${n}`, 'follows', `${R}#step-${n - 1}`), `step ${n} follows ${n - 1}`);
    assert.ok(has(g, `${R}#step-2.2`, 'follows', `${R}#step-2.1`));
    assert.ok(!has(g, `${R}#step-3`, 'follows', `${R}#step-2.2`), 'not across levels');
    assert.ok(!g.links.some((l) => l.kind === 'follows' && (l.from.includes('decision') || l.from.includes('question'))));
  });

  test('blocks and supersedes from phrases; ∥ and bare counts make none', () => {
    const g = markdownAdapter.read(fixture(), opts);
    const s = (n: number) => `${R}#step-${n}`;
    assert.ok(has(g, s(1), 'blocks', s(2)), '"After 1."');
    assert.ok(has(g, s(2), 'blocks', s(3)), '"Depends on step 2"');
    assert.ok(has(g, s(3), 'blocks', s(4)), '"Blocked by Exporter", by title');
    assert.ok(!has(g, s(2), 'blocks', s(4)), '"Needs 2 files" is a count, not step 2');
    assert.ok(has(g, s(2), 'blocks', s(5)) && has(g, s(3), 'blocks', s(5)), '"once steps 2 and 3 are in"');
    assert.ok(has(g, s(5), 'supersedes', s(4)), '"Replaces step 4"');
    assert.ok(has(g, s(7), 'blocks', s(8)), '"Decides step 8"');
    assert.ok(!g.links.some((l) => l.kind === 'blocks' && l.from === s(4)), '"∥ with 4" is parallel');
    assert.strictEqual(linksOf(g, 'blocks').filter((l) => l.from.startsWith(R)).length, 6);
    assert.ok(g.links.every((l) => l.inferred === true), 'every markdown link is inferred');
  });

  test('decisions and open questions hang under the epic', () => {
    const b = by(markdownAdapter.read(fixture(), opts));
    assert.deepStrictEqual(
      [`${R}#decision-format`, `${R}#decision-hosting`, `${R}#question-1`, `${R}#question-2`].map((id) => [b.get(id)!.kind, b.get(id)!.title, b.get(id)!.status, b.get(id)!.parent]),
      [
        ['decision', 'Format', 'done', R],
        ['decision', 'Hosting', 'open', R],
        ['question', 'Who reviews?', 'open', R],
        ['question', 'Which version', 'done', R],
      ],
    );
    assert.deepStrictEqual(b.get(`${R}#decision-format`)!.refs, { paths: ['docs/format.md'] });
  });

  test('without a plan section, each top-level heading with plan content is an epic', () => {
    const g = markdownAdapter.read(fixture(), opts);
    const b = by(g);
    assert.deepStrictEqual(g.items.filter((i) => i.id.startsWith(M)).map((i) => `${i.id.slice(M.length)} ${i.kind}`), [
      '#q1 epic',
      '#q1-1 task',
      '#q1-2 task',
      '#q1-2.1 task',
      '#q1-2.2 task',
      '#stretch milestone',
      '#stretch-1 task',
      '#components epic',
      '#components-parser task',
      '#components-checker task',
      '#components-exporter task',
      '#components-importer task',
      '#components-viewer task',
      '#decisions epic',
      '#decision-use-typescript decision',
    ]);
    assert.ok(!g.items.some((i) => i.id.includes('install')), 'a numbered install list is not a plan');
    assert.strictEqual(b.get(`${M}#stretch`)!.parent, `${M}#q1`);
    assert.strictEqual(b.get(`${M}#stretch-1`)!.parent, `${M}#stretch`);
    assert.deepStrictEqual([b.get(`${M}#q1-2.1`)!.confidence, b.get(`${M}#q1-2.2`)!.confidence], ['observed', 'inferred']);
    assert.deepStrictEqual([b.get(`${M}#q1-1`)!.status, b.get(`${M}#q1-2`)!.status], ['done', 'open']);
    assert.strictEqual(b.get(`${M}#q1`)!.status, 'in_progress');
    assert.ok(has(g, `${M}#q1-2`, 'blocks', `${M}#stretch-1`), '"after Ship the guide", by title, across sections');
    assert.ok(!g.items.some((i) => i.id.startsWith('README')), 'the README gives nothing');
  });

  test('a table with a Status column: rows are items with mapped statuses', () => {
    const b = by(markdownAdapter.read(fixture(), opts));
    const st = (n: string) => b.get(`${M}#components-${n}`)!.status;
    assert.deepStrictEqual(['parser', 'checker', 'exporter', 'importer', 'viewer'].map(st), ['done', 'in_progress', 'blocked', 'dropped', 'open']);
    assert.strictEqual(b.get(`${M}#components-parser`)!.confidence, 'inferred');
    const done = markdownAdapter.read([file('t.md', '## Tasks\n\n| Task | Done |\n| --- | --- |\n| One | x |\n| Two | |\n| Three | yes |\n')], opts);
    assert.deepStrictEqual(done.items.map((i) => [i.title, i.status]), [['Tasks', 'in_progress'], ['One', 'done'], ['Two', 'open'], ['Three', 'done']]);
  });

  test('phases with subheadings are milestones; a title with lists of its own counts only for those', () => {
    const md = '# Phases\n\nIntro.\n\n## Phase one\n\n1. Build\n2. **Test.** After 1.\n\n## Phase two\n\n1. Ship, after Test\n';
    const g = markdownAdapter.read([file('p.md', md)], opts);
    assert.deepStrictEqual(g.items.map((i) => `${i.id} ${i.kind}`), ['p.md epic', 'p.md#phase-one milestone', 'p.md#phase-one-1 step', 'p.md#phase-one-2 step', 'p.md#phase-two milestone', 'p.md#phase-two-1 step']);
    assert.ok(has(g, 'p.md#phase-one-1', 'blocks', 'p.md#phase-one-2'), '"after 1" within its own list');
    assert.ok(has(g, 'p.md#phase-one-2', 'blocks', 'p.md#phase-two-1'), '"after Test", by title');
    assert.ok(!has(g, 'p.md#phase-two-1', 'follows', 'p.md#phase-one-2'), 'no follows across milestones');
    const titled = markdownAdapter.read([file('q.md', '# Rollout plan\n\n1. Build\n2. Ship\n\n## Notes\n\n- not a step\n')], opts);
    assert.deepStrictEqual(titled.items.map((i) => i.id), ['q.md', 'q.md#step-1', 'q.md#step-2']);
    const nested = markdownAdapter.read([file('n.md', '# Design\n\n## Roadmap\n\n### Phase 1\n\n1. Build\n2. Test, after 1\n\n### Phase 2\n\n- Ship\n')], opts);
    assert.deepStrictEqual(nested.items.map((i) => `${i.id} ${i.kind} ${i.parent ?? ''}`.trim()), [
      'n.md epic',
      'n.md#phase-1 milestone n.md',
      'n.md#phase-1-1 step n.md#phase-1',
      'n.md#phase-1-2 step n.md#phase-1',
      'n.md#phase-2 milestone n.md',
      'n.md#phase-2-1 step n.md#phase-2',
    ]);
    assert.ok(has(nested, 'n.md#phase-1-1', 'blocks', 'n.md#phase-1-2'));
  });

  test('paths: relative, links resolved against the document, never absolute or above the folder', () => {
    const b = by(markdownAdapter.read(fixture(), opts));
    assert.deepStrictEqual(b.get(`${R}#step-1`)!.refs, { paths: ['plans/notes/parser.md', 'src/parse.ts'] });
    assert.deepStrictEqual(b.get(`${R}#step-2`)!.refs, { urls: ['https://example.com/spec.html'] });
    const g = markdownAdapter.read([file('a/b.md', '## Steps\n\n1. See [up](../c.md), [too far](../../d.md), [root](/e.md), [mail](mailto:x@example.com), [anchor](#steps) and C:\\x\\y.md.\n')], opts);
    assert.deepStrictEqual(g.items[1].refs, { paths: ['c.md'] });
    for (const it of markdownAdapter.read(docs(), opts).items) for (const p of it.refs?.paths ?? []) assert.ok(!/^(\/|[A-Za-z]:)/.test(p) && !p.split('/').includes('..'), `${it.id}: ${p}`);
  });

  test('keepText keeps the entry text; titles and refs are the same either way', () => {
    const off = markdownAdapter.read(fixture(), opts);
    const on = markdownAdapter.read(fixture(), { ...opts, keepText: true });
    assert.ok(off.items.every((i) => i.text === undefined));
    assert.ok(!JSON.stringify(off).includes('It never reads'));
    assert.ok(by(on).get(`${R}#step-2`)!.text!.startsWith('**Checker.** After 1.'));
    assert.deepStrictEqual(on.items.map((i) => [i.id, i.title, i.refs]), off.items.map((i) => [i.id, i.title, i.refs]));
  });

  test('status words and titles', () => {
    assert.deepStrictEqual(['done', 'shipped', '✓', 'done, but for the review', 'partly', 'later', 'not planned', 'blocked', 'cancelled', 'not decided', 'whatever'].map(statusOf), ['done', 'done', 'done', 'in_progress', 'in_progress', 'deferred', 'deferred', 'blocked', 'dropped', 'open', undefined]);
    assert.deepStrictEqual(titleAndStatus('**Model and catalog — done.** `src/catalog.ts`'), { title: 'Model and catalog', status: 'done' });
    assert.deepStrictEqual(titleAndStatus('**Hero visualizations — done, but for the review.** More.'), { title: 'Hero visualizations', status: 'in_progress' });
    assert.deepStrictEqual(titleAndStatus('**Plan adapter: beads.** An in-page module.'), { title: 'Plan adapter: beads' });
    assert.deepStrictEqual(titleAndStatus('Write the docs (deferred)'), { title: 'Write the docs', status: 'deferred' });
    assert.deepStrictEqual(titleAndStatus('Ship it ✓'), { title: 'Ship it', status: 'done' });
    assert.deepStrictEqual(titleAndStatus('Front-end work - the hard part'), { title: 'Front-end work - the hard part' });
  });

  test("this project's docs: workspace-explorer.md is one epic of 24 steps", () => {
    const g = markdownAdapter.read(docs(), opts);
    const W = 'docs/workspace-explorer.md';
    const s = (n: number) => `${W}#step-${n}`;
    const b = by(g);
    const steps = g.items.filter((i) => i.parent === W && i.kind === 'step');
    assert.strictEqual(steps.length, 24);
    assert.deepStrictEqual(steps.map((i) => i.id), Array.from({ length: 24 }, (_, i) => s(i + 1)));
    assert.strictEqual(b.get(W)!.kind, 'epic');
    assert.strictEqual(b.get(W)!.title, 'Design: the workspace explorer');
    assert.strictEqual(b.get(s(1))!.title, 'Design review');
    assert.strictEqual(b.get(s(10))!.title, 'Plan adapter: planning markdown');
    assert.strictEqual(b.get(s(24))!.title, 'Credits');
    assert.ok(b.get(s(2))!.refs!.paths!.includes('src/model/code.ts'));
    for (let n = 2; n <= 24; n++) assert.ok(has(g, s(n), 'follows', s(n - 1)), `step ${n} follows ${n - 1}`);
    assert.ok(has(g, s(5), 'blocks', s(24)), 'step 24: "after 5"');
    assert.ok(!has(g, s(6), 'blocks', s(24)) && !has(g, s(7), 'blocks', s(24)), 'step 24: "∥ with 6–7"');
    assert.ok(!g.links.some((l) => l.kind === 'blocks' && l.to === s(4)), 'step 4: "∥ with 3"');
    assert.ok(has(g, s(11), 'blocks', s(21)) && has(g, s(12), 'blocks', s(21)), 'step 21: "after Atlas\'s foundations (steps 11 and 12)"');
    assert.ok(has(g, s(22), 'blocks', s(23)), 'step 22 decides 23; 23 only if 22');
    assert.strictEqual(linksOf(g, 'blocks').filter((l) => l.from.startsWith(W)).length, 4);
    // The Decisions table and the Open questions list.
    const decisions = g.items.filter((i) => i.parent === W && i.kind === 'decision');
    assert.strictEqual(decisions.length, 18);
    assert.deepStrictEqual(decisions.filter((d) => d.status === 'open').map((d) => d.title), ['Fusing design languages']);
    assert.strictEqual(g.items.filter((i) => i.parent === W && i.kind === 'question').length, 4);
    assert.ok(g.items.filter((i) => i.id.startsWith(W)).every((i) => i.confidence === 'inferred'));
  });

  test("this project's docs: visualization-explorer.md's Steps, with done in bold", () => {
    const g = markdownAdapter.read(docs(), opts);
    const V = 'docs/visualization-explorer.md';
    const s = (n: number) => `${V}#step-${n}`;
    const b = by(g);
    const steps = g.items.filter((i) => i.parent === V && i.kind === 'step');
    assert.deepStrictEqual(steps.map((i) => [i.title, i.status]), [
      ['Model and catalog', 'done'],
      ['Explore tab', 'done'],
      ['New visualizers', 'done'],
      ['Web demo', 'done'],
      ['Docs', 'done'],
      ['More visualizers, from the proposal', 'open'],
      ['Hero visualizations', 'in_progress'],
    ]);
    assert.strictEqual(b.get(V)!.status, 'in_progress');
    assert.ok(has(g, s(5), 'blocks', s(6)), '"After step 5"');
    assert.ok(has(g, s(2), 'blocks', s(4)), '"as soon as step 2 is in"');
    assert.ok(!has(g, s(3), 'blocks', s(4)), '"in parallel with step 3"');
    assert.strictEqual(g.items.filter((i) => i.parent === V && i.kind === 'decision').length, 16);
    assert.strictEqual(g.items.filter((i) => i.parent === V && i.kind === 'question').length, 4);
  });

  test("this project's docs: the rest are not plans, and the output checks clean", () => {
    const files = docs();
    const g = markdownAdapter.read(files, opts);
    assert.deepStrictEqual([...new Set(g.items.map((i) => i.id.split('#')[0]))], ['docs/visualization-explorer.md', 'docs/workspace-explorer.md']);
    for (const keepText of [false, true]) {
      const out = markdownAdapter.read(files, { ...opts, keepText });
      const r = checkPlanGraph(out);
      assert.deepStrictEqual(r.errors, []);
      assert.strictEqual(r.value!.items.length, out.items.length);
      assert.strictEqual(r.value!.links.length, out.links.length);
    }
    assert.deepStrictEqual(g.source, { adapter: 'markdown', root: 'factory-clock', generatedAt: NOW });
  });

  test('the fixture checks clean', () => {
    for (const keepText of [false, true]) {
      const g = markdownAdapter.read(fixture(), { ...opts, keepText });
      const r = checkPlanGraph(g);
      assert.deepStrictEqual(r.errors, []);
      assert.strictEqual(r.value!.items.length, g.items.length);
      assert.strictEqual(r.value!.links.length, g.links.length);
    }
  });

  test('deterministic: same output whatever the file order; links in natural order', () => {
    const a = markdownAdapter.read([...docs(), ...fixture()], opts);
    const b = markdownAdapter.read([...fixture(), ...docs()].reverse(), opts);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
    const sorted = [...a.links].sort((x, y) => compareIds(x.from, y.from) || compareIds(x.to, y.to) || x.kind.localeCompare(y.kind));
    assert.deepStrictEqual(a.links, sorted);
    assert.strictEqual(new Set(a.items.map((i) => i.id)).size, a.items.length);
  });

  test('odd input does not throw', () => {
    for (const text of ['', '#', '- [ ]', '|', '| a |\n| --- |', '1.', '```\n- [ ] open fence', '<!-- - [ ] in a comment', '## Steps\n\n1. after 2026-11-13\n2. after 1.5\n']) {
      const g = markdownAdapter.read([file('x.md', text)], opts);
      assert.deepStrictEqual(checkPlanGraph(g).errors, []);
    }
    const dated = markdownAdapter.read([file('x.md', '## Steps\n\n1. after 2026-11-13\n2. after 1.5\n')], opts);
    assert.ok(!dated.links.some((l) => l.kind === 'blocks'), 'a date or a version is not a step');
  });

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}\n${(err as Error).stack}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
}

void main();
