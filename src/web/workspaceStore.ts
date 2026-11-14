import { NormalizedEvent } from '../schema';
import { Checked, CodeGraph, PlanGraph, checkCodeGraph, checkPlanGraph, isAbsolutePath } from '../model';
import { isNormalizedEvent } from './jsonl';
import { SYNTHETIC_DAY, syntheticEvents } from './synthetic';
import { syntheticCodeGraph, syntheticPlanGraph } from './syntheticWorkspace';

/**
 * Workspaces and the store that holds them (docs/workspace-explorer.md,
 * "Workspace packages and the store"). A workspace is one project's sessions,
 * code, and plans packaged together. It has a name and a time range, the first
 * and last of its events, and that pair is its identity: the same project
 * packaged twice over different spans is two workspaces under one name. The
 * built-in workspaces and any the visitor loads go through the same store.
 * Pure: no DOM, no Node, so the page, the tests, and a Node script that
 * writes packages all run this module.
 */

/** First and last event, as ISO timestamps (UTC, milliseconds), so equal instants compare equal. */
export interface TimeRange {
  first: string;
  last: string;
}

/** Where a package came from. Names and words only: no absolute paths. */
export interface WorkspaceSource {
  /** What made the package: `factory-clock synthetic`, the scrape script's name. */
  tool: string;
  generatedAt: string;
  /** A sentence for the person picking it: what's in it, what was removed. */
  note?: string;
}

/** The package format, version 1: what a `.workspace.json` holds and what a site package script registers. */
export interface WorkspacePackage {
  kind: 'workspace-package';
  version: 1;
  name: string;
  /** The range computed from the contents (see timeRangeOf); null when nothing in it has a time. */
  range: TimeRange | null;
  source: WorkspaceSource;
  events: NormalizedEvent[];
  code: CodeGraph[];
  plans: PlanGraph[];
}

