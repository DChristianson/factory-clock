import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { beadsAdapter, compareIds, pathsIn } from '../adapters/plan/beads';
import { ProjectFile } from '../model/adapter';
import { checkPlanGraph } from '../model/plan';

// The beads adapter over a trimmed, scrubbed capture of this repository's own `bd export`
// (src/test/fixtures/adapters/beads/issues.jsonl), plus small hand-made lines for the edges.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test; the repository root is two levels up.
  const root = path.resolve(__dirname, '..', '..');
  const fixtureText = fs.readFileSync(path.join(root, 'src', 'test', 'fixtures', 'adapters', 'beads', 'issues.jsonl'), 'utf8');
  const file = (p: string, text: string): ProjectFile => ({ path: p, text, bytes: text.length });
  const fixture = () => [file('.beads/issues.jsonl', fixtureText)];
  const NOW = '2026-11-13T12:00:00Z';
  const opts = { name: 'factory-clock', now: NOW };
  const E = 'factory-clock-bqx';
  const line = (o: Record<string, unknown>) => JSON.stringify({ _type: 'issue', issue_type: 'task', status: 'open', priority: 2, ...o });

  test('detects the export by its place in the folder', () => {
    assert.ok(beadsAdapter.detect([file('.beads/issues.jsonl', '')]));
    assert.ok(beadsAdapter.detect([file('some/project/.beads/issues.jsonl', fixtureText)]));
    assert.strictEqual(beadsAdapter.id, 'beads');
    assert.strictEqual(beadsAdapter.subject, 'plans');
  });

  test('detects a dropped bd export by its content, and not an event log', () => {
    assert.ok(beadsAdapter.detect([file('dump.jsonl', '\n' + fixtureText)]));
    assert.ok(beadsAdapter.detect([file('old.jsonl', JSON.stringify({ id: 'x-1', title: 't', status: 'open', issue_type: 'bug' }))]));
    const events = [
      { kind: 'session_start', ts: '2026-11-13T10:00:00Z', sessionId: 's1' },
      { kind: 'tool_call', ts: '2026-11-13T10:00:01Z', sessionId: 's1', tool: 'Read' },
    ].map((e) => JSON.stringify(e)).join('\n');
    assert.ok(!beadsAdapter.detect([file('events.jsonl', events)]));
    assert.ok(!beadsAdapter.detect([file('issues.json', fixtureText)]), 'only .jsonl');
    assert.ok(!beadsAdapter.detect([file('memo.jsonl', JSON.stringify({ _type: 'memory', id: 'm', title: 't', status: 'open' }))]));
    assert.ok(!beadsAdapter.detect([file('broken.jsonl', '{not json')]));
    assert.ok(!beadsAdapter.detect([]));
  });

  test('reads the real export: kinds, statuses, priorities, timestamps', () => {
    const g = beadsAdapter.read(fixture(), opts);
    assert.deepStrictEqual(g.items.map((i) => i.id), [E, `${E}.1`, `${E}.2`, `${E}.4`, `${E}.5`, `${E}.6`]);
    const by = new Map(g.items.map((i) => [i.id, i]));
    assert.strictEqual(by.get(E)!.kind, 'epic');
    assert.strictEqual(by.get(E)!.status, 'open');
    assert.strictEqual(by.get(`${E}.1`)!.kind, 'task');
    assert.strictEqual(by.get(`${E}.1`)!.status, 'done');
    assert.strictEqual(by.get(`${E}.1`)!.closed, '2026-11-13T02:50:47Z');
    assert.strictEqual(by.get(`${E}.5`)!.status, 'in_progress');
    assert.strictEqual(by.get(`${E}.5`)!.assignee, 'agent-a');
    assert.strictEqual(by.get(`${E}.6`)!.kind, 'feature');
    assert.strictEqual(by.get(`${E}.6`)!.priority, 1);
    assert.strictEqual(by.get(`${E}.4`)!.priority, 2);
    assert.strictEqual(by.get(`${E}.6`)!.created, '2026-11-12T21:35:38Z');
    assert.ok(g.items.every((i) => i.confidence === 'observed'));
    assert.deepStrictEqual(g.source, { adapter: 'beads', root: 'factory-clock', generatedAt: NOW, tool: 'beads' });
  });

  test('maps every issue type and status', () => {
    const types = ['epic', 'feature', 'task', 'bug', 'chore', 'spike'];
    const statuses = ['open', 'in_progress', 'blocked', 'closed', 'deferred', 'tombstone', 'deleted', 'pondering'];
    const text = [
      ...types.map((t, i) => line({ id: `t-${i}`, title: t, issue_type: t })),
      ...statuses.map((s, i) => line({ id: `s-${i}`, title: s, status: s })),
    ].join('\n');
    const g = beadsAdapter.read([file('x.jsonl', text)], opts);
    const by = new Map(g.items.map((i) => [i.title, i]));
    assert.deepStrictEqual(types.map((t) => by.get(t)!.kind), ['epic', 'feature', 'task', 'bug', 'task', 'task']);
    assert.deepStrictEqual(statuses.map((s) => by.get(s)!.status), ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped', 'dropped', 'open']);
  });

  test('parents come from parent-child dependencies; blocks point from the blocker', () => {
    const g = beadsAdapter.read(fixture(), opts);
    const by = new Map(g.items.map((i) => [i.id, i]));
    assert.strictEqual(by.get(E)!.parent, undefined);
    for (const n of [1, 2, 4, 5, 6]) assert.strictEqual(by.get(`${E}.${n}`)!.parent, E);
    const has = (from: string, to: string, kind: string) => g.links.some((l) => l.from === from && l.to === to && l.kind === kind);
    // bqx.6 depends on bqx.4 and bqx.5 (type blocks): 4 and 5 block 6.
    assert.ok(has(`${E}.4`, `${E}.6`, 'blocks'));
    assert.ok(has(`${E}.5`, `${E}.6`, 'blocks'));
    assert.ok(has(`${E}.1`, `${E}.2`, 'blocks'));
    assert.ok(!has(`${E}.6`, `${E}.4`, 'blocks'), 'not the other way round');
    assert.ok(has(`${E}.6`, E, 'parent'), 'parent links run child → parent');
    assert.strictEqual(g.links.filter((l) => l.kind === 'parent').length, 5);
    assert.ok(g.links.every((l) => !l.inferred));
  });

  test('a parent field, other link types, links to missing issues, and the id fallback', () => {
    const withField = [
      line({ id: 'p-1', title: 'epic', issue_type: 'epic' }),
      line({ id: 'p-2', title: 'child', parent: 'p-1', dependencies: [{ issue_id: 'p-2', depends_on_id: 'p-3', type: 'discovered-from' }, { issue_id: 'p-2', depends_on_id: 'gone', type: 'blocks' }] }),
      line({ id: 'p-3', title: 'other', dependencies: [{ depends_on_id: 'p-1', type: 'related' }, { issue_id: 'p-3', depends_on_id: 'p-2', type: 'supersedes' }, { issue_id: 'p-3', depends_on_id: 'p-1', type: 'tracks' }] }),
    ].join('\n');
    const g = beadsAdapter.read([file('a.jsonl', withField)], opts);
    assert.strictEqual(g.items.find((i) => i.id === 'p-2')!.parent, 'p-1');
    assert.deepStrictEqual(g.links.map((l) => `${l.from} ${l.kind} ${l.to}`), ['p-2 parent p-1', 'p-2 discovered-from p-3', 'p-3 relates p-1', 'p-3 supersedes p-2']);

    // Neither convention anywhere: the hierarchical id stands in, marked inferred.
    const bare = [line({ id: 'q', title: 'epic', issue_type: 'epic' }), line({ id: 'q.1', title: 'one' }), line({ id: 'q.2', title: 'two' }), line({ id: 'r.1', title: 'orphan' })].join('\n');
    const h = beadsAdapter.read([file('b.jsonl', bare)], opts);
    assert.deepStrictEqual(h.items.map((i) => i.parent), [undefined, 'q', 'q', undefined]);
    assert.ok(h.links.every((l) => l.kind === 'parent' && l.inferred === true));
    assert.strictEqual(h.links.length, 2);
  });

  test('keepText keeps descriptions; paths are found either way', () => {
    const off = beadsAdapter.read(fixture(), opts);
    const on = beadsAdapter.read(fixture(), { ...opts, keepText: true });
    assert.ok(off.items.every((i) => i.text === undefined), 'no text by default');
    assert.ok(!JSON.stringify(off).includes('Extend Factory Clock from session views'), 'description absent');
    assert.ok(on.items.every((i) => typeof i.text === 'string' && i.text.length > 0));
    assert.ok(on.items.find((i) => i.id === E)!.text!.startsWith('Extend Factory Clock'));
    for (const g of [off, on]) {
      const by = new Map(g.items.map((i) => [i.id, i]));
      assert.ok(by.get(`${E}.2`)!.refs!.paths!.includes('src/model/code.ts'));
      assert.ok(by.get(`${E}.2`)!.refs!.paths!.includes('docs/workspace-explorer.md'));
      // The epic's notes name the sketches page; the glob beside it is not a path.
      assert.ok(by.get(E)!.refs!.paths!.includes('docs/images/workspace-explorer-sketches.html'));
      assert.ok(by.get(E)!.refs!.paths!.every((p) => !p.includes('*')));
    }
    assert.deepStrictEqual(on.items.map((i) => i.refs), off.items.map((i) => i.refs));
  });

  test('paths and urls: relative, normalized, no absolutes or urls', () => {
    const t = 'See src/model/code.ts, ./docs/x.md and viz/ plus src/model/{plan,shape}.ts. Not /etc/passwd, C:\\x\\y.txt, ../up/z.ts, and/or, 1/2, src/*.ts or https://example.com/a/b.html; also (hosts/web/index.html).';
    assert.deepStrictEqual(pathsIn(t).sort(), ['docs/x.md', 'hosts/web/index.html', 'src/model/code.ts', 'src/model/plan.ts', 'src/model/shape.ts', 'viz']);
    const g = beadsAdapter.read([file('u.jsonl', line({ id: 'u-1', title: 'links', description: `${t} Docs at https://example.com/a/b.html.` }))], opts);
    assert.deepStrictEqual(g.items[0].refs!.urls, ['https://example.com/a/b.html']);
    assert.ok(!g.items[0].refs!.paths!.some((p) => p.includes('example.com')));
  });

  test('no email address anywhere in the output', () => {
    const extra = line({ id: 'm-1', title: 'mail', owner: 'someone@example.com', created_by: 'someone@example.com', assignee: 'someone@example.com', description: 'write to x' });
    for (const keepText of [false, true]) {
      const g = beadsAdapter.read([file('.beads/issues.jsonl', fixtureText + extra + '\n')], { ...opts, keepText });
      assert.ok(!/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i.test(JSON.stringify(g)), 'an email address leaked');
      assert.strictEqual(g.items.find((i) => i.id === 'm-1')!.assignee, undefined);
    }
  });

  test('bad lines are skipped without throwing', () => {
    const text = ['{not json', '', '[1,2]', '"str"', JSON.stringify({ _type: 'memory', id: 'mem', title: 'secret', status: 'open' }), JSON.stringify({ id: 'no-title', status: 'open', issue_type: 'task' }), line({ id: 'ok-1', title: 'fine', priority: 'high', created_at: 'yesterday' }), 'null'].join('\n');
    const g = beadsAdapter.read([file('.beads/issues.jsonl', text)], opts);
    assert.deepStrictEqual(g.items.map((i) => i.id), ['ok-1']);
    assert.strictEqual(g.items[0].priority, undefined);
    assert.strictEqual(g.items[0].created, undefined);
    assert.deepStrictEqual(beadsAdapter.read([], opts).items, []);
  });

  test('duplicates across files: the later updated_at wins', () => {
    const older = line({ id: 'd-1', title: 'old title', updated_at: '2026-11-10T00:00:00Z' });
    const newer = line({ id: 'd-1', title: 'new title', status: 'closed', updated_at: '2026-11-12T00:00:00Z' });
    for (const files of [[file('.beads/issues.jsonl', older), file('drop.jsonl', newer)], [file('.beads/issues.jsonl', newer), file('drop.jsonl', older)], [file('one.jsonl', `${newer}\n${older}`)]]) {
      const g = beadsAdapter.read(files, opts);
      assert.strictEqual(g.items.length, 1);
      assert.strictEqual(g.items[0].title, 'new title');
      assert.strictEqual(g.items[0].status, 'done');
    }
  });

  test('only beads files are read', () => {
    const events = JSON.stringify({ kind: 'x', ts: '2026-11-13T10:00:00Z', sessionId: 's', id: 'e', title: 'e', status: 'open', issue_type: 'task' });
    const g = beadsAdapter.read([...fixture(), file('notes.md', 'factory-clock-bqx.99'), file('events.json', events)], opts);
    assert.strictEqual(g.items.length, 6);
  });

  test('the output checks clean', () => {
    for (const keepText of [false, true]) {
      const r = checkPlanGraph(beadsAdapter.read(fixture(), { ...opts, keepText }));
      assert.deepStrictEqual(r.errors, []);
      assert.ok(r.value);
    }
  });

  test('deterministic: same output whatever the line or file order', () => {
    const lines = fixtureText.trim().split('\n');
    const a = beadsAdapter.read([file('.beads/issues.jsonl', lines.join('\n'))], opts);
    const b = beadsAdapter.read([file('.beads/issues.jsonl', [...lines].reverse().join('\n'))], opts);
    const c = beadsAdapter.read([file('z.jsonl', lines.slice(0, 3).join('\n')), file('a.jsonl', lines.slice(3).join('\n'))], opts);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
    assert.strictEqual(JSON.stringify(a), JSON.stringify(c));
    const sorted = [...a.links].sort((x, y) => compareIds(x.from, y.from) || compareIds(x.to, y.to) || x.kind.localeCompare(y.kind));
    assert.deepStrictEqual(a.links, sorted);
  });

  test('natural order of ids', () => {
    const ids = ['x.10', 'x.2', 'x', 'x.1', 'x.2.1', 'w.3'];
    assert.deepStrictEqual([...ids].sort(compareIds), ['w.3', 'x', 'x.1', 'x.2', 'x.2.1', 'x.10']);
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
