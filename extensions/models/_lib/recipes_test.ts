/**
 * Tests for the built-in recipes and the runner that executes them.
 *
 * Run with: make test
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type Exec,
  isAllowed,
  matchRecipe,
  RECIPES,
  runRecipe,
  searchQuery,
} from "./recipes.ts";

Deno.test("every recipe is read-only and from an allowed extension", () => {
  assert(RECIPES.length >= 3);
  for (const r of RECIPES) {
    assertEquals(r.readOnly, true, r.id);
    assert(isAllowed(r.extension), r.id);
  }
});

Deno.test("isAllowed accepts the default scopes only", () => {
  assert(isAllowed("@swamp/git"));
  assert(isAllowed("@mesgme/hetzner-cloud-power"));
  assert(isAllowed("@webframp/github"));
  assert(isAllowed("@puddleworks/puddlerouter"));
  assert(!isAllowed("@hivemq/hetzner/servers"));
  assert(!isAllowed("@swampy/git"));
  assert(!isAllowed("swamp/git"));
});

Deno.test("matchRecipe finds git status in common phrasings", () => {
  for (
    const t of [
      "git status",
      "Git status?",
      "what's the git status",
      "what is git status?",
      "show me the git status",
    ]
  ) assertEquals(matchRecipe(t)?.recipe.id, "git-status", t);
});

Deno.test("matchRecipe captures the commit count", () => {
  const m = matchRecipe("show me the last 5 commits");
  assertEquals(m?.recipe.id, "git-log");
  assertEquals(m?.captures, ["5"]);
  assertEquals(matchRecipe("what are the latest 12 commits?")?.captures, [
    "12",
  ]);
  assertEquals(matchRecipe("list the recent 3 commits")?.recipe.id, "git-log");
});

Deno.test("matchRecipe finds the current branch", () => {
  for (
    const t of [
      "what branch am I on?",
      "what branch are we on",
      "what's the current branch",
      "what is the branch?",
    ]
  ) assertEquals(matchRecipe(t)?.recipe.id, "git-branch", t);
});

Deno.test("matchRecipe does not match near misses", () => {
  for (
    const t of [
      "git status and then commit everything",
      "show me the last 500 commits",
      "show me the last 5 commits and revert them",
      "list the open pull requests in puddle-works/puddleworks",
      "explain git status",
    ]
  ) assertEquals(matchRecipe(t), null, t);
});

Deno.test("searchQuery keeps the content words", () => {
  assertEquals(
    searchQuery("list the hetzner servers in my account"),
    "hetzner servers account",
  );
  assertEquals(
    searchQuery("How many open issues are labelled bug?"),
    "open issues labelled bug",
  );
  assertEquals(searchQuery("is it?"), "");
});

function fakeExec(
  stdout: string,
  calls: string[][] = [],
  code = 0,
): Exec {
  return (args) => {
    calls.push(args);
    return Promise.resolve({ code, stdout, stderr: code ? "boom" : "" });
  };
}

const STATUS = {
  dataArtifacts: [{
    name: "status",
    attributes: {
      entries: [{ status: " M", path: "a.ts" }, { status: "??", path: "b/" }],
      clean: false,
      count: 2,
    },
  }],
};
const LOG = {
  dataArtifacts: [{
    name: "log",
    attributes: {
      commits: [
        {
          sha: "8799c81ee93787eee3bff20a2a1770170cf9b5aa",
          author: "Mark Ellens",
          date: "2026-10-05T14:35:49+01:00",
          message: "Merge pull request #37",
        },
      ],
      count: 1,
    },
  }],
};
const BRANCH = {
  dataArtifacts: [{
    name: "branch-list",
    attributes: { current: "main", branches: ["main", "feature/x"] },
  }],
};

Deno.test("runRecipe runs the method with literal inputs and renders status", async () => {
  const calls: string[][] = [];
  const out = await runRecipe(
    matchRecipe("git status")!,
    fakeExec(JSON.stringify(STATUS), calls),
    "/runtime",
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    "behavior",
    "run",
    "@swamp/git",
    "status",
    "git",
    "--repo-dir",
    "/runtime",
    "--literal-inputs",
    "--json",
  ]);
  assertEquals(out.ok, true);
  assertEquals(out.text, "2 changed files:\n M a.ts\n?? b/");
});

Deno.test("runRecipe passes the commit count and renders the log", async () => {
  const calls: string[][] = [];
  const out = await runRecipe(
    matchRecipe("show the last 3 commits")!,
    fakeExec(JSON.stringify(LOG), calls),
    "/runtime",
  );
  assert(calls[0].join(" ").includes("--input maxCount=3"));
  assertEquals(
    out.text,
    "Last 1 commit:\n8799c81 Merge pull request #37 (Mark Ellens, 2026-10-05)",
  );
});

Deno.test("runRecipe renders the branch list", async () => {
  const calls: string[][] = [];
  const out = await runRecipe(
    matchRecipe("what branch am I on")!,
    fakeExec(JSON.stringify(BRANCH), calls),
    "/runtime",
  );
  assert(calls[0].join(" ").includes("--input list=true"));
  assertEquals(out.text, "On branch main. Other branches: feature/x");
});

Deno.test("runRecipe says a clean tree is clean", async () => {
  const clean = {
    dataArtifacts: [{
      name: "status",
      attributes: { entries: [], clean: true, count: 0 },
    }],
  };
  const out = await runRecipe(
    matchRecipe("git status")!,
    fakeExec(JSON.stringify(clean)),
    "/runtime",
  );
  assertEquals(out.text, "Working tree clean.");
});

Deno.test("runRecipe reports failure instead of throwing", async () => {
  const failed = await runRecipe(
    matchRecipe("git status")!,
    fakeExec("", [], 1),
    "/runtime",
  );
  assertEquals(failed.ok, false);
  assertEquals(failed.text, "");
  const noData = await runRecipe(
    matchRecipe("git status")!,
    fakeExec(JSON.stringify({ dataArtifacts: [] })),
    "/runtime",
  );
  assertEquals(noData.ok, false);
  const junk = await runRecipe(
    matchRecipe("git status")!,
    fakeExec("not json"),
    "/runtime",
  );
  assertEquals(junk.ok, false);
});

Deno.test("runRecipe pulls an allowed extension that is missing, then retries", async () => {
  const calls: string[][] = [];
  let n = 0;
  const exec: Exec = (args) => {
    calls.push(args);
    if (args[0] === "extension") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    n++;
    return Promise.resolve(
      n === 1
        ? {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({ code: "unknown_model_type" }),
        }
        : { code: 0, stdout: JSON.stringify(STATUS), stderr: "" },
    );
  };
  const out = await runRecipe(matchRecipe("git status")!, exec, "/runtime");
  assertEquals(out.ok, true);
  assertEquals(calls.map((c) => c[0] + " " + c[1]), [
    "behavior run",
    "extension pull",
    "behavior run",
  ]);
  assertEquals(calls[1].slice(0, 3), ["extension", "pull", "@swamp/git"]);
});

Deno.test("runRecipe refuses an extension outside the allowlist", async () => {
  const recipe = {
    ...matchRecipe("git status")!.recipe,
    extension: "@evil/git",
  };
  await assertRejects(
    () => runRecipe({ recipe, captures: [] }, fakeExec("{}"), "/runtime"),
    Error,
    "allowlist",
  );
});
