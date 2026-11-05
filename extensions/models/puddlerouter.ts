/**
 * @puddleworks/puddlerouter — decides what happens to a turn typed into Claude Code
 *
 * The `puddlerouter` workflow runs these methods for each turn the hook hands
 * over: `load` reads the turn file and stores the cleaned text, `alwaysLlm`
 * checks the phrases that always go to Claude, and a recipe is tried. Only if
 * none matched does Jev pick a route and answer a yes/no question on the
 * decision route. `reply` turns all that into what the hook should do.
 *
 * In live mode a confident yes or no blocks the turn with Jev's answer, so
 * Claude does not run. In shadow mode every reply passes, so Claude runs as
 * normal, and the reply records what live mode would have done.
 *
 * Output: a `turn` resource (the cleaned text and its `sourceRef`) and a
 * `reply` resource (`{action, text}` plus the route it came from).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { type Config, loadConfig, parseConfig } from "./_lib/config.ts";
import { allowPredicate } from "./_lib/allowlist.ts";
import { type Exec, searchQuery } from "./_lib/search.ts";
import {
  checkMerged,
  matchMerged,
  type MergedCheck,
  MergedCheckSchema,
  type RunModel,
} from "./_lib/merged.ts";

/** Jev's answer to a decision: unsure when it is not past the cut-off. */
export const ANSWERS = ["yes", "no", "unsure"] as const;
/** One answer. */
export type Answer = typeof ANSWERS[number];

/** The routes Jev picks between. */
export const ROUTES = ["deterministic", "decision", "llm"] as const;
/** One route. */
export type Route = typeof ROUTES[number];

/** The model takes no settings. */
export const GlobalArgsSchema = z.object({});
/** The settings of one model instance (none). */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `load`. */
export const LoadArgsSchema = z.object({
  turnFile: z.string().min(1).describe(
    "Path of the file holding the turn text. The hook writes it with mktemp.",
  ),
  maxChars: z.number().int().positive().default(2000).describe(
    "Longest cleaned text kept; the rest is cut off.",
  ),
});
/** The arguments `load` accepts. */
export type LoadArgs = z.infer<typeof LoadArgsSchema>;

/** What `load` stores. */
export const TurnSchema = z.object({
  /** The turn with pasted and fenced blocks replaced, trimmed and capped. */
  text: z.string(),
  /** `puddlerouter:` and 16 hex characters of the normalised text's hash. */
  sourceRef: z.string(),
  /** True when nothing is left after cleaning; the route step is skipped. */
  empty: z.boolean(),
  /** Pasted blocks replaced. */
  pasted: z.number().int(),
  /** Fenced code blocks replaced. */
  fenced: z.number().int(),
  /** True when the text was cut at `maxChars`. */
  truncated: z.boolean(),
  /** True when nothing was replaced or cut, so the text is the whole turn. */
  complete: z.boolean(),
  /** True when the turn looked like it held a secret; `text` is a placeholder. */
  withheld: z.boolean(),
  /** True when the turn started with `capture:`; `text` is without it. */
  capture: z.boolean(),
  loadedAt: z.iso.datetime(),
});
/** The stored turn. */
export type Turn = z.infer<typeof TurnSchema>;

/** Arguments for `search`. */
export const SearchArgsSchema = z.object({
  text: z.string().describe("The cleaned turn text."),
  sourceRef: z.string().optional().describe(
    "The turn's sourceRef; the key of the Capture request logged for it.",
  ),
  repoDir: z.string().min(1).default(".").describe(
    "The runtime repo; its puddlerouter.yaml adds allowlist entries.",
  ),
  capture: z.boolean().optional().describe(
    "The turn had a capture: prefix: skip the search, draft the request as is.",
  ),
});
/** The arguments `search` accepts. */
export type SearchArgs = z.infer<typeof SearchArgsSchema>;

const CandidatesSchema = z.array(
  z.object({ name: z.string(), description: z.string() }),
);

/**
 * What `recall` stores: Jev's earlier answers for this turn. Every field is
 * always present so the workflow's CEL needs no `has()` checks on it.
 */
export const RecallSchema = z.object({
  hasRoute: z.boolean(),
  choice: z.string(),
  confidence: z.number(),
  hasDecision: z.boolean(),
  yes: z.number(),
  hasPick: z.boolean(),
  pickChoice: z.string(),
  pickConfidence: z.number(),
  candidates: CandidatesSchema,
  cachedAt: z.string(),
});
/** The recalled answers. */
export type Recall = z.infer<typeof RecallSchema>;

/** What `reply` stores in the route cache, keyed by the turn. */
export const RouteCacheSchema = z.object({
  choice: z.string(),
  confidence: z.number(),
  yes: z.number().nullable(),
  pickChoice: z.string(),
  pickConfidence: z.number(),
  candidates: CandidatesSchema,
  cachedAt: z.iso.datetime(),
});
/** One route cache entry. */
export type RouteCache = z.infer<typeof RouteCacheSchema>;

/** The searched extensions `search` keeps for a day. */
export const SearchCacheSchema = z.object({
  found: CandidatesSchema,
  cachedAt: z.iso.datetime(),
});

