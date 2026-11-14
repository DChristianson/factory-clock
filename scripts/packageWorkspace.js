// Scrapes a whole project, sanitizes it, and packages it as one workspace in
// the store's format (docs/workspace-explorer.md, "The scrape script"):
//
//   node scripts/packageWorkspace.js --project <dir> --out <dir>
//     [--name <name>] [--events <dir or file>]... [--beads <file>]
//     [--exclude <path prefix>]... [--match <abs path>]... [--include-unscoped]
//     [--keep-text] [--report <file>] [--now <iso time>]
//
// (or npm run package-workspace -- <the same arguments>). Usage notes are in
// README.md, "Package a project as a workspace".
//
// It reads only the files git tracks in the project (minus any the
// project's .gitignore ignores and any that look like secrets), runs the
// page's own adapters over them, keeps the sessions in Snagboat's event files
// that worked in the project, and sanitizes all of it: prompt, reply, tool
// input, and plan text are dropped unless --keep-text; file targets become
// relative; secrets, email addresses, home folders, and absolute paths are
// replaced. It writes <out>/<name>.js and adds it to <out>/index.js, keeping
// the other workspaces there, and writes a report of what was removed, as
// counts, to <out>-reports/<name>.report.txt (outside the output folder, so a
// site build that copies the folder never ships it). It refuses an output
// folder inside a git work tree unless git ignores it, and it fails, writing
// nothing, if a project path, the home folder, or a secret is found in the
// output after sanitizing.
//
// The decisions are in src/scrape/index.ts, bundled here with esbuild (as
// scripts/site.js bundles the page) so the script needs no compile step.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const repo = path.join(__dirname, '..');

/** The pure half (src/scrape/index.ts), bundled in memory and loaded as a module. */
function loadScrape() {
  const entry = path.join(repo, 'src', 'scrape', 'index.ts');
  const built = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node20', write: false, logLevel: 'warning' });
  const m = new Module(entry, module);
  m.filename = entry;
  m.paths = module.paths;
  m._compile(built.outputFiles[0].text, entry);
  return m.exports;
}

const USAGE = `usage: node scripts/packageWorkspace.js --project <dir> --out <dir> [--name <name>]
  [--events <dir or file>]... [--beads <file>] [--exclude <path prefix>]...
  [--match <absolute path>]... [--include-unscoped] [--keep-text] [--report <file>] [--now <iso time>]`;

function parseArgs(argv) {
  const opts = { events: [], exclude: [], match: [], keepText: false, includeUnscoped: false };
  const many = { '--events': 'events', '--exclude': 'exclude', '--match': 'match' };
  const one = { '--project': 'project', '--out': 'out', '--name': 'name', '--beads': 'beads', '--report': 'report', '--now': 'now' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-text') opts.keepText = true;
    else if (a === '--include-unscoped') opts.includeUnscoped = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (many[a] || one[a]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (many[a]) opts[many[a]].push(v);
      else opts[one[a]] = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** The nearest folder that exists, at or above p. */
function existingAncestor(p) {
  let d = p;
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

/**
 * Refuses a folder inside a git work tree that git doesn't ignore, so a
 * package of real data is never left where `git add` would pick it up.
 */
function checkOutside(dir, what) {
  const anchor = existingAncestor(dir);
  const top = git(anchor, ['rev-parse', '--show-toplevel']);
  if (top === null) return;
  const rel = path.relative(top.trim(), dir).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return;
  const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', `${rel}/`], { cwd: top.trim() });
  if (ignored.status !== 0) throw new Error(`${what} is inside a git work tree and not ignored by it; use a folder outside the repository, or an ignored one such as out/`);
}

/** The project's tracked files, relative to it, with tracked-but-ignored ones marked. */
function trackedFiles(root) {
  const list = git(root, ['ls-files', '-z']);
  if (list === null) throw new Error('the project is not a git work tree; only files git tracks are read');
  const ignored = new Set((git(root, ['ls-files', '-z', '-c', '-i', '--exclude-standard']) ?? '').split('\0').filter(Boolean));
  const out = [];
  for (const p of list.split('\0').filter(Boolean)) {
    const abs = path.join(root, p);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue; // tracked, deleted in the working tree
    }
    if (stat.isFile()) out.push({ path: p, bytes: stat.size, abs, ignored: ignored.has(p) });
  }
  return out;
}

/** Every worktree of the project's repository, when the project is a repository's top: sessions in any of them worked on it. */
function worktrees(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top === null || path.resolve(top.trim()) !== fs.realpathSync(root)) return [];
  const list = git(root, ['worktree', 'list', '--porcelain']) ?? '';
  return list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
}

/** Event lines from Snagboat's files: a folder's *.jsonl and its events/ folder's, or one file. */
function readEvents(sources) {
  const values = [];
  let unparsed = 0;
  const files = [];
  for (const s of sources) {
    const abs = path.resolve(s);
    const stat = fs.statSync(abs);
    if (stat.isFile()) files.push(abs);
    else {
      for (const dir of [abs, path.join(abs, 'events')]) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) files.push(path.join(dir, f));
      }
    }
  }
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        unparsed += 1;
      }
    }
  }
  return { values, unparsed, files: files.length };
}

