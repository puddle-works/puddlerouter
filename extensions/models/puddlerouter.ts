/**
 * @puddleworks/puddlerouter — decides what happens to a turn typed into Claude Code
 *
 * The `puddlerouter` workflow runs these methods for each turn the hook hands
 * over: `load` reads the turn file and stores the cleaned text, Jev picks a
 * route, Jev answers a yes/no question on the decision route, and `reply`
 * turns the route into what the hook should do.
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
import {
  type Config,
  loadConfig,
  parseConfig,
  parseRecipe,
} from "./_lib/config.ts";
import { syncPacks } from "./_lib/packs.ts";
import { allowPredicate } from "./_lib/allowlist.ts";
import {
  type Exec,
  matchRecipe,
  RECIPES,
  runRecipe,
  searchQuery,
} from "./_lib/recipes.ts";

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
  loadedAt: z.iso.datetime(),
});
/** The stored turn. */
export type Turn = z.infer<typeof TurnSchema>;

/** Arguments for `match`. */
export const MatchArgsSchema = z.object({
  text: z.string().describe("The cleaned turn text."),
  sourceRef: z.string().optional().describe(
    "The turn's sourceRef; the key of the issue raised for it.",
  ),
  repoDir: z.string().min(1).default(".").describe(
    "The runtime repo; its puddlerouter.yaml adds allowlist entries and recipes.",
  ),
});
/** The arguments `match` accepts. */
export type MatchArgs = z.infer<typeof MatchArgsSchema>;

/** Arguments for `execute`. */
export const ExecuteArgsSchema = z.object({
  recipeId: z.string().min(1),
  captures: z.array(z.string()).default([]),
  repoDir: z.string().min(1).default(".").describe(
    "The swamp repo the recipe's extension is pulled into.",
  ),
});
/** The arguments `execute` accepts. */
export type ExecuteArgs = z.infer<typeof ExecuteArgsSchema>;

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

/** The searched extensions `match` keeps for a day. */
export const SearchCacheSchema = z.object({
  found: CandidatesSchema,
  cachedAt: z.iso.datetime(),
});

/** A successful recipe answer kept for the recipe's `cacheFor`. */
export const ResultCacheSchema = z.object({
  text: z.string(),
  cachedAt: z.iso.datetime(),
});

/** The recipes of the synced packs, as `sync` leaves them for `match`. */
export const RecipeIndexSchema = z.object({
  recipes: z.array(z.object({
    pack: z.string(),
    recipe: z.record(z.string(), z.unknown()),
  })),
  packs: z.array(z.object({ name: z.string(), version: z.string() })),
  errors: z.array(z.string()),
  syncedAt: z.iso.datetime(),
});

