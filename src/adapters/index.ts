// The adapters (docs/workspace-explorer.md, "Adapters"): each reads one tool's
// files from a project folder and returns a CodeGraph or a PlanGraph. They run
// in the page and in Node alike; the loader runs every one whose detect says
// yes. Adding an adapter is a file, a fixture, a test, and a line here.
import { CodeAdapter, PlanAdapter } from '../model';
import { npmAdapter } from './code/npm';
import { beadsAdapter } from './plan/beads';
import { markdownAdapter } from './plan/markdown';

export { npmAdapter } from './code/npm';
export { beadsAdapter } from './plan/beads';
export { markdownAdapter } from './plan/markdown';

export const CODE_ADAPTERS: CodeAdapter[] = [npmAdapter];
export const PLAN_ADAPTERS: PlanAdapter[] = [beadsAdapter, markdownAdapter];