/** Arguments for `merged`. */
export const MergedArgsSchema = z.object({
  text: z.string().describe("The cleaned turn text."),
});
/** The arguments `merged` accepts. */
export type MergedArgs = z.infer<typeof MergedArgsSchema>;

/** What `merged` stores: whether the turn only says "merged", and the check. */
export const MergedSchema = MergedCheckSchema.extend({
  /** True when the turn only says a PR merged; nothing else is set if not. */
  matched: z.boolean(),
  /** The PR numbers the turn names; empty for a bare "merged". */
  numbers: z.array(z.number().int()),
  checkedAt: z.iso.datetime(),
});

/** Arguments for `alwaysLlm`. */
export const AlwaysLlmArgsSchema = z.object({
  text: z.string().describe("The cleaned turn text."),
  repoDir: z.string().min(1).default(".").describe(
    "The runtime repo; its puddlerouter.yaml lists the phrases.",
  ),
});
/** The arguments `alwaysLlm` accepts. */
export type AlwaysLlmArgs = z.infer<typeof AlwaysLlmArgsSchema>;

/** What `alwaysLlm` stores: whether a listed phrase matched, and which. */
export const AlwaysLlmSchema = z.object({
  matched: z.boolean(),
  /** The pattern that matched; empty if none did. */
  pattern: z.string(),
  checkedAt: z.iso.datetime(),
});

/** Arguments for `recall`. */
export const RecallArgsSchema = z.object({
  sourceRef: z.string().describe("The turn's sourceRef; the route cache key."),
});
/** The arguments `recall` accepts. */
export type RecallArgs = z.infer<typeof RecallArgsSchema>;

/** Arguments for `reply`. */
export const ReplyArgsSchema = z.object({
  mode: z.enum(["shadow", "live"]).default("shadow").describe(
    "shadow logs the route and always passes; live acts on it.",
  ),
  sourceRef: z.string().describe("The turn's sourceRef."),
  capture: z.boolean().optional().describe(
    "The turn had a capture: prefix, so it goes to Capture whatever Jev or the cache says.",
  ),
  alwaysLlm: z.boolean().optional().describe(
    "The turn matched a listed phrase, so it goes to Claude whatever a recipe or the cache says.",
  ),
  choice: z.string().optional().describe(
    "Jev's route; empty or missing when the route step did not answer.",
  ),
  confidence: z.number().optional().describe("Jev's confidence in `choice`."),
  cutoff: z.number().min(0).max(1).default(0.7).describe(
    "Below this confidence the route is llm.",
  ),
  hookStartedAt: z.number().optional().describe(
    "When the hook started, in ms since the epoch; 0 or missing if unknown.",
  ),
  complete: z.boolean().default(false).describe(
    "The turn's `complete`. A decision is only answered for a complete turn.",
  ),
  yes: z.number().min(0).max(1).nullable().optional().describe(
    "Jev's probability that the answer is yes; null if it was not asked.",
  ),
  answerCutoff: z.number().min(0.5).max(1).default(0.8).describe(
    "A yes needs `yes` at or above this, a no at or below 1 minus this.",
  ),
  matchKind: z.enum(["recipe", "candidates", "none"]).optional().describe(
    "recipe if the `match` step matched, else the `search` step's kind.",
  ),
  recipeId: z.string().optional().describe("The matched recipe's id."),
  resultAction: z.string().optional().describe(
    "What `execute` did: ran, ask, would-ask or none; empty if it did not run.",
  ),
  resultOk: z.boolean().optional().describe(
    "True if `execute` gave an answer.",
  ),
  resultText: z.string().optional().describe(
    "The recipe's answer, or the plan it asks about.",
  ),
  confirmAction: z.string().optional().describe(
    "What `confirm` did with a plan: ran, refused or none; empty if it did not run.",
  ),
  confirmOk: z.boolean().optional().describe(
    "True if the confirmed recipe ran.",
  ),
  confirmText: z.string().optional().describe("The confirmed recipe's answer."),
  confirmError: z.string().optional().describe("Why `confirm` ran nothing."),
  confirmRecipeId: z.string().optional().describe(
    "The recipe the plan was for.",
  ),
  candidates: z.array(z.object({ name: z.string(), description: z.string() }))
    .optional().describe("Extensions found by search, in c1, c2, c3 order."),
  pickChoice: z.string().optional().describe("Jev's pick: c1, c2, c3 or none."),
  pickConfidence: z.number().optional().describe(
    "Jev's confidence in the pick.",
  ),
  requestUrl: z.string().optional().describe(
    "The Capture request logged for a turn nothing could answer; empty if none was.",
  ),
  recalled: RecallSchema.optional().describe(
    "The `recall` step's answers; used where a Jev step was skipped.",
  ),
  mergedMatched: z.boolean().optional().describe(
    "True when the `merged` step found the turn only says a PR merged.",
  ),
  mergedOk: z.boolean().optional().describe("True if the merged check ran."),
  mergedText: z.string().optional().describe(
    "What the merged check found and the steps to finish.",
  ),
  mergedSummary: z.string().optional().describe(
    "The merged check in one line, e.g. #12 clean.",
  ),
  mergedError: z.string().optional().describe(
    "Why the merged check failed; empty if it ran.",
  ),
});
/** The arguments `reply` accepts. */
export type ReplyArgs = z.infer<typeof ReplyArgsSchema>;

