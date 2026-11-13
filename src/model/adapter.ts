/**
 * The adapter contract (docs/workspace-explorer.md, "Adapters"). An adapter
 * reads one tool's artifacts from a project folder the visitor picked and
 * returns one schema object. It runs in the page, inside the bundle, and the
 * same module runs in Node for the tests and the demo build, so it imports
 * only the model types: no Node builtins, no DOM, no network.
 */
import { CodeGraph } from './code';
import { PlanGraph } from './plan';

/** One file from the chosen folder. Only text files reach an adapter. */
export interface ProjectFile {
  /** Relative to the chosen folder, forward slashes, never absolute. */
  path: string;
  text: string;
  bytes: number;
}

export interface AdapterOptions {
  /** What `source.root` says: the project's name, the folder's by default. */
  name: string;
  /** Plan adapters: keep descriptions. Off by default, so text is kept only when asked. */
  keepText?: boolean;
  /** Adapter-specific switches the loader offers, such as the npm adapter's `globals`. */
  hints?: string[];
  /** The `generatedAt` to stamp; the time of reading by default. Tests pass a fixed one. */
  now?: string;
}

export interface Adapter<T> {
  /** 'npm', 'beads', 'markdown'. */
  id: string;
  subject: 'code' | 'plans';
  /** Whether these files are this adapter's kind; the loader runs only the ones that say yes. */
  detect(files: ProjectFile[]): boolean;
  read(files: ProjectFile[], options: AdapterOptions): T;
}

export type CodeAdapter = Adapter<CodeGraph> & { subject: 'code' };
export type PlanAdapter = Adapter<PlanGraph> & { subject: 'plans' };
