/**
 * The npm + TypeScript/JavaScript code adapter (docs/workspace-explorer.md,
 * "Code adapters"). It reads `package.json` manifests (and their workspaces)
 * and the source tree, and returns a CodeGraph: a workspace, packages,
 * directory modules, files, and externals, with `import` dependencies between
 * files and `runtime`/`dev` dependencies from the manifests.
 *
 * It runs in the page and in Node alike, so it imports only the model types:
 * no Node builtins, no DOM.
 *
 * Imports are found by a small tokenizer, not a parser. It knows comments,
 * quoted strings, template literals (with nested substitutions), and regular
 * expression literals well enough that a specifier in a comment or inside
 * another string isn't counted. Its limits:
 * - Whether a slash starts a regex or is a division is guessed from the token
 *   before it, as editors do; an odd case can swallow the rest of a line.
 * - JSX text with an apostrophe (don't) reads as an unterminated string up to
 *   the end of its line, which can hide an import on that same line.
 * - Specifiers built at run time (template literals, variables) aren't seen.
 * - A triple-slash `reference types` directive is ignored; only
 *   `reference path` is read, as a path relative to the file.
 * - Package `exports`/`main` fields, tsconfig `paths`, and `#` subpath imports
 *   aren't consulted; a workspace package imported by name links to the
 *   package itself, not to one of its files.
 */
import { Artifact, ArtifactRole, CodeGraph, Dependency, DependencyKind, normalizePath } from '../../model/code';
import { AdapterOptions, CodeAdapter, ProjectFile } from '../../model/adapter';

// ---------- paths ----------

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const segmentsOf = (dir: string): string[] => (dir === '' ? [] : dir.split('/'));