/** What `reply` stores, and what the hook reads. */
export const ReplySchema = z.object({
  /** block: answer instead of Claude; hint: add context; pass: do nothing. */
  action: z.enum(["block", "hint", "pass"]),
  /** The answer (block) or the context (hint). Empty for pass. */
  text: z.string(),
  /** What live mode does: the same as `action` unless the mode is shadow. */
  wouldAction: z.enum(["block", "hint", "pass"]),
  /** The text live mode uses; in shadow mode the hook shows it to the user. */
  wouldText: z.string(),
  mode: z.enum(["shadow", "live"]),
  /** The route taken after the cut-off; capture for a capture: turn. */
  route: z.enum([...ROUTES, "capture"]),
  /** Jev's own choice, before the cut-off; empty if it gave none. */
  choice: z.string(),
  confidence: z.number().nullable(),
  cutoff: z.number(),
  /** Jev's answer on the decision route; null if it was not asked. */
  answer: z.enum(ANSWERS).nullable(),
  /** Jev's probability of yes; null if it was not asked. */
  yes: z.number().nullable(),
  answerCutoff: z.number(),
  /** The recipe that answered on the deterministic route; empty if none. */
  recipe: z.string(),
  /** The extension hinted at on the deterministic route; empty if none. */
  extension: z.string(),
  /** The Capture request logged when nothing could answer the turn; empty if none. */
  request: z.string(),
  /** True when a Jev answer (route, decision or pick) came from the cache. */
  cached: z.boolean(),
  sourceRef: z.string(),
  /** Why the action was chosen. */
  reason: z.string(),
  /** Milliseconds from the hook starting to this reply; null if unknown. */
  elapsedMs: z.number().nullable(),
  repliedAt: z.iso.datetime(),
});
/** The stored reply. */
export type Reply = z.infer<typeof ReplySchema>;

/**
 * The first `alwaysLlm` pattern that matches what was typed, or "". Pasted and
 * fenced blocks don't count, and whitespace is collapsed.
 */
export function alwaysLlmHit(text: string, patterns: RegExp[]): string {
  const typed = text
    .replace(/\[(?:pasted text|code block)\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return patterns.find((re) => re.test(typed))?.source ?? "";
}

/** Why an `alwaysLlm` turn passed; the hook shows it as the turn's note. */
export const ALWAYS_LLM_REASON = "not routed (an always-LLM phrase)";

/** Lowercase, trim and collapse whitespace, so trivial edits hash the same. */
export function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Part of every route cache key. Bump it when the route, decide or pick
 * question changes (here and in the eval workflows), so old answers are not
 * reused for a different question.
 */
export const ROUTE_CACHE_VERSION = "v1";
const DAY_MS = 24 * 3600 * 1000;
const ROUTE_TTL_MS = 7 * DAY_MS;
const SEARCH_TTL_MS = DAY_MS;

/** Where cache entries live: this model's own swamp resources. */
export interface Store {
  read(name: string): Promise<Record<string, unknown> | null>;
  write(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<void>;
}

async function hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fresh(cachedAt: unknown, ttlMs: number, now: Date): boolean {
  const at = typeof cachedAt === "string" ? Date.parse(cachedAt) : NaN;
  return !Number.isNaN(at) && now.getTime() - at < ttlMs;
}

/** The route cache instance name for a turn's sourceRef. */
export function routeCacheKey(sourceRef: string): string {
  return `route-${ROUTE_CACHE_VERSION}-${sourceRef.replace(/^[^:]*:/, "")}`;
}

/** Jev's earlier answers for this turn; all `has*` false on any miss. */
export async function recallRoute(
  store: Store,
  sourceRef: string,
  now: Date = new Date(),
): Promise<Recall> {
  const miss: Recall = {
    hasRoute: false,
    choice: "",
    confidence: 0,
    hasDecision: false,
    yes: 0,
    hasPick: false,
    pickChoice: "",
    pickConfidence: 0,
    candidates: [],
    cachedAt: "",
  };
  try {
    const entry = RouteCacheSchema.safeParse(
      await store.read(routeCacheKey(sourceRef)),
    );
    if (!entry.success || !fresh(entry.data.cachedAt, ROUTE_TTL_MS, now)) {
      return miss;
    }
    const e = entry.data;
    return {
      hasRoute: e.choice !== "",
      choice: e.choice,
      confidence: e.confidence,
      hasDecision: e.yes !== null,
      yes: e.yes ?? 0,
      hasPick: e.pickChoice !== "",
      pickChoice: e.pickChoice,
      pickConfidence: e.pickConfidence,
      candidates: e.candidates,
      cachedAt: e.cachedAt,
    };
  } catch {
    return miss;
  }
}

/** The answers of the Jev steps, which `recall` can fill in. */
type Recallable = Pick<
  ReplyArgs,
  | "choice"
  | "confidence"
  | "yes"
  | "pickChoice"
  | "pickConfidence"
  | "candidates"
>;

/**
 * Fill the answers a skipped Jev step left empty from the recalled ones. A
 * fresh answer always wins. `cached` says whether any value came from the cache.
 */
export function withRecall<T extends Recallable>(
  args: T,
  recalled: Recall | undefined,
): { args: T & Recallable; cached: boolean } {
  if (!recalled) return { args, cached: false };
  const out = { ...args };
  let cached = false;
  if (!args.choice && recalled.hasRoute) {
    out.choice = recalled.choice;
    out.confidence = recalled.confidence;
    cached = true;
  }
  if ((args.yes === undefined || args.yes === null) && recalled.hasDecision) {
    out.yes = recalled.yes;
    cached = true;
  }
  if (!args.pickChoice && recalled.hasPick) {
    out.pickChoice = recalled.pickChoice;
    out.pickConfidence = recalled.pickConfidence;
    out.candidates = recalled.candidates;
    cached = true;
  }
  return { args: out, cached };
}

const PASTED =
  /<pasted_content id="[^"]*">[\s\S]*?(?:<\/pasted_content id="[^"]*">|$)/g;
const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|(?![\s\S]))/gm;

/** The turn text without pasted or fenced blocks, trimmed and capped. */
export function cleanTurn(
  raw: string,
  maxChars: number,
): { text: string; pasted: number; fenced: number; truncated: boolean } {
  let pasted = 0;
  let fenced = 0;
  const text = raw
    .replace(PASTED, () => {
      pasted++;
      return "[pasted text]";
    })
    .replace(FENCED, () => {
      fenced++;
      return "[code block]";
    })
    .trim();
  const truncated = text.length > maxChars;
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    pasted,
    fenced,
    truncated,
  };
}

