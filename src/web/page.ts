import { CATALOG } from '../catalog';
import { ExploreSessionList, ExplorerState } from '../explorerModel';
import { ProjectFile, Workspace } from '../model';
import { creditRows } from './credits';
import { EventSet, FindingsFor } from './eventSet';
import { ProjectRead, Picks, Subject, UnitSummary, WorkspaceSet, isSkippedDir, looksBinary, planWalk, readProject, readSingleFiles } from './loader';
import { readDemoTraces } from './traces';
import { syntheticEvents, syntheticSessionIds } from './synthetic';
import { syntheticCodeGraph, syntheticPlanGraph } from './syntheticWorkspace';

/**
 * The web page (docs/visualization-explorer.md, "A web demo on
 * GitHub Pages"): mounts explore.js over a source backed by an EventSet
 * in memory, the example traces (or the generated sessions, when the page was
 * built without traces) until files are loaded, and keeps the tab's
 * small state in localStorage. This and src/main.ts are the only
 * DOM-touching files in the TypeScript, whose tsconfig has the DOM lib. Nothing here fetches, posts, or
 * stores anything but that state: the page's CSP forbids network requests,
 * and loaded events live in memory until the tab closes.
 */

/** The explorer's saved state, under one key. */
const STATE_KEY = 'factoryClock.explore';

/** The source object explore.js expects (see its header). */
interface ExploreSource {
  listSessions(): void;
  loadSessions(ids: string[]): void;
  closeExplorer(): void;
  getState(): Record<string, unknown>;
  setState(partial: Record<string, unknown>): void;
  onSessions(cb: (list: ExploreSessionList) => void): void;
  onExplorer(cb: (state: ExplorerState | null) => void): void;
  openSessionId(): string | null;
  /** The pickable units of one subject: sessions, code roots, or plan roots. */
  listUnits(subject: Subject): UnitSummary[];
  /** Picks units of one subject and sends the Workspace for every subject's picks. */
  loadUnits(subject: Subject, ids: string[]): void;
  onWorkspace(cb: (workspace: Workspace) => void): void;
}

interface ExploreTab {
  shown(): void;
  /** Covers the stage with a loading screen and this text; null takes it away. */
  loading(text: string | null): void;
  destroy(): void;
}

/** What the page's plain scripts (vizkit.js, explore.js) put on window. */
interface PageGlobals {
  factoryClockKit: Record<string, unknown> & { tipFor(tooltip: HTMLElement): { showTip: (evt: MouseEvent, rows: unknown[]) => void; hideTip: () => void } };
  factoryClockExplore: { mount(root: HTMLElement, source: ExploreSource, ctx: Record<string, unknown>): ExploreTab };
  /** Set by demo-traces.js (hosts/web/demo/traces.js, from Snagboat's npm run demo:traces) when the page was built with it. */
  factoryClockDemoTraces?: { picked?: unknown; events?: unknown };
}

const TRACES_NOTE = 'Example traces: real sessions from building Snagboat and another project, with paths and command lines removed; the prompts and replies are as they were written. Load your own files below to explore yours.';
const GENERATED_NOTE = 'Generated sessions: four made-up ones, shaped like real Claude Code and Copilot sessions but not recorded from anyone. Load your own files below to explore yours.';


function readState(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeState(state: Record<string, unknown>): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked or full: the tab still works, it just won't remember.
  }
}

/** The picks of code and plans, saved beside the sessions' `picked`. */
function storedPicks(): Picks {
  const raw = readState().picks;
  const out: Picks = {};
  if (raw && typeof raw === 'object') {
    for (const subject of ['code', 'plans'] as const) {
      const ids = (raw as Record<string, unknown>)[subject];
      if (Array.isArray(ids)) out[subject] = ids.filter((id): id is string => typeof id === 'string');
    }
  }
  return out;
}

/**
 * A source over the page's workspace: lists and loads synchronously, since
 * everything is in memory. The session methods are the ones explore.js has
 * always called; listUnits, loadUnits, and onWorkspace serve every subject.
 */
