import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  EventSet,
  LOADER_LIMITS,
  WorkspaceSet,
  looksBinary,
  planWalk,
  readProject,
  readSingleFiles,
  sortFile,
  syntheticCodeGraph,
  syntheticEvents,
  syntheticPlanGraph,
  syntheticSessionIds,
} from '../web';
import { CodeAdapter, ProjectFile } from '../model';

// The loader: which files of a folder are read, how single files are sorted,
// the adapters run over a folder, and the workspace the page holds.

const REPO = path.resolve(__dirname, '..', '..');
const BEADS_FIXTURE = path.join(REPO, 'src/test/fixtures/adapters/beads/issues.jsonl');

/** This repository as the page would read it from a chosen folder. */
function repoAsChosen(): ProjectFile[] {
  const entries: Array<{ path: string; bytes: number; abs: string }> = [];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.isFile()) entries.push({ path: `factory-clock/${path.relative(REPO, abs).split(path.sep).join('/')}`, bytes: fs.statSync(abs).size, abs });
    }
  };
  // The walk itself prunes nothing: planWalk must.
  for (const top of ['package.json', 'src', 'viz', 'hosts', 'docs', 'scripts', '.beads', 'node_modules/typescript/package.json']) {
    const abs = path.join(REPO, top);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(abs);
    else entries.push({ path: `factory-clock/${top}`, bytes: fs.statSync(abs).size, abs });
  }
  const plan = planWalk(entries);
  assert.strictEqual(plan.name, 'factory-clock');
  return plan.keep.map(({ entry, path: p }) => ({ path: p, text: fs.readFileSync(entry.abs, 'utf8'), bytes: entry.bytes }));
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a walk names the project for its folder, cuts that folder from paths, and skips what it should', () => {
    const plan = planWalk([
      { path: 'proj/src/a.ts', bytes: 10 },
      { path: 'proj/node_modules/x/index.js', bytes: 10 },
      { path: 'proj/packages/ui/dist/ui.js', bytes: 10 },
      { path: 'proj/.git/HEAD', bytes: 10 },
      { path: 'proj/.beads/issues.jsonl', bytes: 10 },
      { path: 'proj/.beads/dolt/noms/manifest', bytes: 10 },
      { path: 'proj/docs/logo.png', bytes: 10 },
      { path: 'proj/data/huge.json', bytes: LOADER_LIMITS.fileBytes + 1 },
      { path: 'proj/package.json', bytes: 10 },
    ]);
    assert.strictEqual(plan.name, 'proj');
    assert.deepStrictEqual(plan.keep.map((k) => k.path), ['.beads/issues.jsonl', 'package.json', 'src/a.ts']);
    assert.deepStrictEqual(plan.skipped, { folders: 4, binary: 1, large: ['data/huge.json'], overLimit: 0 });
  });

  test('the file limit cuts the same files every time, in path order', () => {
    const entries = ['p/c.ts', 'p/a.ts', 'p/b.ts'].map((p) => ({ path: p, bytes: 1 }));
    const plan = planWalk(entries, { fileBytes: 100, files: 2 });
    assert.deepStrictEqual(plan.keep.map((k) => k.path), ['a.ts', 'b.ts']);
    assert.strictEqual(plan.skipped.overLimit, 1);
    assert.strictEqual(planWalk([{ path: 'loose.ts', bytes: 1 }]).name, 'project');
  });

  test('binary text is noticed by its NULs', () => {
    assert.strictEqual(looksBinary('const a = 1;\n'), false);
    assert.strictEqual(looksBinary('PK\u0003\u0004\u0000\u0000'), true);
  });

  test('single files are sorted by content, not by name', () => {
    const event = JSON.stringify(syntheticEvents()[0]);
    const issue = fs.readFileSync(BEADS_FIXTURE, 'utf8');
    assert.strictEqual(sortFile('2026-11-12.jsonl', `${event}\n`), 'events');
    assert.strictEqual(sortFile('anything.txt', `${event}\n`), 'events');
    assert.strictEqual(sortFile('export.jsonl', issue), 'beads');
    assert.strictEqual(sortFile('repo.json', JSON.stringify(syntheticCodeGraph())), 'code');
    assert.strictEqual(sortFile('roadmap.json', JSON.stringify(syntheticPlanGraph())), 'plans');
    assert.strictEqual(sortFile('package.json', '{"name":"x"}'), 'unknown');
    assert.strictEqual(sortFile('notes.md', '# Notes\n'), 'unknown');
  });

  test('single files merge by subject; clashing roots stay distinct; the rest are named and refused', () => {
    const events = syntheticEvents();
    const half = Math.floor(events.length / 2);
    const jsonl = (es: unknown[]) => es.map((e) => JSON.stringify(e)).join('\n');
    const plan = JSON.stringify(syntheticPlanGraph());
    const sorted = readSingleFiles([
      { name: 'a.jsonl', text: jsonl(events.slice(0, half + 3)) },
      { name: 'b.jsonl', text: jsonl(events.slice(half)) },
      { name: 'plan-1.json', text: plan },
      { name: 'plan-2.json', text: plan },
      { name: 'issues.jsonl', text: fs.readFileSync(BEADS_FIXTURE, 'utf8') },
      { name: 'bad.json', text: '{"kind":"code-graph","version":2}' },
      { name: 'notes.md', text: '# hi' },
    ]);
    assert.strictEqual(sorted.events.length, events.length);
    assert.strictEqual(sorted.duplicates, 3);
    assert.deepStrictEqual(sorted.plans.map((p) => p.source.root), ['example-plan', 'example-plan (2)', 'issues']);
    assert.deepStrictEqual(sorted.refused.map((r) => r.name), ['bad.json', 'notes.md']);
    assert.ok(sorted.refused.every((r) => r.reason.length > 0));
  });

  test('this repository, chosen as a folder: npm and beads detect and read it, and a switch turns one off', () => {
    const files = repoAsChosen();
    assert.ok(!files.some((f) => f.path.startsWith('node_modules/')), 'node_modules is skipped');
    assert.ok(!files.some((f) => /^\.beads\/(?!.*\.jsonl$)/.test(f.path)), 'only the beads export is read under .beads');
    const read = readProject(files, { name: 'factory-clock', hints: ['globals'], now: '2026-11-13T00:00:00Z' });
    const npm = read.reports.find((r) => r.id === 'npm')!;
    assert.ok(npm.detected && npm.ran, 'npm ran');
    assert.deepStrictEqual(npm.errors, []);
    assert.match(npm.summary, /^1 package, \d+ files/);
    assert.strictEqual(read.code.length, 1);
    assert.strictEqual(read.code[0].source.root, 'factory-clock');
    assert.ok(!read.code[0].artifacts.some((a) => a.path?.startsWith('/')), 'no absolute paths');
    const beads = read.reports.find((r) => r.id === 'beads')!;
    if (files.some((f) => f.path === '.beads/issues.jsonl')) {
      assert.ok(beads.ran && read.plans.length === 1, 'beads ran over .beads/issues.jsonl');
      assert.match(beads.summary, /items/);
    }
    const off = readProject(files, { name: 'factory-clock', off: ['npm'] });
    assert.strictEqual(off.code.length, 0);
    const npmOff = off.reports.find((r) => r.id === 'npm')!;
    assert.ok(npmOff.detected && !npmOff.ran && npmOff.summary === '');
  });

  test('an adapter that throws is reported, and the others still stand', () => {
    const broken: CodeAdapter = { id: 'broken', subject: 'code', detect: () => true, read: () => { throw new Error('boom'); } };
    const files: ProjectFile[] = [{ path: '.beads/issues.jsonl', text: fs.readFileSync(BEADS_FIXTURE, 'utf8'), bytes: 1 }];
    const read = readProject(files, { name: 'p', adapters: { code: [broken], plans: [require('../adapters').beadsAdapter] } });
    assert.match(read.reports[0].errors[0], /read failed: Error: boom/);
    assert.strictEqual(read.plans.length, 1);
  });

  test('the workspace set lists units per subject and builds a Workspace from picks, keeping each subject on its own', () => {
    const set = new WorkspaceSet(new EventSet(syntheticEvents()), [syntheticCodeGraph()], [syntheticPlanGraph()]);
    assert.deepStrictEqual(set.listUnits('code').map((u) => u.id), ['example-monorepo']);
    assert.deepStrictEqual(set.listUnits('plans').map((u) => u.id), ['example-plan']);
    assert.strictEqual(set.listUnits('sessions').length, syntheticSessionIds().length);
    assert.deepStrictEqual(set.keep('code', ['gone']), ['example-monorepo'], 'no pick means every root');
    assert.deepStrictEqual(set.keep('sessions', ['gone']), [], 'sessions keep the page’s default pick rule');
    const ws = set.workspace({ sessions: syntheticSessionIds() });
    assert.strictEqual(ws.sessions.length, syntheticSessionIds().length);
    assert.strictEqual(ws.code.length, 1);
    assert.ok(ws.joins.sessionToCode.length > 0, 'the example sessions touch the example code');
    assert.ok(ws.joins.planToSession.length > 0, 'an example plan item names an example prompt');
    const swapped = set.withSessions(new EventSet([]));
    assert.strictEqual(swapped.code.length, 1, 'loading events keeps the project');
    assert.strictEqual(set.withProject([], []).sessions, set.sessions, 'loading a project keeps the sessions');
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