/** Joins a relative path onto a directory; null when it climbs out of the root. */
function joinPath(dir: string, rel: string): string | null {
  const out = segmentsOf(dir);
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** The extension, lowercased, without the dot; `.d.ts` reads as `ts`. Empty for none or a bare dotfile. */
function extOf(p: string): string {
  const b = baseOf(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

// ---------- languages and roles ----------

const SCRIPT_EXTS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);
const LANGUAGE: Record<string, string> = { mts: 'ts', cts: 'ts', mjs: 'js', cjs: 'js', yml: 'yaml', htm: 'html', markdown: 'md' };
const ASSET_EXTS = new Set(['css', 'scss', 'sass', 'less', 'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'webm']);
const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'lerna.json', 'bun.lockb', 'bun.lock']);
const DOC_NAMES = /^(license|licence|copying|changelog|authors|notice|contributors)(\.|$)/i;
const GENERATED_DIRS = new Set(['dist', 'out', 'build', 'site']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__']);

function languageOf(p: string): string | undefined {
  const e = extOf(p);
  if (e === '') return undefined;
  return LANGUAGE[e] ?? e;
}

function roleOf(p: string, packageDirs: Set<string>): ArtifactRole {
  const dirs = segmentsOf(dirOf(p));
  const base = baseOf(p);
  const e = extOf(p);
  if (dirs.some((d) => GENERATED_DIRS.has(d))) return 'generated';
  if (dirs.some((d) => TEST_DIRS.has(d)) || /\.(test|spec)\.[^.]+$/i.test(base)) return 'test';
  if (e === 'md' || e === 'markdown' || e === 'txt' || DOC_NAMES.test(base)) return 'doc';
  if (
    MANIFESTS.has(base) ||
    base.startsWith('.') ||
    dirs.some((d) => d.startsWith('.')) ||
    /^[tj]sconfig.*\.json$/i.test(base) ||
    /\.config\.[^.]+$/i.test(base) ||
    (e === 'json' && packageDirs.has(dirOf(p)))
  )
    return 'config';
  if (ASSET_EXTS.has(e)) return 'asset';
  return 'source';
}

function linesOf(text: string): number {
  if (text === '') return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

// ---------- the tokenizer ----------

interface Token {
  t: 'id' | 'str' | 'tmpl' | 'num' | 'punct' | 'regex';
  v: string;
}

export interface Scanned {
  /** Module specifiers, one per import statement, `require` call, or dynamic import. */
  specifiers: string[];
  /** Paths from triple-slash `reference path` directives. */
  references: string[];
  /** The text of every comment, for the `globals` hint's see-lines. */
  comments: string[];
}

// After these keywords a slash starts a regex, not a division.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// Any non-ASCII character counts as part of a name, which is close enough for finding imports.
const isIdStart = (c: string) => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isIdPart = (c: string) => /[\w$]/.test(c) || c.charCodeAt(0) > 127;

/** Tokenizes a JavaScript/TypeScript source and picks out its import specifiers. */
export function scanScript(text: string): Scanned {
  const tokens: Token[] = [];
  const comments: string[] = [];
  const references: string[] = [];
  const templateDepths: number[] = []; // brace depth at each open `${`
  let braces = 0;
  let i = 0;
  const n = text.length;

  // Scans a template literal's body from i; stops after the closing backtick or after a `${`.
  const templateBody = (from: number): { end: number; open: boolean } => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') return { end: j + 1, open: false };
      else if (c === '$' && text[j + 1] === '{') return { end: j + 2, open: true };
      else j++;
    }
    return { end: n, open: false };
  };
  const enterTemplate = (from: number) => {
    const r = templateBody(from);
    tokens.push({ t: 'tmpl', v: '' });
    if (r.open) {
      templateDepths.push(braces);
      braces++;
    }
    i = r.end;
  };
  const regexAllowed = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.t === 'id') return REGEX_AFTER_WORD.has(prev.v);
    if (prev.t === 'punct') return prev.v !== ')' && prev.v !== ']';
    return false;
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c.charCodeAt(0) === 0xfeff) {
      i++;
    } else if (c === '/' && next === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      const body = text.slice(i + 2, j);
      comments.push(body);
      if (body.startsWith('/')) {
        const m = /^\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/.exec(body);
        if (m) references.push(m[1]);
      }
      i = j;
    } else if (c === '/' && next === '*') {
      let j = text.indexOf('*/', i + 2);
      if (j < 0) j = n;
      comments.push(text.slice(i + 2, j));
      i = Math.min(n, j + 2);
    } else if (c === '/' && regexAllowed()) {
      // A regex literal: to the closing slash outside a character class, never past the line.
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        const d = text[j];
        if (d === '\\') j += 2;
        else {
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
      }
      j++;
      while (j < n && isIdPart(text[j])) j++;
      tokens.push({ t: 'regex', v: '' });
      i = j;
    } else if (c === '"' || c === "'") {
      // A quoted string, ending at its quote or, unterminated, at the end of the line.
      let j = i + 1;
      let v = '';
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') {
          v += text[j + 1] ?? '';
          j += 2;
        } else v += text[j++];
      }
      tokens.push({ t: 'str', v });
      i = j + 1;
    } else if (c === '`') {
      enterTemplate(i + 1);
    } else if (c === '{') {
      braces++;
      tokens.push({ t: 'punct', v: c });
      i++;
    } else if (c === '}') {
      braces--;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braces) {
        templateDepths.pop();
        enterTemplate(i + 1);
      } else {
        tokens.push({ t: 'punct', v: c });
        i++;
      }
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(text[j])) j++;
      tokens.push({ t: 'id', v: text.slice(i, j) });
      i = j;
    } else if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      tokens.push({ t: 'num', v: text.slice(i, j) });
      i = j;
    } else {
      tokens.push({ t: 'punct', v: c });
      i++;
    }
  }

  // The patterns: import STR; import ( STR; from STR (import and export); require ( STR.
  // A preceding dot means a property (x.require), not the keyword.
  const specifiers: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t !== 'id') continue;
    const prev = tokens[k - 1];
    if (prev && prev.t === 'punct' && prev.v === '.') continue;
    const a = tokens[k + 1];
    const b = tokens[k + 2];
    if (tok.v === 'import') {
      if (a?.t === 'str') specifiers.push(a.v);
      else if (a?.t === 'punct' && a.v === '(' && b?.t === 'str') specifiers.push(b.v);
    } else if (tok.v === 'from') {
      if (a?.t === 'str') specifiers.push(a.v);
    } else if (tok.v === 'require') {
      if (a?.t === 'punct' && a.v === '(' && b?.t === 'str') specifiers.push(b.v);
    }
  }
  return { specifiers, references, comments };
}

// ---------- specifiers ----------

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** A bare specifier's package: `@a/b/c` → `@a/b`, `a/b` → `a`, a Node builtin → `node:<name>`; null for anything else. */
export function packageOfSpecifier(spec: string): string | null {
  if (spec.startsWith('node:')) {
    const name = spec.slice(5).split('/')[0];
    return name ? `node:${name}` : null;
  }
  // URLs and other schemes, subpath imports, absolute paths: not a package.
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('#') || spec.startsWith('/') || spec === '') return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  if (NODE_BUILTINS.has(parts[0])) return `node:${parts[0]}`;
  return parts[0];
}