/** The longest name a package may have; a name is for a list, not a description. */
export const WORKSPACE_NAME_MAX = 120;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** An ISO timestamp for a parseable time, or null. */
function instant(ts: unknown): number | null {
  if (typeof ts !== 'string' || !ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The time range of a workspace's contents. Its events are the sessions'
 * events and the plan items' created, updated, and closed times: all of them
 * are things that happened in the project. When none of those has a time, the
 * code and plan graphs' `generatedAt` stand in, so a workspace of code alone
 * still has a place in the list; with none of those either, the range is null.
 * A timestamp that doesn't parse is skipped and counted, never guessed.
 */
export function timeRangeOf(parts: { events?: readonly NormalizedEvent[]; code?: readonly CodeGraph[]; plans?: readonly PlanGraph[] }): { range: TimeRange | null; unparsed: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let unparsed = 0;
  const see = (ts: unknown) => {
    const ms = instant(ts);
    if (ms === null) {
      unparsed += 1;
      return;
    }
    if (ms < lo) lo = ms;
    if (ms > hi) hi = ms;
  };
  for (const e of parts.events ?? []) see(e.ts);
  for (const p of parts.plans ?? []) {
    for (const item of p.items) for (const ts of [item.created, item.updated, item.closed]) if (ts !== undefined) see(ts);
  }
  if (lo === Infinity) for (const g of [...(parts.code ?? []), ...(parts.plans ?? [])]) see(g.source.generatedAt);
  const range = lo === Infinity ? null : { first: new Date(lo).toISOString(), last: new Date(hi).toISOString() };
  return { range, unparsed };
}

/** Packages contents as a workspace, its range computed from them. */
export function makeWorkspacePackage(parts: { name: string; source: WorkspaceSource; events?: NormalizedEvent[]; code?: CodeGraph[]; plans?: PlanGraph[] }): WorkspacePackage {
  const events = parts.events ?? [];
  const code = parts.code ?? [];
  const plans = parts.plans ?? [];
  return { kind: 'workspace-package', version: 1, name: parts.name, range: timeRangeOf({ events, code, plans }).range, source: parts.source, events, code, plans };
}

const sameRange = (a: TimeRange | null, b: TimeRange | null) => (a === null || b === null ? a === b : a.first === b.first && a.last === b.last);

function checkName(x: unknown): string | null {
  if (typeof x !== 'string' || !x.trim()) return 'name is missing';
  if (x !== x.trim()) return 'name has leading or trailing spaces';
  if (x.length > WORKSPACE_NAME_MAX) return `name is longer than ${WORKSPACE_NAME_MAX} characters`;
  if (isAbsolutePath(x)) return 'name is an absolute path; it must be a name';
  if (/[\n\r]/.test(x)) return 'name has a line break';
  return null;
}

/**
 * Checks an object read from a package. A wrong kind or version, a bad name or
 * source, or contents that aren't lists make it unusable. Otherwise broken
 * rows are reported and dropped, as the graph checks do: an event that isn't
 * one, or whose time doesn't parse, or that repeats an event id; a code or
 * plan graph that doesn't check (its own row errors are passed on, prefixed).
 * The range is always recomputed from what's kept; a stated range that
 * disagrees is reported, and the computed one is used.
 */
export function checkWorkspacePackage(x: unknown): Checked<WorkspacePackage> {
  const errors: string[] = [];
  if (!isObject(x) || x.kind !== 'workspace-package') return { errors: ['not a workspace package (kind is not "workspace-package")'] };
  if (x.version !== 1) return { errors: [`workspace package version ${String(x.version)} is not supported`] };
  const nameError = checkName(x.name);
  if (nameError) return { errors: [`workspace package: ${nameError}`] };
  const name = x.name as string;
  const at = `workspace ${name}`;
  const src = x.source;
  if (!isObject(src)) return { errors: [`${at}: source is missing`] };
  if (typeof src.tool !== 'string' || !src.tool) errors.push(`${at}: source.tool is missing`);
  if (instant(src.generatedAt) === null) errors.push(`${at}: source.generatedAt is not a timestamp`);
  if (src.note !== undefined && typeof src.note !== 'string') errors.push(`${at}: source.note is not a string`);
  if (errors.length) return { errors };
  for (const key of ['events', 'code', 'plans'] as const) if (!Array.isArray(x[key])) errors.push(`${at}: ${key} is not a list`);
  if (errors.length) return { errors };

  const events: NormalizedEvent[] = [];
  const seen = new Set<string>();
  let badEvents = 0;
  let badTimes = 0;
  let repeats = 0;
  for (const e of x.events as unknown[]) {
    if (!isNormalizedEvent(e)) badEvents += 1;
    else if (instant(e.ts) === null) badTimes += 1;
    else if (seen.has(e.eventId)) repeats += 1;
    else {
      seen.add(e.eventId);
      events.push(e);
    }
  }
  if (badEvents) errors.push(`${at}: ${badEvents} event(s) dropped: not an event`);
  if (badTimes) errors.push(`${at}: ${badTimes} event(s) dropped: the time doesn't parse`);
  if (repeats) errors.push(`${at}: ${repeats} event(s) dropped: event id seen before`);

  const graphs = <T>(list: unknown[], what: string, check: (g: unknown) => Checked<T>): T[] => {
    const out: T[] = [];
    list.forEach((g, i) => {
      const c = check(g);
      for (const e of c.errors) errors.push(`${at}: ${what} ${i}: ${e}`);
      if (c.value) out.push(c.value);
    });
    return out;
  };
  const code = graphs(x.code as unknown[], 'code graph', checkCodeGraph);
  const plans = graphs(x.plans as unknown[], 'plan graph', checkPlanGraph);

  const { range } = timeRangeOf({ events, code, plans });
  const stated = x.range;
  const statedRange = stated === null ? null : isObject(stated) && instant(stated.first) !== null && instant(stated.last) !== null
    ? { first: new Date(instant(stated.first)!).toISOString(), last: new Date(instant(stated.last)!).toISOString() }
    : undefined;
  if (statedRange === undefined) errors.push(`${at}: range is missing or malformed; computed from the contents`);
  else if (!sameRange(statedRange, range)) errors.push(`${at}: the stated range doesn't match the contents; computed from the contents`);

  const source: WorkspaceSource = { tool: src.tool as string, generatedAt: src.generatedAt as string, ...(typeof src.note === 'string' ? { note: src.note } : {}) };
  return { value: { kind: 'workspace-package', version: 1, name, range, source, events, code, plans }, errors };
}

/**
 * The string that names a workspace's identity, for the picker and saved
 * state: `name @ first..last`, or `name @ -` without a range. The name comes
 * first so ids sort with their group; timestamps hold no ` @ `, so the last
 * one splits it.
 */
export function workspaceId(name: string, range: TimeRange | null): string {
  return `${name} @ ${range ? `${range.first}..${range.last}` : '-'}`;
}

/** Where a workspace came from: built into the site, or loaded by the visitor from their files. */
export type WorkspaceOrigin = 'built-in' | 'loaded';

/** A workspace in the store: its identity and, once it's in hand, its package. */
export interface WorkspaceEntry {
  id: string;
  name: string;
  range: TimeRange | null;
  origin: WorkspaceOrigin;
  /** Absent for a listed site package that hasn't been loaded yet; `file` says where it is. */
  package?: WorkspacePackage;
  /** A site package's script, relative to the page. */
  file?: string;
}

/** One name's workspaces, newest first. */
export interface WorkspaceGroup {
  name: string;
  entries: WorkspaceEntry[];
}

/** Newest first: by first event, then last event, descending; no range goes last. */
function byNewest(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (!a.range || !b.range) return a.range ? -1 : b.range ? 1 : 0;
  return b.range.first.localeCompare(a.range.first) || b.range.last.localeCompare(a.range.last);
}

/**
 * The page's workspaces in memory, keyed by identity. Adding one whose
 * identity is already held replaces it in place and says so: loading the same
 * files again should give what's in them now, and two packages with the same
 * name and the same first and last event are the same workspace as far as
 * the list can tell, so keeping both would show two rows nobody can tell
 * apart. A visitor's package can replace a built-in one this way; it's
 * marked loaded from then on.
 */
export class WorkspaceStore {
  private readonly entries = new Map<string, WorkspaceEntry>();

  /** Adds a package in hand, built-in or loaded. */
  add(pkg: WorkspacePackage, origin: WorkspaceOrigin): { entry: WorkspaceEntry; replaced: boolean } {
    const id = workspaceId(pkg.name, pkg.range);
    const replaced = this.entries.has(id);
    const entry: WorkspaceEntry = { id, name: pkg.name, range: pkg.range, origin, package: pkg };
    this.entries.set(id, entry);
    return { entry, replaced };
  }

  /** Lists a site package by its index entry, to be loaded when picked (see readWorkspaceIndex). */
  addListed(listed: WorkspaceIndexEntry): { entry: WorkspaceEntry; replaced: boolean } {
    const id = workspaceId(listed.name, listed.range);
    const replaced = this.entries.has(id);
    const entry: WorkspaceEntry = { id, name: listed.name, range: listed.range, origin: 'built-in', file: listed.file };
    this.entries.set(id, entry);
    return { entry, replaced };
  }

  /**
   * Fills a listed entry with its package once its script has run. The
   * package must be the one the index promised: a different name or range is
   * an error, and the entry stays unloaded.
   */
  fill(id: string, pkg: WorkspacePackage): WorkspaceEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`no workspace ${id}`);
    const got = workspaceId(pkg.name, pkg.range);
    if (got !== id) throw new Error(`workspace ${id}: its package is ${got}`);
    entry.package = pkg;
    return entry;
  }

  /** Drops a workspace: the visitor's folder, read again with other switches, can come out with another range. */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): WorkspaceEntry | undefined {
    return this.entries.get(id);
  }

  /** Looks a workspace up by its identity. */
  find(name: string, range: TimeRange | null): WorkspaceEntry | undefined {
    return this.entries.get(workspaceId(name, range));
  }

  /** Every workspace, grouped by name (in alphabetical order), each group newest first. */
  list(): WorkspaceGroup[] {
    const groups = new Map<string, WorkspaceEntry[]>();
    for (const e of this.entries.values()) groups.set(e.name, [...(groups.get(e.name) ?? []), e]);
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entries]) => ({ name, entries: entries.sort(byNewest) }));
  }
}

