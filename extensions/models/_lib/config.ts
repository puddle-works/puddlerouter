/**
 * The `allow:` list in the local `puddlerouter.yaml`: extra extensions a search
 * may offer, on top of the defaults.
 *
 * ```yaml
 * allow: ['@acme/*']
 * ```
 *
 * The same file holds `recipes:` and `reads:`, which `@puddleworks/recipes`
 * reads; this reader leaves them alone. A bad entry is reported in `errors` and
 * dropped; the rest still load.
 *
 * @module
 */
import { parse } from "jsr:@std/yaml@1.3.0";
import { allowPredicate, DEFAULT_ALLOWLIST, isEntry } from "./allowlist.ts";

export { allowPredicate, DEFAULT_ALLOWLIST };

/** What the router takes from the file. */
export interface Config {
  allowlist: string[];
  errors: string[];
}

/** Parse the file's text; never throws. */
export function parseConfig(text: string): Config {
  const config: Config = { allowlist: [...DEFAULT_ALLOWLIST], errors: [] };
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
  const { allow } = doc as Record<string, unknown>;
  for (const entry of Array.isArray(allow) ? allow : []) {
    if (typeof entry === "string" && isEntry(entry)) {
      if (!config.allowlist.includes(entry)) config.allowlist.push(entry);
    } else config.errors.push(`allow: ignored ${JSON.stringify(entry)}`);
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
