import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { NormalizedEvent } from '../schema';
import {
  SYNTHETIC_WORKSPACE_NAME,
  TRACES_WORKSPACE_NAME,
  WorkspaceStore,
  entryDetail,
  filesWorkspacePackage,
  folderEvents,
  formatRange,
  listSiteWorkspaces,
  makeWorkspacePackage,
  readRegisteredWorkspace,
  readSingleFiles,
  readWorkspaceIndex,
  sessionCountOf,
  sortFile,
  startingWorkspace,
  syntheticPlanGraph,
  syntheticWorkspacePackage,
  tracesWorkspacePackage,
  workspaceId,
  workspaceIndexScript,
  workspaceNameFrom,
  workspaceScript,
} from '../web';

// The workspace picker's logic, and the build's handling of site packages (scripts/siteWorkspaces.js).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { siteWorkspaces } = require(path.join(__dirname, '..', '..', 'scripts', 'siteWorkspaces.js')) as {
  siteWorkspaces(args: { root: string; out: string; html: string; env: Record<string, string | undefined> }): { html: string; from: string | null; files: string[] };
};

const ev = (id: string, ts: string, sessionId = 's1'): NormalizedEvent => ({ eventId: id, sessionId, agent: 'claude-code', kind: 'user_prompt', ts, status: 'unknown' } as NormalizedEvent);
const SOURCE = { tool: 'test', generatedAt: '2026-11-14T00:00:00.000Z' };
const pkg = (name: string, events: NormalizedEvent[]) => makeWorkspacePackage({ name, source: SOURCE, events });
const UTC = { locale: 'en-US', timeZone: 'UTC' };
/** Intl puts thin and narrow spaces around the dash; plain ones compare more readably. */
const plain = (s: string) => s.replace(/[\u2009\u202f]/g, ' ');

const PAGE = '<body>\n<script src="explore.js"></script>\n<!-- workspaces-index: here -->\n<script src="factory-clock.js"></script>\n</body>\n';