const isRelative = (spec: string) => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.d.ts'];
// TypeScript's convention: a file imports `./a.js` and means `./a.ts`.
const TS_FOR_JS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/**
 * Resolves a relative specifier against the files, by the rules TypeScript
 * and Node use: the exact path, `./a.js` meaning `./a.ts`, an added
 * extension, then a folder's index file. Following those rules isn't a
 * guess, so the result is `inferred` only when the rules leave more than one
 * file that could be meant (`a.ts` beside `a.js`, `a.ts` beside `a/index.ts`),
 * and the first in rule order is taken.
 */
function resolveRelative(fromDir: string, spec: string, exists: (p: string) => boolean): { path: string; inferred: boolean } | null {
  const target = joinPath(fromDir, spec);
  if (target === null) return null;
  if (target !== '' && exists(target)) return { path: target, inferred: false };
  const candidates: string[] = [];
  const m = /\.(js|jsx|mjs|cjs)$/.exec(target);
  if (m) for (const e of TS_FOR_JS[m[0]]) candidates.push(target.slice(0, -m[0].length) + e);
  if (target !== '') for (const e of RESOLVE_EXTS) candidates.push(target + e);
  for (const e of RESOLVE_EXTS) candidates.push((target === '' ? '' : target + '/') + 'index' + e);
  // `a.d.ts` beside `a.ts` is the same module's types, not a second candidate.
  const hits = [...new Set(candidates.filter(exists))];
  const distinct = hits.filter((h) => !(h.endsWith('.d.ts') && hits.includes(h.slice(0, -5) + '.ts')));
  if (distinct.length === 0) return null;
  return { path: distinct[0], inferred: distinct.length > 1 };
}

// ---------- manifests ----------

interface Manifest {
  dir: string;
  path: string;
  name?: string;
  workspaces: string[];
  deps: Array<{ name: string; kind: DependencyKind }>;
}

function readManifest(f: ProjectFile): Manifest {
  const dir = dirOf(f.path);
  const out: Manifest = { dir, path: f.path, workspaces: [], deps: [] };
  let json: unknown;
  try {
    json = JSON.parse(f.text);
  } catch {
    return out; // A broken manifest still marks a package; it just names nothing.
  }
  if (typeof json !== 'object' || json === null) return out;
  const j = json as Record<string, unknown>;
  if (typeof j.name === 'string' && j.name.trim() !== '') out.name = j.name.trim();
  const ws = Array.isArray(j.workspaces) ? j.workspaces : typeof j.workspaces === 'object' && j.workspaces !== null ? (j.workspaces as Record<string, unknown>).packages : undefined;
  if (Array.isArray(ws)) out.workspaces = ws.filter((w): w is string => typeof w === 'string');
  const fields: Array<[string, DependencyKind]> = [
    ['dependencies', 'runtime'],
    ['peerDependencies', 'runtime'],
    ['optionalDependencies', 'runtime'],
    ['devDependencies', 'dev'],
  ];
  for (const [field, kind] of fields) {
    const d = j[field];
    if (typeof d === 'object' && d !== null && !Array.isArray(d)) for (const name of Object.keys(d)) out.deps.push({ name, kind });
  }
  return out;
}

/**
 * Whether a workspace pattern takes a package folder. Supports literal paths,
 * `dir/*` (a direct child), and `dir/**` (any folder below); a `!` negation
 * excludes. Other glob syntax is treated literally.
 */
function workspaceMatches(patterns: string[], dir: string): boolean {
  let hit = false;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const p = normalizePath(neg ? raw.slice(1) : raw);
    let m = false;
    if (p.endsWith('/**')) m = dir.startsWith(p.slice(0, -3) + '/');
    else if (p.endsWith('/*')) m = dirOf(dir) === p.slice(0, -2) && dir !== p.slice(0, -2);
    else if (p === '*') m = dir !== '' && !dir.includes('/');
    else m = dir === p;
    if (m) hit = !neg;
  }
  return hit;
}

// ---------- the adapter ----------

