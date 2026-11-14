import { SessionSummary } from './schema';
import { SessionView } from './schema';
import { CATALOG, TAXONOMY, Taxonomy, VisualizerEntry } from './catalog';

/** The day's session list the Sessions tab draws (the `sessions` message). */
export interface SessionListPayload {
  day: string;
  /** Days with sessions, newest first, for the day picker. */
  days: string[];
  sessions: SessionSummary[];
  /** The advisor's headline per session, where there is one (model output). */
  headlines: Record<string, string>;
}

/** The Explore tab's picker: every retained session, with no day filter (the `exploreSessions` message). */
export interface ExploreSessionList {
  /** Newest start first. */
  sessions: SessionSummary[];
  /** The advisor's headline per session, where there is one (model output). */
  headlines: Record<string, string>;
}

/** Sessions in the order the Explore picker lists them: newest start first, the date its first column shows. */
export function byNewestStart(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.firstTs.localeCompare(a.firstTs) || a.sessionId.localeCompare(b.sessionId));
}

/**
 * Everything the Explore tab renders, sent whole on the `explorer` message
 * the way `sessions` and `session` are: the taxonomy and catalog for the
 * carousel and puck, the picked sessions' views, and the picked ids that have
 * no view (unknown, or no longer retained).
 */
export interface ExplorerState {
  taxonomy: Taxonomy;
  catalog: VisualizerEntry[];
  /** In the order picked. */
  sessions: SessionView[];
  notLoaded: string[];
}

/** Builds the state for the picked ids, keeping their order and naming the ones without a view. */
export function buildExplorerState(picked: string[], viewFor: (sessionId: string) => SessionView | undefined): ExplorerState {
  const sessions: SessionView[] = [];
  const notLoaded: string[] = [];
  for (const id of picked) {
    const view = viewFor(id);
    if (view) sessions.push(view);
    else notLoaded.push(id);
  }
  return { taxonomy: TAXONOMY, catalog: CATALOG, sessions, notLoaded };
}

/**
 * The puck's filters, which are also the guide's answers (docs/workspace-explorer.md,
 * "The puck as a guide"): per facet, the values picked, in the order they were picked.
 * An empty or missing facet doesn't filter.
 */
export type GuideFilters = Partial<Record<string, string[]>>;

/** Whether an entry passes the filters: any picked value within a facet, every facet with picks. */
export function matchesFilters(entry: VisualizerEntry, filters: GuideFilters): boolean {
  return Object.entries(filters).every(([facet, vals]) => !vals || !vals.length || vals.some((v) => ((entry.tags as Record<string, string[]>)[facet] || []).includes(v)));
}

/** "For: impressing" alone (expressive picked, informative not): the shelf leads with the hero views. */
export function leadsWithHeroes(filters: GuideFilters): boolean {
  const purpose = filters.purpose || [];
  return purpose.includes('expressive') && !purpose.includes('informative');
}

/**
 * The guide's recommendation, which is the shelf's order: the views the filters
 * allow, hero views first when the answer is "For: impressing", then by the
 * first picked subject each draws (subjects in the order picked), then in the
 * catalog's order. No scoring: every step is a tag or the catalog's own order.
 */
export function guideShelf(catalog: VisualizerEntry[], filters: GuideFilters): VisualizerEntry[] {
  const subjects = filters.subject || [];
  const heroesFirst = leadsWithHeroes(filters);
  const subjectRank = (e: VisualizerEntry) => {
    const ranks = (e.tags.subject || []).map((s) => subjects.indexOf(s)).filter((i) => i >= 0);
    return ranks.length ? Math.min(...ranks) : subjects.length;
  };
  return catalog
    .map((entry, index) => ({ entry, index, hero: heroesFirst && entry.hero ? 0 : 1, subject: subjectRank(entry) }))
    .filter((x) => matchesFilters(x.entry, filters))
    .sort((a, b) => a.hero - b.hero || a.subject - b.subject || a.index - b.index)
    .map((x) => x.entry);
}
