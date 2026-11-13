import { CODE_ADAPTERS, PLAN_ADAPTERS, beadsAdapter } from '../adapters';
import {
  AdapterOptions,
  Checked,
  CodeAdapter,
  CodeGraph,
  PlanAdapter,
  PlanGraph,
  ProjectFile,
  Workspace,
  buildWorkspace,
  checkCodeGraph,
  checkPlanGraph,
  normalizePath,
} from '../model';
import { NormalizedEvent } from '../schema';
import { EventSet } from './eventSet';
import { parseJsonl } from './jsonl';

/**
 * The loader's model (docs/workspace-explorer.md, "What the page does with a
 * file"): which files of a chosen folder are read, how single files are
 * sorted by content, how the adapters run over a folder, and the workspace
 * the page holds. DOM-free, so Node tests run it; src/web/page.ts does the
 * reading of File objects and the drawing. Nothing here touches the network:
 * every byte came from a file the visitor chose.
 */

/** The named limits on a folder walk. Tuned on the first target project. */
export const LOADER_LIMITS = { fileBytes: 2 * 1024 * 1024, files: 20_000 } as const;

/** Folders never read: version control, installed packages, and build output. */
export const SKIPPED_DIRS = [
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'dist', 'build', 'out', 'site', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', 'target', '__pycache__', '.venv', 'venv', '.tox', '.idea', '.vscode-test',
] as const;

/** Extensions whose files are binary, skipped without being read. */
export const BINARY_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'psd', 'pdf',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war', 'class',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'm4a', 'mov', 'avi', 'wav', 'ogg', 'webm', 'flac',
  'wasm', 'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'obj', 'pyc', 'sqlite', 'db', 'vsix', 'node',
] as const;

const SKIPPED_DIR_SET = new Set<string>(SKIPPED_DIRS);
const BINARY_SET = new Set<string>(BINARY_EXTENSIONS);

/** A file offered by the walk: its path relative to the drop, top folder included, and its size. */
export interface WalkEntry {
  path: string;
  bytes: number;
}

/** Why files weren't read, counted, so the loader can say so. */
export interface WalkSkips {
  folders: number;
  binary: number;
  large: string[];
  overLimit: number;
}

export interface WalkPlan<T extends WalkEntry> {
  /** The chosen folder's name: the project's name unless the visitor changes it. */
  name: string;
  /** What to read, with paths relative to the chosen folder. */
  keep: Array<{ entry: T; path: string }>;
  skipped: WalkSkips;
}

const extOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** Whether a folder is never read, by its name: lets a walk prune before listing. */
export function isSkippedDir(name: string): boolean {
  return SKIPPED_DIR_SET.has(name);
}

/**
 * Whether a path inside the folder is skipped for its folder. Beads keeps its
 * database beside its export, so under `.beads/` only the JSONL is read.
 */
function inSkippedFolder(path: string): boolean {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((p) => SKIPPED_DIR_SET.has(p))) return true;
  return parts[0] === '.beads' && !/\.jsonl$/i.test(path);
}

/**
 * Decides which files of a chosen folder are read. Every entry's path starts
 * with the folder's own name (as `webkitRelativePath` does); that first
 * segment becomes the project name and is cut from the paths the adapters see.
 * Files are taken in path order, so the limit cuts the same files every time.
 */
export function planWalk<T extends WalkEntry>(entries: T[], limits: { fileBytes: number; files: number } = LOADER_LIMITS): WalkPlan<T> {
  const skipped: WalkSkips = { folders: 0, binary: 0, large: [], overLimit: 0 };
  const rel = entries
    .map((entry) => ({ entry, full: normalizePath(entry.path) }))
    .sort((a, b) => a.full.localeCompare(b.full));
  const tops = new Set(rel.map((r) => r.full.split('/')[0]));
  const oneFolder = tops.size === 1 && rel.every((r) => r.full.includes('/'));
  const name = oneFolder ? [...tops][0] : 'project';
  const keep: WalkPlan<T>['keep'] = [];
  for (const { entry, full } of rel) {
    const path = oneFolder ? full.slice(full.indexOf('/') + 1) : full;
    if (inSkippedFolder(path)) skipped.folders += 1;
    else if (BINARY_SET.has(extOf(path))) skipped.binary += 1;
    else if (entry.bytes > limits.fileBytes) skipped.large.push(path);
    else if (keep.length >= limits.files) skipped.overLimit += 1;
    else keep.push({ entry, path });
  }
  return { name, keep, skipped };
}

/** Text that isn't text: a NUL in its first few kilobytes. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes('\u0000');
}

/** What a single dropped file is, by its content. */
export type FileKind = 'events' | 'code' | 'plans' | 'beads' | 'unknown';

