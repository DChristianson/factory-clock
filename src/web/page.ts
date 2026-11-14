import { ExploreSessionList, ExplorerState, guideShelf } from '../explorerModel';
import { ProjectFile, Workspace, shapeOfWorkspace } from '../model';
import { EventSet, FindingsFor } from './eventSet';
import { ProjectRead, Picks, Subject, UnitSummary, WorkspaceSet, isSkippedDir, looksBinary, planWalk, readProject, readSingleFiles } from './loader';
import { startingPick } from './pick';
import { readDemoTraces } from './traces';
import { hashForViewId, viewIdFromHash } from './viewLink';
import { entryDetail, filesWorkspacePackage, folderEvents, listSiteWorkspaces, sessionCountOf, startingWorkspace, tracesWorkspacePackage } from './workspacePicker';
import {
  WORKSPACE_GLOBAL,
  WORKSPACE_INDEX_GLOBAL,
  WorkspaceEntry,
  WorkspacePackage,
  WorkspaceStore,
  readRegisteredWorkspace,
  syntheticWorkspacePackage,
  workspaceId,
} from './workspaceStore';

/**
 * The web page (docs/visualization-explorer.md, "A web demo on
 * GitHub Pages"; docs/workspace-explorer.md, "The workspace picker"): lists
 * the workspaces in a picker, mounts explore.js over the one selected, a
 * source backed by an EventSet in memory, and keeps the tab's small state in
 * localStorage. Files the visitor chooses become a workspace too. This and
 * src/main.ts are the only DOM-touching files in the TypeScript, whose
 * tsconfig has the DOM lib. Nothing here fetches, posts, or stores anything
 * but that state: the page's CSP forbids network requests, a site package is
 * a script from the page's own site, and loaded files live in memory until
 * the tab closes.
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
  /** The view the page's #hash names, or null. */
  getViewId(): string | null;
  /** Writes the view on stage to the #hash, without a history entry. */
  setViewId(id: string): void;
  /** cb on each hashchange; returns a function that stops it. */
  onViewId(cb: (id: string | null) => void): () => void;
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
  /** Set by workspaces/index.js when the build listed site packages (scripts/site.js, FC_WORKSPACES). */
  [WORKSPACE_INDEX_GLOBAL]?: unknown;
  /** Where each site package's script registers its package, by id. */
  [WORKSPACE_GLOBAL]?: unknown;
}

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

/**
 * The view's address (bqx.46): #<view id> names the view on stage. Only a catalog id is ever written,
 * with replaceState, so flipping adds no history entry and doesn't fire hashchange back at the explorer.
 */