/**
 * Site packages (docs/workspace-explorer.md, "Where packages live"): each is
 * a script under `workspaces/` in the site, which registers its package on
 * `window.factoryClockWorkspaces` under its id when run. The page lists them
 * from `workspaces/index.js`, which sets `window.factoryClockWorkspaceIndex`,
 * and adds a package's script tag only when it's picked. Scripts rather than
 * JSON because the page's security policy allows scripts from its own origin
 * but no fetches.
 */
export interface WorkspaceIndexEntry {
  name: string;
  range: TimeRange | null;
  /** The package's script, relative to the page: `workspaces/<file>.js`. */
  file: string;
}

/** The global a site package registers itself on. */
export const WORKSPACE_GLOBAL = 'factoryClockWorkspaces';
/** The global the site's index of packages sets. */
export const WORKSPACE_INDEX_GLOBAL = 'factoryClockWorkspaceIndex';

const jsonInScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** A site package's script: registers the package under its id. What the scrape script writes for each workspace. */
export function workspaceScript(pkg: WorkspacePackage): string {
  return `(globalThis.${WORKSPACE_GLOBAL} = globalThis.${WORKSPACE_GLOBAL} || {})[${jsonInScript(workspaceId(pkg.name, pkg.range))}] = ${jsonInScript(pkg)};\n`;
}