function sourceOver(set: WorkspaceSet): ExploreSource {
  const data = set.sessions;
  const listeners = {
    sessions: [] as Array<(list: ExploreSessionList) => void>,
    explorer: [] as Array<(state: ExplorerState | null) => void>,
    workspace: [] as Array<(workspace: Workspace) => void>,
  };
  let sessionPick: string[] = [];
  const sendWorkspace = () => {
    if (!listeners.workspace.length) return;
    const workspace = set.workspace({ ...storedPicks(), sessions: sessionPick });
    for (const cb of listeners.workspace) cb(workspace);
  };
  return {
    listSessions() {
      const list = data.listAll();
      for (const cb of listeners.sessions) cb(list);
    },
    loadSessions(ids) {
      sessionPick = ids;
      const state = data.explorerState(ids);
      for (const cb of listeners.explorer) cb(state);
      sendWorkspace();
    },
    closeExplorer() {
      for (const cb of listeners.explorer) cb(null);
    },
    getState: readState,
    setState(partial) {
      writeState({ ...readState(), ...partial });
    },
    onSessions(cb) {
      listeners.sessions.push(cb);
    },
    onExplorer(cb) {
      listeners.explorer.push(cb);
    },
    openSessionId: () => null,
    listUnits: (subject) => set.listUnits(subject),
    loadUnits(subject, ids) {
      if (subject === 'sessions') {
        this.loadSessions(ids);
        return;
      }
      writeState({ ...readState(), picks: { ...storedPicks(), [subject]: set.keep(subject, ids) } });
      sendWorkspace();
    },
    onWorkspace(cb) {
      listeners.workspace.push(cb);
      cb(set.workspace({ ...storedPicks(), sessions: sessionPick }));
    },
  };
}

/** A dropped folder's files, listed through the entries API, pruning skipped folders before listing them. */
async function filesOfEntry(entry: FileSystemEntry): Promise<Array<{ file: File; path: string }>> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, path: entry.fullPath.replace(/^\//, '') }];
  }
  if (!entry.isDirectory || (entry.fullPath.split('/').length > 2 && isSkippedDir(entry.name))) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries returns a batch at a time; an empty batch means the end.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  const out: Array<{ file: File; path: string }> = [];
  for (const child of children) out.push(...(await filesOfEntry(child)));
  return out;
}

/** Fills the Credits list below the fold from the catalog: a row per view, each credit linked to its source when it has one. */
function renderCredits(list: HTMLElement): void {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  list.replaceChildren(
    ...creditRows(CATALOG).map((row) => {
      const item = make('li', 'credit-row');
      item.id = `credits-${row.id}`;
      const works = make('ul', 'credit-works');
      for (const c of row.credits) {
        const work = make('li', '');
        let cite: HTMLElement = make('strong', '', c.cite);
        if (c.url) {
          const link = make('a', '');
          link.href = c.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.append(cite);
          cite = link;
        }
        work.append(cite, make('span', 'muted', ` · ${c.relation} · `), c.detail);
        works.append(work);
      }
      item.append(make('span', 'credit-view', row.title), works);
      return item;
    })
  );
}

