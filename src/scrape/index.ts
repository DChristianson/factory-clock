import { CodeGraph, PlanGraph, ProjectFile, isAbsolutePath, joinSessionToCode, normalizePath, touchesOf } from '../model';
import { NormalizedEvent } from '../schema';
import { isNormalizedEvent } from '../web/jsonl';
import { AdapterReport, WalkSkips, looksBinary, planWalk, readProject } from '../web/loader';
import { WorkspacePackage, makeWorkspacePackage } from '../web/workspaceStore';

/**
 * The scrape script's pure half (scripts/packageWorkspace.js; the design is in
 * docs/workspace-explorer.md, "The scrape script"): reads a project's tracked
 * files with the page's own walk rules and adapters, keeps the sessions that
 * worked in it, sanitizes all of it, and packages it as one workspace. The
 * script does the file system and git; everything that decides what's kept
 * is here, so the tests run it on made-up fixtures. No Node, no DOM.
 *
 * What is removed is counted by kind in a report; the removed values are
 * never kept, printed, or written anywhere.
 */

// What the script needs from the store, so one bundle serves it.
export { checkWorkspacePackage, readWorkspaceIndex, workspaceIndexScript, workspaceScript } from '../web/workspaceStore';

export const SCRAPE_TOOL = 'factory-clock packageWorkspace';

/** Counts of what was removed or changed, by kind. Values are never recorded. */
export type Counts = Record<string, number>;

const bump = (counts: Counts, kind: string, n = 1) => {
  if (n) counts[kind] = (counts[kind] ?? 0) + n;
};

// ---------- files that are never read ----------

/**
 * Names that look like secrets, read for no adapter whether tracked or not:
 * dotenv files, keys and certificates, credential and token files, and
 * package-manager and shell configs that commonly hold tokens.
 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.|rc$)/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|kdbx|ovpn)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)[^/]*(credential|secret|token|password|passwd)[^/]*$/i,
  /(^|\/)\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|pgpass|htpasswd|git-credentials|dockercfg)$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
];

/** Whether a relative path looks like it holds a secret. */
export function looksLikeSecretFile(path: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(path));
}

// ---------- the string scrubber ----------