function projectName(root) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    // no manifest: the folder's name
  }
  return path.basename(root);
}

/** Reads the output folder's index, so a run adds to it rather than replacing it. */
function readIndex(file, scrape) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const m = /^globalThis\.factoryClockWorkspaceIndex = ([\s\S]*);\s*$/.exec(text);
  if (!m) throw new Error(`${file} is not an index this script wrote; move it aside first`);
  return scrape.readWorkspaceIndex(JSON.parse(m[1]));
}

/**
 * Runs the script. Returns { report, file, package } and writes the files;
 * throws with a message on a usage error or a leak. `log` gets the report.
 */
function run(argv, { log = console.log, scrape = loadScrape() } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return null;
  }
  if (!opts.project || !opts.out) throw new Error(`--project and --out are required\n${USAGE}`);
  const root = path.resolve(opts.project);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('--project is not a folder');
  const out = path.resolve(opts.out);
  const name = (opts.name ?? projectName(root)).trim();
  const stem = scrape.fileStem(name);
  const reportFile = path.resolve(opts.report ?? path.join(`${out}-reports`, `${stem}.report.txt`));
  if (path.dirname(reportFile) === out || reportFile.startsWith(out + path.sep)) throw new Error('--report must be outside the output folder, which the site build copies');
  checkOutside(out, '--out');
  checkOutside(path.dirname(reportFile), 'the report folder');
  for (const m of opts.match) if (!path.isAbsolute(m)) throw new Error('--match takes an absolute path');

  const real = fs.realpathSync(root);
  const roots = [...new Set([root, real, ...worktrees(root), ...opts.match.map((m) => path.resolve(m))])];
  const homes = [...new Set([os.homedir(), process.env.HOME].filter(Boolean))];
  const gitUser = (git(root, ['config', 'user.name']) ?? '').trim();
  const users = [...new Set([os.userInfo().username, process.env.USER, gitUser].filter(Boolean))];

  const files = trackedFiles(root);
  if (opts.beads) {
    const abs = path.resolve(opts.beads);
    if (!files.some((f) => f.path === '.beads/issues.jsonl')) files.push({ path: '.beads/issues.jsonl', bytes: fs.statSync(abs).size, abs, ignored: false });
  }
  const events = readEvents(opts.events);
  // The last commit's time by default, so one commit packages the same way every time (a package of code alone takes its range from it).
  const committed = (git(root, ['log', '-1', '--format=%cI']) ?? '').trim();
  const now = opts.now ?? (committed ? new Date(committed).toISOString() : new Date().toISOString());
  const result = scrape.scrapeProject({
    name,
    files,
    read: (f) => fs.readFileSync(f.abs, 'utf8'),
    events: events.values,
    unparsedLines: events.unparsed,
    roots,
    homes,
    users,
    exclude: opts.exclude,
    includeUnscoped: opts.includeUnscoped,
    keepText: opts.keepText,
    now,
  });
  const pkg = result.package;
  const checked = scrape.checkWorkspacePackage(JSON.parse(JSON.stringify(pkg)));
  if (!checked.value) throw new Error(`the package doesn't check: ${checked.errors[0]}`);
  const script = scrape.workspaceScript(pkg);
  const leaks = scrape.findLeaks(script, { forbidden: [...roots, ...homes], users, events: pkg.events });
  if (leaks.length) throw new Error(`refusing to write: the output still holds ${leaks.join('; ')}`);

  const joins = scrape.countSessionJoins(pkg);
  const report = scrape.formatReport(result, { name, keepText: opts.keepText, eventsGiven: opts.events.length > 0, joins })
    + (checked.errors.length ? `\nPackage check: ${checked.errors.length} problem(s):\n${checked.errors.map((e) => `  ${e}`).join('\n')}\n` : '\nPackage check: clean.\n')
    + `Leak check: none of the project's paths, the home folder, a user name, or a secret pattern found.\n`;

  fs.mkdirSync(out, { recursive: true });
  const indexFile = path.join(out, 'index.js');
  const file = `workspaces/${stem}.js`;
  const index = readIndex(indexFile, scrape).filter((e) => e.file !== file);
  index.push({ name: pkg.name, range: pkg.range, file });
  index.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(out, `${stem}.js`), script);
  fs.writeFileSync(indexFile, scrape.workspaceIndexScript(index));
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, report);
  log(report);
  log(`wrote ${path.join(out, `${stem}.js`)} and its index entry; the report is ${reportFile}`);
  return { report, file, package: pkg, reportFile, result };
}

module.exports = { run, parseArgs, loadScrape };

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(`packageWorkspace: ${err.message}`);
    process.exit(1);
  }
}