/** The site's index script, listing packages by name, range, and file. */
export function workspaceIndexScript(entries: WorkspaceIndexEntry[]): string {
  return `globalThis.${WORKSPACE_INDEX_GLOBAL} = ${jsonInScript(entries)};\n`;
}

/** Reads the index global defensively: entries without a name or a relative `workspaces/…js` file are dropped. */
export function readWorkspaceIndex(value: unknown): WorkspaceIndexEntry[] {
  if (!Array.isArray(value)) return [];
  const out: WorkspaceIndexEntry[] = [];
  for (const v of value) {
    if (!isObject(v) || checkName(v.name) || typeof v.file !== 'string' || !/^workspaces\/[A-Za-z0-9._-]+\.js$/.test(v.file)) continue;
    const r = v.range;
    const range = r === null ? null : isObject(r) && instant(r.first) !== null && instant(r.last) !== null
      ? { first: new Date(instant(r.first)!).toISOString(), last: new Date(instant(r.last)!).toISOString() }
      : undefined;
    if (range === undefined) continue;
    out.push({ name: v.name as string, range, file: v.file });
  }
  return out;
}

/** Reads a registered package by id from the global a site package sets, checked as any package is. */
export function readRegisteredWorkspace(registry: unknown, id: string): Checked<WorkspacePackage> {
  if (!isObject(registry) || !(id in registry)) return { errors: [`workspace ${id} didn't register`] };
  return checkWorkspacePackage(registry[id]);
}

/** The name of the built-in synthetic workspace. */
export const SYNTHETIC_WORKSPACE_NAME = 'Example monorepo (generated)';

/**
 * The generated sessions, with the example code and plan made beside them,
 * as one built-in workspace. Built in the bundle rather than shipped as a
 * site package, since it's generated; it goes through the same format.
 */
export function syntheticWorkspacePackage(): WorkspacePackage {
  return makeWorkspacePackage({
    name: SYNTHETIC_WORKSPACE_NAME,
    source: {
      tool: 'factory-clock synthetic',
      generatedAt: `${SYNTHETIC_DAY}T18:00:00.000Z`,
      note: 'Four made-up sessions, shaped like real Claude Code and Copilot sessions but not recorded from anyone, with the example code and plan they were made beside.',
    },
    events: syntheticEvents(),
    code: [syntheticCodeGraph()],
    plans: [syntheticPlanGraph()],
  });
}
