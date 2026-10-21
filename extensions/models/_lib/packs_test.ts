/**
 * Tests for recipe packs: reading a recipe from a workflow, and syncing packs
 * from the registry (against a fake swamp and fake files).
 *
 * Run with: make test
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { stringify } from "jsr:@std/yaml@1.3.0";
import { allowPredicate, DEFAULT_ALLOWLIST } from "./config.ts";
import { recipeFromWorkflow, syncPacks } from "./packs.ts";

const TAG = {
  id: "github-open-prs",
  extension: "@webframp/github",
  pattern: "^open prs in ([\\w.-]+/[\\w.-]+)$",
  dataName: "prs-{repo}-{state}",
  inputs: { repo: { capture: 1, as: "repo" } },
  template: "{count} open",
};

function workflow(over: Record<string, unknown> = {}, tag: unknown = TAG) {
  return {
    name: "@puddleworks/puddlerouter-recipes-github-open-prs",
    tags: { puddlerouterRecipe: JSON.stringify(tag) },
    inputs: { properties: { repo: { type: "string" } } },
    jobs: [{
      name: "main",
      steps: [{
        name: "list",
        task: {
          type: "model_method",
          modelIdOrName: "github",
          methodName: "list_prs",
          inputs: { repo: "${{ inputs.repo }}", state: "open" },
        },
      }],
    }],
    ...over,
  };
}

Deno.test("recipeFromWorkflow takes the tag, then method, definition and fixed words from the step", () => {
  const r = recipeFromWorkflow(workflow());
  assert("raw" in r);
  assertEquals(r.raw, {
    ...TAG,
    method: "list_prs",
    definition: "github",
    fixed: { state: "open" },
  });
});

Deno.test("recipeFromWorkflow drops a workflow that is not one recipe", () => {
  const bad = (wf: unknown) => {
    const r = recipeFromWorkflow(wf);
    assert("error" in r, JSON.stringify(wf).slice(0, 80));
    return r.error;
  };
  assertMatch(bad(null), /not a workflow/);
  assertMatch(bad(workflow({ tags: {} })), /no puddlerouterRecipe tag/);
  assertMatch(bad(workflow({ tags: { puddlerouterRecipe: "{nope" } })), /JSON/);
  assertMatch(bad(workflow({ tags: { puddlerouterRecipe: "[1]" } })), /JSON/);
  const step = workflow().jobs[0].steps[0];
  assertMatch(
    bad(workflow({ jobs: [{ steps: [step, step] }] })),
    /exactly one step/,
  );
  assertMatch(
    bad(workflow({ jobs: [{ steps: [{ task: { type: "model_method" } }] }] })),
    /method/,
  );
  assertMatch(
    bad(workflow({
      jobs: [{ steps: [{ task: { ...step.task, type: "workflow" } }] }],
    })),
    /model_method/,
  );
});

Deno.test("recipeFromWorkflow refuses step inputs the recipe has no capture for", () => {
  const withInputs = (inputs: Record<string, unknown>) =>
    workflow({
      jobs: [{
        steps: [{
          task: { ...workflow().jobs[0].steps[0].task, inputs },
        }],
      }],
    });
  const err = (wf: unknown) => {
    const r = recipeFromWorkflow(wf);
    assert("error" in r);
    return r.error;
  };
  assertMatch(err(withInputs({ owner: "${{ inputs.owner }}" })), /owner/);
  assertMatch(err(withInputs({ repo: "${{ inputs.other }}" })), /repo/);
  assertMatch(err(withInputs({ repo: "${{ data.latest('a','b') }}" })), /repo/);
  assertMatch(err(withInputs({ state: "x ${{ inputs.repo }}" })), /state/);
  assertMatch(err(withInputs({ state: "open" })), /repo.*step input/);
  const ok = recipeFromWorkflow(
    withInputs({ repo: "${{ inputs.repo }}", count: 5, all: true }),
  );
  assert("raw" in ok);
  assertEquals(ok.raw.fixed, { count: "5", all: "true" });
});

// ---- syncPacks ----

const PACK = "@puddleworks/puddlerouter-recipes-github";
const FILE =
  `.swamp/pulled-extensions/${PACK}/workflows/workflow-github-open-prs.yaml`;
const allow = allowPredicate(DEFAULT_ALLOWLIST);
const NOW = new Date("2026-10-13T10:00:00Z");

interface World {
  /** Registry rows: name -> latestVersion. */
  registry: Record<string, string>;
  /** Installed: name -> version. */
  installed: Record<string, string>;
  files: Record<string, string>;
  failSearch?: boolean;
  failPull?: boolean;
}

function fake(w: World) {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    const out = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    const sub = args.slice(0, 2).join(" ");
    if (sub === "extension search") {
      return Promise.resolve(
        w.failSearch ? { code: 1, stdout: "", stderr: "down" } : out({
          extensions: Object.entries(w.registry).map((
            [name, latestVersion],
          ) => ({ name, latestVersion })),
        }),
      );
    }
    if (sub === "extension list") {
      return Promise.resolve(out({
        extensions: Object.entries(w.installed).map(([name, version]) => ({
          name,
          version,
          files: Object.keys(w.files).filter((f) => f.includes(`/${name}/`)),
        })),
      }));
    }
    if (sub === "extension pull") {
      if (w.failPull) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "no" });
      }
      w.installed[args[2]] = w.registry[args[2]];
      return Promise.resolve(out({}));
    }
    return Promise.resolve({ code: 1, stdout: "", stderr: "unexpected" });
  };
  const readFile = (path: string) => {
    const text = w.files[path.replace("/repo/", "")];
    return text === undefined
      ? Promise.reject(new Error("missing"))
      : Promise.resolve(text);
  };
  return { exec, calls, readFile };
}

