import { EXPLORE_SESSION_CAP } from '../catalog';

/**
 * The sessions the explorer starts with, and whether the visitor chose them.
 * By default every session (up to the explorer's cap), so the views draw all
 * the data. A pick the visitor chose (`pickChosen: true`, saved by the
 * explorer when they tick a session) wins, but only its ids that the data
 * has, since ids mean something only for the data they were picked from;
 * with none left, the default stands in again. A saved pick without
 * `pickChosen` was the page's own default and is not kept.
 */
export function startingPick(state: Record<string, unknown>, all: readonly string[], has: (id: string) => boolean): { picked: string[]; pickChosen: boolean } {
  const stored = state.pickChosen === true ? state.picked : null;
  const kept = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && has(id)).slice(0, EXPLORE_SESSION_CAP) : [];
  return kept.length ? { picked: kept, pickChosen: true } : { picked: all.slice(0, EXPLORE_SESSION_CAP), pickChosen: false };
}
