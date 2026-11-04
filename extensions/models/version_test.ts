/**
 * Keeps the versions in step: the model's, the manifest's and its last upgrade.
 *
 * Run with: make test
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1.3.0";
import { model } from "./puddlerouter.ts";

const manifest = parse(
  await Deno.readTextFile(new URL("../../manifest.yaml", import.meta.url)),
) as { version: string };

Deno.test("the model's version is the manifest's", () => {
  assertEquals(model.version, manifest.version);
});

Deno.test("the last upgrade reaches the model's version", () => {
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});

Deno.test("upgrades leave the settings alone", () => {
  const settings = {};
  for (const upgrade of model.upgrades) {
    assert(upgrade.upgradeAttributes(settings) === settings);
  }
});

Deno.test("the recipes instance's version is the pinned one", async () => {
  const pinned = JSON.parse(
    await Deno.readTextFile(
      new URL("./upstream_extensions.json", import.meta.url),
    ),
  ) as Record<string, { version: string }>;
  const instance = parse(
    await Deno.readTextFile(
      new URL(
        "../../models/@puddleworks/recipes/recipes.yaml",
        import.meta.url,
      ),
    ),
  ) as { typeVersion: string };
  assertEquals(instance.typeVersion, pinned["@puddleworks/recipes"].version);
});
