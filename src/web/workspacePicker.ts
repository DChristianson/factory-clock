import { CodeGraph, PlanGraph, ProjectFile, isAbsolutePath } from '../model';
import { NormalizedEvent } from '../schema';
import { parseJsonl } from './jsonl';
import { sortFile } from './loader';
import {
  TimeRange,
  WORKSPACE_NAME_MAX,
  WorkspaceEntry,
  WorkspacePackage,
  WorkspaceStore,
  makeWorkspacePackage,
  readWorkspaceIndex,
  workspaceId,
} from './workspaceStore';

/**
 * The workspace picker's logic (docs/workspace-explorer.md, "The workspace
 * picker"): how an entry reads in the list, which workspace the page opens
 * with, the site's index read into the store, the example traces as a
 * workspace, and the visitor's files made into one. DOM-free, so Node tests
 * run it; src/web/page.ts draws the list and reads the files.
 */

/** A range as the picker shows it, in the visitor's locale: "Oct 3 – Nov 2, 2026", or one day alone. */
export function formatRange(range: TimeRange | null, options: { locale?: string; timeZone?: string } = {}): string {
  if (!range) return 'no dates';
  const format = new Intl.DateTimeFormat(options.locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: options.timeZone });
  return format.formatRange(new Date(range.first), new Date(range.last));
}

/** How many sessions a package holds: its distinct session ids. */
export function sessionCountOf(pkg: WorkspacePackage): number {
  return new Set(pkg.events.map((e) => e.sessionId)).size;
}

/** The line under an entry's name: its range, and its session count once its package is in hand. */
export function entryDetail(entry: WorkspaceEntry, options: { locale?: string; timeZone?: string } = {}): string {
  const parts = [formatRange(entry.range, options)];
  if (entry.package) {
    const n = sessionCountOf(entry.package);
    parts.push(`${n.toLocaleString(options.locale)} session${n === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/**
 * Lists the site's packages (the index global, read defensively) in the
 * store, to be loaded when picked. A workspace the store already has in hand
 * is left as it is, so a listing never unloads one. Returns how many were listed.
 */
export function listSiteWorkspaces(store: WorkspaceStore, index: unknown): number {
  let listed = 0;
  for (const entry of readWorkspaceIndex(index)) {
    if (store.get(workspaceId(entry.name, entry.range))?.package) continue;
    store.addListed(entry);
    listed += 1;
  }
  return listed;
}

/**
 * The workspace the page opens with: the one saved in the page state when
 * the store has it and it's built in (a built-in package or a listed site
 * package), else the default. A workspace read from the visitor's files is
 * gone after a reload, so its id never matches and the default stands in.
 */
export function startingWorkspace(store: WorkspaceStore, saved: unknown, fallback: string): string {
  if (typeof saved !== 'string') return fallback;
  const entry = store.get(saved);
  return entry && entry.origin === 'built-in' && (entry.package || entry.file) ? entry.id : fallback;
}

/** The name of the example traces' workspace. */
export const TRACES_WORKSPACE_NAME = 'Example traces (redacted)';

/**
 * The example traces (hosts/web/demo/traces.js, when the build has them) as
 * a workspace of sessions alone: they're real sessions from more than one
 * project, so they come with no code or plans.
 */
export function tracesWorkspacePackage(traces: { events: NormalizedEvent[] }): WorkspacePackage {
  const last = traces.events.reduce((hi, e) => (e.ts > hi ? e.ts : hi), '');
  return makeWorkspacePackage({
    name: TRACES_WORKSPACE_NAME,
    source: {
      tool: 'snagboat demo:traces',
      generatedAt: last || new Date(0).toISOString(),
      note: 'Real sessions from building Snagboat and another project, with paths and command lines removed; the prompts and replies are as they were written. Sessions only: no code or plans.',
    },
    events: traces.events,
  });
}

/**
 * A workspace name from a folder or file name: the extension dropped, line
 * breaks and an absolute path's folders taken out, cut to the store's
 * limit; `My files` when nothing is left.
 */
export function workspaceNameFrom(raw: string): string {
  let name = raw.replace(/[\r\n]+/g, ' ');
  if (isAbsolutePath(name) || /[\\/]/.test(name)) name = name.split(/[\\/]/).filter(Boolean).pop() ?? '';
  name = name.replace(/\.(workspace\.json|jsonl|json|ndjson|txt)$/i, '').trim().slice(0, WORKSPACE_NAME_MAX).trim();
  return name || 'My files';
}

/** The visitor's files as a workspace, loaded in this tab: its range computed from what's in it. */
export function filesWorkspacePackage(parts: { name: string; events: NormalizedEvent[]; code: CodeGraph[]; plans: PlanGraph[]; now?: string }): WorkspacePackage {
  return makeWorkspacePackage({
    name: workspaceNameFrom(parts.name),
    source: { tool: 'factory-clock files', generatedAt: parts.now ?? new Date().toISOString(), note: 'Read from your files in this browser; nothing was uploaded. It is gone when the tab closes.' },
    events: parts.events,
    code: parts.code,
    plans: parts.plans,
  });
}

/** The events in a chosen folder: its JSONL files that read as events (a beads export is the beads adapter's). */
export function folderEvents(files: readonly ProjectFile[]): { events: NormalizedEvent[]; skipped: number; duplicates: number } {
  const seen = new Set<string>();
  const out = { events: [] as NormalizedEvent[], skipped: 0, duplicates: 0 };
  for (const file of files) {
    if (!/\.jsonl$/i.test(file.path) || sortFile(file.path, file.text) !== 'events') continue;
    const parsed = parseJsonl(file.text, seen);
    out.events.push(...parsed.events);
    out.skipped += parsed.skipped;
    out.duplicates += parsed.duplicates;
  }
  return out;
}
