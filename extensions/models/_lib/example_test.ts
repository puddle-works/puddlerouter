import { assertEquals } from "jsr:@std/assert@1";
import { parseConfig } from "./config.ts";

Deno.test("puddlerouter.example.yaml parses with no errors", async () => {
  const c = parseConfig(
    await Deno.readTextFile(
      new URL("../../../puddlerouter.example.yaml", import.meta.url),
    ),
  );
  assertEquals(c.errors, []);
  assertEquals(c.recipes.map((r) => r.id), ["github-open-prs"]);
});