/** `puddlerouter:<hash>`, the same for the same normalised text. */
export async function sourceRef(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalise(text)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `puddlerouter:${hex.slice(0, 16)}`;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*\s*[:=]\s*\S+/i,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\b[0-9a-f]{32,}\b/i,
];

/** True if the text looks like it holds a token, key, password, email or hash. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** What `text` is replaced with when the turn looks like it holds a secret. */
export const WITHHELD_TEXT = "[withheld: looks like it contains a secret]";

const ONLY_PLACEHOLDERS = /^(\[(pasted text|code block)\]\s*)*$/;
const CAPTURE_PREFIX = /^\s*capture:\s*/i;

/**
 * The turn to store for `raw`: cleaned, hashed and stamped `now`. A leading
 * `capture:` is taken off and marks the turn for Capture.
 */
export async function loadTurn(
  text: string,
  maxChars: number,
  now: Date = new Date(),
): Promise<Turn> {
  const capture = CAPTURE_PREFIX.test(text);
  const raw = text.replace(CAPTURE_PREFIX, "");
  const withheld = looksSecret(raw);
  const cleaned = withheld
    ? { text: WITHHELD_TEXT, pasted: 0, fenced: 0, truncated: false }
    : cleanTurn(raw, maxChars);
  return {
    ...cleaned,
    sourceRef: await sourceRef(cleaned.text),
    empty: !withheld && ONLY_PLACEHOLDERS.test(cleaned.text),
    complete: !withheld && cleaned.pasted === 0 && cleaned.fenced === 0 &&
      !cleaned.truncated,
    withheld,
    capture,
    loadedAt: now.toISOString(),
  };
}

/** Jev's route if it is a known one at or above the cut-off, else llm. */
export function effectiveRoute(
  choice: string | undefined,
  confidence: number | undefined,
  cutoff: number,
): Route {
  if (!ROUTES.includes(choice as Route)) return "llm";
  if (confidence === undefined || confidence < cutoff) return "llm";
  return choice as Route;
}

/** yes or no if Jev's probability of yes is past the cut-off, else unsure. */
export function decisionAnswer(yes: number, answerCutoff: number): Answer {
  if (yes >= answerCutoff) return "yes";
  if (1 - yes >= answerCutoff) return "no";
  return "unsure";
}

/** The text shown to the user when a decision blocks the turn. */
export function decisionText(answer: "yes" | "no", yes: number): string {
  const sure = Math.round((answer === "yes" ? yes : 1 - yes) * 100);
  return `Jev: ${answer} (${sure}% sure).\n` +
    "Answered by puddlerouter without Claude. To ask Claude instead, " +
    "send the prompt again starting with llm:";
}

/** Extensions the deterministic route offers Jev to pick from. */
const MAX_CANDIDATES = 3;
const NO_CANDIDATE = "No such candidate.";

/** What `search` stores. */
export const SearchSchema = z.object({
  /** candidates: search found extensions; none: it found nothing allowed. */
  kind: z.enum(["candidates", "none"]),
  /** The words searched for. */
  query: z.string(),
  candidates: z.array(z.object({ name: z.string(), description: z.string() })),
  /** Criteria for Jev's pick: c1..c3 and none. */
  criteria: z.record(z.string(), z.string()),
  /** The Capture request to log if nothing can answer the turn. */
  requestTitle: z.string(),
  requestDescription: z.string(),
  /** Idempotency key: the turn's sourceRef, so one request per distinct turn. */
  requestKey: z.string(),
  searchedAt: z.iso.datetime(),
});
/** The stored search. */
export type Search = z.infer<typeof SearchSchema>;

function criteriaFor(candidates: Search["candidates"]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (let i = 0; i < MAX_CANDIDATES; i++) {
    const c = candidates[i];
    criteria[`c${i + 1}`] = c
      ? `${c.name}: ${c.description || "no description"}`
      : NO_CANDIDATE;
  }
  criteria.none =
    "None of these can answer it, or it needs judgement or data not held anywhere.";
  return criteria;
}