/** Mounts the page; findingsFor gives each session's findings (see EventSet). */
export function startPage(findingsFor?: FindingsFor): void {
  const globals = window as unknown as PageGlobals;
  const byId = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`factory clock: #${id} is missing from the page`);
    return node as T;
  };
  const root = byId('explore-root');
  const tooltip = byId('tooltip');
  const filesInput = byId<HTMLInputElement>('files');
  const drop = byId('drop');
  const dataNote = byId('data-note');
  const examplesBtn = byId<HTMLButtonElement>('examples');
  const tracesBtn = byId<HTMLButtonElement>('traces');
  const traces = readDemoTraces(globals.factoryClockDemoTraces);
  const examplesNote = byId('examples-note');
  const folderInput = byId<HTMLInputElement>('folder');
  const projectBox = byId('project');
  const projectName = byId('project-name');
  const projectFound = byId('project-found');
  const keepText = byId<HTMLInputElement>('keep-text');
  const hintGlobals = byId<HTMLInputElement>('hint-globals');

  const kit = globals.factoryClockKit;
  const ctx = { ...kit, tooltip, ...kit.tipFor(tooltip) };
  let tab: ExploreTab | null = null;
  let set = new WorkspaceSet(new EventSet([], findingsFor));
  /** The last folder read, kept so the switches can read it again. */
  let project: { name: string; files: ProjectFile[]; off: Set<string> } | null = null;

  /**
   * (Re)mounts the explorer over a set. The picked ids only mean something
   * for the data they were picked from, so ones the new set doesn't have are
   * dropped, and with none left the default pick stands in.
   */
  function mountExplorer(next: WorkspaceSet, defaultPick: string[]): void {
    tab?.destroy();
    set = next;
    const data = next.sessions;
    const stored = readState().picked;
    const kept = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && !!data.index.get(id)) : [];
    writeState({ ...readState(), picked: kept.length ? kept : defaultPick });
    tab = globals.factoryClockExplore.mount(root, sourceOver(next), ctx);
    tab.shown();
  }

  /**
   * Puts the loading screen over the stage and waits until it has painted, so
   * the reading and drawing after it (much of it synchronous) can't hide it.
   * A remount replaces the tab, which takes the screen with it.
   */
  async function showLoading(text: string): Promise<void> {
    tab?.loading(text);
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  const hideLoading = (): void => tab?.loading(null);
  /** Runs work behind the loading screen. */
  function behindLoading(text: string, work: () => unknown): Promise<void> {
    return showLoading(text)
      .then(work)
      .then(() => undefined)
      .finally(hideLoading);
  }

  const n = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

  /** Shows one of the built-in sets; the other's button stays offered. */
  function useBuiltIn(which: 'traces' | 'generated'): void {
    dataNote.textContent = '';
    const useTraces = which === 'traces' && !!traces;
    tracesBtn.hidden = !traces || useTraces;
    examplesBtn.hidden = !useTraces;
    examplesNote.hidden = false;
    examplesNote.textContent = useTraces ? TRACES_NOTE : GENERATED_NOTE;
    // The generated sessions come with the example code and plan they were made beside.
    project = null;
    projectBox.hidden = true;
    if (useTraces && traces) mountExplorer(new WorkspaceSet(new EventSet(traces.events, findingsFor)), traces.picked.slice(0, 2));
    else mountExplorer(new WorkspaceSet(new EventSet(syntheticEvents(), findingsFor), [syntheticCodeGraph()], [syntheticPlanGraph()]), syntheticSessionIds().slice(0, 2));
  }

  /** After any load, the built-in sets are offered again. */
  function offerBuiltIns(): void {
    examplesBtn.hidden = false;
    tracesBtn.hidden = !traces;
    examplesNote.hidden = true;
  }

  /** Single files, sorted by content: events replace the sessions, graphs and beads exports the project. */
  async function loadFiles(files: ArrayLike<File>): Promise<void> {
    const list = Array.from(files);
    if (!list.length) return;
    dataNote.textContent = `Reading ${n(list.length, 'file')}…`;
    await showLoading(`Reading ${n(list.length, 'file')}…`);
    const read = [];
    for (const file of list) read.push({ name: file.name, text: await file.text() });
    const sorted = readSingleFiles(read);
    const notes: string[] = [];
    let next = set;
    if (sorted.events.length) {
      const data = new EventSet(sorted.events, findingsFor);
      const sessions = data.index.list();
      notes.push(`Loaded ${n(sorted.events.length, 'event')}: ${n(sessions.length, 'session')} on ${n(data.index.days().length, 'day')}.`);
      if (!sessions.length) notes.push('No agent sessions in these files; is this Snagboat’s events folder?');
      next = next.withSessions(data);
    }
    if (sorted.code.length || sorted.plans.length) {
      notes.push(`Loaded ${[sorted.code.length ? n(sorted.code.length, 'code graph') : '', sorted.plans.length ? n(sorted.plans.length, 'plan') : ''].filter(Boolean).join(' and ')}.`);
      next = next.withProject(sorted.code, sorted.plans);
      project = null;
      projectBox.hidden = true;
    }
    if (sorted.skippedLines) notes.push(`${n(sorted.skippedLines, 'line')} skipped (not JSON, or not an event).`);
    if (sorted.duplicates) notes.push(`${n(sorted.duplicates, 'duplicate event')} ignored.`);
    for (const r of sorted.refused) notes.push(`${r.name}: not read (${r.reason}).`);
    dataNote.textContent = notes.join(' ');
    if (next === set) return;
    offerBuiltIns();
    mountExplorer(next, next.sessions.listAll().sessions.slice(0, 2).map((s) => s.sessionId));
  }

  /** Lists what each adapter found, each with a switch; an adapter that found nothing says so. */
  function showProject(read: ProjectRead): void {
    projectBox.hidden = false;
    projectName.textContent = `Project: ${read.name}`;
    projectFound.replaceChildren();
    for (const report of read.reports) {
      const li = document.createElement('li');
      if (!report.detected) {
        li.className = 'missing small';
        li.textContent = report.id === 'beads'
          ? 'beads: no export found. Run bd export > issues.jsonl in the project and drop the file here.'
          : `${report.id}: nothing of its kind in this folder.`;
      } else {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = report.ran;
        box.addEventListener('change', () => {
          if (!project) return;
          if (box.checked) project.off.delete(report.id);
          else project.off.add(report.id);
          readFolderAgain();
        });
        label.append(box, `${report.id} (${report.subject}): ${report.ran ? report.summary || 'nothing usable' : 'off'}`);
        li.append(label);
        if (report.errors.length) {
          const errors = document.createElement('div');
          errors.className = 'errors small';
          errors.textContent = report.errors.slice(0, 3).join(' · ') + (report.errors.length > 3 ? ` · and ${report.errors.length - 3} more` : '');
          li.append(errors);
        }
      }
      projectFound.append(li);
    }
  }

  /** Runs the adapters over the folder last read, with the switches as they are now. */
  function readFolderAgain(): void {
    if (!project) return;
    const read = readProject(project.files, {
      name: project.name,
      off: [...project.off],
      keepText: keepText.checked,
      hints: hintGlobals.checked ? ['globals'] : [],
    });
    showProject(read);
    offerBuiltIns();
    mountExplorer(set.withProject(read.code, read.plans), set.sessions.listAll().sessions.slice(0, 2).map((s) => s.sessionId));
  }

  /** A chosen or dropped folder: walked, read as text, and handed to the adapters. Sessions stay as they are. */
  async function loadFolder(entries: Array<{ file: File; path: string }>): Promise<void> {
    if (!entries.length) return;
    const plan = planWalk(entries.map((e) => ({ ...e, bytes: e.file.size })));
    dataNote.textContent = `Reading ${n(plan.keep.length, 'file')} from ${plan.name}…`;
    await showLoading(`Reading ${n(plan.keep.length, 'file')} from ${plan.name}…`);
    const files: ProjectFile[] = [];
    let binary = plan.skipped.binary;
    for (const { entry, path } of plan.keep) {
      const text = await entry.file.text();
      if (looksBinary(text)) binary += 1;
      else files.push({ path, text, bytes: entry.bytes });
    }
    project = { name: plan.name, files, off: new Set(project?.name === plan.name ? project.off : []) };
    const skips = [
      plan.skipped.folders ? `${n(plan.skipped.folders, 'file')} in skipped folders` : '',
      binary ? `${n(binary, 'binary file')}` : '',
      plan.skipped.large.length ? `${n(plan.skipped.large.length, 'file')} over 2 MB` : '',
      plan.skipped.overLimit ? `${n(plan.skipped.overLimit, 'file')} past the 20,000-file limit` : '',
    ].filter(Boolean);
    dataNote.textContent = `Read ${n(files.length, 'file')} from ${plan.name}.${skips.length ? ` Not read: ${skips.join(', ')}.` : ''}`;
    readFolderAgain();
  }

  filesInput.addEventListener('change', () => {
    void loadFiles(filesInput.files ?? []).finally(() => {
      hideLoading();
      filesInput.value = ''; // so picking the same files again reloads them
    });
  });
  folderInput.addEventListener('change', () => {
    const chosen = Array.from(folderInput.files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    void loadFolder(chosen).finally(() => {
      hideLoading();
      folderInput.value = '';
    });
  });
  const readAgainBehindLoading = () => {
    if (project) void behindLoading(`Reading ${project.name} again…`, readFolderAgain);
  };
  keepText.addEventListener('change', readAgainBehindLoading);
  hintGlobals.addEventListener('change', readAgainBehindLoading);
  examplesBtn.addEventListener('click', () => void behindLoading('Loading the generated sessions…', () => useBuiltIn('generated')));
  tracesBtn.addEventListener('click', () => void behindLoading('Loading the example traces…', () => useBuiltIn('traces')));

  // The drop zone; a drop anywhere else must not make the browser open the file.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());
  drop.addEventListener('dragover', () => drop.classList.add('over'));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    drop.classList.remove('over');
    // A folder goes to the adapters; loose files are sorted by content.
    const items = Array.from(e.dataTransfer?.items ?? []);
    const entries = items.map((item) => item.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (entries.some((x) => x.isDirectory)) {
      void behindLoading('Reading the folder…', () => Promise.all(entries.filter((x) => x.isDirectory).map(filesOfEntry)).then((lists) => loadFolder(lists.flat())));
    } else {
      void loadFiles(e.dataTransfer?.files ?? []).finally(hideLoading);
    }
  });

  useBuiltIn('traces');
  renderCredits(byId('credits-list'));
}