function firstJson(text: string): unknown {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Sorts one file: a `.json` whose top says `kind: 'code-graph'` or
 * `'plan-graph'` is that subject; a JSONL whose first line is an issue is a
 * beads export; one whose first line has `kind` and `ts` is events. Anything
 * else is unknown, and the page names it and refuses it.
 */
export function sortFile(name: string, text: string): FileKind {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') && !/\.jsonl$/i.test(name)) {
    try {
      const whole: unknown = JSON.parse(text);
      if (isObject(whole) && whole.kind === 'code-graph') return 'code';
      if (isObject(whole) && whole.kind === 'plan-graph') return 'plans';
    } catch {
      // Not one JSON document; it may still be JSONL.
    }
  }
  if (beadsAdapter.detect([{ path: name, text, bytes: text.length }])) return 'beads';
  const first = firstJson(text);
  if (isObject(first) && typeof first.kind === 'string' && typeof first.ts === 'string') return 'events';
  return 'unknown';
}

/** What one adapter made of a folder, for the loader's found-list. */
export interface AdapterReport {
  id: string;
  subject: 'code' | 'plans';
  detected: boolean;
  /** Detected and not switched off. */
  ran: boolean;
  /** "1 package, 61 files" or "24 items"; empty when it didn't run. */
  summary: string;
  /** The adapter threw, or the validator dropped rows. */
  errors: string[];
}

export interface ProjectRead {
  name: string;
  code: CodeGraph[];
  plans: PlanGraph[];
  reports: AdapterReport[];
}

export interface ReadOptions {
  name: string;
  /** Adapter ids switched off in the loader. */
  off?: string[];
  keepText?: boolean;
  hints?: string[];
  now?: string;
  /** The adapters to try; the page's lists by default. */
  adapters?: { code: CodeAdapter[]; plans: PlanAdapter[] };
}

