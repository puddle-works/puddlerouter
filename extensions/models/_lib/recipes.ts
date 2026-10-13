/**
 * Built-in recipes: phrasings a regex can match exactly, the read-only
 * extension method each one runs, and how its data is shown as text.
 *
 * A recipe never reads the turn as free text. The regex captures only digits,
 * and the captured pieces become method inputs run with `--literal-inputs`.
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

/** A rule that turns one phrasing into one read-only method call. */
export interface Recipe {
  id: string;
  /** The extension that holds the model type; must pass `isAllowed`. */
  extension: string;
  method: string;
  /** Name of the model definition swamp creates for the type. */
  definition: string;
  /** The data the method writes that holds the answer. */
  dataName: string;
  pattern: RegExp;
  /** Only read-only recipes run unattended. */
  readOnly: true;
  /** Method inputs from the regex's captured pieces. */
  inputs: (captures: string[]) => Record<string, string>;
  /** The answer as text, from the data's attributes. */
  render: (attrs: Record<string, unknown>) => string;
}

/** Extensions that may be pulled and run without asking. */
const ALLOWED = /^@(swamp|mesgme)\/[a-z0-9][a-z0-9/_-]*$/;

/** True if the extension may be pulled and run unattended. */
export function isAllowed(extension: string): boolean {
  return ALLOWED.test(extension);
}

const MAX_LINES = 20;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function lines(rows: string[]): string[] {
  return rows.length <= MAX_LINES ? rows : [
    ...rows.slice(0, MAX_LINES),
    `… and ${rows.length - MAX_LINES} more`,
  ];
}

interface Entry {
  status: string;
  path: string;
}
interface Commit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/** The recipes puddlerouter ships with. */
export const RECIPES: Recipe[] = [
  {
    id: "git-status",
    extension: "@swamp/git",
    method: "status",
    definition: "git",
    dataName: "status",
    pattern:
      /^(?:(?:what(?:'s| is)|show(?: me)?) (?:the )?)?git status[?.!]?$/i,
    readOnly: true,
    inputs: () => ({}),
    render: (attrs) => {
      const entries = (attrs.entries ?? []) as Entry[];
      if (attrs.clean === true || entries.length === 0) {
        return "Working tree clean.";
      }
      return [
        `${plural(entries.length, "changed file", "changed files")}:`,
        ...lines(entries.map((e) => `${e.status} ${e.path}`)),
      ].join("\n");
    },
  },
  {
    id: "git-log",
    extension: "@swamp/git",
    method: "log",
    definition: "git",
    dataName: "log",
    pattern:
      /^(?:(?:show|list|give)(?: me)?|what are) (?:the )?(?:last|latest|recent) ([1-9]\d?) commits[?.!]?$/i,
    readOnly: true,
    inputs: ([count]) => ({ maxCount: count }),
    render: (attrs) => {
      const commits = (attrs.commits ?? []) as Commit[];
      return [
        `Last ${plural(commits.length, "commit", "commits")}:`,
        ...lines(
          commits.map((c) =>
            `${c.sha.slice(0, 7)} ${c.message} (${c.author}, ${
              c.date.slice(0, 10)
            })`
          ),
        ),
      ].join("\n");
    },
  },
  {
    id: "git-branch",
    extension: "@swamp/git",
    method: "branch",
    definition: "git",
    dataName: "branch-list",
    pattern:
      /^(?:what(?:'s| is) (?:the )?(?:current )?branch|what branch (?:am i|are we) on)[?.!]?$/i,
    readOnly: true,
    inputs: () => ({ list: "true" }),
    render: (attrs) => {
      const others = ((attrs.branches ?? []) as string[]).filter((b) =>
        b !== attrs.current
      );
      return `On branch ${attrs.current}. ` +
        (others.length
          ? `Other branches: ${others.join(", ")}`
          : "No other branches.");
    },
  },
];

/** A recipe whose pattern matches the whole turn, with its captured pieces. */
export interface RecipeMatch {
  recipe: Recipe;
  captures: string[];
}

/** The first recipe that matches the whole turn, or null. */
export function matchRecipe(text: string): RecipeMatch | null {
  const t = text.trim().replace(/\s+/g, " ");
  for (const recipe of RECIPES) {
    const m = recipe.pattern.exec(t);
    if (m) return { recipe, captures: m.slice(1) };
  }
  return null;
}

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

/** What running a recipe gave. */
export interface RecipeResult {
  ok: boolean;
  /** The rendered answer; empty when `ok` is false. */
  text: string;
  /** Why it failed; empty when `ok` is true. */
  error: string;
}

const fail = (error: string): RecipeResult => ({ ok: false, text: "", error });

function errorCode(res: ExecResult): string {
  for (const s of [res.stderr, res.stdout]) {
    try {
      const code = JSON.parse(s)?.code;
      if (typeof code === "string") return code;
    } catch { /* not JSON */ }
  }
  return "";
}

/**
 * Run a matched recipe through swamp and render its data.
 * Never throws for a failed run; throws only for an extension that is not on
 * the allowlist, which is a bug in the recipe.
 */
export async function runRecipe(
  { recipe, captures }: RecipeMatch,
  exec: Exec,
  repoDir: string,
): Promise<RecipeResult> {
  if (!isAllowed(recipe.extension)) {
    throw new Error(`${recipe.extension} is not on the allowlist`);
  }
  const inputs = Object.entries(recipe.inputs(captures)).flatMap((
    [k, v],
  ) => ["--input", `${k}=${v}`]);
  const run = () =>
    exec([
      "behavior",
      "run",
      recipe.extension,
      recipe.method,
      recipe.definition,
      "--repo-dir",
      repoDir,
      ...inputs,
      "--literal-inputs",
      "--json",
    ]);
  let res = await run();
  if (
    res.code !== 0 &&
    ["unknown_model_type", "missing_deps"].includes(errorCode(res))
  ) {
    const pulled = await exec([
      "extension",
      "pull",
      recipe.extension,
      "--repo-dir",
      repoDir,
    ]);
    if (pulled.code !== 0) return fail(`could not pull ${recipe.extension}`);
    res = await run();
  }
  if (res.code !== 0) return fail(`swamp exited ${res.code}`);
  let parsed: { dataArtifacts?: Array<{ name: string; attributes?: unknown }> };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return fail("swamp output was not JSON");
  }
  const artifact = parsed.dataArtifacts?.find((a) =>
    a.name === recipe.dataName
  );
  if (
    !artifact || typeof artifact.attributes !== "object" || !artifact.attributes
  ) {
    return fail(`no ${recipe.dataName} data`);
  }
  try {
    return {
      ok: true,
      text: recipe.render(artifact.attributes as Record<string, unknown>),
      error: "",
    };
  } catch (e) {
    return fail(`could not render: ${e instanceof Error ? e.message : e}`);
  }
}
