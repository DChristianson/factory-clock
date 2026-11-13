import { creditCite, VisualizerEntry } from '../catalog';

/**
 * The page's Credits list (docs/workspace-explorer.md, "Credits"): one row per
 * view, in carousel order, with every work it draws on. Built from the catalog
 * as plain data here; page.ts turns it into DOM.
 */
export interface CreditLine {
  /** "Shneiderman 1992": the short form the puck's After line shows. */
  cite: string;
  /** The rest of the line: the work, who by in full, and what was taken. */
  detail: string;
  url?: string;
  relation: string;
}

export interface CreditRow {
  id: string;
  title: string;
  credits: CreditLine[];
}

export function creditRows(catalog: VisualizerEntry[]): CreditRow[] {
  return catalog.map((entry) => ({
    id: entry.id,
    title: entry.title,
    credits: (entry.credits ?? []).map((c) => ({
      cite: creditCite(c),
      detail: `${c.work}, ${c.by}${c.note ? `. ${c.note}` : ''}`,
      url: c.url,
      relation: c.relation,
    })),
  }));
}
