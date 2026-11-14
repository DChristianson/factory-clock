import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '../schema';
import { joinSessionToCode, touchesOf } from '../model';
import { WorkspacePackage, checkWorkspacePackage, readWorkspaceIndex } from '../web';
import * as scrape from '../scrape';
import { Scrubber, findLeaks, looksLikeSecretFile, relativeTarget } from '../scrape';

// The scrape script (scripts/packageWorkspace.js) on a made-up project: a tiny
// npm package with a beads export and a markdown plan, made in a temporary
// git repository, and a made-up Snagboat event file with planted secrets,
// absolute paths, an email address, and text. Nothing here was recorded from
// anyone. The secrets are assembled from pieces so no whole one sits in the
// repository.

const REPO = path.resolve(__dirname, '..', '..');
const { run, loadScrape } = require(path.join(REPO, 'scripts', 'packageWorkspace.js')) as {
  run: (argv: string[], opts?: { log?: (s: string) => void; scrape?: unknown }) => { report: string; package: WorkspacePackage; reportFile: string; result: scrape.ScrapeResult } | null;
  loadScrape: () => typeof scrape;
};

const NOW = '2026-11-14T12:00:00.000Z';
const HOME = os.homedir();

// Planted values: each must be gone from every output.
const SECRETS = {
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'Zq9xVb7Lm2Np4Rt6Wy8Ac0Ef',
  github: 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  aws: 'AK' + 'IA' + 'QWERTYUIOPASDFGH',
  bearer: 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTYifQ' + '.' + 'c2lnbmF0dXJlLXRleHQx',
  urlPassword: 'hunter2-' + 'pw',
  envValue: 'Sup3r' + 'Secret' + 'Value',
  keyBody: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'BKcwggSjAgEAAoIBAQC7',
  email: 'jane.' + 'doe' + '@example.org',
  otherHome: '/Users/' + 'jdoe' + '/private-notes',
};
const PROMPT = 'Please refactor the parser, my key is ' + SECRETS.anthropic + ' and mail me at ' + SECRETS.email;
const REPLY = 'Done. Found ' + SECRETS.github + ' and ' + SECRETS.aws + ' in ' + SECRETS.otherHome + '\n-----BEGIN RSA PRIVATE KEY-----\n' + SECRETS.keyBody + '\n-----END RSA PRIVATE KEY-----';
const COMMAND = 'curl -H "Authorization: Bearer ' + SECRETS.bearer + '" https://bot:' + SECRETS.urlPassword + '@registry.example.com/x API_TOKEN=' + SECRETS.envValue;

