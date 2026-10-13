/**
 * Tests for the allowlist and the local recipes file.
 *
 * Run with: make test
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { allowPredicate, DEFAULT_ALLOWLIST, parseConfig } from "./config.ts";
import { matchRecipe, runRecipe } from "./recipes.ts";

Deno.test("the default allowlist trusts swamp, mesgme, webframp and puddleworks", () => {
  const ok = allowPredicate(DEFAULT_ALLOWLIST);
  for (
    const n of [
      "@swamp/git",
      "@mesgme/hetzner-cloud-power",
      "@webframp/github",
      "@puddleworks/puddlerouter",
      "@swamp/aws/ec2",
    ]
  ) assert(ok(n), n);
  for (
    const n of ["@swampy/git", "swamp/git", "@other/git", "@swamp/", "@swamp"]
  ) {
    assert(!ok(n), n);
  }
});

Deno.test("allow entries add to the defaults; bad entries are reported and dropped", () => {
  const c = parseConfig(
    "allow:\n  - '@acme/*'\n  - '@acme2/tool'\n  - '*'\n  - 'nope'\n  - '@a/b c'\n",
  );
  const ok = allowPredicate(c.allowlist);
  assert(ok("@acme/anything"));
  assert(ok("@acme2/tool"));
  assert(!ok("@acme2/other"));
  assert(ok("@swamp/git"));
  assertEquals(c.errors.length, 3);
});

Deno.test("an empty or missing file gives the defaults and no recipes", () => {
  for (const text of ["", "# nothing\n"]) {
    const c = parseConfig(text);
    assertEquals(c.allowlist, DEFAULT_ALLOWLIST);
    assertEquals(c.recipes, []);
    assertEquals(c.errors, []);
  }
});

Deno.test("invalid YAML gives the defaults and an error", () => {
  const c = parseConfig("allow: [unclosed");
  assertEquals(c.allowlist, DEFAULT_ALLOWLIST);
  assertEquals(c.recipes, []);
  assertEquals(c.errors.length, 1);
});

const GH = `
recipes:
  - id: gh-open-prs
    extension: '@webframp/github'
    method: list_prs
    definition: github
    dataName: prs
    pattern: '^(?:list|show) the open (?:prs|pull requests) in ([\\w.-]+/[\\w.-]+)$'
    inputs:
      repo: {capture: 1, as: repo}
    fixed:
      state: open
    each:
      path: items
      line: '#{number} {title}'
    template: |-
      {count} open:
      {lines}
    empty: No open pull requests.
`;

Deno.test("a local recipe compiles, matches and builds inputs from checked captures", () => {
  const c = parseConfig(GH);
  assertEquals(c.errors, []);
  assertEquals(c.recipes.length, 1);
  const r = c.recipes[0];
  assertEquals(r.readOnly, true);
  const m = matchRecipe(
    "list the open PRs in puddle-works/puddleworks",
    c.recipes,
  );
  assert(m);
  assertEquals(m.captures, ["puddle-works/puddleworks"]);
  assertEquals(r.inputs(m.captures), {
    repo: "puddle-works/puddleworks",
    state: "open",
  });
});

Deno.test("a capture that is not the declared shape is refused", () => {
  const c = parseConfig(
    GH.replace("([\\w.-]+/[\\w.-]+)", "(.+)"),
  );
  const r = c.recipes[0];
  let threw = false;
  try {
    r.inputs(["x; rm -rf /"]);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("a local recipe renders a template, a list and the empty text", () => {
  const r = parseConfig(GH).recipes[0];
  assertEquals(
    r.render({
      items: [{ number: 4, title: "fix" }, { number: 9, title: "add" }],
    }),
    "2 open:\n#4 fix\n#9 add",
  );
  assertEquals(r.render({ items: [] }), "No open pull requests.");
});

Deno.test("local recipes are rejected for bad ids, patterns, extensions and duplicates", () => {
  const base = (over: string) =>
    GH.replace(
      "id: gh-open-prs",
      over.startsWith("id") ? over : "id: gh-open-prs",
    ) +
    (over.startsWith("id") ? "" : over);
  assertEquals(parseConfig(base("id: Bad Id")).recipes.length, 0);
  assertEquals(
    parseConfig(GH.replace("^(?:list", "^(?:list(")).recipes.length,
    0,
  );
  assertEquals(
    parseConfig(GH.replace("'@webframp/github'", "'@unknown/github'")).recipes
      .length,
    0,
  );
  assertEquals(
    parseConfig(GH.replace("id: gh-open-prs", "id: git-status")).recipes.length,
    0,
  );
  assertEquals(
    parseConfig(GH.replace("    method:", "    readOnly: false\n    method:"))
      .recipes.length,
    0,
  );
  const twice = parseConfig(GH + GH.replace("recipes:\n", ""));
  assertEquals(twice.recipes.length, 1);
  assert(twice.errors.length >= 1);
});

Deno.test("a local extension is allowed once the file allows it", () => {
  const c = parseConfig(
    "allow: ['@unknown/*']\n" +
      GH.replace("'@webframp/github'", "'@unknown/github'"),
  );
  assertEquals(c.recipes.length, 1);
});

Deno.test("runRecipe uses the allowlist it is given", async () => {
  const r = parseConfig(GH).recipes[0];
  const exec = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
  const none = () => false;
  let msg = "";
  try {
    await runRecipe({ recipe: r, captures: ["a/b"] }, exec, "/repo", none);
  } catch (e) {
    msg = (e as Error).message;
  }
  assertMatch(msg, /not on the allowlist/);
});

Deno.test("dataName may name inputs; a repo becomes a slug", () => {
  const c = parseConfig(
    GH.replace("dataName: prs", "dataName: prs-{repo}-{state}"),
  );
  assertEquals(c.errors, []);
  const r = c.recipes[0];
  assertEquals(
    r.dataNameFor?.(["puddle-works/puddleworks"]),
    "prs-puddle-works-puddleworks-open",
  );
});