const KIND_ORDER: Record<string, number> = { workspace: 0, package: 1, target: 2, module: 3, file: 4, external: 5 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function read(input: ProjectFile[], options: AdapterOptions): CodeGraph {
  const hints = new Set(options.hints ?? []);
  const files = input
    .map((f) => ({ ...f, path: normalizePath(f.path) }))
    .filter((f) => f.path !== '' && !`/${f.path}/`.includes('/node_modules/'))
    .sort((a, b) => cmp(a.path, b.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const exists = (p: string) => byPath.has(p);

  const artifacts: Artifact[] = [];
  const used = new Set<string>(files.map((f) => f.path));

  // Packages, one per manifest, deepest folder last so lookups can scan from the end.
  const manifests = files.filter((f) => baseOf(f.path) === 'package.json').map(readManifest);
  manifests.sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || cmp(a.dir, b.dir));
  const packageDirs = new Set(manifests.map((m) => m.dir));
  const rootManifest = manifests.find((m) => m.dir === '');

  // Modules: every folder holding a script, and its folders up to (not including) its package's folder.
  const packageDirOf = (dir: string): string | undefined => {
    for (let d: string | null = dir; d !== null; d = d === '' ? null : dirOf(d)) if (packageDirs.has(d)) return d;
    return undefined;
  };
  const moduleDirs = new Set<string>();
  for (const f of files) {
    if (!SCRIPT_EXTS.has(extOf(f.path))) continue;
    for (let d = dirOf(f.path); d !== '' && !packageDirs.has(d); d = dirOf(d)) moduleDirs.add(d);
  }
  for (const d of moduleDirs) used.add(d);

  const unique = (id: string, prefix: string) => {
    let out = used.has(id) ? `${prefix}:${id}` : id;
    for (let k = 2; used.has(out); k++) out = `${prefix}:${id}~${k}`;
    used.add(out);
    return out;
  };

  let workspaceId: string | undefined;
  if (rootManifest && rootManifest.workspaces.length > 0) {
    const name = rootManifest.name ?? options.name;
    workspaceId = unique(`workspace:${name}`, 'workspace');
    artifacts.push({ id: workspaceId, kind: 'workspace', name });
  }

  // Package ids: the manifest name; an unnamed package goes by its folder (the project's name at the root).
  const packageIdByDir = new Map<string, string>();
  const packageIdByName = new Map<string, string>();
  for (const m of manifests) {
    const id = unique(m.name ?? (m.dir === '' ? options.name : m.dir), 'package');
    packageIdByDir.set(m.dir, id);
    if (m.name && !packageIdByName.has(m.name)) packageIdByName.set(m.name, id);
  }
  for (const m of manifests) {
    let parent: string | undefined;
    if (workspaceId && (m.dir === '' || workspaceMatches(rootManifest!.workspaces, m.dir))) parent = workspaceId;
    else if (m.dir !== '') {
      const up = packageDirOf(dirOf(m.dir));
      parent = up !== undefined ? packageIdByDir.get(up) : workspaceId;
    }
    artifacts.push({
      id: packageIdByDir.get(m.dir)!,
      kind: 'package',
      name: m.name ?? (m.dir === '' ? options.name : baseOf(m.dir)),
      ...(m.dir !== '' ? { path: m.dir } : {}),
      ...(parent ? { parent } : {}),
    });
  }

  // The container of anything in a folder: the folder's module, else its package, else the workspace.
  const containerOf = (dir: string): string | undefined => {
    if (moduleDirs.has(dir)) return dir;
    const p = packageDirOf(dir);
    return p !== undefined ? packageIdByDir.get(p) : workspaceId;
  };
  for (const d of moduleDirs) {
    const parent = containerOf(dirOf(d));
    artifacts.push({ id: d, kind: 'module', name: baseOf(d), path: d, ...(parent ? { parent } : {}) });
  }
  for (const f of files) {
    const parent = containerOf(dirOf(f.path));
    const language = languageOf(f.path);
    artifacts.push({
      id: f.path,
      kind: 'file',
      name: baseOf(f.path),
      path: f.path,
      ...(parent ? { parent } : {}),
      ...(language ? { language } : {}),
      size: { bytes: f.bytes, lines: linesOf(f.text) },
      role: roleOf(f.path, packageDirs),
    });
  }

  // Dependencies, merged by from, to and kind: weights add, and an edge is inferred only if every hit was.
  const edges = new Map<string, Dependency>();
  const externals = new Map<string, string>(); // id → name
  const addEdge = (from: string, to: string, kind: DependencyKind, inferred: boolean) => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    const e = edges.get(key);
    if (e) {
      e.weight = (e.weight ?? 1) + 1;
      if (!inferred) delete e.inferred;
    } else edges.set(key, { from, to, kind, weight: 1, ...(inferred ? { inferred: true } : {}) });
  };
  // A package name: a workspace package's artifact, else an external (`npm:<name>` or `node:<name>`).
  const packageTarget = (pkg: string): string => {
    const internal = packageIdByName.get(pkg);
    if (internal) return internal;
    const id = pkg.startsWith('node:') ? pkg : `npm:${pkg}`;
    externals.set(id, pkg);
    return id;
  };

  for (const m of manifests) {
    const from = packageIdByDir.get(m.dir)!;
    const seen = new Set<string>();
    for (const d of m.deps) {
      const pkg = packageOfSpecifier(d.name) ?? d.name;
      const key = `${pkg}\u0000${d.kind}`;
      if (seen.has(key)) continue; // listed under both dependencies and peerDependencies: one edge
      seen.add(key);
      addEdge(from, packageTarget(pkg), d.kind, false);
    }
  }

  const globals = hints.has('globals');
  for (const f of files) {
    const e = extOf(f.path);
    const dir = dirOf(f.path);
    let comments: string[] = [];
    if (SCRIPT_EXTS.has(e)) {
      const s = scanScript(f.text);
      comments = s.comments;
      for (const spec of s.specifiers) {
        if (isRelative(spec)) {
          const r = resolveRelative(dir, spec, exists);
          if (r) addEdge(f.path, r.path, 'import', r.inferred);
        } else {
          const pkg = packageOfSpecifier(spec);
          if (pkg) addEdge(f.path, packageTarget(pkg), 'import', false);
        }
      }
      for (const ref of s.references) {
        const r = resolveRelative(dir, ref.startsWith('.') || ref.startsWith('/') ? ref : `./${ref}`, exists);
        if (r) addEdge(f.path, r.path, 'import', r.inferred);
      }
    } else if (globals && (e === 'css' || e === 'scss' || e === 'less')) {
      comments = [...f.text.matchAll(/\/\*([\s\S]*?)(?:\*\/|$)/g)].map((m) => m[1]);
    } else if (globals && (e === 'html' || e === 'htm')) {
      comments = [...f.text.matchAll(/<!--([\s\S]*?)(?:-->|$)/g)].map((m) => m[1]);
      const html = f.text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
      const loads = [
        ...[...html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
        ...[...html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
      ];
      for (const url of loads) {
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) continue; // loaded from elsewhere
        const clean = url.replace(/[?#].*$/, '');
        // Next to the page first; then from the project root, since a site build
        // (Factory Clock's scripts/site.js) copies root files beside the page.
        const target = clean.startsWith('/') ? joinPath('', clean) : joinPath(dir, clean);
        const atRoot = joinPath('', clean);
        const hit = target !== null && target !== '' && exists(target) ? target : atRoot !== null && atRoot !== '' && exists(atRoot) ? atRoot : null;
        if (hit) addEdge(f.path, hit, 'reference', true);
      }
    }
    if (globals) {
      // `see path/to/file.ext` in a comment: relative to the file first, then to the root.
      for (const c of comments) {
        for (const m of c.matchAll(/\bsee\s+([\w./-]+\.\w+)/gi)) {
          const near = joinPath(dir, m[1]);
          const root = joinPath('', m[1]);
          const hit = near !== null && exists(near) ? near : root !== null && exists(root) ? root : null;
          if (hit) addEdge(f.path, hit, 'reference', true);
        }
      }
    }
  }

  for (const [id, name] of externals) artifacts.push({ id, kind: 'external', name });
  artifacts.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || cmp(a.id, b.id));
  const dependencies = [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind));

  return {
    kind: 'code-graph',
    version: 1,
    source: { adapter: 'npm', root: options.name, generatedAt: options.now ?? new Date().toISOString(), tool: 'npm' },
    artifacts,
    dependencies,
  };
}

export const npmAdapter: CodeAdapter = {
  id: 'npm',
  subject: 'code',
  detect: (files) => files.some((f) => {
    const p = normalizePath(f.path);
    return baseOf(p) === 'package.json' && !`/${p}/`.includes('/node_modules/');
  }),
  read,
};