function sh(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function write(root: string, rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** The made-up project, as a git repository with its files added (no commit needed: ls-files reads the index). */
function makeProject(base: string): string {
  const root = path.join(base, 'tiny-app');
  write(root, 'package.json', JSON.stringify({ name: 'tiny-app', version: '1.0.0', dependencies: { lodash: '^4.0.0' } }, null, 2));
  write(root, 'src/index.ts', "import { parse } from './parser';\nimport { trim } from './util';\nexport const run = (s: string) => parse(trim(s));\n");
  write(root, 'src/parser.ts', "import { trim } from './util';\nexport const parse = (s: string) => trim(s).split(',');\n");
  write(root, 'src/util.ts', 'export const trim = (s: string) => s.trim();\n');
  write(root, 'docs/plan.md', [
    '# Tiny app plan',
    '',
    '## Steps',
    '',
    '1. **Parser — done.** Write `src/parser.ts`; ask ' + SECRETS.email + ' for the grammar.',
    '2. **Util.** Trim input in `src/util.ts`.',
    '3. **Release.** Publish with NPM_TOKEN=' + SECRETS.envValue + '.',
    '',
  ].join('\n'));
  const issue = (o: Record<string, unknown>) => JSON.stringify({ _type: 'issue', issue_type: 'task', status: 'open', priority: 2, created_at: '2026-11-01T09:00:00Z', updated_at: '2026-11-02T09:00:00Z', ...o });
  write(root, '.beads/issues.jsonl', [
    issue({ id: 'tiny-1', issue_type: 'epic', title: 'Tiny app', description: 'The whole thing. Owner is ' + SECRETS.email + '.' }),
    issue({ id: 'tiny-2', title: 'Write the parser', description: 'In src/parser.ts. Token ' + SECRETS.github, assignee: 'pat', status: 'closed', closed_at: '2026-11-03T10:00:00Z' }),
    issue({ id: 'tiny-3', title: 'Ask ' + SECRETS.email + ' about util', description: 'src/util.ts' }),
  ].join('\n') + '\n');
  write(root, '.gitignore', '.env\nforced.ts\nout/\n');
  // Never read: ignored and untracked; tracked but named like a secret; tracked by force though ignored.
  write(root, '.env', 'API_KEY=' + SECRETS.envValue + '\n');
  write(root, 'config/credentials.json', JSON.stringify({ token: SECRETS.github }));
  write(root, 'forced.ts', "export const k = '" + SECRETS.anthropic + "';\n");
  sh(root, ['init', '-q']);
  sh(root, ['add', '.']);
  sh(root, ['add', '-f', 'forced.ts']);
  return root;
}

/** The made-up event file: sessions in the project, in a worktree under it, elsewhere, and with no workspace. */
function makeEvents(base: string, root: string): string {
  let n = 0;
  const ev = (sessionId: string, workspace: string | undefined, o: Record<string, unknown>) => JSON.stringify({
    eventId: `e${++n}`, sessionId, agent: 'claude-code', ts: `2026-11-10T10:00:${String(n).padStart(2, '0')}.000Z`, status: 'success',
    ...(workspace ? { workspace } : {}), raw: { adapter: 'claude-code', ref: `${HOME}/.claude/projects/x.jsonl:${n}`, event: { secret: SECRETS.anthropic } }, ...o,
  });
  const wt = path.join(root, '.claude', 'worktrees', 'w1');
  const lines = [
    ev('s-a', root, { kind: 'session_name', sessionName: 'Refactor for ' + SECRETS.email }),
    ev('s-a', root, { kind: 'user_prompt', turnId: 't1', promptText: PROMPT }),
    ev('s-a', root, { kind: 'tool_call', turnId: 't1', toolName: 'Read', toolCategory: 'file-read', target: path.join(root, 'src', 'util.ts') }),
    ev('s-a', root, { kind: 'tool_call', turnId: 't1', toolName: 'Edit', toolCategory: 'file-edit', target: path.join(root, 'src', 'parser.ts'), model: 'claude-opus-5-5', tokens: { input: 100, output: 20 } }),
    ev('s-a', root, { kind: 'tool_call', turnId: 't1', toolName: 'Bash', toolCategory: 'shell', target: COMMAND }),
    ev('s-a', root, { kind: 'tool_call', turnId: 't1', toolName: 'Read', toolCategory: 'file-read', target: path.join(HOME, 'notes', 'todo.md') }),
    ev('s-a', root, { kind: 'tool_call', turnId: 't1', toolName: 'TodoWrite', toolCategory: 'other', todos: { pending: 1, inProgress: 0, completed: 1, items: [{ text: 'mail ' + SECRETS.email, status: 'pending' }, { text: 'done', status: 'completed' }] } }),
    ev('s-a', root, { kind: 'turn_stop', turnId: 't1', endsTurn: true, textExcerpt: REPLY, tokens: { input: 300, output: 50, cacheRead: 1000 } }),
    ev('s-b', wt, { kind: 'user_prompt', turnId: 't2', promptText: 'short prompt' }),
    ev('s-b', wt, { kind: 'tool_call', turnId: 't2', toolName: 'Read', toolCategory: 'file-read', target: path.join(wt, 'src', 'util.ts') }),
    ev('s-b', undefined, { kind: 'tool_call', turnId: 't2', toolName: 'Edit', toolCategory: 'file-edit', target: 'src/index.ts' }),
    ev('s-c', '/elsewhere/other-project', { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', target: '/elsewhere/other-project/a.ts' }),
    ev('s-d', undefined, { kind: 'user_prompt', promptText: 'no workspace here' }),
    'this line is not json',
    JSON.stringify({ hello: 'not an event' }),
    // A repeat of the first event, as when a day file is read twice.
    ev('s-a', root, { kind: 'turn_start', eventId: 'e1' }),
  ];
  const dir = path.join(base, 'snagboat', 'events');
  write(dir, '2026-11-10.jsonl', lines.join('\n') + '\n');
  return path.dirname(dir);
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scrape-'));
  const root = makeProject(base);
  const events = makeEvents(base, root);
  const out = path.join(base, 'site-workspaces');
  const quiet = { log: () => undefined, scrape };
  const go = (...extra: string[]) => run(['--project', root, '--out', out, '--events', events, '--now', NOW, ...extra], quiet)!;

  const first = go();
  const script = fs.readFileSync(path.join(out, 'tiny-app.js'), 'utf8');
  const pkg = first.package;
  const removed = first.result.removed;

  test('writes one package, named for the project, that checks clean', () => {
    assert.strictEqual(pkg.name, 'tiny-app');
    assert.ok(fs.existsSync(path.join(out, 'index.js')));
    const registry: Record<string, unknown> = {};
    new Function('globalThis', script)(registry);
    const reg = (registry as { factoryClockWorkspaces: Record<string, unknown> }).factoryClockWorkspaces;
    const [id] = Object.keys(reg);
    const checked = checkWorkspacePackage(reg[id]);
    assert.deepStrictEqual(checked.errors, []);
    assert.strictEqual(checked.value!.source.tool, scrape.SCRAPE_TOOL);
    assert.strictEqual(checked.value!.code.length, 1);
    assert.deepStrictEqual(checked.value!.plans.map((p) => p.source.adapter).sort(), ['beads', 'markdown']);
  });

  test('the time range runs from the first plan item to the last event', () => {
    assert.deepStrictEqual(pkg.range, { first: '2026-11-01T09:00:00.000Z', last: '2026-11-10T10:00:11.000Z' });
  });

  test('the index lists it as workspaces/<name>.js', () => {
    const g: Record<string, unknown> = {};
    new Function('globalThis', fs.readFileSync(path.join(out, 'index.js'), 'utf8'))(g);
    assert.deepStrictEqual(readWorkspaceIndex(g.factoryClockWorkspaceIndex), [{ name: 'tiny-app', range: pkg.range, file: 'workspaces/tiny-app.js' }]);
  });

  test('only the sessions that worked in the project are kept, a worktree under it included', () => {
    assert.deepStrictEqual([...new Set(pkg.events.map((e) => e.sessionId))].sort(), ['s-a', 's-b']);
    assert.strictEqual(removed['session in another workspace'], 1);
    assert.strictEqual(removed['session with no workspace'], 1);
    assert.strictEqual(removed['event of a session left out'], 2);
    assert.strictEqual(removed['event line that is not JSON'], 1);
    assert.strictEqual(removed['line that is not an event'], 1);
    assert.strictEqual(removed['repeated event'], 1);
    assert.ok(pkg.events.every((e) => e.workspace === undefined), 'no workspace folder');
    assert.ok(pkg.events.every((e) => e.raw.ref === '' && e.raw.event === undefined), 'no raw record');
  });

  test('sessions join to code through relative paths', () => {
    const targets = pkg.events.filter((e) => e.toolCategory === 'file-read' || e.toolCategory === 'file-edit').filter((e) => e.target).map((e) => `${e.sessionId} ${e.target}`);
    assert.deepStrictEqual(targets.sort(), ['s-a src/parser.ts', 's-a src/util.ts', 's-b src/index.ts', 's-b src/util.ts']);
    const touches = touchesOf(pkg.events);
    assert.ok([...touches.values()].flat().every((t) => t.anchored));
    const joins = joinSessionToCode(touches, pkg.code).map((j) => `${j.from} ${j.to}`).sort();
    const file = (p: string) => pkg.code[0].artifacts.find((a) => a.path === p);
    assert.ok(file('src/util.ts') && file('src/parser.ts') && file('src/index.ts'), 'the code graph has the files');
    assert.strictEqual(joins.length, 4, joins.join(', '));
    assert.ok(joins.every((j) => /^s-[ab] /.test(j)));
    assert.strictEqual(scrape.countSessionJoins(pkg), 4);
    assert.strictEqual(removed['file target outside the project'], 1);
    assert.strictEqual(removed['file target made relative'], 3);
  });

  test('every planted secret, path, and email is gone from the package and the report', () => {
    for (const text of [script, first.report, fs.readFileSync(first.reportFile, 'utf8')]) {
      for (const [kind, value] of Object.entries(SECRETS)) assert.ok(!text.includes(value), `${kind} leaked`);
      assert.ok(!text.includes(root), 'the project root leaked');
      assert.ok(!text.includes(base), 'the temporary folder leaked');
      assert.ok(!text.includes(HOME + '/'), 'the home folder leaked');
      assert.ok(!text.includes('jdoe'), 'another home folder leaked');
      assert.ok(!text.includes('/elsewhere'), 'another project leaked');
    }
  });

  test('text is dropped by default: prompts, replies, names, tool input, todo items, plan text, assignees', () => {
    assert.ok(pkg.events.every((e) => e.promptText === undefined && e.textExcerpt === undefined && e.sessionName === undefined));
    assert.strictEqual(pkg.events.find((e) => e.toolName === 'Bash')!.target, undefined);
    assert.deepStrictEqual(pkg.events.find((e) => e.toolName === 'TodoWrite')!.todos, { pending: 1, inProgress: 0, completed: 1 });
    for (const p of pkg.plans) for (const i of p.items) assert.ok(i.text === undefined && i.assignee === undefined, i.id);
    assert.strictEqual(removed['prompt text'], 2);
    assert.strictEqual(removed['reply text'], 1);
    assert.strictEqual(removed['session name'], 1);
    assert.strictEqual(removed['tool input (target)'], 1);
    assert.strictEqual(removed['todo item text'], 2);
    assert.strictEqual(removed['plan assignee'], 1);
    assert.ok(removed['plan item text'] >= 3, String(removed['plan item text']));
  });

  test('the structure the views draw is kept: turns, times, tokens, tools, models', () => {
    const edit = pkg.events.find((e) => e.toolName === 'Edit' && e.sessionId === 's-a')!;
    assert.strictEqual(edit.model, 'claude-opus-5-5');
    assert.deepStrictEqual(edit.tokens, { input: 100, output: 20 });
    const stop = pkg.events.find((e) => e.kind === 'turn_stop')!;
    assert.strictEqual(stop.endsTurn, true);
    assert.strictEqual(stop.turnId, 't1');
    assert.deepStrictEqual(stop.tokens, { input: 300, output: 50, cacheRead: 1000 });
    assert.strictEqual(pkg.events.filter((e) => e.kind === 'user_prompt').length, 2, 'prompts are kept as events');
  });

  test('plan titles stay, scrubbed: the email in one is replaced', () => {
    const beads = pkg.plans.find((p) => p.source.adapter === 'beads')!;
    assert.deepStrictEqual(beads.items.map((i) => i.title), ['Tiny app', 'Write the parser', 'Ask [email] about util']);
    assert.ok(beads.items.find((i) => i.id === 'tiny-2')!.refs?.paths?.includes('src/parser.ts'), 'paths named in the text are kept as refs');
  });

  test('files the .gitignore ignores, or that look like secrets, are never read', () => {
    const files = pkg.code[0].artifacts.map((a) => a.path ?? '');
    assert.ok(!files.some((p) => /\.env|credentials|forced/.test(p)), files.join(', '));
    assert.strictEqual(removed['file the .gitignore ignores'], 1);
    assert.strictEqual(removed['file that looks like a secret'], 1);
  });

  test('the report lists counts by kind, and never the values', () => {
    const r = first.report;
    assert.match(r, /prompt text: 2/);
    assert.match(r, /reply text: 1/);
    assert.match(r, /email address: \d+/);
    assert.match(r, /sessions: 2, events: 11, file targets: 4/);
    assert.match(r, /session-to-code joins: 4/);
    assert.match(r, /Package check: clean/);
    assert.ok(!r.includes('WARNING'));
    assert.strictEqual(path.dirname(first.reportFile), `${out}-reports`, 'the report is outside the output folder');
    assert.strictEqual(fs.readFileSync(first.reportFile, 'utf8'), r);
  });

  test('--keep-text keeps the text, scrubbed, and says so', () => {
    const kept = run(['--project', root, '--out', path.join(base, 'kept'), '--events', events, '--now', NOW, '--keep-text'], quiet)!;
    const text = fs.readFileSync(path.join(base, 'kept', 'tiny-app.js'), 'utf8');
    const prompt = kept.package.events.find((e) => e.sessionId === 's-a' && e.kind === 'user_prompt')!.promptText!;
    assert.strictEqual(prompt, 'Please refactor the parser, my key is [key] and mail me at [email]');
    const reply = kept.package.events.find((e) => e.kind === 'turn_stop')!.textExcerpt!;
    assert.ok(reply.startsWith('Done. Found [token] and [key] in ~/private-notes'), reply);
    assert.ok(reply.includes('[private key]'));
    const bash = kept.package.events.find((e) => e.toolName === 'Bash')!.target!;
    assert.strictEqual(bash, 'curl -H "Authorization: Bearer [token]" https://[credentials]@registry.example.com/x API_TOKEN=[redacted]');
    assert.ok(kept.package.plans.some((p) => p.items.some((i) => i.text)), 'plan text kept');
    assert.ok(kept.package.plans.every((p) => p.items.every((i) => !i.text || !i.text.includes('@example.org'))));
    for (const [kind, value] of Object.entries(SECRETS)) assert.ok(!text.includes(value), `${kind} leaked with --keep-text`);
    assert.match(kept.report, /WARNING: --keep-text/);
    assert.deepStrictEqual(checkWorkspacePackage(JSON.parse(JSON.stringify(kept.package))).errors, []);
  });

  test('without --events there are no sessions, and the report says so', () => {
    const r = run(['--project', root, '--out', path.join(base, 'code-only'), '--now', NOW], quiet)!;
    assert.strictEqual(r.package.events.length, 0);
    assert.match(r.report, /No event files were given/);
  });

  test('--include-unscoped keeps a session that names no workspace', () => {
    const r = run(['--project', root, '--out', path.join(base, 'unscoped'), '--events', events, '--now', NOW, '--include-unscoped'], quiet)!;
    assert.deepStrictEqual([...new Set(r.package.events.map((e) => e.sessionId))].sort(), ['s-a', 's-b', 's-d']);
  });

  test('running again replaces the workspace in the index and keeps the others', () => {
    go('--name', 'other app');
    go('--exclude', 'docs');
    const g: Record<string, unknown> = {};
    new Function('globalThis', fs.readFileSync(path.join(out, 'index.js'), 'utf8'))(g);
    const index = readWorkspaceIndex(g.factoryClockWorkspaceIndex);
    assert.deepStrictEqual(index.map((e) => [e.name, e.file]), [['other app', 'workspaces/other-app.js'], ['tiny-app', 'workspaces/tiny-app.js']]);
    assert.ok(fs.existsSync(path.join(out, 'other-app.js')));
    const again = fs.readFileSync(path.join(out, 'tiny-app.js'), 'utf8');
    assert.notStrictEqual(again, script, 'the second run rewrote it');
    assert.ok(!again.includes('docs/plan.md'), 'the excluded plan is gone');
  });

  test('refuses an output folder inside the project that git does not ignore, and allows an ignored one', () => {
    assert.throws(() => go('--out', path.join(root, 'packages')), /inside a git work tree/);
    assert.ok(!fs.existsSync(path.join(root, 'packages')));
    const ok = run(['--project', root, '--out', path.join(root, 'out', 'workspaces'), '--now', NOW], quiet)!;
    assert.ok(ok && fs.existsSync(path.join(root, 'out', 'workspaces', 'tiny-app.js')));
    assert.throws(() => go('--report', path.join(out, 'r.txt')), /outside the output folder/);
  });

  test('refuses a project that is not a git work tree', () => {
    const loose = path.join(base, 'loose');
    write(loose, 'package.json', '{"name":"loose"}');
    assert.throws(() => run(['--project', loose, '--out', path.join(base, 'loose-out')], quiet), /not a git work tree/);
  });

  test('the script loads its own bundle of the sanitizer', () => {
    const bundled = loadScrape();
    assert.strictEqual(typeof bundled.scrapeProject, 'function');
    assert.strictEqual(bundled.fileStem('My App / 2'), 'My-App-2');
  });

  // The pieces, on their own.

  test('the scrubber replaces each kind of secret and counts it', () => {
    const s = new Scrubber({ roots: ['/work/proj'], homes: ['/home/me'], users: ['someone'] });
    assert.strictEqual(s.scrub('see /work/proj/src/a.ts and /work/proj'), 'see src/a.ts and .');
    assert.strictEqual(s.scrub('/work/project/x'), '[path]', 'a sibling folder is not the project');
    assert.strictEqual(s.scrub('/home/me/x and /Users/pat/y and C:\\Users\\pat\\z'), '~/x and ~/y and ~\\z');
    assert.strictEqual(s.scrub('ask someone', { text: true }), 'ask [user]');
    assert.strictEqual(s.scrub('.vscode/settings.json and src/home/index.ts'), '.vscode/settings.json and src/home/index.ts', 'relative paths stay');
    assert.strictEqual(s.scrub('https://example.com/a/b'), 'https://example.com/a/b', 'a URL is not an absolute path');
    assert.strictEqual(s.scrub('password: hunter2'), 'password: [redacted]');
    assert.strictEqual(s.scrub('xo' + 'xb-1234567890-abcdefghij'), '[key]');
    assert.ok(s.counts['home folder'] >= 3 && s.counts['project path made relative'] === 2 && s.counts['user name'] === 1);
  });

  test('file targets are made relative to the event workspace or the project, or dropped', () => {
    const roots = ['/work/proj'];
    assert.strictEqual(relativeTarget('/work/proj/src/a.ts', '/work/proj', roots), 'src/a.ts');
    assert.strictEqual(relativeTarget('/work/proj/.wt/b/src/a.ts', '/work/proj/.wt/b', roots), 'src/a.ts');
    assert.strictEqual(relativeTarget('/work/other/a.ts', '/work/proj', roots), null);
    assert.strictEqual(relativeTarget('../a.ts', undefined, roots), null);
    assert.strictEqual(relativeTarget('src/a.ts', undefined, roots), 'src/a.ts');
  });

  test('secret-looking file names', () => {
    for (const p of ['.env', '.env.local', 'config/.envrc', 'certs/site.pem', 'id_rsa', 'deploy/credentials.json', 'app/secrets.yml', '.npmrc', 'a/.ssh/config']) assert.ok(looksLikeSecretFile(p), p);
    for (const p of ['src/env.ts', 'src/environment.ts', 'docs/keys.md', 'src/tokenizer.ts'.replace('tokenizer', 'lexer'), 'package.json']) assert.ok(!looksLikeSecretFile(p), p);
  });

  test('the leak check finds a project path, a home folder, or a secret, and names only the kind', () => {
    assert.deepStrictEqual(findLeaks('clean text', { forbidden: ['/work/proj'] }), []);
    assert.deepStrictEqual(findLeaks('at /work/proj/a', { forbidden: ['/work/proj'] }), ['an absolute project or home path']);
    assert.deepStrictEqual(findLeaks('"C:\\\\work\\\\proj"', { forbidden: ['C:/work/proj'] }), ['an absolute project or home path']);
    assert.deepStrictEqual(findLeaks('"/home/pat/x"', { forbidden: [] }), ['a home folder path']);
    const leak = findLeaks('token ' + SECRETS.github, { forbidden: [] });
    assert.deepStrictEqual(leak, ['something shaped like: GitHub token']);
    const e = { eventId: 'e', sessionId: 's', agent: 'claude-code', ts: NOW, kind: 'user_prompt', status: 'unknown', promptText: 'hi Someone', raw: { adapter: 'x', ref: '' } } as NormalizedEvent;
    assert.deepStrictEqual(findLeaks('{}', { forbidden: [], users: ['someone'], events: [e] }), ['a user name in kept text']);
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
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

main();