const deps = (f: ReturnType<typeof fake>) => ({
  exec: f.exec,
  readFile: f.readFile,
  repoDir: "/repo",
  now: NOW,
});

Deno.test("syncPacks pulls a missing pack and indexes its recipes", async () => {
  const w: World = {
    registry: { [PACK]: "2026.10.13.2" },
    installed: {},
    files: { [FILE]: stringify(workflow()) },
  };
  const f = fake(w);
  const index = await syncPacks(deps(f), allow);
  assertEquals(index.errors, []);
  assertEquals(index.packs, [{ name: PACK, version: "2026.10.13.2" }]);
  assertEquals(index.recipes.length, 1);
  assertEquals(index.recipes[0].pack, PACK);
  assertEquals(index.recipes[0].recipe.id, "github-open-prs");
  assertEquals(index.syncedAt, NOW.toISOString());
  assert(f.calls.some((c) => c[0] === "extension" && c[1] === "pull"));
  const search = f.calls.find((c) => c[1] === "search")!;
  assert(search.includes("--label") && search.includes("puddlerouter-recipe"));
});

Deno.test("syncPacks does not pull a pack that is already current, and pulls a stale one", async () => {
  const w: World = {
    registry: { [PACK]: "2026.10.13.2" },
    installed: { [PACK]: "2026.10.13.2" },
    files: { [FILE]: stringify(workflow()) },
  };
  const same = fake(w);
  await syncPacks(deps(same), allow);
  assert(!same.calls.some((c) => c[1] === "pull"));
  w.installed[PACK] = "2026.10.13.1";
  const stale = fake(w);
  const index = await syncPacks(deps(stale), allow);
  assert(stale.calls.some((c) => c[1] === "pull"));
  assertEquals(index.packs[0].version, "2026.10.13.2");
});

Deno.test("syncPacks skips a pack the allowlist does not cover", async () => {
  const w: World = {
    registry: { "@evil/recipes": "1", [PACK]: "1" },
    installed: {},
    files: { [FILE]: stringify(workflow()) },
  };
  const f = fake(w);
  const index = await syncPacks(deps(f), allow);
  assertEquals(index.packs.map((p) => p.name), [PACK]);
  assertEquals(index.errors.length, 1);
  assertMatch(index.errors[0], /@evil\/recipes.*not allowed/);
  assert(!f.calls.some((c) => c.includes("@evil/recipes") && c[1] === "pull"));
});

Deno.test("syncPacks reports a bad workflow, a failed pull and a recipe outside the allowlist, and keeps the rest", async () => {
  const w: World = {
    registry: { [PACK]: "1" },
    installed: { [PACK]: "1" },
    files: {
      [FILE]: stringify(workflow()),
      [FILE.replace("open-prs", "broken")]: stringify(workflow({ tags: {} })),
      [FILE.replace("open-prs", "evil")]: stringify(
        workflow({}, { ...TAG, id: "evil", extension: "@evil/x" }),
      ),
      [FILE.replace("open-prs", "dup")]: stringify(workflow()),
      [FILE.replace("open-prs", "junk")]: "not: [valid",
    },
  };
  const index = await syncPacks(deps(fake(w)), allow);
  assertEquals(index.recipes.map((r) => r.recipe.id), ["github-open-prs"]);
  assertEquals(index.errors.length, 4);
  assert(index.errors.some((e) => /no puddlerouterRecipe tag/.test(e)));
  assert(index.errors.some((e) => /not allowed/.test(e)));
  assert(index.errors.some((e) => /id already used/.test(e)));
  assert(index.errors.some((e) => /not valid YAML/.test(e)));

  const failing: World = { ...w, installed: {}, failPull: true };
  const r = await syncPacks(deps(fake(failing)), allow);
  assertEquals(r.recipes, []);
  assertMatch(r.errors[0], /could not pull/);
});

Deno.test("syncPacks refuses a built-in id and throws when the registry cannot be searched", async () => {
  const w: World = {
    registry: { [PACK]: "1" },
    installed: { [PACK]: "1" },
    files: {
      [FILE]: stringify(workflow({}, { ...TAG, id: "git-status" })),
    },
  };
  const index = await syncPacks(deps(fake(w)), allow);
  assertEquals(index.recipes, []);
  assertMatch(index.errors[0], /id already used/);

  let msg = "";
  try {
    await syncPacks(deps(fake({ ...w, failSearch: true })), allow);
  } catch (e) {
    msg = (e as Error).message;
  }
  assertMatch(msg, /search/);
});

Deno.test("syncPacks reads only workflow files inside the pack's folder", async () => {
  const w: World = {
    registry: { [PACK]: "1" },
    installed: { [PACK]: "1" },
    files: {
      [`.swamp/pulled-extensions/${PACK}/workflows/../../../../secret.yaml`]:
        stringify(workflow()),
    },
  };
  const index = await syncPacks(deps(fake(w)), allow);
  assertEquals(index.recipes, []);
  assertEquals(index.errors, []);
});