/** A folder as the scrape script writes it, made with the store's writers. */
function fixtureFolder(): { dir: string; packages: ReturnType<typeof pkg>[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-workspaces-'));
  const packages = [pkg('Fixture project', [ev('a', '2026-10-03T09:00:00Z'), ev('b', '2026-11-02T17:00:00Z', 's2')]), pkg('Fixture project', [ev('c', '2026-09-01T09:00:00Z')])];
  const files = ['fixture-1.js', 'fixture-2.js'];
  packages.forEach((p, i) => fs.writeFileSync(path.join(dir, files[i]), workspaceScript(p)));
  fs.writeFileSync(path.join(dir, 'index.js'), workspaceIndexScript(packages.map((p, i) => ({ name: p.name, range: p.range, file: `workspaces/${files[i]}` }))));
  fs.writeFileSync(path.join(dir, 'raw.jsonl'), '{"not":"for the site"}\n');
  fs.mkdirSync(path.join(dir, 'scratch'));
  fs.writeFileSync(path.join(dir, 'scratch', 'x.js'), '');
  return { dir, packages };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a range reads as a span of days, and one day alone', () => {
    assert.strictEqual(plain(formatRange({ first: '2026-10-03T09:00:00.000Z', last: '2026-11-02T17:00:00.000Z' }, UTC)), 'Oct 3 – Nov 2, 2026');
    assert.strictEqual(plain(formatRange({ first: '2026-10-03T09:00:00.000Z', last: '2026-10-03T17:00:00.000Z' }, UTC)), 'Oct 3, 2026');
    assert.strictEqual(plain(formatRange({ first: '2025-12-30T09:00:00.000Z', last: '2026-01-02T17:00:00.000Z' }, UTC)), 'Dec 30, 2025 – Jan 2, 2026');
    assert.strictEqual(formatRange(null, UTC), 'no dates');
  });

  test('an entry reads as its range, with the session count once its package is in hand', () => {
    const store = new WorkspaceStore();
    const { entry } = store.add(pkg('P', [ev('a', '2026-10-03T09:00:00Z'), ev('b', '2026-10-04T09:00:00Z', 's2'), ev('c', '2026-10-04T10:00:00Z', 's2')]), 'built-in');
    assert.strictEqual(sessionCountOf(entry.package!), 2);
    assert.strictEqual(plain(entryDetail(entry, UTC)), 'Oct 3 – 4, 2026 · 2 sessions');
    const listed = store.addListed({ name: 'Q', range: { first: '2026-10-03T09:00:00.000Z', last: '2026-10-03T10:00:00.000Z' }, file: 'workspaces/q.js' }).entry;
    assert.strictEqual(plain(entryDetail(listed, UTC)), 'Oct 3, 2026');
    const synthetic = syntheticWorkspacePackage();
    assert.strictEqual(sessionCountOf(synthetic), 4);
  });

  test('the site index is listed in the store, broken entries dropped, and a workspace in hand is never unloaded', () => {
    const store = new WorkspaceStore();
    const held = store.add(pkg('Held', [ev('a', '2026-10-03T09:00:00Z')]), 'built-in').entry;
    const index = [
      { name: 'Live', range: { first: '2026-10-01T00:00:00Z', last: '2026-10-02T00:00:00Z' }, file: 'workspaces/live.js' },
      { name: 'Held', range: held.range, file: 'workspaces/held.js' },
      { name: '/abs/path', range: null, file: 'workspaces/x.js' },
      { name: 'Elsewhere', range: null, file: 'https://example.com/x.js' },
    ];
    assert.strictEqual(listSiteWorkspaces(store, index), 1);
    assert.strictEqual(store.get(held.id)!.package, held.package);
    const live = store.find('Live', { first: '2026-10-01T00:00:00.000Z', last: '2026-10-02T00:00:00.000Z' })!;
    assert.strictEqual(live.file, 'workspaces/live.js');
    assert.strictEqual(live.package, undefined);
    assert.strictEqual(listSiteWorkspaces(store, undefined), 0);
    assert.strictEqual(listSiteWorkspaces(store, { not: 'a list' }), 0);
  });

  test('the starting workspace is the saved one when it is still offered, else the default', () => {
    const store = new WorkspaceStore();
    const generated = store.add(syntheticWorkspacePackage(), 'built-in').entry;
    const listed = store.addListed({ name: 'Live', range: null, file: 'workspaces/live.js' }).entry;
    const loaded = store.add(pkg('Mine', [ev('a', '2026-10-03T09:00:00Z')]), 'loaded').entry;
    assert.strictEqual(startingWorkspace(store, undefined, generated.id), generated.id);
    assert.strictEqual(startingWorkspace(store, 42, generated.id), generated.id);
    assert.strictEqual(startingWorkspace(store, listed.id, generated.id), listed.id);
    assert.strictEqual(startingWorkspace(store, generated.id, generated.id), generated.id);
    // A workspace read from files, or one this build no longer has, gives way to the default.
    assert.strictEqual(startingWorkspace(store, loaded.id, generated.id), generated.id);
    assert.strictEqual(startingWorkspace(store, workspaceId('Gone', null), generated.id), generated.id);
  });

  test('the example traces are a workspace of sessions alone', () => {
    const t = tracesWorkspacePackage({ events: [ev('a', '2026-10-03T09:00:00Z'), ev('b', '2026-10-05T09:00:00Z', 's2')] });
    assert.strictEqual(t.name, TRACES_WORKSPACE_NAME);
    assert.deepStrictEqual(t.range, { first: '2026-10-03T09:00:00.000Z', last: '2026-10-05T09:00:00.000Z' });
    assert.deepStrictEqual([t.code, t.plans], [[], []]);
    assert.strictEqual(t.source.generatedAt, '2026-10-05T09:00:00Z');
  });

  test('a workspace from files is named after its folder or first file, as a name and never a path', () => {
    assert.strictEqual(workspaceNameFrom('2026-11-01.jsonl'), '2026-11-01');
    assert.strictEqual(workspaceNameFrom('my-app'), 'my-app');
    assert.strictEqual(workspaceNameFrom('demo.workspace.json'), 'demo');
    assert.strictEqual(workspaceNameFrom('/home/me/secret/project'), 'project');
    assert.strictEqual(workspaceNameFrom('C:\\Users\\me\\proj'), 'proj');
    assert.strictEqual(workspaceNameFrom('  \n '), 'My files');
    assert.strictEqual(workspaceNameFrom('x'.repeat(300)).length, 120);
    const p = filesWorkspacePackage({ name: 'a.jsonl', events: [ev('a', '2026-10-03T09:00:00Z')], code: [], plans: [syntheticPlanGraph()], now: SOURCE.generatedAt });
    assert.strictEqual(p.name, 'a');
    assert.strictEqual(p.source.generatedAt, SOURCE.generatedAt);
    assert.ok(p.range && p.range.first <= '2026-10-03T09:00:00.000Z');
  });

  test('a dropped .workspace.json is sorted as a workspace and checked; a broken one is refused', () => {
    const synthetic = syntheticWorkspacePackage();
    const text = JSON.stringify(synthetic);
    assert.strictEqual(sortFile('example.workspace.json', text), 'workspace');
    const sorted = readSingleFiles([
      { name: 'example.workspace.json', text },
      { name: 'broken.workspace.json', text: '{"kind":"workspace-package","version":9}' },
    ]);
    assert.strictEqual(sorted.workspaces.length, 1);
    assert.strictEqual(sorted.workspaces[0].pkg.name, SYNTHETIC_WORKSPACE_NAME);
    assert.deepStrictEqual(sorted.workspaces[0].errors, []);
    assert.deepStrictEqual(sorted.refused.map((r) => r.name), ['broken.workspace.json']);
  });

  test('a folder\'s event files are its sessions; a beads export and other JSONL are not', () => {
    const jsonl = (es: NormalizedEvent[]) => es.map((e) => JSON.stringify(e)).join('\n');
    const found = folderEvents([
      { path: 'events/2026-10-03.jsonl', text: jsonl([ev('a', '2026-10-03T09:00:00Z'), ev('b', '2026-10-03T10:00:00Z')]), bytes: 1 },
      { path: 'events/2026-10-04.jsonl', text: jsonl([ev('b', '2026-10-03T10:00:00Z'), ev('c', '2026-10-04T10:00:00Z')]), bytes: 1 },
      { path: 'notes.json', text: JSON.stringify(ev('z', '2026-10-03T09:00:00Z')), bytes: 1 },
      { path: 'other.jsonl', text: '{"hello":1}\n', bytes: 1 },
    ]);
    assert.deepStrictEqual(found.events.map((e) => e.eventId), ['a', 'b', 'c']);
    assert.strictEqual(found.duplicates, 1);
  });

  test('the build copies nothing and writes no index tag when FC_WORKSPACES is unset', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-site-'));
    for (const env of [{}, { FC_WORKSPACES: '' }, { FC_WORKSPACES: '  ' }]) {
      const r = siteWorkspaces({ root: out, out, html: PAGE, env });
      assert.strictEqual(r.from, null);
      assert.deepStrictEqual(r.files, []);
      assert.ok(!r.html.includes('workspaces'), r.html);
      assert.ok(r.html.includes('<script src="factory-clock.js">'));
    }
    assert.deepStrictEqual(fs.readdirSync(out), []);
  });

  test('with FC_WORKSPACES set, the build copies the folder\'s scripts and tags the index, and the page can list and load them', () => {
    const { dir, packages } = fixtureFolder();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-site-'));
    // Relative to the repository root, as a person running the build would write it.
    const root = path.dirname(dir);
    const r = siteWorkspaces({ root, out, html: PAGE, env: { FC_WORKSPACES: path.basename(dir) } });
    assert.strictEqual(r.from, dir);
    assert.deepStrictEqual(r.files, ['fixture-1.js', 'fixture-2.js', 'index.js']);
    assert.deepStrictEqual(fs.readdirSync(path.join(out, 'workspaces')).sort(), r.files);
    assert.ok(r.html.includes('<script src="workspaces/index.js"></script>\n<script src="factory-clock.js">'), r.html);
    // An absolute path works too.
    assert.strictEqual(siteWorkspaces({ root: '/elsewhere', out, html: PAGE, env: { FC_WORKSPACES: dir } }).from, dir);

    // What the page does with them: the index lists both, and a picked one's script registers the package the index promised.
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(out, 'workspaces', 'index.js'), 'utf8'), sandbox);
    const store = new WorkspaceStore();
    assert.strictEqual(listSiteWorkspaces(store, sandbox.factoryClockWorkspaceIndex), 2);
    assert.deepStrictEqual(store.list().map((g) => [g.name, g.entries.length]), [['Fixture project', 2]]);
    const newest = store.list()[0].entries[0];
    assert.deepStrictEqual(newest.range, packages[0].range);
    vm.runInContext(fs.readFileSync(path.join(out, newest.file!), 'utf8'), sandbox);
    const read = readRegisteredWorkspace(sandbox.factoryClockWorkspaces, newest.id);
    assert.ok(read.value, read.errors.join('; '));
    assert.strictEqual(sessionCountOf(store.fill(newest.id, read.value).package!), 2);
    assert.strictEqual(readWorkspaceIndex(sandbox.factoryClockWorkspaceIndex).length, 2);
  });

  test('the build refuses a folder without an index, and a page without the marker', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-empty-'));
    assert.throws(() => siteWorkspaces({ root: empty, out: empty, html: PAGE, env: { FC_WORKSPACES: empty } }), /no index\.js/);
    assert.throws(() => siteWorkspaces({ root: empty, out: empty, html: '<body></body>', env: {} }), /marker/);
  });

  test('the store drops a workspace by id', () => {
    const store = new WorkspaceStore();
    const { entry } = store.add(pkg('P', [ev('a', '2026-10-03T09:00:00Z')]), 'loaded');
    assert.ok(store.remove(entry.id));
    assert.ok(!store.remove(entry.id));
    assert.deepStrictEqual(store.list(), []);
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

main();