/**
 * The Capture request to log for a turn no recipe or extension can answer.
 * Capture shows the description as plain text, so it has no Markdown.
 */
export function requestDraft(
  text: string,
  sourceRef: string,
  query: string,
  candidates: Search["candidates"],
): { title: string; description: string; key: string } {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const title = `Recipe wanted: ${oneLine.slice(0, 80)}`;
  const searched = query || "nothing (no content words)";
  const found = candidates.length
    ? candidates.map((c) => c.name).join(", ")
    : "none on the allowlist";
  const description = [
    text,
    "",
    "puddlerouter routed this turn deterministic, but no built-in recipe or",
    "allowlisted extension could answer it.",
    `Searched for: ${searched}`,
    `Found: ${found}`,
    `Logged by puddlerouter (${sourceRef}).`,
  ].join("\n");
  return { title, description, key: sourceRef };
}

/**
 * The search for a turn sent with a capture: prefix: nothing is searched, and
 * the request is the turn as typed. Capture shows the description as plain
 * text, so it has no Markdown.
 */
export function captureSearch(
  text: string,
  sourceRef: string,
  now: Date = new Date(),
): Search {
  const description = [
    text,
    "",
    "Sent to Capture with a capture: prefix.",
    `Logged by puddlerouter (${sourceRef}).`,
  ].join("\n");
  return {
    kind: "none",
    query: "",
    candidates: [],
    criteria: criteriaFor([]),
    requestTitle: text.replace(/\s+/g, " ").trim().slice(0, 80),
    requestDescription: description,
    requestKey: sourceRef,
    searchedAt: now.toISOString(),
  };
}