const count = (n: number, noun: string, plural = `${noun}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? noun : plural}`;

/** A code graph in a few words: its packages and files. */
export function summarizeCode(graph: CodeGraph): string {
  const of = (kind: string) => graph.artifacts.filter((a) => a.kind === kind).length;
  const parts = [count(of('package'), 'package'), count(of('file'), 'file')];
  const externals = of('external');
  if (externals) parts.push(count(externals, 'external'));
  return parts.join(', ');
}

/** A plan in a few words: its items and links. */
export function summarizePlan(graph: PlanGraph): string {
  return `${count(graph.items.length, 'item')}, ${count(graph.links.length, 'link')}`;
}

/**
 * Runs every adapter that detects its kind in the files, minus the ones
 * switched off, and validates what each returns the way a dropped schema file
 * is validated. An adapter that throws is reported, not fatal: the others'
 * results stand.
 */
export function readProject(files: ProjectFile[], options: ReadOptions): ProjectRead {
  const adapters = options.adapters ?? { code: CODE_ADAPTERS, plans: PLAN_ADAPTERS };
  const off = new Set(options.off ?? []);
  const adapterOptions: AdapterOptions = { name: options.name, keepText: options.keepText, hints: options.hints, now: options.now };
  const out: ProjectRead = { name: options.name, code: [], plans: [], reports: [] };
  const run = <T>(adapter: CodeAdapter | PlanAdapter, check: (x: unknown) => Checked<T>, summarize: (t: T) => string): T | undefined => {
    const report: AdapterReport = { id: adapter.id, subject: adapter.subject, detected: false, ran: false, summary: '', errors: [] };
    out.reports.push(report);
    try {
      report.detected = adapter.detect(files);
    } catch (err) {
      report.errors.push(`detect failed: ${String(err)}`);
    }
    if (!report.detected || off.has(adapter.id)) return undefined;
    report.ran = true;
    try {
      const checked = check(adapter.read(files, adapterOptions));
      report.errors.push(...checked.errors);
      if (checked.value) report.summary = summarize(checked.value);
      return checked.value;
    } catch (err) {
      report.errors.push(`read failed: ${String(err)}`);
      return undefined;
    }
  };
  for (const adapter of adapters.code) {
    const graph = run(adapter, checkCodeGraph, summarizeCode);
    if (graph) out.code.push(graph);
  }
  for (const adapter of adapters.plans) {
    const graph = run(adapter, checkPlanGraph, summarizePlan);
    if (graph) out.plans.push(graph);
  }
  return out;
}

/** Several loaded graphs whose roots clash get distinct roots, so qualified ids stay unique. */
export function distinctRoots<T extends CodeGraph | PlanGraph>(graphs: T[]): T[] {
  const seen = new Map<string, number>();
  return graphs.map((g) => {
    const n = (seen.get(g.source.root) ?? 0) + 1;
    seen.set(g.source.root, n);
    return n === 1 ? g : { ...g, source: { ...g.source, root: `${g.source.root} (${n})` } };
  });
}

/** What a set of single files held, sorted by content. */
export interface SortedFiles {
  events: NormalizedEvent[];
  code: CodeGraph[];
  plans: PlanGraph[];
  /** Files read but not usable, with why. */
  refused: Array<{ name: string; reason: string }>;
  /** Event lines skipped or duplicated, for the note. */
  skippedLines: number;
  duplicates: number;
}

/**
 * Reads single files the visitor dropped or chose: events are parsed, schema
 * files validated, a beads export run through the beads adapter, and the rest
 * named and refused.
 */
export function readSingleFiles(files: Array<{ name: string; text: string }>, options: { now?: string; keepText?: boolean } = {}): SortedFiles {
  const out: SortedFiles = { events: [], code: [], plans: [], refused: [], skippedLines: 0, duplicates: 0 };
  const seen = new Set<string>();
  for (const file of files) {
    const kind = sortFile(file.name, file.text);
    if (kind === 'events') {
      const parsed = parseJsonl(file.text, seen);
      out.events.push(...parsed.events);
      out.skippedLines += parsed.skipped;
      out.duplicates += parsed.duplicates;
      if (!parsed.events.length && !parsed.duplicates) out.refused.push({ name: file.name, reason: 'no events in it' });
    } else if (kind === 'code' || kind === 'plans') {
      const checked = kind === 'code' ? checkCodeGraph(JSON.parse(file.text)) : checkPlanGraph(JSON.parse(file.text));
      if (!checked.value) out.refused.push({ name: file.name, reason: checked.errors[0] ?? 'not a valid graph' });
      else if (kind === 'code') out.code.push(checked.value as CodeGraph);
      else out.plans.push(checked.value as PlanGraph);
    } else if (kind === 'beads') {
      const stem = file.name.replace(/\.jsonl$/i, '') || 'beads';
      const read = readProject([{ path: file.name, text: file.text, bytes: file.text.length }], {
        name: stem,
        now: options.now,
        keepText: options.keepText,
        adapters: { code: [], plans: [beadsAdapter] },
      });
      if (read.plans.length) out.plans.push(...read.plans);
      else out.refused.push({ name: file.name, reason: read.reports[0]?.errors[0] ?? 'no issues in it' });
    } else {
      out.refused.push({ name: file.name, reason: 'not events, a code or plan graph, or a beads export' });
    }
  }
  out.code = distinctRoots(out.code);
  out.plans = distinctRoots(out.plans);
  return out;
}

/** The subjects the explorer can draw. */
export const SUBJECTS = ['sessions', 'code', 'plans'] as const;
export type Subject = (typeof SUBJECTS)[number];

/** One pickable unit: a session, a code root, or a plan root. */
export interface UnitSummary {
  subject: Subject;
  id: string;
  label: string;
  detail: string;
}

/** The picks across subjects; a subject left out takes its default. */
export type Picks = Partial<Record<Subject, string[]>>;

/**
 * The page's data across subjects: the sessions (an EventSet, as before) and
 * the loaded code and plan graphs. Each subject is replaced on its own, so a
 * folder loaded after event files keeps the sessions, and the other way round.
 */
export class WorkspaceSet {
  readonly code: CodeGraph[];
  readonly plans: PlanGraph[];

  constructor(readonly sessions: EventSet, code: CodeGraph[] = [], plans: PlanGraph[] = []) {
    this.code = distinctRoots(code);
    this.plans = distinctRoots(plans);
  }

  withSessions(sessions: EventSet): WorkspaceSet {
    return new WorkspaceSet(sessions, this.code, this.plans);
  }

  withProject(code: CodeGraph[], plans: PlanGraph[]): WorkspaceSet {
    return new WorkspaceSet(this.sessions, code, plans);
  }

  listUnits(subject: Subject): UnitSummary[] {
    if (subject === 'sessions') {
      return this.sessions.listAll().sessions.map((s) => ({ subject, id: s.sessionId, label: s.name ?? s.sessionId, detail: s.firstTs.slice(0, 10) }));
    }
    if (subject === 'code') return this.code.map((g) => ({ subject, id: g.source.root, label: g.source.root, detail: `${g.source.adapter}: ${summarizeCode(g)}` }));
    return this.plans.map((g) => ({ subject, id: g.source.root, label: g.source.root, detail: `${g.source.adapter}: ${summarizePlan(g)}` }));
  }

  /** The ids of a pick that this set has; every code and plan root when none is picked. */
  keep(subject: Subject, ids: readonly string[] | undefined): string[] {
    const have = new Set(this.listUnits(subject).map((u) => u.id));
    const kept = (ids ?? []).filter((id) => have.has(id));
    if (kept.length || subject === 'sessions') return kept;
    return [...have];
  }

  /** The Workspace for a set of picks, joins built at load. */
  workspace(picks: Picks): Workspace {
    const sessionIds = this.keep('sessions', picks.sessions);
    const codeIds = new Set(this.keep('code', picks.code));
    const planIds = new Set(this.keep('plans', picks.plans));
    const views = sessionIds.map((id) => this.sessions.view(id)).filter((v): v is NonNullable<typeof v> => !!v);
    return buildWorkspace({
      sessions: views,
      events: this.sessions.events,
      code: this.code.filter((g) => codeIds.has(g.source.root)),
      plans: this.plans.filter((g) => planIds.has(g.source.root)),
    });
  }
}