/** Arguments for `sync`. */
export const SyncArgsSchema = z.object({
  repoDir: z.string().min(1).default(".").describe(
    "The swamp repo the packs are pulled into; its puddlerouter.yaml sets the allowlist.",
  ),
});
/** The arguments `sync` accepts. */
export type SyncArgs = z.infer<typeof SyncArgsSchema>;

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
    "The `match` step's kind; missing if it did not run.",
  ),
  recipeId: z.string().optional().describe("The matched recipe's id."),
  resultOk: z.boolean().optional().describe("True if the recipe ran."),
  resultText: z.string().optional().describe("The recipe's answer."),
  candidates: z.array(z.object({ name: z.string(), description: z.string() }))
    .optional().describe("Extensions found by search, in c1, c2, c3 order."),
  pickChoice: z.string().optional().describe("Jev's pick: c1, c2, c3 or none."),
  pickConfidence: z.number().optional().describe(
    "Jev's confidence in the pick.",
  ),
  issueUrl: z.string().optional().describe(
    "The issue raised for a turn nothing could answer; empty if none was.",
  ),
  recalled: RecallSchema.optional().describe(
    "The `recall` step's answers; used where a Jev step was skipped.",
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
  mode: z.enum(["shadow", "live"]),
  /** The route taken after the cut-off. */
  route: z.enum(ROUTES),
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
  /** The issue raised when nothing could answer the turn; empty if none. */
  issue: z.string(),
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
/** The instance name of the one recipe index. */
export const RECIPE_INDEX = "recipe-index";

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

/** The turn to store for `raw`: cleaned, hashed and stamped `now`. */
export async function loadTurn(
  raw: string,
  maxChars: number,
  now: Date = new Date(),
): Promise<Turn> {
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

/** What `match` stores. */
export const MatchSchema = z.object({
  /** recipe: a built-in recipe fits; candidates: search found extensions. */
  kind: z.enum(["recipe", "candidates", "none"]),
  recipeId: z.string(),
  /** Digits the recipe's pattern captured. */
  captures: z.array(z.string()),
  /** The words searched for; empty for a recipe. */
  query: z.string(),
  candidates: z.array(z.object({ name: z.string(), description: z.string() })),
  /** Criteria for Jev's pick: c1..c3 and none. */
  criteria: z.record(z.string(), z.string()),
  /** The issue to raise if nothing can answer the turn. */
  issueTitle: z.string(),
  issueBody: z.string(),
  /** Idempotency key: the turn's sourceRef, so one issue per distinct turn. */
  issueKey: z.string(),
  matchedAt: z.iso.datetime(),
});
/** The stored match. */
export type Match = z.infer<typeof MatchSchema>;

/** What `execute` stores. */
export const ResultSchema = z.object({
  recipeId: z.string(),
  ok: z.boolean(),
  text: z.string(),
  error: z.string(),
  /** True when the answer came from the result cache. */
  cached: z.boolean(),
  ranAt: z.iso.datetime(),
});
/** The stored result. */
export type RecipeOutcome = z.infer<typeof ResultSchema>;

function criteriaFor(candidates: Match["candidates"]): Record<string, string> {
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

/** The issue to raise for a turn no recipe or extension can answer. */
export function issueDraft(
  text: string,
  sourceRef: string,
  query: string,
  candidates: Match["candidates"],
): { title: string; body: string; key: string } {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const title = `Recipe wanted: ${oneLine.slice(0, 80)}`;
  const searched = query ? `\`${query}\`` : "nothing (no content words)";
  const found = candidates.length
    ? candidates.map((c) => `- ${c.name}`).join("\n")
    : "- none on the allowlist";
  const body = [
    "A turn was routed `deterministic` but no built-in recipe or allowlisted",
    "extension could answer it.",
    "",
    "Turn:",
    "",
    text.replace(/^/gm, "> "),
    "",
    `Searched for: ${searched}`,
    "",
    "Found:",
    found,
    "",
    `Raised by puddlerouter (${sourceRef}).`,
  ].join("\n");
  return { title, body, key: sourceRef };
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
): Promise<Match["candidates"]> {
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
 * Find how to answer a deterministic turn: a built-in recipe, else the
 * extensions swamp finds for its content words. Search failing is not an error.
 */
export async function findMatch(
  text: string,
  exec: Exec,
  now: Date = new Date(),
  sourceRef = "",
  config: Pick<Config, "allowlist" | "recipes"> = parseConfig(""),
  store?: Store,
): Promise<Match> {
  const allow = allowPredicate(config.allowlist);
  const draft = (query: string, candidates: Match["candidates"]) => {
    const d = issueDraft(text, sourceRef, query, candidates);
    return { issueTitle: d.title, issueBody: d.body, issueKey: d.key };
  };
  const base = {
    recipeId: "",
    captures: [] as string[],
    query: "",
    candidates: [] as Match["candidates"],
    matchedAt: now.toISOString(),
  };
  const hit = matchRecipe(text, [...config.recipes, ...RECIPES]);
  if (hit) {
    return {
      ...base,
      kind: "recipe",
      recipeId: hit.recipe.id,
      captures: hit.captures,
      criteria: criteriaFor([]),
      ...draft("", []),
    };
  }
  const query = searchQuery(text);
  if (!query) {
    return {
      ...base,
      kind: "none",
      criteria: criteriaFor([]),
      ...draft("", []),
    };
  }
  const found = await searchExtensions(query, exec, now, store);
  const candidates = found.filter(({ name }) => allow(name)).slice(
    0,
    MAX_CANDIDATES,
  );
  return {
    ...base,
    kind: candidates.length ? "candidates" : "none",
    query,
    candidates,
    criteria: criteriaFor(candidates),
    ...draft(query, candidates),
  };
}

/**
 * The config plus the recipes of the synced packs, after the local ones. A
 * missing index adds nothing; a stale one is still used. A pack recipe that
 * clashes, is no longer allowed or does not compile is dropped. `notes` says
 * what was off; `match` never pulls.
 */
export async function withPacks(
  config: Config,
  store: Store,
  now: Date = new Date(),
): Promise<{ config: Config; notes: string[] }> {
  const notes: string[] = [];
  let raw: Record<string, unknown> | null = null;
  try {
    raw = await store.read(RECIPE_INDEX);
  } catch { /* unreadable: no pack recipes */ }
  if (raw === null) return { config, notes };
  const index = RecipeIndexSchema.safeParse(raw);
  if (!index.success) {
    return { config, notes: ["recipe index is not valid; ignored"] };
  }
  if (!fresh(index.data.syncedAt, DAY_MS, now)) {
    notes.push(
      `recipe index is stale (synced ${index.data.syncedAt}); run the ` +
        "puddlerouter-recipes-sync workflow",
    );
  }
  const allowed = allowPredicate(config.allowlist);
  const taken = new Set([...RECIPES, ...config.recipes].map((r) => r.id));
  const recipes = [...config.recipes];
  for (const { pack, recipe } of index.data.recipes) {
    const parsed = parseRecipe(recipe, allowed, taken);
    if ("error" in parsed) notes.push(`${pack}: ${parsed.error}`);
    else recipes.push(parsed.recipe);
  }
  return { config: { ...config, recipes }, notes };
}

/** The result cache instance name for a recipe and its captures. */
export async function resultCacheKey(
  recipeId: string,
  captures: string[],
): Promise<string> {
  return `result-${
    (await hex([recipeId, ...captures].join("\0"))).slice(0, 32)
  }`;
}

/**
 * Run the recipe with this id; an unknown id is a failed result. A recipe with
 * `cacheFor` reuses its last successful answer for that long.
 */
export async function executeRecipe(
  recipeId: string,
  captures: string[],
  exec: Exec,
  repoDir: string,
  config: Pick<Config, "allowlist" | "recipes"> = parseConfig(""),
  store?: Store,
  now: Date = new Date(),
): Promise<{ ok: boolean; text: string; error: string; cached?: boolean }> {
  const recipe = [...config.recipes, ...RECIPES].find((r) => r.id === recipeId);
  if (!recipe) {
    return { ok: false, text: "", error: `unknown recipe ${recipeId}` };
  }
  const key = store && recipe.cacheFor !== undefined
    ? await resultCacheKey(recipeId, captures)
    : "";
  if (store && key) {
    try {
      const entry = ResultCacheSchema.safeParse(await store.read(key));
      if (entry.success && fresh(entry.data.cachedAt, recipe.cacheFor!, now)) {
        return { ok: true, text: entry.data.text, error: "", cached: true };
      }
    } catch { /* read failed: run it */ }
  }
  const result = await runRecipe(
    { recipe, captures },
    exec,
    repoDir,
    allowPredicate(config.allowlist),
  );
  if (store && key && result.ok) {
    try {
      await store.write("resultCache", key, {
        text: result.text,
        cachedAt: now.toISOString(),
      });
    } catch { /* not cached: the next turn runs it again */ }
  }
  return result;
}

/**
 * Runs the `swamp` on the path; used by `match` and `execute`. Arguments are
 * never joined into a shell line. Recipes pass fixed words and digits, and a
 * search passes at most four words of `[a-z0-9_-]` (see README, "Subprocesses").
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

/** The text shown when no extension could answer and an issue was raised. */
export function issueText(url: string): string {
  return `No swamp recipe or extension can answer this yet. Raised ${url}.\n\n` +
    "Answered by puddlerouter without Claude. To ask Claude instead, send " +
    "the prompt again starting with llm:";
}

/** The context added when search found an extension but no recipe covers it. */
export function extensionHint(name: string): string {
  return `puddlerouter: this looks answerable by a program. The swamp ` +
    `extension ${name} may cover it: run \`swamp model type describe ${name}\` ` +
    `(\`swamp extension pull ${name}\` first if it is missing) and use it ` +
    "rather than raw tools. If it does not cover this, ask the user whether to " +
    "raise a recipe-wanted issue.";
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
  const route = effectiveRoute(choice, args.confidence, args.cutoff);
  const complete = args.complete ?? false;
  const answerCutoff = args.answerCutoff ?? 0.8;
  const yes = route === "decision" && complete ? args.yes ?? null : null;
  const answer = yes === null ? null : decisionAnswer(yes, answerCutoff);
  let wouldAction: Reply["action"] = "pass";
  let text = "";
  let recipe = "";
  let extension = "";
  let issue = "";
  let reason: string;
  if (!choice) reason = "no route answer";
  else if (route !== choice) reason = "confidence below cut-off";
  else if (route === "llm") reason = "llm route";
  else if (route === "deterministic") {
    const picked = /^c([1-9])$/.exec(args.pickChoice ?? "");
    const candidate = picked ? args.candidates?.[Number(picked[1]) - 1] : null;
    if (args.matchKind === "recipe" && args.recipeId) {
      recipe = args.recipeId;
      if (args.resultOk && args.resultText) {
        wouldAction = "block";
        text = recipeText(args.recipeId, args.resultText);
        reason = `recipe ${args.recipeId} answered`;
      } else reason = `recipe ${args.recipeId} failed`;
    } else if (
      args.matchKind === "candidates" && candidate &&
      (args.pickConfidence ?? 0) >= args.cutoff
    ) {
      wouldAction = "hint";
      extension = candidate.name;
      text = extensionHint(candidate.name);
      reason = `extension ${candidate.name}, no recipe`;
    } else if (args.mode === "shadow") {
      wouldAction = "block";
      reason = "no extension found, would raise an issue";
    } else if (args.issueUrl) {
      wouldAction = "block";
      issue = args.issueUrl;
      text = issueText(args.issueUrl);
      reason = "no extension found, issue raised";
    } else reason = "no extension found, no issue raised";
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
    mode: args.mode,
    route,
    choice,
    confidence: args.confidence ?? null,
    cutoff: args.cutoff,
    answer,
    yes,
    answerCutoff,
    recipe,
    extension,
    issue,
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

/** The model type: `load`, `match`, `execute`, `sync` and `reply`. */
export const model = {
  type: "@puddleworks/puddlerouter",
  version: "2026.10.13.2",
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
    match: {
      description:
        "How a deterministic turn can be answered: recipe or search.",
      schema: MatchSchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
    result: {
      description: "What running a recipe gave.",
      schema: ResultSchema,
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
    resultCache: {
      description: "A recipe's answer, kept for the recipe's cacheFor.",
      schema: ResultCacheSchema,
      lifetime: "1d" as const,
      garbageCollection: 1,
    },
    recipeIndex: {
      description: "The recipes of the synced packs; `sync` writes it.",
      schema: RecipeIndexSchema,
      lifetime: "7d" as const,
      garbageCollection: 1,
    },
  },
  methods: {
    match: {
      description:
        "Match a turn to a built-in recipe, else search for extensions; store `match`.",
      arguments: MatchArgsSchema,
      execute: async (args: MatchArgs, context: MethodContext) => {
        context.logger.info("Matching turn", {});
        const store = resourceStore(context);
        const local = await loadConfig(args.repoDir);
        if (local.errors.length) {
          context.logger.info("puddlerouter.yaml: {errors}", {
            errors: local.errors.join("; "),
          });
        }
        const { config, notes } = await withPacks(local, store);
        if (notes.length) {
          context.logger.info("recipe packs: {notes}", {
            notes: notes.join("; "),
          });
        }
        const match = await findMatch(
          args.text,
          swampExec,
          new Date(),
          args.sourceRef,
          config,
          store,
        );
        const handle = await context.writeResource("match", "match", match);
        context.logger.info("Matched {kind} {recipeId}", {
          kind: match.kind,
          recipeId: match.recipeId,
        });
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Pull the recipe packs the allowlist covers and store their recipes as `recipeIndex`.",
      arguments: SyncArgsSchema,
      execute: async (args: SyncArgs, context: MethodContext) => {
        context.logger.info("Syncing recipe packs", {});
        const config = await loadConfig(args.repoDir);
        const index = await syncPacks(
          {
            exec: swampExec,
            readFile: (path) => Deno.readTextFile(path),
            repoDir: args.repoDir,
            now: new Date(),
          },
          allowPredicate(config.allowlist),
        );
        const handle = await context.writeResource(
          "recipeIndex",
          RECIPE_INDEX,
          { ...index },
        );
        context.logger.info("Synced {packs} packs, {recipes} recipes", {
          packs: index.packs.length,
          recipes: index.recipes.length,
        });
        if (index.errors.length) {
          context.logger.info("recipe packs: {errors}", {
            errors: index.errors.join("; "),
          });
        }
        return { dataHandles: [handle] };
      },
    },
    execute: {
      description: "Run a built-in recipe through swamp; store `result`.",
      arguments: ExecuteArgsSchema,
      execute: async (args: ExecuteArgs, context: MethodContext) => {
        context.logger.info("Running recipe {recipeId}", {
          recipeId: args.recipeId,
        });
        const store = resourceStore(context);
        const { config } = await withPacks(
          await loadConfig(args.repoDir),
          store,
        );
        const r = await executeRecipe(
          args.recipeId,
          args.captures,
          swampExec,
          args.repoDir,
          config,
          store,
        );
        const handle = await context.writeResource("result", "result", {
          recipeId: args.recipeId,
          ...r,
          cached: r.cached ?? false,
          ranAt: new Date().toISOString(),
        });
        context.logger.info("Recipe {recipeId} ok {ok}", {
          recipeId: args.recipeId,
          ok: r.ok,
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
        const merged = withRecall(fresh, recalled);
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