async function searchJson(exec: Exec, args: string[]): Promise<unknown> {
  try {
    const res = await exec(args);
    return res.code === 0 ? JSON.parse(res.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Extensions swamp finds for the query, before the allowlist. A search from
 * the last day is reused; a failed search is never stored.
 */
async function searchExtensions(
  query: string,
  exec: Exec,
  now: Date,
  store?: Store,
): Promise<Search["candidates"]> {
  const key = `search-${(await hex(query)).slice(0, 32)}`;
  try {
    const entry = SearchCacheSchema.safeParse(await store?.read(key));
    if (entry.success && fresh(entry.data.cachedAt, SEARCH_TTL_MS, now)) {
      return entry.data.found;
    }
  } catch { /* read failed: search instead */ }
  const [local, registry] = await Promise.all([
    searchJson(exec, ["model", "type", "search", query, "--json"]),
    searchJson(exec, ["extension", "search", query, "--json"]),
  ]);
  const found = new Map<string, string>();
  const rows = (registry as { extensions?: unknown } | null)?.extensions;
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (typeof r?.name === "string") {
        found.set(
          r.name,
          typeof r.description === "string" ? r.description : "",
        );
      }
    }
  }
  const types = (local as { results?: unknown } | null)?.results;
  if (Array.isArray(types)) {
    for (const t of types) {
      if (typeof t?.raw === "string" && !found.has(t.raw)) found.set(t.raw, "");
    }
  }
  const list = [...found].map(([name, description]) => ({ name, description }));
  if (store && local !== null && registry !== null) {
    try {
      await store.write("searchCache", key, {
        found: list,
        cachedAt: now.toISOString(),
      });
    } catch { /* not cached: the next turn searches again */ }
  }
  return list;
}

/**
 * The extensions swamp finds for a deterministic turn's content words, on the
 * allowlist. Search failing is not an error.
 */
export async function searchTurn(
  text: string,
  exec: Exec,
  now: Date = new Date(),
  sourceRef = "",
  config: Pick<Config, "allowlist"> = parseConfig(""),
  store?: Store,
): Promise<Search> {
  const allow = allowPredicate(config.allowlist);
  const query = searchQuery(text);
  const found = query ? await searchExtensions(query, exec, now, store) : [];
  const candidates = found.filter(({ name }) => allow(name)).slice(
    0,
    MAX_CANDIDATES,
  );
  const d = requestDraft(text, sourceRef, query, candidates);
  return {
    kind: candidates.length ? "candidates" : "none",
    query,
    candidates,
    criteria: criteriaFor(candidates),
    requestTitle: d.title,
    requestDescription: d.description,
    requestKey: d.key,
    searchedAt: now.toISOString(),
  };
}

/**
 * Runs the `swamp` on the path; used by `search`. Arguments are never joined
 * into a shell line, and a search passes at most four words of `[a-z0-9_-]`
 * (see README, "Subprocesses").
 */
export const swampExec: Exec = async (args) => {
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command("swamp", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

/** The text shown when a recipe answers the turn. */
export function recipeText(recipeId: string, answer: string): string {
  return `${answer}\n\nAnswered by puddlerouter (recipe ${recipeId}) without ` +
    "Claude. To ask Claude instead, send the prompt again starting with llm:";
}

/** The text shown when a recipe that makes changes asks before it runs. */
export function planText(recipeId: string, plan: string): string {
  return `${plan}\n\nAsked by puddlerouter (recipe ${recipeId}) without Claude. ` +
    "To ask Claude instead, send the prompt again starting with llm:";
}

/** The context added when a yes ran a recipe and the recipe failed. */
export function confirmFailedHint(recipeId: string, error: string): string {
  return `puddlerouter: the user said yes to recipe ${recipeId} and it ran, ` +
    `but it failed: ${error}\nTell the user. Do not run it again unasked, ` +
    "because it may have made some of its changes.";
}

/** The context added when a yes ran nothing. */
export function confirmRefusedHint(recipeId: string, error: string): string {
  return `puddlerouter: the user said yes to recipe ${recipeId}, but it did ` +
    `not run: ${error}\nTell the user nothing changed. Do not make the change ` +
    "yourself unless they ask.";
}

/**
 * The text shown when a request was logged: because no extension could
 * answer the turn, or (`unanswered` false) because it had a capture: prefix.
 */
export function requestText(url: string, unanswered = true): string {
  return (unanswered
    ? "No swamp recipe or extension can answer this yet. Logged a request "
    : "Logged a request ") +
    `in Capture: ${url}\n\n` +
    "Answered by puddlerouter without Claude. To ask Claude instead, send " +
    "the prompt again starting with llm:";
}

/** The context added when a capture: turn could not be logged. */
export const CAPTURE_FAILED_HINT =
  "puddlerouter: the user started this turn with capture:, which asks for it " +
  "to be logged as a request in Capture rather than done now, but it was not " +
  "logged. Tell the user it was not logged and do not act on it.";

/** The context added when search found an extension but no recipe covers it. */
export function extensionHint(name: string): string {
  return `puddlerouter: this looks answerable by a program. The swamp ` +
    `extension ${name} may cover it: run \`swamp model type describe ${name}\` ` +
    `(\`swamp extension pull ${name}\` first if it is missing) and use it ` +
    "rather than raw tools. If it does not cover this, ask the user whether to " +
    "log a recipe-wanted request in Capture.";
}

/** The arguments `buildReply` needs; `complete` and `answerCutoff` default. */
export type BuildReplyArgs =
  & Omit<ReplyArgs, "mode" | "cutoff" | "complete" | "answerCutoff">
  & {
    mode: ReplyArgs["mode"];
    cutoff: number;
    complete?: boolean;
    answerCutoff?: number;
    cached?: boolean;
  };

/**
 * What the hook should do with the turn. Live mode blocks a decision Jev
 * answered past the answer cut-off; anything else passes. Shadow mode always
 * passes and records the live action in `wouldAction`.
 */
export function buildReply(
  args: BuildReplyArgs,
  now: Date = new Date(),
): Reply {
  const choice = args.choice ?? "";
  const merged = args.mergedMatched === true;
  const capture = args.capture === true;
  const confirmAction = args.confirmAction ?? "";
  const confirmed = confirmAction === "ran" || confirmAction === "refused";
  const alwaysLlm = args.alwaysLlm === true;
  const recipeId = !alwaysLlm && args.matchKind === "recipe"
    ? args.recipeId ?? ""
    : "";
  const route: Reply["route"] = capture
    ? "capture"
    : merged || confirmed || recipeId
    ? "deterministic"
    : alwaysLlm
    ? "llm"
    : effectiveRoute(choice, args.confidence, args.cutoff);
  const complete = args.complete ?? false;
  const answerCutoff = args.answerCutoff ?? 0.8;
  const yes = route === "decision" && complete ? args.yes ?? null : null;
  const answer = yes === null ? null : decisionAnswer(yes, answerCutoff);
  let wouldAction: Reply["action"] = "pass";
  let text = "";
  let recipe = "";
  let extension = "";
  let request = "";
  let reason: string;
  if (confirmed) {
    const id = args.confirmRecipeId ?? "";
    const error = args.confirmError ?? "";
    recipe = id;
    if (confirmAction === "refused") {
      wouldAction = "hint";
      text = confirmRefusedHint(id, error);
      reason = `a yes ran nothing: ${error}`;
    } else if (args.confirmOk && args.confirmText) {
      wouldAction = "block";
      text = recipeText(id, args.confirmText);
      reason = `recipe ${id} answered after a yes`;
    } else {
      wouldAction = "hint";
      text = confirmFailedHint(id, error);
      reason = `recipe ${id} failed after a yes`;
    }
  } else if (capture) {
    if (args.mode === "shadow") {
      wouldAction = "block";
      reason = "capture: prefix, would log a request";
    } else if (args.requestUrl) {
      wouldAction = "block";
      request = args.requestUrl;
      text = requestText(args.requestUrl, false);
      reason = "capture: prefix, request logged";
    } else {
      wouldAction = "hint";
      text = CAPTURE_FAILED_HINT;
      reason = "capture: prefix, no request logged";
    }
  } else if (merged) {
    // Claude still does the clean-up, so the steps go in as context.
    recipe = "merged";
    if (args.mergedOk && args.mergedText) {
      wouldAction = "hint";
      text = args.mergedText;
      reason = `merged: ${args.mergedSummary ?? ""}`;
    } else reason = `merged check failed: ${args.mergedError ?? ""}`;
  } else if (alwaysLlm) reason = ALWAYS_LLM_REASON;
  else if (recipeId) {
    recipe = recipeId;
    const asks = args.resultAction === "ask" ||
      args.resultAction === "would-ask";
    if (asks && args.resultOk && args.resultText) {
      wouldAction = "block";
      text = planText(recipeId, args.resultText);
      reason = args.resultAction === "ask"
        ? `recipe ${recipeId} asked before running`
        : `recipe ${recipeId} would ask before running`;
    } else if (
      !asks && args.resultAction !== "none" && args.resultOk &&
      args.resultText
    ) {
      wouldAction = "block";
      text = recipeText(recipeId, args.resultText);
      reason = `recipe ${recipeId} answered`;
    } else reason = `recipe ${recipeId} failed`;
  } else if (!choice) reason = "no route answer";
  else if (route !== choice) reason = "confidence below cut-off";
  else if (route === "llm") reason = "llm route";
  else if (route === "deterministic") {
    const picked = /^c([1-9])$/.exec(args.pickChoice ?? "");
    const candidate = picked ? args.candidates?.[Number(picked[1]) - 1] : null;
    if (
      args.matchKind === "candidates" && candidate &&
      (args.pickConfidence ?? 0) >= args.cutoff
    ) {
      wouldAction = "hint";
      extension = candidate.name;
      text = extensionHint(candidate.name);
      reason = `extension ${candidate.name}, no recipe`;
    } else if (args.mode === "shadow") {
      wouldAction = "block";
      reason = "no extension found, would log a request";
    } else if (args.requestUrl) {
      wouldAction = "block";
      request = args.requestUrl;
      text = requestText(args.requestUrl);
      reason = "no extension found, request logged";
    } else reason = "no extension found, no request logged";
  } else if (!complete) reason = "decision text not in the turn";
  else if (answer === null) reason = "no decision answer";
  else if (answer === "unsure") reason = "decision unsure";
  else {
    wouldAction = "block";
    text = decisionText(answer, yes as number);
    reason = `decision answered ${answer}`;
  }
  const shadow = args.mode === "shadow";
  return {
    action: shadow ? "pass" : wouldAction,
    text: shadow ? "" : text,
    wouldAction,
    wouldText: text,
    mode: args.mode,
    route,
    choice,
    confidence: choice ? args.confidence ?? null : null,
    cutoff: args.cutoff,
    answer,
    yes,
    answerCutoff,
    recipe,
    extension,
    request,
    cached: args.cached ?? false,
    sourceRef: args.sourceRef,
    reason: shadow ? `shadow: ${reason}` : reason,
    elapsedMs: args.hookStartedAt ? now.getTime() - args.hookStartedAt : null,
    repliedAt: now.toISOString(),
  };
}

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
  /** Runs another model's method in process; `merged` uses it. */
  runModel?: RunModel;
}

/** A store over the method's own swamp resources. */
function resourceStore(context: MethodContext): Store {
  return {
    read: (name) => context.readResource(name),
    write: async (spec, name, data) => {
      await context.writeResource(spec, name, data);
    },
  };
}

/** The model type: `load`, `alwaysLlm`, `recall`, `merged`, `search` and `reply`. */
export const model = {
  type: "@puddleworks/puddlerouter",
  version: "2026.11.05.1",
  upgrades: [
    {
      toVersion: "2026.11.04.1",
      description:
        "Recipes moved to @puddleworks/recipes; match became search. No settings changed.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.05.1",
      description:
        "Recipes are tried before Jev, and alwaysLlm phrases go straight to Claude. No settings changed.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    turn: {
      description: "The cleaned text of the last turn and its sourceRef.",
      schema: TurnSchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
    reply: {
      description: "What the hook should do with the last turn, and why.",
      schema: ReplySchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
    search: {
      description:
        "The extensions a search found for a deterministic turn, and the request to log.",
      schema: SearchSchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
    recall: {
      description: "Jev's earlier answers for the turn, from the route cache.",
      schema: RecallSchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
    routeCache: {
      description: "Jev's route, decision and pick for a turn, kept 7 days.",
      schema: RouteCacheSchema,
      lifetime: "7d" as const,
      garbageCollection: 1,
    },
    searchCache: {
      description: "Extensions a search found, kept 1 day.",
      schema: SearchCacheSchema,
      lifetime: "1d" as const,
      garbageCollection: 1,
    },
    merged: {
      description:
        "Whether the turn only says a PR merged, and what checking it found.",
      schema: MergedSchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
    alwaysLlm: {
      description:
        "Whether the turn matched a phrase that always goes to Claude.",
      schema: AlwaysLlmSchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
  },
  methods: {
    alwaysLlm: {
      description:
        "Check the turn against the alwaysLlm list in puddlerouter.yaml; store `alwaysLlm`.",
      arguments: AlwaysLlmArgsSchema,
      execute: async (args: AlwaysLlmArgs, context: MethodContext) => {
        const config = await loadConfig(args.repoDir);
        if (config.errors.length) {
          context.logger.info("puddlerouter.yaml: {errors}", {
            errors: config.errors.join("; "),
          });
        }
        const pattern = alwaysLlmHit(args.text, config.alwaysLlm);
        const handle = await context.writeResource("alwaysLlm", "alwaysLlm", {
          matched: pattern !== "",
          pattern,
          checkedAt: new Date().toISOString(),
        });
        context.logger.info("Always-LLM pattern: {pattern}", {
          pattern: pattern || "none",
        });
        return { dataHandles: [handle] };
      },
    },
    merged: {
      description:
        "If the turn only says a PR merged, check the PR and its worktree " +
        "(read-only, via @swamp/git and @webframp/github); store `merged`.",
      arguments: MergedArgsSchema,
      execute: async (args: MergedArgs, context: MethodContext) => {
        const hit = matchMerged(args.text);
        const empty = {
          ok: false,
          repo: "",
          mainCheckout: "",
          prs: [],
          checked: [],
          summary: "",
          text: "",
          error: "",
        };
        let check: MergedCheck = { ...empty };
        if (hit && context.runModel) {
          context.logger.info("Checking merged PRs {numbers}", {
            numbers: hit.numbers.join(", "),
          });
          check = await checkMerged(hit.numbers, context.runModel);
        } else if (hit) check.error = "runModel is not available";
        const handle = await context.writeResource("merged", "merged", {
          ...check,
          matched: hit !== null,
          numbers: hit?.numbers ?? [],
          checkedAt: new Date().toISOString(),
        });
        context.logger.info("Merged {matched}: {summary}", {
          matched: hit !== null,
          summary: check.summary || check.error,
        });
        return { dataHandles: [handle] };
      },
    },
    search: {
      description:
        "Search for extensions that could answer a turn; store `search`.",
      arguments: SearchArgsSchema,
      execute: async (args: SearchArgs, context: MethodContext) => {
        context.logger.info("Searching for turn", {});
        if (args.capture) {
          const search = captureSearch(args.text, args.sourceRef ?? "");
          const handle = await context.writeResource(
            "search",
            "search",
            search,
          );
          context.logger.info("Capture: turn, nothing searched", {});
          return { dataHandles: [handle] };
        }
        const config = await loadConfig(args.repoDir);
        if (config.errors.length) {
          context.logger.info("puddlerouter.yaml: {errors}", {
            errors: config.errors.join("; "),
          });
        }
        const search = await searchTurn(
          args.text,
          swampExec,
          new Date(),
          args.sourceRef,
          config,
          resourceStore(context),
        );
        const handle = await context.writeResource("search", "search", search);
        context.logger.info("Search {kind} for {query}", {
          kind: search.kind,
          query: search.query,
        });
        return { dataHandles: [handle] };
      },
    },
    load: {
      description: "Read a turn file, clean it and store it as `turn`.",
      arguments: LoadArgsSchema,
      execute: async (args: LoadArgs, context: MethodContext) => {
        context.logger.info("Loading turn", {});
        const raw = await Deno.readTextFile(args.turnFile);
        const turn = await loadTurn(raw, args.maxChars);
        const handle = await context.writeResource("turn", "turn", turn);
        context.logger.info("Loaded turn {sourceRef}", {
          sourceRef: turn.sourceRef,
        });
        return { dataHandles: [handle] };
      },
    },
    recall: {
      description:
        "Read Jev's earlier answers for the turn from the route cache; store `recall`.",
      arguments: RecallArgsSchema,
      execute: async (args: RecallArgs, context: MethodContext) => {
        const recalled = await recallRoute(
          resourceStore(context),
          args.sourceRef,
        );
        const handle = await context.writeResource(
          "recall",
          "recall",
          recalled,
        );
        context.logger.info("Recalled route {hasRoute} for {sourceRef}", {
          hasRoute: recalled.hasRoute,
          sourceRef: args.sourceRef,
        });
        return { dataHandles: [handle] };
      },
    },
    reply: {
      description: "Turn the route into a reply for the hook; store `reply`.",
      arguments: ReplyArgsSchema,
      execute: async (args: ReplyArgs, context: MethodContext) => {
        context.logger.info("Replying for {sourceRef}", {
          sourceRef: args.sourceRef,
        });
        const { recalled, ...fresh } = args;
        // These turns never reached Jev, so an earlier answer has no say.
        const notRouted = args.alwaysLlm === true ||
          (args.matchKind === "recipe" && Boolean(args.recipeId));
        const merged = withRecall(fresh, notRouted ? undefined : recalled);
        const reply = buildReply({
          ...merged.args,
          mode: args.mode ?? "shadow",
          cutoff: args.cutoff ?? 0.7,
          cached: merged.cached,
        });
        const handles = [
          await context.writeResource("reply", "reply", reply),
        ];
        const m = merged.args;
        const somethingNew = Boolean(fresh.choice) || fresh.yes != null ||
          Boolean(fresh.pickChoice);
        if (m.choice && somethingNew) {
          const entry: RouteCache = {
            choice: m.choice,
            confidence: m.confidence ?? 0,
            yes: m.yes ?? null,
            pickChoice: m.pickChoice ?? "",
            pickConfidence: m.pickConfidence ?? 0,
            candidates: m.pickChoice ? m.candidates ?? [] : [],
            cachedAt: new Date().toISOString(),
          };
          handles.push(
            await context.writeResource(
              "routeCache",
              routeCacheKey(args.sourceRef),
              entry,
            ),
          );
        }
        context.logger.info("Reply {action} for {sourceRef} ({reason})", {
          action: reply.action,
          sourceRef: reply.sourceRef,
          reason: reply.reason,
        });
        return { dataHandles: handles };
      },
    },
  },
};
