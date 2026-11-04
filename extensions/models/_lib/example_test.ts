import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1.3.0";
import { parseConfig } from "./config.ts";

const EXAMPLE = new URL("../../../puddlerouter.example.yaml", import.meta.url);

Deno.test("puddlerouter.example.yaml parses with no errors", async () => {
  const c = parseConfig(await Deno.readTextFile(EXAMPLE));
  assertEquals(c.errors, []);
  assert(c.allowlist.includes("@webframp/*"));
});

// @puddleworks/recipes reads the rest of the file.
Deno.test("the example names its read-only method and no longer claims readOnly", async () => {
  const doc = parse(await Deno.readTextFile(EXAMPLE)) as {
    reads: string[];
    recipes: Array<Record<string, unknown>>;
  };
  assertEquals(doc.reads, ["@webframp/github list_prs"]);
  assertEquals(doc.recipes.map((r) => r.id), ["github-open-prs"]);
  assertEquals(doc.recipes[0].readOnly, undefined);
});
