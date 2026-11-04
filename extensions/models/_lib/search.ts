/**
 * What the router needs to search the registry for a turn: the runner for
 * `swamp` and the turn's content words.
 *
 * @module
 */

/** Result of running one `swamp` command. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `swamp <args>`; the real one is built in the model, tests use a fake. */
export type Exec = (args: string[]) => Promise<ExecResult>;

const STOPWORDS = new Set(
  `all and any about are can could did does for from get give had has have how
  its list many much show tell that the their there these this those was what
  whats with would you your please our not but which when where who why will
  into out off than then them they been being also just some such only own
  same too very more most other another each every both few`
    .split(/\s+/),
);

/** The content words of a turn, for searching the registry; at most four. */
export function searchQuery(text: string): string {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    seen.add(w);
  }
  return [...seen].slice(0, 4).join(" ");
}