/** A pattern that marks a secret, and what replaces it. Order matters: wider patterns first. */
const SECRET_PATTERNS: Array<{ kind: string; re: RegExp; to: string | ((...m: string[]) => string) }> = [
  { kind: 'private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, to: '[private key]' },
  { kind: 'URL credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"]+:[^\s/@'"]+@/gi, to: (_m, scheme) => `${scheme}[credentials]@` },
  { kind: 'bearer token', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, to: (_m, word) => `${word} [token]` },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: '[token]' },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, to: '[token]' },
  { kind: 'API key', re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, to: '[key]' },
  { kind: 'API key', re: /\b(?:AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})/g, to: '[key]' },
  { kind: 'AWS key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, to: '[key]' },
  {
    // KEY=value and key: value, where the key's name says it's a secret; .env lines are this shape.
    kind: 'secret assignment',
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*|password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(\s*[=:]\s*)(?!\\?["']?\[)("[^"\n]*"|'[^'\n]*'|[^\s'",;]+)/g,
    to: (_m, key, sep) => `${key}${sep}[redacted]`,
  },
  { kind: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, to: '[email]' },
];

/** Home folders, anyone's: `/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, and `/root`. */
const HOME_RE = /(?:(?<![\w.~:/@-])\/(?:Users|home)\/[^/\s'"`]+|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s'"`]+|(?<![\w.-])\/root(?=\/|\b))/g;
/** Any other absolute path: a slash-led run of two or more segments not inside a word or URL, or a drive path. */
const ABSOLUTE_RE = /(?<![\w.~:/@-])\/(?:[\w.@+-]+\/)+[\w.@+-]*|\b[A-Za-z]:\\(?:[^\\\s'"`]+\\)*[^\\\s'"`]*/g;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Scrubs strings: secrets and email addresses are replaced, the project's own
 * absolute paths become relative, home folders become `~`, and any other
 * absolute path becomes `[path]`. With `text` (free text: a prompt, a reply,
 * a command line), the user's names as words become `[user]` too; not in
 * paths and names, where a user name can be an ordinary word (`vscode`) or a
 * folder (`.vscode/`), and a home folder is caught by its shape anyway.
 * Every replacement is counted by kind.
 */
export class Scrubber {
  readonly counts: Counts = {};
  private readonly roots: string[];
  private readonly homes: string[];
  private readonly userRe: RegExp | null;

  constructor(options: { roots: string[]; homes?: string[]; users?: string[] }) {
    this.homes = (options.homes ?? []).map((h) => normalizePath(h)).filter((h) => isAbsolutePath(h) && h.length > 1).sort((a, b) => b.length - a.length);
    this.roots = [...new Set(options.roots.map((r) => normalizePath(r)).filter((r) => isAbsolutePath(r) && r.length > 1))].sort((a, b) => b.length - a.length);
    const users = [...new Set((options.users ?? []).filter((u) => u && u.length >= 3))];
    this.userRe = users.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${users.map(escape).join('|')})(?![A-Za-z0-9_])`, 'gi') : null;
  }

  /** The string with every secret, email, path, and user name replaced. */
  scrub(s: string, options: { text?: boolean } = {}): string {
    let out = s;
    for (const p of SECRET_PATTERNS) {
      out = out.replace(p.re, (...m) => {
        bump(this.counts, p.kind);
        return typeof p.to === 'string' ? p.to : p.to(...(m as string[]));
      });
    }
    out = this.paths(out);
    if (options.text && this.userRe) {
      out = out.replace(this.userRe, () => {
        bump(this.counts, 'user name');
        return '[user]';
      });
    }
    return out;
  }

  /** The project's paths made relative, then home folders, then any other absolute path. */
  private paths(s: string): string {
    let out = s;
    // Backslashed and forward-slashed spellings both, since Windows events can carry either.
    const spellings = (paths: string[]) => paths.flatMap((p) => [...new Set([p, p.replace(/\//g, '\\')])]);
    for (const spelled of spellings(this.roots)) {
      const re = new RegExp(`${escape(spelled)}(?:[\\\\/]([^\\s'"\`]*))?(?![^\\s\\\\/'"\`])`, 'g');
      out = out.replace(re, (_m, rest?: string) => {
        bump(this.counts, 'project path made relative');
        return rest ? rest.replace(/\\/g, '/') : '.';
      });
    }
    for (const spelled of spellings(this.homes)) {
      const re = new RegExp(`${escape(spelled)}(?![^\\s\\\\/'"\`])`, 'g');
      out = out.replace(re, () => {
        bump(this.counts, 'home folder');
        return '~';
      });
    }
    out = out.replace(HOME_RE, () => {
      bump(this.counts, 'home folder');
      return '~';
    });
    out = out.replace(ABSOLUTE_RE, () => {
      bump(this.counts, 'other absolute path');
      return '[path]';
    });
    return out;
  }

  /** Scrubs every string in a JSON-shaped value, keys left as they are; `text` as for scrub. */
  deep<T>(value: T, options: { text?: boolean } = {}): T {
    if (typeof value === 'string') return this.scrub(value, options) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.deep(v, options)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.deep(v, options);
      return out as T;
    }
    return value;
  }
}

// ---------- sessions ----------

/** Whether an absolute path is one of the roots or inside one. */
function under(path: string, roots: string[]): string | null {
  const p = normalizePath(path);
  const lower = (s: string) => (/^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s);
  for (const r of roots) if (lower(p) === lower(r) || lower(p).startsWith(lower(r) + '/')) return r;
  return null;
}

/** Makes a file target relative: to the event's workspace if it's in it, else to the project root; null when it's outside both. */
export function relativeTarget(target: string, workspace: string | undefined, roots: string[]): string | null {
  const t = normalizePath(target.trim().replace(/^file:\/\//, ''));
  if (!t || /[\n\r]/.test(t)) return null;
  if (!isAbsolutePath(t)) return t.startsWith('../') || t === '..' ? null : t;
  const bases = [...(workspace && isAbsolutePath(workspace) && under(workspace, roots) ? [normalizePath(workspace)] : []), ...roots].sort((a, b) => b.length - a.length);
  const base = under(t, bases);
  if (!base) return null;
  const rel = t.slice(base.length + 1);
  return rel || null;
}

const FILE_CATEGORIES = new Set(['file-read', 'file-edit']);

export interface SessionOptions {
  /** Absolute paths the project was opened at: its root, the root's real path, and any the person adds. */
  roots: string[];
  /** Keep sessions whose events say no workspace at all (a VS Code window's own event log, which holds only that window). */
  includeUnscoped?: boolean;
  keepText?: boolean;
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
const pick = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * One event, rebuilt from the fields the views draw and nothing else: ids,
 * time, kind, status, model, tokens, turn and agent, tool name and category,
 * compaction and outcome numbers, todo counts and task ops. Text (the prompt,
 * the reply, the session's name, a tool's input such as a command line or a
 * search pattern, todo items and task subjects) is kept only with keepText.
 * A file read's or edit's target is kept as a path relative to the project,
 * or dropped when it's outside. The event's workspace (an absolute folder)
 * and its raw source record are always dropped.
 */
function sanitizeEvent(e: NormalizedEvent, options: SessionOptions, counts: Counts): NormalizedEvent {
  const keep = options.keepText === true;
  const text = (kind: string, v: unknown) => {
    if (typeof v !== 'string' || !v) return undefined;
    if (keep) return v;
    bump(counts, kind);
    return undefined;
  };
  let target: string | undefined;
  if (typeof e.target === 'string' && e.target) {
    if (e.toolCategory && FILE_CATEGORIES.has(e.toolCategory)) {
      const rel = relativeTarget(e.target, e.workspace, options.roots);
      if (rel === null) bump(counts, 'file target outside the project');
      else {
        target = rel;
        if (isAbsolutePath(normalizePath(e.target))) bump(counts, 'file target made relative');
      }
    } else target = text('tool input (target)', e.target);
  }
  if (e.workspace !== undefined) bump(counts, 'workspace folder');
  if (e.raw && (e.raw as { event?: unknown }).event !== undefined) bump(counts, 'raw source record');
  const tokens = e.tokens && typeof e.tokens === 'object'
    ? pick({ input: num(e.tokens.input), output: num(e.tokens.output), cacheRead: num(e.tokens.cacheRead), cacheCreation: num(e.tokens.cacheCreation) })
    : undefined;
  const todos = e.todos && typeof e.todos === 'object'
    ? pick({
      pending: num(e.todos.pending) ?? 0,
      inProgress: num(e.todos.inProgress) ?? 0,
      completed: num(e.todos.completed) ?? 0,
      items: Array.isArray(e.todos.items) && e.todos.items.length
        ? keep ? e.todos.items : (bump(counts, 'todo item text', e.todos.items.length), undefined)
        : undefined,
    })
    : undefined;
  let taskOp: NormalizedEvent['taskOp'];
  if (e.taskOp && typeof e.taskOp === 'object') {
    const op = e.taskOp;
    taskOp = pick({
      op: op.op,
      id: str(op.id),
      status: op.status,
      subject: text('task subject', op.subject),
      tasks: Array.isArray(op.tasks)
        ? op.tasks.map((t) => pick({ id: String(t.id), status: t.status, subject: text('task subject', t.subject) }))
        : undefined,
    });
  }
  const c = e.compaction;
  const o = e.outcome;
  return pick({
    eventId: e.eventId,
    sessionId: e.sessionId,
    agent: e.agent,
    ts: e.ts,
    kind: e.kind,
    target,
    status: e.status ?? 'unknown',
    model: str(e.model),
    tokens: tokens && Object.keys(tokens).length ? tokens : undefined,
    textExcerpt: text('reply text', e.textExcerpt),
    promptText: text('prompt text', e.promptText),
    sessionName: text('session name', e.sessionName),
    turnId: str(e.turnId),
    agentId: str(e.agentId),
    toolName: str(e.toolName),
    toolCategory: e.toolCategory,
    channel: e.channel === 'inline' ? 'inline' : undefined,
    endsTurn: e.endsTurn === true ? true : undefined,
    contextLimit: num(e.contextLimit),
    todos,
    taskOp,
    compaction: c && typeof c === 'object' ? pick({ trigger: c.trigger ?? 'unknown', preTokens: num(c.preTokens), postTokens: num(c.postTokens) }) : undefined,
    outcome: o && typeof o === 'object'
      ? pick({
        type: o.type,
        refs: Array.isArray(o.refs) ? o.refs.filter((r) => typeof r === 'string') : undefined,
        failures: num(o.failures),
        afterMs: num(o.afterMs),
        heuristicId: str(o.heuristicId),
        response: o.response,
        commit: str(o.commit),
        files: num(o.files),
        linesWritten: num(o.linesWritten),
        linesSurviving: num(o.linesSurviving),
        days: num(o.days),
        decision: o.decision,
        advisor: str(o.advisor),
      })
      : undefined,
    raw: { adapter: str(e.raw?.adapter) ?? 'unknown', ref: '' },
  }) as NormalizedEvent;
}

/** The free-text fields of a sanitized event that are present, as getters and setters: what --keep-text keeps. */
export function textFields(e: NormalizedEvent): Array<{ get: () => string; set: (s: string) => void }> {
  const out: Array<{ get: () => string; set: (s: string) => void }> = [];
  const field = <O extends object, K extends keyof O>(o: O, k: K) => {
    if (typeof o[k] === 'string') out.push({ get: () => o[k] as string, set: (s) => ((o as Record<K, unknown>)[k] = s) });
  };
  field(e, 'textExcerpt');
  field(e, 'promptText');
  field(e, 'sessionName');
  if (!(e.toolCategory && FILE_CATEGORIES.has(e.toolCategory))) field(e, 'target');
  for (const item of e.todos?.items ?? []) field(item, 'text');
  if (e.taskOp) {
    field(e.taskOp, 'subject');
    for (const t of e.taskOp.tasks ?? []) field(t, 'subject');
  }
  return out;
}

export interface SessionsRead {
  events: NormalizedEvent[];
  sessions: number;
}

/**
 * Keeps the sessions that worked in the project and sanitizes their events.
 * A session is the project's when any of its events was recorded in a
 * workspace that is the project's root or inside it (a worktree under it, a
 * subfolder); then all its events are kept. A session whose events name no
 * workspace at all is kept only with includeUnscoped. Values that aren't
 * events and repeated event ids are dropped and counted.
 */
export function readSessions(values: unknown[], options: SessionOptions, counts: Counts): SessionsRead {
  const bySession = new Map<string, NormalizedEvent[]>();
  const seen = new Set<string>();
  for (const v of values) {
    if (!isNormalizedEvent(v)) {
      bump(counts, 'line that is not an event');
      continue;
    }
    if (seen.has(v.eventId)) {
      bump(counts, 'repeated event');
      continue;
    }
    seen.add(v.eventId);
    bySession.set(v.sessionId, [...(bySession.get(v.sessionId) ?? []), v]);
  }
  const events: NormalizedEvent[] = [];
  let sessions = 0;
  for (const list of bySession.values()) {
    const places = list.map((e) => e.workspace).filter((w): w is string => typeof w === 'string' && w.length > 0);
    const ours = places.some((w) => isAbsolutePath(w) && under(w, options.roots) !== null);
    if (!ours && !(places.length === 0 && options.includeUnscoped)) {
      bump(counts, places.length ? 'session in another workspace' : 'session with no workspace', 1);
      bump(counts, 'event of a session left out', list.length);
      continue;
    }
    sessions += 1;
    for (const e of list) events.push(sanitizeEvent(e, options, counts));
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts) || a.eventId.localeCompare(b.eventId));
  return { events, sessions };
}

// ---------- code and plans ----------

export interface TrackedFile {
  /** Relative to the project root, forward slashes. */
  path: string;
  bytes: number;
  /** Ignored by the project's own .gitignore although tracked (added by force). */
  ignored?: boolean;
}

export interface FilesOptions {
  name: string;
  /** Path prefixes left out, such as test fixtures whose made-up packages and plans aren't the project's. */
  exclude?: string[];
  keepText?: boolean;
  now: string;
}

export interface FilesRead {
  code: CodeGraph[];
  plans: PlanGraph[];
  /** Files handed to the adapters. */
  read: number;
  reports: AdapterReport[];
  skipped: WalkSkips;
}

/**
 * Reads the project's tracked files as the page reads a folder: the walk's
 * rules (skipped folders, binary, size limits), then every adapter. Files the
 * project's .gitignore ignores, files that look like secrets, and excluded
 * prefixes are never read. The adapters always run with keepText on, so the
 * report can count the plan descriptions; they're removed here unless
 * keepText was asked for. Plan assignees, which can name a person, go too.
 */
export function readFiles<T extends TrackedFile>(files: T[], read: (file: T) => string, options: FilesOptions, counts: Counts): FilesRead {
  const exclude = (options.exclude ?? []).map((p) => normalizePath(p)).filter(Boolean);
  const kept: T[] = [];
  for (const f of files) {
    const p = normalizePath(f.path);
    if (isAbsolutePath(p) || p.startsWith('../')) bump(counts, 'file outside the project');
    else if (f.ignored) bump(counts, 'file the .gitignore ignores');
    else if (looksLikeSecretFile(p)) bump(counts, 'file that looks like a secret');
    else if (exclude.some((x) => p === x || p.startsWith(x + '/'))) bump(counts, 'file excluded');
    else kept.push(f);
  }
  const plan = planWalk(kept.map((f) => ({ path: `${options.name}/${normalizePath(f.path)}`, bytes: f.bytes, file: f })));
  const projectFiles: ProjectFile[] = [];
  for (const { entry, path } of plan.keep) {
    const text = read(entry.file);
    if (looksBinary(text)) plan.skipped.binary += 1;
    else projectFiles.push({ path, text, bytes: entry.bytes });
  }
  const result = readProject(projectFiles, { name: options.name, hints: ['globals'], now: options.now, keepText: true });
  const plans = result.plans.map((g) => ({
    ...g,
    items: g.items.map((item) => {
      const out = { ...item };
      if (!options.keepText && out.text !== undefined) {
        delete out.text;
        bump(counts, 'plan item text');
      }
      if (!options.keepText && out.assignee !== undefined) {
        delete out.assignee;
        bump(counts, 'plan assignee');
      }
      return out;
    }),
  }));
  return { code: result.code, plans, read: projectFiles.length, reports: result.reports, skipped: plan.skipped };
}

// ---------- the package ----------

export interface ScrapeInput<T extends TrackedFile> {
  name: string;
  files: T[];
  read: (file: T) => string;
  /** Parsed event lines from the event files, as they came. */
  events: unknown[];
  /** Lines of the event files that didn't parse as JSON. */
  unparsedLines?: number;
  roots: string[];
  /** Home folders, as `~`; anyone's `/Users/<name>` and `/home/<name>` are caught by shape as well. */
  homes?: string[];
  /** The user's names, as `[user]` in kept free text. */
  users?: string[];
  exclude?: string[];
  includeUnscoped?: boolean;
  keepText?: boolean;
  now: string;
}

export interface ScrapeResult {
  package: WorkspacePackage;
  /** What was removed or changed, by kind. */
  removed: Counts;
  /** What was read and kept. */
  kept: {
    filesRead: number;
    artifacts: number;
    codeFiles: number;
    planItems: number;
    sessions: number;
    events: number;
    fileTargets: number;
  };
  reports: AdapterReport[];
  skipped: WalkSkips;
}

/**
 * Scrapes, sanitizes, and packages a project. The final scrub runs over every
 * string in the package, so a secret, email, or path that came through an
 * adapter (a plan title, a package name) is caught as well as one in the
 * events.
 */
export function scrapeProject<T extends TrackedFile>(input: ScrapeInput<T>): ScrapeResult {
  const removed: Counts = {};
  const keepText = input.keepText === true;
  bump(removed, 'event line that is not JSON', input.unparsedLines ?? 0);
  const files = readFiles(input.files, input.read, { name: input.name, exclude: input.exclude, keepText, now: input.now }, removed);
  const sessions = readSessions(input.events, { roots: input.roots, includeUnscoped: input.includeUnscoped, keepText }, removed);
  const scrubber = new Scrubber({ roots: input.roots, homes: input.homes, users: input.users });
  const events = sessions.events.map((e) => {
    const out = scrubber.deep(e);
    if (keepText) for (const at of textFields(out)) at.set(scrubber.scrub(at.get(), { text: true }));
    return out;
  });
  const code = scrubber.deep(files.code);
  const plans = scrubber.deep(files.plans);
  for (const [k, n] of Object.entries(scrubber.counts)) bump(removed, k, n);

  const what = [
    `${files.read} tracked files`,
    `${sessions.sessions} session${sessions.sessions === 1 ? '' : 's'}`,
    `${plans.reduce((n, p) => n + p.items.length, 0)} plan items`,
  ].join(', ');
  const pkg = makeWorkspacePackage({
    name: input.name,
    source: {
      tool: SCRAPE_TOOL,
      generatedAt: input.now,
      note: keepText
        ? `Scraped from ${what}. Secrets, email addresses, and paths were removed; prompt, reply, and plan text was kept on purpose.`
        : `Scraped from ${what}. Prompt, reply, tool input, and plan text, secrets, email addresses, and paths were removed.`,
    },
    events,
    code,
    plans,
  });
  const artifacts = code.reduce((n, g) => n + g.artifacts.length, 0);
  const codeFiles = code.reduce((n, g) => n + g.artifacts.filter((a) => a.kind === 'file').length, 0);
  return {
    package: pkg,
    removed,
    kept: {
      filesRead: files.read,
      artifacts,
      codeFiles,
      planItems: plans.reduce((n, p) => n + p.items.length, 0),
      sessions: sessions.sessions,
      events: events.length,
      fileTargets: events.filter((e) => e.target && e.toolCategory && FILE_CATEGORIES.has(e.toolCategory)).length,
    },
    reports: files.reports,
    skipped: files.skipped,
  };
}

/**
 * The last check before anything is written: the serialized output must not
 * hold any of the forbidden strings (the project's absolute paths, the home
 * folder) anywhere, nor a home folder of anyone's by its shape, nor anything
 * the secret patterns or the email pattern still match; and the events' kept
 * free text must not hold a user name as a word. Returns what kind of thing
 * was found, never the thing.
 */
export function findLeaks(serialized: string, options: { forbidden: string[]; users?: string[]; events?: NormalizedEvent[] }): string[] {
  const found: string[] = [];
  for (const f of options.forbidden.map((s) => normalizePath(s)).filter((s) => s && s.length > 1)) {
    for (const spelled of new Set([f, f.replace(/\//g, '\\'), JSON.stringify(f.replace(/\//g, '\\')).slice(1, -1)])) {
      if (serialized.includes(spelled)) found.push('an absolute project or home path');
    }
  }
  const users = (options.users ?? []).filter((x) => x && x.length >= 3);
  if (users.length) {
    const re = new RegExp(`(?<![A-Za-z0-9_])(?:${users.map(escape).join('|')})(?![A-Za-z0-9_])`, 'i');
    for (const e of options.events ?? []) if (textFields(e).some((f) => re.test(f.get()))) found.push('a user name in kept text');
  }
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    if (new RegExp(p.re.source, p.re.flags.replace('g', '')).test(serialized)) found.push(`something shaped like: ${p.kind}`);
  }
  if (/(?<![\w.~:/@-])\/(?:Users|home)\/[^/\s'"`\\]+/.test(serialized)) found.push('a home folder path');
  return [...new Set(found)];
}

/** How many session-to-code links the page will draw from a package: the join it builds at load. */
export function countSessionJoins(pkg: WorkspacePackage): number {
  return joinSessionToCode(touchesOf(pkg.events), pkg.code).length;
}

/** A file name for a workspace's script: the name with anything but letters, digits, dot, dash, and underscore made a dash. */
export function fileStem(name: string): string {
  const stem = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return !stem || stem === 'index' ? `workspace-${stem || 'unnamed'}` : stem;
}

/** The report: counts only. */
export function formatReport(result: ScrapeResult, options: { name: string; keepText: boolean; eventsGiven: boolean; joins?: number }): string {
  const lines: string[] = [];
  const pkg = result.package;
  lines.push(`Sanitization report for workspace "${options.name}"`);
  lines.push(`Range: ${pkg.range ? `${pkg.range.first} .. ${pkg.range.last}` : 'none'}`);
  lines.push('');
  if (options.keepText) lines.push('WARNING: --keep-text was given. Prompt, reply, tool input, and plan text are in the package (scrubbed of secrets, emails, and paths). Read it before sharing.', '');
  if (!options.eventsGiven) lines.push('No event files were given (--events), so the package has no sessions.', '');
  const k = result.kept;
  lines.push('Kept:');
  lines.push(`  files read by the adapters: ${k.filesRead}`);
  lines.push(`  code graphs: ${pkg.code.length}, artifacts: ${k.artifacts}, of them files: ${k.codeFiles}`);
  lines.push(`  plan graphs: ${pkg.plans.length}, plan items: ${k.planItems}`);
  lines.push(`  sessions: ${k.sessions}, events: ${k.events}, file targets: ${k.fileTargets}`);
  if (options.joins !== undefined) lines.push(`  session-to-code joins: ${options.joins}`);
  for (const r of result.reports) if (r.ran) lines.push(`  adapter ${r.id}: ${r.summary}${r.errors.length ? ` (${r.errors.length} error${r.errors.length === 1 ? '' : 's'})` : ''}`);
  lines.push('');
  lines.push('Removed or changed (counts only; the values themselves are not recorded):');
  const s = result.skipped;
  const all: Counts = { ...result.removed };
  bump(all, 'file in a skipped folder', s.folders);
  bump(all, 'binary file', s.binary);
  bump(all, 'file over the size limit', s.large.length);
  bump(all, 'file over the file limit', s.overLimit);
  const kinds = Object.keys(all).sort();
  if (!kinds.length) lines.push('  nothing');
  for (const kind of kinds) lines.push(`  ${kind}: ${all[kind]}`);
  return lines.join('\n') + '\n';
}
