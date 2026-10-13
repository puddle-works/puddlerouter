/**
 * Recipe packs: extensions in the registry labelled `puddlerouter-recipe`,
 * each holding one workflow per recipe. A workflow's `puddlerouterRecipe` tag
 * is the recipe as JSON (`id`, `extension`, `pattern`, `dataName`, `inputs`,
 * `each`, `template`, `empty`); its one `model_method` step gives the method,
 * the definition and the fixed inputs. puddlerouter runs that method itself,
 * not the workflow.
 *
 * `syncPacks` pulls the packs the allowlist covers and returns the checked
 * recipes as an index; `match` and `execute` compile it with `parseRecipe`.
 *
 * @module
 */
import { parse } from "jsr:@std/yaml@1";
import { parseRecipe } from "./config.ts";
import { type Exec, RECIPES } from "./recipes.ts";

/** The label a recipe pack carries in the registry. */
export const PACK_LABEL = "puddlerouter-recipe";

const REF = /^\$\{\{ inputs\.(\w+) \}\}$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A raw recipe (as `parseRecipe` takes it) from a workflow, or why not. */
export function recipeFromWorkflow(
  wf: unknown,
): { raw: Obj } | { error: string } {
  if (!isObj(wf)) return { error: "not a workflow" };
  const tag = isObj(wf.tags) ? wf.tags.puddlerouterRecipe : undefined;
  if (typeof tag !== "string") return { error: "no puddlerouterRecipe tag" };
  let recipe: unknown;
  try {
    recipe = JSON.parse(tag);
  } catch {
    return { error: "the puddlerouterRecipe tag is not JSON" };
  }
  if (!isObj(recipe)) {
    return { error: "the puddlerouterRecipe tag is not JSON" };
  }
  const steps = (Array.isArray(wf.jobs) ? wf.jobs : []).flatMap((j) =>
    isObj(j) && Array.isArray(j.steps) ? j.steps : []
  );
  if (steps.length !== 1) return { error: "must have exactly one step" };
  const task = isObj(steps[0]) && isObj(steps[0].task) ? steps[0].task : {};
  if (task.type !== "model_method") {
    return { error: "the step must be a model_method" };
  }
  if (
    typeof task.methodName !== "string" ||
    typeof task.modelIdOrName !== "string"
  ) {
    return { error: "the step has no method or definition" };
  }
  const captures = isObj(recipe.inputs) ? recipe.inputs : {};
  const fixed: Record<string, string> = {};
  const fed = new Set<string>();
  for (
    const [name, value] of Object.entries(isObj(task.inputs) ? task.inputs : {})
  ) {
    if (typeof value === "number" || typeof value === "boolean") {
      fixed[name] = String(value);
      continue;
    }
    if (typeof value !== "string") {
      return { error: `step input ${name} must be a word or an input` };
    }
    const ref = REF.exec(value);
    if (ref) {
      if (ref[1] !== name || !(name in captures)) {
        return {
          error: `step input ${name} must be \${{ inputs.${name} }} with a ` +
            `capture declared for ${name}`,
        };
      }
      fed.add(name);
    } else if (value.includes("${{")) {
      return {
        error: `step input ${name} may only be a fixed word or an input`,
      };
    } else fixed[name] = value;
  }
  for (const name of Object.keys(captures)) {
    if (!fed.has(name)) {
      return { error: `capture ${name} is not a step input` };
    }
  }
  return {
    raw: {
      ...recipe,
      method: task.methodName,
      definition: task.modelIdOrName,
      fixed,
    },
  };
}

/** One recipe in the index, with the pack it came from. */
export interface IndexedRecipe {
  pack: string;
  recipe: Obj;
}

/** What a sync found. */
export interface RecipeIndex {
  recipes: IndexedRecipe[];
  packs: Array<{ name: string; version: string }>;
  /** One message per pack, workflow or recipe dropped. */
  errors: string[];
  syncedAt: string;
}

/** What `syncPacks` needs from outside. */
export interface SyncDeps {
  exec: Exec;
  readFile: (path: string) => Promise<string>;
  repoDir: string;
  now: Date;
}

async function json(exec: Exec, args: string[]): Promise<Obj | null> {
  try {
    const res = await exec(args);
    if (res.code !== 0) return null;
    const out = JSON.parse(res.stdout);
    return isObj(out) ? out : null;
  } catch {
    return null;
  }
}

interface Installed {
  version: string;
  files: string[];
}

async function installed(
  { exec, repoDir }: SyncDeps,
): Promise<Map<string, Installed>> {
  const list = await json(exec, [
    "extension",
    "list",
    "--repo-dir",
    repoDir,
    "--json",
  ]);
  const out = new Map<string, Installed>();
  for (const row of Array.isArray(list?.extensions) ? list.extensions : []) {
    if (isObj(row) && typeof row.name === "string") {
      out.set(row.name, {
        version: typeof row.version === "string" ? row.version : "",
        files: Array.isArray(row.files)
          ? row.files.filter((f): f is string => typeof f === "string")
          : [],
      });
    }
  }
  return out;
}

/**
 * Pull the allowlisted recipe packs that are missing or older than the
 * registry's, and index their recipes. A bad pack, workflow or recipe is
 * reported in `errors` and dropped. Throws only if the registry cannot be
 * searched, so the caller keeps its old index.
 */
export async function syncPacks(
  deps: SyncDeps,
  allow: (extension: string) => boolean,
): Promise<RecipeIndex> {
  const { exec, readFile, repoDir } = deps;
  const found = await json(exec, [
    "extension",
    "search",
    "--label",
    PACK_LABEL,
    "--json",
  ]);
  if (!found || !Array.isArray(found.extensions)) {
    throw new Error("could not search the registry for recipe packs");
  }
  const index: RecipeIndex = {
    recipes: [],
    packs: [],
    errors: [],
    syncedAt: deps.now.toISOString(),
  };
  let have = await installed(deps);
  const taken = new Set(RECIPES.map((r) => r.id));
  for (const row of found.extensions) {
    if (!isObj(row) || typeof row.name !== "string") continue;
    const name = row.name;
    const latest = typeof row.latestVersion === "string"
      ? row.latestVersion
      : "";
    if (!allow(name)) {
      index.errors.push(`${name}: pack is not allowed`);
      continue;
    }
    if (have.get(name)?.version !== latest) {
      const pulled = await exec([
        "extension",
        "pull",
        name,
        "--repo-dir",
        repoDir,
        "--yes",
      ]);
      if (pulled.code !== 0) {
        index.errors.push(`${name}: could not pull`);
        continue;
      }
      have = await installed(deps);
    }
    const pack = have.get(name);
    if (!pack) {
      index.errors.push(`${name}: not installed after pull`);
      continue;
    }
    index.packs.push({ name, version: pack.version });
    for (
      const file of pack.files.filter((f) =>
        /\/workflows\/[^/]+\.ya?ml$/.test(f) && !f.includes("..")
      )
    ) {
      const label = `${name}: ${file.split("/").pop()}`;
      let wf: unknown;
      try {
        wf = parse(await readFile(`${repoDir}/${file}`));
      } catch (e) {
        index.errors.push(`${label}: not valid YAML (${(e as Error).message})`);
        continue;
      }
      const r = recipeFromWorkflow(wf);
      if ("error" in r) {
        index.errors.push(`${label}: ${r.error}`);
        continue;
      }
      const parsed = parseRecipe(r.raw, allow, taken);
      if ("error" in parsed) index.errors.push(`${label}: ${parsed.error}`);
      else index.recipes.push({ pack: name, recipe: r.raw });
    }
  }
  return index;
}
