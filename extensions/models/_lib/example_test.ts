import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1.3.0";
import { parseConfig } from "./config.ts";

const EXAMPLE = new URL("../../../puddlerouter.example.yaml", import.meta.url);

Deno.test("puddlerouter.example.yaml parses with no errors", async () => {
  const c = parseConfig(await Deno.readTextFile(EXAMPLE));
  assertEquals(c.errors, []);
  assert(c.allowlist.includes("@webframp/*"));
});

Deno.test("the example lists an always-LLM phrase that compiles", async () => {
  const c = parseConfig(await Deno.readTextFile(EXAMPLE));
  assertEquals(c.alwaysLlm.length, 1);
  assert(c.alwaysLlm[0].test("Load the handover doc at /tmp/x.md"));
});

// @puddleworks/recipes reads the rest of the file.
Deno.test("the example names its read-only method and no longer claims readOnly", async () => {
  const doc = parse(await Deno.readTextFile(EXAMPLE)) as {
    reads: string[];
    recipes: Array<Record<string, unknown>>;
  };
  assertEquals(doc.reads, [
    "@webframp/github list_prs",
    "@webframp/github list_workflows",
    "@puddleworks/capture/requests list_requests",
  ]);
  assertEquals(doc.recipes.map((r) => r.id), [
    "github-open-prs",
    "capture-raised-requests",
  ]);
  assertEquals(doc.recipes[0].readOnly, undefined);
});

// Capture lists only the requests the person acting is on, and Intake Bot is
// not on the ones it logs for the requester; swamp runs the nested type name.
Deno.test("the raised-requests recipe runs list_requests as a person, by its type", async () => {
  const doc = parse(await Deno.readTextFile(EXAMPLE)) as {
    reads: string[];
    recipes: Array<Record<string, unknown>>;
  };
  const r = doc.recipes.find((x) => x.id === "capture-raised-requests")!;
  assertEquals(
    [r.extension, r.method, r.definition, r.dataName],
    ["@puddleworks/capture/requests", "list_requests", "capture", "requests-mine-all"],
  );
  assert(doc.reads.includes(`${r.extension} ${r.method}`));
  const fixed = r.fixed as Record<string, string>;
  assertEquals(fixed.scope, "mine");
  assert(fixed.as !== "intake-bot@example.com" && fixed.as.includes("@"));
});