const viewAddress: Pick<ExploreSource, 'getViewId' | 'setViewId' | 'onViewId'> = {
  getViewId: () => viewIdFromHash(location.hash),
  setViewId(id) {
    const hash = hashForViewId(id);
    if (location.hash === hash) return;
    try {
      history.replaceState(history.state, '', hash);
    } catch {
      // A browser that refuses (some file:// pages): the address just doesn't follow.
    }
  },
  onViewId(cb) {
    const onHash = () => cb(viewIdFromHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  },
};

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
    ...viewAddress,
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
  const pickerList = byId('workspace-list');
  const pickerNote = byId('workspace-note');
  const pickerError = byId('workspace-error');
  const filesInput = byId<HTMLInputElement>('files');
  const folderInput = byId<HTMLInputElement>('folder');
  const drop = byId('drop');
  const dataNote = byId('data-note');
  const projectBox = byId('project');
  const projectName = byId('project-name');
  const projectFound = byId('project-found');
  const keepText = byId<HTMLInputElement>('keep-text');
  const hintGlobals = byId<HTMLInputElement>('hint-globals');

  const kit = globals.factoryClockKit;
  // shapeFor(workspace, subject, options) builds options.shape for the Shape views (explore.js); guideShelf orders the shelf (the puck's guide).
  const ctx = { ...kit, tooltip, ...kit.tipFor(tooltip), shapeFor: shapeOfWorkspace, guideShelf };
  let tab: ExploreTab | null = null;

  // The page's workspaces (docs/workspace-explorer.md, "The workspace picker"): the generated one, the
  // example traces when the build has them, and the site's packages when the build listed some.
  const workspaces = new WorkspaceStore();
  const generated = workspaces.add(syntheticWorkspacePackage(), 'built-in').entry;
  const traces = readDemoTraces(globals.factoryClockDemoTraces);
  if (traces) workspaces.add(tracesWorkspacePackage(traces), 'built-in');
  listSiteWorkspaces(workspaces, globals[WORKSPACE_INDEX_GLOBAL]);
  /** The workspace every view draws; null until the first one is mounted. */
  let selected: string | null = null;
  /** True while a workspace is being loaded, so a second pick waits for the first. */
  let busy = false;
  /** The last folder read, kept so the switches can read it again, and the workspace it became. */
  let project: { name: string; files: ProjectFile[]; off: Set<string>; id: string | null } | null = null;

  /** (Re)mounts the explorer over a set, picking every session in it unless the visitor chose a pick that still applies (startingPick). */
  function mountExplorer(next: WorkspaceSet): void {
    tab?.destroy();
    const data = next.sessions;
    const state = readState();
    const all = data.listAll().sessions.map((s) => s.sessionId);
    writeState({ ...state, ...startingPick(state, all, (id) => !!data.index.get(id)) });
    tab = globals.factoryClockExplore.mount(root, sourceOver(next), ctx);
    tab.shown();
  }

  /**
   * Puts the loading screen over the stage and waits until it has painted, so
   * the reading and drawing after it (much of it synchronous) can't hide it.
   * A remount replaces the tab, which takes the screen with it. Before the
   * first mount, the page's own loading screen is still up.
   */
  async function showLoading(text: string): Promise<void> {
    tab?.loading(text);
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  const hideLoading = (): void => tab?.loading(null);

  const n = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

  /** The site package scripts added so far, by file, so each is added once. */
  const scripts = new Map<string, Promise<void>>();
  function addScript(file: string): Promise<void> {
    const known = scripts.get(file);
    if (known) return known;
    const loaded = new Promise<void>((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = file;
      tag.addEventListener('load', () => resolve());
      tag.addEventListener('error', () => {
        tag.remove();
        scripts.delete(file); // so picking it again tries again
        reject(new Error(`its file (${file}) didn't load`));
      });
      document.body.append(tag);
    });
    scripts.set(file, loaded);
    return loaded;
  }

  /** A workspace's package: in hand, or its site script added, read back, checked, and filled in. */
  async function packageOf(entry: WorkspaceEntry): Promise<WorkspacePackage> {
    if (entry.package) return entry.package;
    if (!entry.file) throw new Error('it has no package');
    await addScript(entry.file);
    const checked = readRegisteredWorkspace(globals[WORKSPACE_GLOBAL], entry.id);
    if (!checked.value) {
      const error = checked.errors[0] ?? 'its package is not a workspace';
      throw new Error(/didn't register$/.test(error) ? `its file (${entry.file}) doesn't hold it` : error);
    }
    return workspaces.fill(entry.id, checked.value).package!;
  }

  /** Draws the list: every workspace by name and range, grouped by name, the selected one marked. */
  function renderPicker(): void {
    pickerList.replaceChildren();
    for (const group of workspaces.list()) {
      for (const entry of group.entries) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'workspace-pick';
        const name = document.createElement('span');
        name.className = 'workspace-name';
        name.textContent = entry.name;
        const detail = document.createElement('span');
        detail.className = 'workspace-detail small';
        detail.textContent = entryDetail(entry) + (entry.origin === 'loaded' ? ' · your files' : '');
        button.append(name, detail);
        if (entry.id === selected) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => {
          if (entry.id !== selected) void select(entry.id);
        });
        li.append(button);
        pickerList.append(li);
      }
    }
    pickerNote.textContent = (selected && workspaces.get(selected)?.package?.source.note) || '';
  }

  /**
   * Makes a workspace the one every view draws, behind the loading screen.
   * A listed package that fails to load or check says so in the picker, and
   * the current workspace stays. Returns whether it was selected.
   */
  async function select(id: string): Promise<boolean> {
    const entry = workspaces.get(id);
    if (!entry || busy) return false;
    busy = true;
    pickerError.textContent = '';
    try {
      await showLoading(`Loading ${entry.name}…`);
      const pkg = await packageOf(entry);
      selected = id;
      // Only a built-in workspace is saved: one read from files is gone after a reload, and its name is the visitor's.
      const state = readState();
      if (entry.origin === 'built-in') state.workspace = id;
      else delete state.workspace;
      writeState(state);
      projectBox.hidden = !project || project.id !== id;
      mountExplorer(new WorkspaceSet(new EventSet(pkg.events, findingsFor), pkg.code, pkg.plans));
      return true;
    } catch (err) {
      const still = selected ? workspaces.get(selected)?.name : null;
      pickerError.textContent = `${entry.name} could not be loaded: ${err instanceof Error ? err.message : String(err)}.${still ? ` Still showing ${still}.` : ''}`;
      hideLoading();
      return false;
    } finally {
      busy = false;
      renderPicker();
    }
  }

  /** Adds the visitor's package and selects it. */
  function addLoaded(pkg: WorkspacePackage): Promise<boolean> {
    const { entry } = workspaces.add(pkg, 'loaded');
    return select(entry.id);
  }

  /**
   * Single files, sorted by content: each workspace package is its own
   * workspace, and the events, graphs, and beads exports together make one
   * more, named after the first of those files.
   */
  async function loadFiles(files: ArrayLike<File>): Promise<void> {
    const list = Array.from(files);
    if (!list.length) return;
    dataNote.textContent = `Reading ${n(list.length, 'file')}…`;
    await showLoading(`Reading ${n(list.length, 'file')}…`);
    const read = [];
    for (const file of list) read.push({ name: file.name, text: await file.text() });
    const sorted = readSingleFiles(read);
    const notes: string[] = [];
    const made: WorkspacePackage[] = [];
    for (const w of sorted.workspaces) {
      const dropped = w.errors.length ? ` ${w.errors[0]}${w.errors.length > 1 ? ` (and ${w.errors.length - 1} more)` : ''}.` : '';
      notes.push(`${w.name}: the workspace ${w.pkg.name}, ${n(sessionCountOf(w.pkg), 'session')}.${dropped}`);
      made.push(w.pkg);
    }
    if (sorted.events.length || sorted.code.length || sorted.plans.length) {
      const first = list.find((f) => !sorted.workspaces.some((w) => w.name === f.name)) ?? list[0];
      const pkg = filesWorkspacePackage({ name: first.name, events: sorted.events, code: sorted.code, plans: sorted.plans });
      const parts = [
        sorted.events.length ? `${n(sorted.events.length, 'event')} in ${n(sessionCountOf(pkg), 'session')}` : '',
        sorted.code.length ? n(sorted.code.length, 'code graph') : '',
        sorted.plans.length ? n(sorted.plans.length, 'plan') : '',
      ].filter(Boolean);
      notes.push(`Read ${parts.join(', ')} as the workspace ${pkg.name}.`);
      made.push(pkg);
    }
    if (sorted.skippedLines) notes.push(`${n(sorted.skippedLines, 'line')} skipped (not JSON, or not an event).`);
    if (sorted.duplicates) notes.push(`${n(sorted.duplicates, 'duplicate event')} ignored.`);
    for (const r of sorted.refused) notes.push(`${r.name}: not read (${r.reason}).`);
    dataNote.textContent = notes.join(' ');
    if (!made.length) return;
    for (const pkg of made.slice(0, -1)) workspaces.add(pkg, 'loaded');
    await addLoaded(made[made.length - 1]);
  }

  /** Lists what each adapter found, each with a switch; an adapter that found nothing says so. */
  function showProject(read: ProjectRead): void {
    projectName.textContent = `Project: ${read.name}`;
    projectFound.replaceChildren();
    for (const report of read.reports) {
      const li = document.createElement('li');
      if (!report.detected) {
        li.className = 'missing small';
        li.textContent = report.id === 'beads'
          ? 'beads: no export found. Run bd export > issues.jsonl in the project and choose the folder again.'
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
          readAgain();
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

  /**
   * Runs the adapters over the folder last read, with the switches as they
   * are now, and makes the folder's code, plans, and any event files in it
   * one workspace, in place of the one it made before.
   */
  async function readFolderAgain(): Promise<void> {
    if (!project) return;
    await showLoading(`Reading ${project.name}…`);
    const read = readProject(project.files, {
      name: project.name,
      off: [...project.off],
      keepText: keepText.checked,
      hints: hintGlobals.checked ? ['globals'] : [],
    });
    showProject(read);
    const found = folderEvents(project.files);
    const pkg = filesWorkspacePackage({ name: project.name, events: found.events, code: read.code, plans: read.plans });
    const id = workspaceId(pkg.name, pkg.range);
    // Other switches can change the range, so the workspace the folder made before goes; the views keep drawing it until the next one mounts.
    if (project.id && project.id !== id && project.id !== selected) workspaces.remove(project.id);
    const before = project.id;
    project.id = id;
    if (!found.events.length && !read.code.length && !read.plans.length) {
      // Nothing to draw: the switches stay up so one can be turned back on, and the views keep what they show.
      projectBox.hidden = false;
      hideLoading();
      return;
    }
    const ok = await addLoaded(pkg);
    if (ok && before && before !== id) workspaces.remove(before);
    renderPicker();
  }
  const readAgain = (): void => void readFolderAgain().finally(hideLoading);

  /** A chosen or dropped folder: walked, read as text, handed to the adapters, and made a workspace. */
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
    const before = project?.name === plan.name ? project : null;
    project = { name: plan.name, files, off: new Set(before ? before.off : []), id: before ? before.id : null };
    const skips = [
      plan.skipped.folders ? `${n(plan.skipped.folders, 'file')} in skipped folders` : '',
      binary ? `${n(binary, 'binary file')}` : '',
      plan.skipped.large.length ? `${n(plan.skipped.large.length, 'file')} over 2 MB` : '',
      plan.skipped.overLimit ? `${n(plan.skipped.overLimit, 'file')} past the 20,000-file limit` : '',
    ].filter(Boolean);
    const events = folderEvents(files).events.length;
    dataNote.textContent = `Read ${n(files.length, 'file')} from ${plan.name}${events ? `, ${n(events, 'event')} among them` : ''}.${skips.length ? ` Not read: ${skips.join(', ')}.` : ''}`;
    await readFolderAgain();
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
  keepText.addEventListener('change', readAgain);
  hintGlobals.addEventListener('change', readAgain);

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
      void showLoading('Reading the folder…')
        .then(() => Promise.all(entries.filter((x) => x.isDirectory).map(filesOfEntry)))
        .then((lists) => loadFolder(lists.flat()))
        .finally(hideLoading);
    } else {
      void loadFiles(e.dataTransfer?.files ?? []).finally(hideLoading);
    }
  });

  // The saved workspace when it's still offered, else the generated one; a saved one that fails to load gives way to it too.
  const start = startingWorkspace(workspaces, readState().workspace, generated.id);
  renderPicker();
  void select(start).then((ok) => {
    if (!ok && start !== generated.id) void select(generated.id);
  });
}
