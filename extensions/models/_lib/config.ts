/**
 * The local `puddlerouter.yaml`: extra allowlist entries and the owner's own
 * recipes, for ones not published as a pack.
 *
 * ```yaml
 * allow: ['@acme/*']
 * recipes:
 *   - id: gh-open-prs
 *     extension: '@webframp/github'
 *     method: list_prs
 *     definition: github
 *     dataName: prs
 *     pattern: '^list the open prs in ([\w.-]+/[\w.-]+)$'
 *     inputs: { repo: { capture: 1, as: repo } }
 *     fixed: { state: open }
 *     each: { path: items, line: '#{number} {title}' }
 *     template: "{count} open:\n{lines}"
 *     empty: No open pull requests.
 * ```
 *
 * A bad entry is reported in `errors` and dropped; the rest still load. Local
 * recipes are always read-only. A capture only reaches swamp if it has the
 * declared shape (`int`, `repo` or `word`).
 *
 * @module
 */
import { parse } from "jsr:@std/yaml@1";
import { z } from "npm:zod@4";
import { allowPredicate, DEFAULT_ALLOWLIST, isEntry } from "./allowlist.ts";
import { type Recipe, RECIPES } from "./recipes.ts";

export { allowPredicate, DEFAULT_ALLOWLIST };

const SHAPES = {
  int: /^\d{1,6}$/,
  repo: /^[\w.-]+\/[\w.-]+$/,
  word: /^[\w.-]{1,64}$/,
} as const;

const LocalRecipe = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  extension: z.string(),
  method: z.string().regex(/^[A-Za-z_][\w]*$/),
  definition: z.string().regex(/^[\w.-]+$/),
  dataName: z.string().min(1),
  pattern: z.string().min(1),
  readOnly: z.literal(true).default(true),
  inputs: z.record(
    z.string().regex(/^[A-Za-z_]\w*$/),
    z.object({
      capture: z.number().int().min(1).max(9),
      as: z.enum(["int", "repo", "word"]),
    }),
  ).default({}),
  fixed: z.record(z.string(), z.string()).default({}),
  each: z.object({ path: z.string(), line: z.string() }).optional(),
  template: z.string().min(1),
  empty: z.string().optional(),
}).strict();
type LocalRecipe = z.infer<typeof LocalRecipe>;

/** What the file gives. */
export interface Config {
  /** Defaults plus the file's `allow` entries. */
  allowlist: string[];
  /** Compiled local recipes, in file order. */
  recipes: Recipe[];
  /** One message per entry dropped. */
  errors: string[];
}

function pick(value: unknown, path: string): unknown {
  let v = value;
  for (const key of path.split(".")) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

function fill(template: string, data: unknown): string {
  return template.replace(/\{([\w.]+)\}/g, (_whole, path) => {
    const v = pick(data, path);
    return v === undefined || v === null ? "" : String(v);
  });
}

function compile(r: LocalRecipe): Recipe {
  const pattern = new RegExp(r.pattern, "i");
  const build = (captures: string[]): Record<string, string> => {
    const out: Record<string, string> = { ...r.fixed };
    for (const [name, { capture, as }] of Object.entries(r.inputs)) {
      const value = captures[capture - 1] ?? "";
      if (!SHAPES[as].test(value)) throw new Error(`${name} is not a ${as}`);
      out[name] = value;
    }
    return out;
  };
  return {
    id: r.id,
    extension: r.extension,
    method: r.method,
    definition: r.definition,
    dataName: r.dataName,
    dataNameFor: (captures) => {
      const inputs = build(captures);
      return r.dataName.replace(
        /\{(\w+)\}/g,
        (_, k) => (inputs[k] ?? "").replace(/[^\w.-]+/g, "-"),
      );
    },
    pattern,
    readOnly: true,
    inputs: build,
    render: (attrs) => {
      let lines = "";
      let count = 0;
      if (r.each) {
        const items = pick(attrs, r.each.path);
        const list = Array.isArray(items) ? items : [];
        count = list.length;
        if (count === 0 && r.empty !== undefined) return r.empty;
        lines = list.slice(0, 20).map((item) => fill(r.each!.line, item))
          .concat(count > 20 ? [`… and ${count - 20} more`] : []).join("\n");
      }
      return fill(r.template, { ...attrs, count, lines });
    },
  };
}

/** Parse the file's text. Never throws. */
export function parseConfig(text: string): Config {
  const config: Config = {
    allowlist: [...DEFAULT_ALLOWLIST],
    recipes: [],
    errors: [],
  };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    config.errors.push(`not valid YAML: ${e instanceof Error ? e.message : e}`);
    return config;
  }
  if (doc === null || doc === undefined) return config;
  if (typeof doc !== "object" || Array.isArray(doc)) {
    config.errors.push("the file must be a mapping");
    return config;
  }
  const { allow, recipes } = doc as Record<string, unknown>;
  for (const entry of Array.isArray(allow) ? allow : []) {
    if (typeof entry === "string" && isEntry(entry)) {
      if (!config.allowlist.includes(entry)) config.allowlist.push(entry);
    } else config.errors.push(`allow: ignored ${JSON.stringify(entry)}`);
  }
  const allowed = allowPredicate(config.allowlist);
  const taken = new Set(RECIPES.map((r) => r.id));
  for (const raw of Array.isArray(recipes) ? recipes : []) {
    const id = (raw as { id?: unknown })?.id;
    const parsed = LocalRecipe.safeParse(raw);
    if (!parsed.success) {
      config.errors.push(`recipe ${id}: ${parsed.error.issues[0]?.message}`);
      continue;
    }
    const r = parsed.data;
    if (taken.has(r.id)) {
      config.errors.push(`recipe ${r.id}: id already used`);
      continue;
    }
    if (!allowed(r.extension)) {
      config.errors.push(`recipe ${r.id}: ${r.extension} is not allowed`);
      continue;
    }
    try {
      config.recipes.push(compile(r));
    } catch (e) {
      config.errors.push(
        `recipe ${r.id}: bad pattern (${(e as Error).message})`,
      );
      continue;
    }
    taken.add(r.id);
  }
  return config;
}

/** Read `<repoDir>/puddlerouter.yaml`; defaults if it is missing. */
export async function loadConfig(repoDir: string): Promise<Config> {
  try {
    return parseConfig(await Deno.readTextFile(`${repoDir}/puddlerouter.yaml`));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return parseConfig("");
    return {
      ...parseConfig(""),
      errors: [`could not read puddlerouter.yaml: ${(e as Error).message}`],
    };
  }
}
