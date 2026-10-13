/**
 * Tests for the puddlerouter model.
 *
 * Run with: make test
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1";
import { parseConfig } from "./_lib/config.ts";
import {
  buildReply,
  cleanTurn,
  decisionAnswer,
  effectiveRoute,
  executeRecipe,
  findMatch,
  issueDraft,
  loadTurn,
  looksSecret,
  model,
  normalise,
  recallRoute,
  resultCacheKey,
  ROUTE_CACHE_VERSION,
  routeCacheKey,
  sourceRef,
  type Store,
  withPacks,
  withRecall,
} from "./puddlerouter.ts";

const OPEN = '<pasted_content id="abc">';
const CLOSE = '</pasted_content id="abc">';

Deno.test("model type is @puddleworks/puddlerouter", () => {
  assertEquals(model.type, "@puddleworks/puddlerouter");
});

Deno.test("normalise lowercases and collapses whitespace", () => {
  assertEquals(normalise("  List   the\nOpen PRs \t"), "list the open prs");
});

Deno.test("cleanTurn keeps plain text, trimmed", () => {
  assertEquals(cleanTurn("  list the open PRs \n", 2000), {
    text: "list the open PRs",
    pasted: 0,
    fenced: 0,
    truncated: false,
  });
});

Deno.test("cleanTurn replaces pasted_content blocks", () => {
  const raw = `review this\n${OPEN}\nsecret stuff\nmore\n${CLOSE}\nplease`;
  const turn = cleanTurn(raw, 2000);
  assertEquals(turn.text, "review this\n[pasted text]\nplease");
  assertEquals(turn.pasted, 1);
});

Deno.test("cleanTurn drops an unclosed pasted_content block to the end", () => {
  const turn = cleanTurn(`look\n${OPEN}\nall of this`, 2000);
  assertEquals(turn.text, "look\n[pasted text]");
  assertEquals(turn.pasted, 1);
});

Deno.test("cleanTurn replaces fenced code blocks, closed or not", () => {
  const raw = "why does\n```ts\nconst x = 1;\n```\nfail? and\n~~~\nopen";
  const turn = cleanTurn(raw, 2000);
  assertEquals(turn.text, "why does\n[code block]\nfail? and\n[code block]");
  assertEquals(turn.fenced, 2);
});

Deno.test("cleanTurn caps the length and says so", () => {
  const turn = cleanTurn("a".repeat(50), 10);
  assertEquals(turn.text, "a".repeat(10));
  assertEquals(turn.truncated, true);
});

Deno.test("sourceRef is prefixed and 16 hex characters", async () => {
  assertMatch(
    await sourceRef("list the open PRs"),
    /^puddlerouter:[0-9a-f]{16}$/,
  );
});

Deno.test("sourceRef ignores case and spacing, not wording", async () => {
  const a = await sourceRef("List the open PRs");
  assertEquals(a, await sourceRef("  list  the open\nprs "));
  assert(a !== await sourceRef("list the closed PRs"));
});

Deno.test("effectiveRoute keeps a confident route", () => {
  assertEquals(effectiveRoute("decision", 0.95, 0.7), "decision");
  assertEquals(effectiveRoute("deterministic", 0.7, 0.7), "deterministic");
});

Deno.test("effectiveRoute sends low confidence or no answer to llm", () => {
  assertEquals(effectiveRoute("deterministic", 0.64, 0.7), "llm");
  assertEquals(effectiveRoute(undefined, undefined, 0.7), "llm");
  assertEquals(effectiveRoute("nonsense", 0.99, 0.7), "llm");
});

Deno.test("buildReply in shadow mode always passes", () => {
  const reply = buildReply({
    mode: "shadow",
    sourceRef: "puddlerouter:0123456789abcdef",
    choice: "decision",
    confidence: 0.95,
    cutoff: 0.7,
  });
  assertEquals(reply.action, "pass");
  assertEquals(reply.text, "");
  assertEquals(reply.route, "decision");
  assertEquals(reply.mode, "shadow");
});

Deno.test("buildReply records a low-confidence route as llm", () => {
  const reply = buildReply({
    mode: "shadow",
    sourceRef: "puddlerouter:0123456789abcdef",
    choice: "deterministic",
    confidence: 0.64,
    cutoff: 0.7,
  });
  assertEquals(reply.route, "llm");
  assertEquals(reply.choice, "deterministic");
  assertEquals(reply.confidence, 0.64);
});

Deno.test("buildReply passes when the route step gave no answer", () => {
  const reply = buildReply({
    mode: "live",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
  });
  assertEquals(reply.action, "pass");
  assertEquals(reply.route, "llm");
  assertEquals(reply.reason, "no route answer");
});

const DECIDED = {
  sourceRef: "puddlerouter:0123456789abcdef",
  choice: "decision",
  confidence: 0.95,
  cutoff: 0.7,
  answerCutoff: 0.8,
  complete: true,
};

Deno.test("decisionAnswer is yes or no only past the answer cut-off", () => {
  assertEquals(decisionAnswer(0.95, 0.8), "yes");
  assertEquals(decisionAnswer(0.8, 0.8), "yes");
  assertEquals(decisionAnswer(0.05, 0.8), "no");
  assertEquals(decisionAnswer(0.2, 0.8), "no");
  assertEquals(decisionAnswer(0.5, 0.8), "unsure");
  assertEquals(decisionAnswer(0.79, 0.8), "unsure");
});

Deno.test("buildReply in live mode blocks with Jev's yes", () => {
  const reply = buildReply({ ...DECIDED, mode: "live", yes: 0.95 });
  assertEquals(reply.action, "block");
  assertEquals(reply.wouldAction, "block");
  assertEquals(reply.route, "decision");
  assertEquals(reply.answer, "yes");
  assertEquals(reply.yes, 0.95);
  assertEquals(reply.reason, "decision answered yes");
  assertMatch(reply.text, /^Jev: yes \(95% sure\)\./);
  assertMatch(reply.text, /llm:/);
});

Deno.test("buildReply in live mode blocks with Jev's no", () => {
  const reply = buildReply({ ...DECIDED, mode: "live", yes: 0.1 });
  assertEquals(reply.action, "block");
  assertEquals(reply.answer, "no");
  assertMatch(reply.text, /^Jev: no \(90% sure\)\./);
});

Deno.test("buildReply passes when Jev is unsure of the answer", () => {
  const reply = buildReply({ ...DECIDED, mode: "live", yes: 0.6 });
  assertEquals(reply.action, "pass");
  assertEquals(reply.text, "");
  assertEquals(reply.answer, "unsure");
  assertEquals(reply.reason, "decision unsure");
});

Deno.test("buildReply passes when the decision step gave no answer", () => {
  const reply = buildReply({ ...DECIDED, mode: "live", yes: null });
  assertEquals(reply.action, "pass");
  assertEquals(reply.answer, null);
  assertEquals(reply.yes, null);
  assertEquals(reply.reason, "no decision answer");
});

Deno.test("buildReply passes a decision whose text was pasted, fenced or cut", () => {
  const reply = buildReply({
    ...DECIDED,
    mode: "live",
    complete: false,
    yes: 0.95,
  });
  assertEquals(reply.action, "pass");
  assertEquals(reply.answer, null);
  assertEquals(reply.reason, "decision text not in the turn");
});

Deno.test("buildReply ignores a yes answer on another route", () => {
  const reply = buildReply({
    ...DECIDED,
    mode: "live",
    choice: "llm",
    yes: 0.95,
  });
  assertEquals(reply.action, "pass");
  assertEquals(reply.answer, null);
  assertEquals(reply.yes, null);
});

Deno.test("buildReply in shadow mode passes but records what live would do", () => {
  const reply = buildReply({ ...DECIDED, mode: "shadow", yes: 0.95 });
  assertEquals(reply.action, "pass");
  assertEquals(reply.text, "");
  assertEquals(reply.wouldAction, "block");
  assertEquals(reply.answer, "yes");
  assertEquals(reply.reason, "shadow: decision answered yes");
});

Deno.test("buildReply records the time since the hook started", () => {
  const args = {
    mode: "shadow" as const,
    sourceRef: "puddlerouter:0123456789abcdef",
    choice: "llm",
    confidence: 0.99,
    cutoff: 0.7,
  };
  const now = new Date("2026-10-13T10:00:02.250Z");
  const started = now.getTime() - 2250;
  assertEquals(
    buildReply({ ...args, hookStartedAt: started }, now).elapsedMs,
    2250,
  );
  assertEquals(buildReply({ ...args, hookStartedAt: 0 }, now).elapsedMs, null);
  assertEquals(buildReply(args, now).elapsedMs, null);
});

interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** A method context; `events` records log messages and writes in order. */
function fakeContext(written: Written[], events: string[] = []) {
  return {
    globalArgs: {},
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      events.push(`write ${spec}`);
      return Promise.resolve({ name });
    },
    readResource: (_name: string): Promise<Record<string, unknown> | null> =>
      Promise.resolve(null),
    logger: { info: (msg: string) => void events.push(`log ${msg}`) },
  };
}

Deno.test("loadTurn cleans the text and hashes it", async () => {
  const turn = await loadTurn(
    "  list the open PRs\n",
    2000,
    new Date("2026-10-13T10:00:00Z"),
  );
  assertEquals(turn.text, "list the open PRs");
  assertEquals(turn.empty, false);
  assertEquals(turn.sourceRef, await sourceRef("list the open PRs"));
  assertEquals(turn.loadedAt, "2026-10-13T10:00:00.000Z");
});

Deno.test("loadTurn marks a turn that is only pasted or code as empty", async () => {
  const turn = await loadTurn(
    `${OPEN}\nall pasted\n${CLOSE}\n\n\`\`\`\ncode\n\`\`\``,
    2000,
  );
  assertEquals(turn.text, "[pasted text]\n\n[code block]");
  assertEquals(turn.empty, true);
  assertEquals((await loadTurn("   ", 2000)).empty, true);
});

Deno.test("loadTurn marks a turn complete only if nothing was removed or cut", async () => {
  assertEquals((await loadTurn("is 'x2' a good name?", 2000)).complete, true);
  assertEquals(
    (await loadTurn(`is this good?\n${OPEN}\nx\n${CLOSE}`, 2000)).complete,
    false,
  );
  assertEquals(
    (await loadTurn("is this good?\n```\nx\n```", 2000)).complete,
    false,
  );
  assertEquals((await loadTurn("a".repeat(50), 10)).complete, false);
});

const SECRETS = [
  "is ghp_abcdefghijklmnopqrstuvwxyz0123456789 a valid token format?",
  "use github_pat_11ABCDEFG0abcdefghijklmnopqrstuv for this",
  "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  "AKIAIOSFODNN7EXAMPLE is that an aws key?",
  "slack xoxb-123456789012-abcdefghijklmn",
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
  "-----BEGIN RSA PRIVATE KEY-----",
  "password=hunter2 is that strong?",
  "export API_TOKEN: abcd1234 ok?",
  "email me at mark@example.com about it",
  "is 3f2a9c1b7d4e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a a good id?",
];

Deno.test("looksSecret flags tokens, keys, passwords, emails and long hex", () => {
  for (const text of SECRETS) assert(looksSecret(text), text);
});

Deno.test("looksSecret leaves ordinary questions alone", () => {
  for (
    const text of [
      "is 'Add hook for routing prompts' written in the imperative mood?",
      "list the open pull requests in puddle-works/puddleworks",
      "is this variable name descriptive enough: 'x2'?",
      "what is the latest published version of @swamp/aws/ec2?",
      "should we set a password policy of 12 characters?",
      "the commit is 6e04ffa, is the message good?",
    ]
  ) assert(!looksSecret(text), text);
});

Deno.test("loadTurn withholds a secret turn: placeholder text, not complete", async () => {
  const turn = await loadTurn(SECRETS[0], 2000);
  assertEquals(turn.withheld, true);
  assertEquals(turn.complete, false);
  assertEquals(turn.text, "[withheld: looks like it contains a secret]");
  assertEquals(turn.text.includes("ghp_"), false);
  assertEquals((await loadTurn("is 'x2' a good name?", 2000)).withheld, false);
});

Deno.test("load fails when the turn file is missing", async () => {
  await assertRejects(() =>
    model.methods.load.execute(
      { turnFile: "/nonexistent/puddlerouter-turn", maxChars: 2000 },
      fakeContext([]),
    )
  );
});

Deno.test("reply writes the reply, and a route cache entry for a routed turn", async () => {
  const written: Written[] = [];
  await model.methods.reply.execute(
    {
      mode: "shadow",
      sourceRef: "puddlerouter:0123456789abcdef",
      choice: "llm",
      confidence: 0.99,
      cutoff: 0.7,
      complete: true,
      answerCutoff: 0.8,
    },
    fakeContext(written),
  );
  assertEquals(written.map((w) => w.spec), ["reply", "routeCache"]);
  assertEquals(written[0].name, "reply");
  assertEquals(written[0].data.action, "pass");
});

Deno.test("load logs before it reads the turn file", async () => {
  const events: string[] = [];
  await assertRejects(() =>
    model.methods.load.execute(
      { turnFile: "/nonexistent/puddlerouter-turn", maxChars: 2000 },
      fakeContext([], events),
    )
  );
  assertEquals(events, ["log Loading turn"]);
});

Deno.test("reply logs before and after it writes", async () => {
  const events: string[] = [];
  await model.methods.reply.execute(
    {
      mode: "shadow",
      sourceRef: "puddlerouter:0123456789abcdef",
      choice: "llm",
      confidence: 0.99,
      cutoff: 0.7,
      complete: true,
      answerCutoff: 0.8,
    },
    fakeContext([], events),
  );
  assertEquals(events, [
    "log Replying for {sourceRef}",
    "write reply",
    "write routeCache",
    "log Reply {action} for {sourceRef} ({reason})",
  ]);
});

// ---- deterministic route ----

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

function fakeExec(replies: Record<string, string>) {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    const key = Object.keys(replies).find((k) => args.join(" ").startsWith(k));
    return Promise.resolve(
      key === undefined
        ? { code: 1, stdout: "", stderr: "nope" }
        : ok(replies[key]),
    );
  };
  return { exec, calls };
}

Deno.test("findMatch picks a recipe without searching", async () => {
  const { exec, calls } = fakeExec({});
  const m = await findMatch(
    "git status",
    exec,
    new Date("2026-10-13T10:00:00Z"),
  );
  assertEquals(m.kind, "recipe");
  assertEquals(m.recipeId, "git-status");
  assertEquals(calls.length, 0);
});

Deno.test("findMatch lists candidates from the local types and the registry", async () => {
  const { exec, calls } = fakeExec({
    "model type search": JSON.stringify({
      results: [{ raw: "@swamp/hetzner-cloud", normalized: "x" }],
    }),
    "extension search": JSON.stringify({
      extensions: [
        { name: "@swamp/hetzner-cloud", description: "Hetzner Cloud models" },
        { name: "@swamp/other", description: "Other" },
      ],
    }),
  });
  const m = await findMatch("list the hetzner servers in my account", exec);
  assertEquals(m.kind, "candidates");
  assertEquals(m.query, "hetzner servers account");
  assertEquals(m.candidates.map((c) => c.name), [
    "@swamp/hetzner-cloud",
    "@swamp/other",
  ]);
  assertEquals(Object.keys(m.criteria), ["c1", "c2", "c3", "none"]);
  assertEquals(m.criteria.c3, "No such candidate.");
  assert(calls.every((c) => !c.join(" ").includes("hetzner servers in my")));
});

Deno.test("findMatch fails open to none when searches fail or find nothing", async () => {
  const none = await findMatch("list the hetzner servers", fakeExec({}).exec);
  assertEquals(none.kind, "none");
  assertEquals(none.candidates, []);
  const empty = await findMatch("hello", fakeExec({}).exec);
  assertEquals(empty.kind, "none");
});

Deno.test("executeRecipe runs the recipe and returns its text", async () => {
  const { exec } = fakeExec({
    "behavior run @swamp/git status git": JSON.stringify({
      dataArtifacts: [{
        name: "status",
        attributes: {
          branch: "main",
          entries: [],
        },
      }],
    }),
  });
  const r = await executeRecipe("git-status", [], exec, "/repo");
  assertEquals(r.ok, true);
  assert(r.text.length > 0);
});

Deno.test("executeRecipe reports an unknown recipe as a failure", async () => {
  const r = await executeRecipe("nope", [], fakeExec({}).exec, "/repo");
  assertEquals(r.ok, false);
  assertMatch(r.error, /unknown recipe/);
});

const detArgs = {
  mode: "live" as const,
  sourceRef: "puddlerouter:0123456789abcdef",
  choice: "deterministic",
  confidence: 0.9,
  cutoff: 0.7,
  complete: true,
};

Deno.test("buildReply blocks with a recipe's answer in live mode", () => {
  const r = buildReply({
    ...detArgs,
    matchKind: "recipe",
    recipeId: "git-status",
    resultOk: true,
    resultText: "On branch main, clean.",
  });
  assertEquals(r.action, "block");
  assertMatch(r.text, /^On branch main, clean\./);
  assertMatch(r.text, /recipe git-status/);
  assertMatch(r.text, /starting with llm:/);
  assertEquals(r.reason, "recipe git-status answered");
});

Deno.test("buildReply passes when the recipe failed", () => {
  const r = buildReply({
    ...detArgs,
    matchKind: "recipe",
    recipeId: "git-status",
    resultOk: false,
    resultText: "",
  });
  assertEquals(r.action, "pass");
  assertEquals(r.reason, "recipe git-status failed");
});

const cands = [
  { name: "@swamp/hetzner-cloud", description: "Hetzner Cloud models" },
];

Deno.test("buildReply hints at the extension Jev picks", () => {
  const r = buildReply({
    ...detArgs,
    matchKind: "candidates",
    candidates: cands,
    pickChoice: "c1",
    pickConfidence: 0.9,
  });
  assertEquals(r.action, "hint");
  assertMatch(r.text, /@swamp\/hetzner-cloud/);
  assertMatch(r.text, /swamp model type describe/);
  assertEquals(r.reason, "extension @swamp/hetzner-cloud, no recipe");
});

Deno.test("buildReply passes when the pick is none, unsure or out of range", () => {
  for (
    const [pickChoice, pickConfidence] of [
      ["none", 0.9],
      ["c1", 0.5],
      ["c2", 0.9],
      [undefined, undefined],
    ] as const
  ) {
    const r = buildReply({
      ...detArgs,
      matchKind: "candidates",
      candidates: cands,
      pickChoice,
      pickConfidence,
    });
    assertEquals(r.action, "pass");
    assertEquals(r.reason, "no extension found, no issue raised");
  }
});

Deno.test("buildReply in shadow mode passes a recipe answer but records it", () => {
  const r = buildReply({
    ...detArgs,
    mode: "shadow",
    matchKind: "recipe",
    recipeId: "git-log",
    resultOk: true,
    resultText: "abc",
  });
  assertEquals(r.action, "pass");
  assertEquals(r.text, "");
  assertEquals(r.wouldAction, "block");
  assertEquals(r.recipe, "git-log");
});

Deno.test("buildReply does not use a recipe off the deterministic route", () => {
  const r = buildReply({
    ...detArgs,
    choice: "llm",
    matchKind: "recipe",
    recipeId: "git-status",
    resultOk: true,
    resultText: "x",
  });
  assertEquals(r.action, "pass");
});

Deno.test("match and execute write one resource each", async () => {
  const w1: Written[] = [];
  await model.methods.match.execute(
    { text: "git status", repoDir: "/nonexistent" },
    fakeContext(w1),
  );
  assertEquals(w1.length, 1);
  assertEquals(w1[0].spec, "match");
  assertEquals(w1[0].data.recipeId, "git-status");
  const w2: Written[] = [];
  await model.methods.execute.execute(
    { recipeId: "nope", captures: [], repoDir: "/nonexistent" },
    fakeContext(w2),
  );
  assertEquals(w2[0].spec, "result");
  assertEquals(w2[0].data.ok, false);
});

Deno.test("findMatch offers only allowlisted extensions", async () => {
  const { exec } = fakeExec({
    "extension search": JSON.stringify({
      extensions: [
        { name: "@hivemq/hetzner/servers", description: "third party" },
        { name: "@swamp/hetzner-cloud", description: "official" },
      ],
    }),
  });
  const m = await findMatch("list the hetzner servers", exec);
  assertEquals(m.candidates.map((c) => c.name), ["@swamp/hetzner-cloud"]);
});

// ---- step 4: raise an issue when nothing can answer ----

Deno.test("issueDraft makes a one-line title, a body with the turn, and a key", () => {
  const d = issueDraft(
    "list the hetzner servers\nin my account " + "x".repeat(200),
    "puddlerouter:0123456789abcdef",
    "hetzner servers account",
    [{ name: "@swamp/hetzner-cloud", description: "Hetzner" }],
  );
  assert(d.title.startsWith("Recipe wanted: list the hetzner servers in my"));
  assert(d.title.length <= 100, `${d.title.length}`);
  assert(!d.title.includes("\n"));
  assertMatch(d.body, /> list the hetzner servers\n> in my account/);
  assertMatch(d.body, /puddlerouter:0123456789abcdef/);
  assertMatch(d.body, /hetzner servers account/);
  assertMatch(d.body, /@swamp\/hetzner-cloud/);
  assertEquals(d.key, "puddlerouter:0123456789abcdef");
});

Deno.test("findMatch carries the issue draft for a turn nothing can answer", async () => {
  const m = await findMatch(
    "list the hetzner servers",
    fakeExec({}).exec,
    new Date(),
    "puddlerouter:0123456789abcdef",
  );
  assertEquals(m.kind, "none");
  assertEquals(m.issueKey, "puddlerouter:0123456789abcdef");
  assertMatch(m.issueTitle, /^Recipe wanted: list the hetzner servers/);
  assertMatch(m.issueBody, /Raised by puddlerouter/);
});

Deno.test("buildReply blocks with the issue link when one was raised", () => {
  const r = buildReply({
    ...detArgs,
    matchKind: "none",
    issueUrl: "https://github.com/puddle-works/puddleworks-apps/issues/7",
  });
  assertEquals(r.action, "block");
  assertMatch(r.text, /issues\/7/);
  assertMatch(r.text, /starting with llm:/);
  assertEquals(
    r.issue,
    "https://github.com/puddle-works/puddleworks-apps/issues/7",
  );
  assertEquals(r.reason, "no extension found, issue raised");
});

Deno.test("buildReply passes when the issue could not be raised", () => {
  const r = buildReply({ ...detArgs, matchKind: "none", issueUrl: "" });
  assertEquals(r.action, "pass");
  assertEquals(r.reason, "no extension found, no issue raised");
});

Deno.test("buildReply in shadow mode records that live would raise an issue", () => {
  const r = buildReply({ ...detArgs, mode: "shadow", matchKind: "none" });
  assertEquals(r.action, "pass");
  assertEquals(r.wouldAction, "block");
  assertMatch(r.reason, /would raise an issue/);
});

Deno.test("buildReply does not raise an issue for a failed recipe or a hint", () => {
  const failed = buildReply({
    ...detArgs,
    matchKind: "recipe",
    recipeId: "git-status",
    resultOk: false,
  });
  assertEquals(failed.wouldAction, "pass");
  const hint = buildReply({
    ...detArgs,
    matchKind: "candidates",
    candidates: cands,
    pickChoice: "c1",
    pickConfidence: 0.9,
  });
  assertEquals(hint.action, "hint");
});

// ---- step 6: local config ----

const LOCAL = parseConfig(`
allow: ['@acme/*']
recipes:
  - id: gh-open-prs
    extension: '@webframp/github'
    method: list_prs
    definition: github
    dataName: prs
    pattern: '^list the open prs in ([\\w.-]+/[\\w.-]+)$'
    inputs: { repo: { capture: 1, as: repo } }
    each: { path: items, line: '#{number} {title}' }
    template: "{count} open:\\n{lines}"
`);

Deno.test("findMatch tries local recipes before the built-in ones", async () => {
  const m = await findMatch(
    "list the open PRs in puddle-works/puddleworks",
    fakeExec({}).exec,
    new Date(),
    "puddlerouter:0123456789abcdef",
    LOCAL,
  );
  assertEquals(m.kind, "recipe");
  assertEquals(m.recipeId, "gh-open-prs");
  assertEquals(m.captures, ["puddle-works/puddleworks"]);
});

Deno.test("findMatch offers extensions the file allows", async () => {
  const { exec } = fakeExec({
    "extension search": JSON.stringify({
      extensions: [
        { name: "@acme/hetzner", description: "acme" },
        { name: "@other/hetzner", description: "other" },
      ],
    }),
  });
  const m = await findMatch(
    "list the hetzner servers",
    exec,
    new Date(),
    "",
    LOCAL,
  );
  assertEquals(m.candidates.map((c) => c.name), ["@acme/hetzner"]);
});

Deno.test("executeRecipe runs a local recipe", async () => {
  const { exec, calls } = fakeExec({
    "behavior run @webframp/github list_prs github": JSON.stringify({
      dataArtifacts: [{
        name: "prs",
        attributes: { items: [{ number: 4, title: "fix" }] },
      }],
    }),
  });
  const r = await executeRecipe(
    "gh-open-prs",
    ["puddle-works/puddleworks"],
    exec,
    "/repo",
    LOCAL,
  );
  assertEquals(r, { ok: true, text: "1 open:\n#4 fix", error: "" });
  assert(calls[0].includes("repo=puddle-works/puddleworks"));
});

Deno.test("executeRecipe refuses a capture of the wrong shape", async () => {
  const r = await executeRecipe(
    "gh-open-prs",
    ["x; rm -rf /"],
    fakeExec({}).exec,
    "/repo",
    LOCAL,
  );
  assertEquals(r.ok, false);
  assertMatch(r.error, /bad input/);
});

Deno.test("match reads puddlerouter.yaml from the repo dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/puddlerouter.yaml`,
      `recipes:\n  - id: my-status\n    extension: '@swamp/git'\n    method: status\n    definition: git\n    dataName: status\n    pattern: '^repo state$'\n    template: ok\n`,
    );
    const written: Written[] = [];
    await model.methods.match.execute(
      { text: "repo state", repoDir: dir },
      fakeContext(written),
    );
    assertEquals(written[0].data.recipeId, "my-status");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("match without a puddlerouter.yaml uses the built-in recipes", async () => {
  const written: Written[] = [];
  await model.methods.match.execute(
    { text: "git status", repoDir: "/nonexistent" },
    fakeContext(written),
  );
  assertEquals(written[0].data.recipeId, "git-status");
});

// ---- caches ----

/** An in-memory store; `writes` lists every write in order. */
function fakeStore(seed: Record<string, Record<string, unknown>> = {}) {
  const data = { ...seed };
  const writes: Array<{ spec: string; name: string }> = [];
  const store: Store = {
    read: (name) => Promise.resolve(data[name] ?? null),
    write: (spec, name, d) => {
      data[name] = d;
      writes.push({ spec, name });
      return Promise.resolve();
    },
  };
  return { store, data, writes };
}

const REF = "puddlerouter:0123456789abcdef";
const T0 = new Date("2026-10-13T10:00:00Z");
const DAY = 24 * 3600 * 1000;
const MISS = {
  hasRoute: false,
  choice: "",
  confidence: 0,
  hasDecision: false,
  yes: 0,
  hasPick: false,
  pickChoice: "",
  pickConfidence: 0,
  candidates: [],
  cachedAt: "",
};

Deno.test("routeCacheKey carries the version and the sourceRef's hex", () => {
  assertEquals(
    routeCacheKey(REF),
    `route-${ROUTE_CACHE_VERSION}-0123456789abcdef`,
  );
});

Deno.test("recallRoute misses on an empty store", async () => {
  assertEquals(await recallRoute(fakeStore().store, REF, T0), MISS);
});

Deno.test("recallRoute returns what a fresh entry holds", async () => {
  const { store } = fakeStore({
    [routeCacheKey(REF)]: {
      choice: "deterministic",
      confidence: 0.9,
      yes: null,
      pickChoice: "c1",
      pickConfidence: 0.85,
      candidates: [{ name: "@a/b", description: "d" }],
      cachedAt: new Date(T0.getTime() - 6 * DAY).toISOString(),
    },
  });
  const r = await recallRoute(store, REF, T0);
  assertEquals(r.hasRoute, true);
  assertEquals(r.choice, "deterministic");
  assertEquals(r.hasDecision, false);
  assertEquals(r.hasPick, true);
  assertEquals(r.pickChoice, "c1");
  assertEquals(r.candidates, [{ name: "@a/b", description: "d" }]);
});

Deno.test("recallRoute ignores an entry older than 7 days", async () => {
  const { store } = fakeStore({
    [routeCacheKey(REF)]: {
      choice: "llm",
      confidence: 0.9,
      yes: null,
      pickChoice: "",
      pickConfidence: 0,
      candidates: [],
      cachedAt: new Date(T0.getTime() - 8 * DAY).toISOString(),
    },
  });
  assertEquals(await recallRoute(store, REF, T0), MISS);
});

Deno.test("recallRoute misses on a read error or a malformed entry", async () => {
  const broken: Store = {
    read: () => Promise.reject(new Error("boom")),
    write: () => Promise.resolve(),
  };
  assertEquals(await recallRoute(broken, REF, T0), MISS);
  const { store } = fakeStore({ [routeCacheKey(REF)]: { choice: 5 } });
  assertEquals(await recallRoute(store, REF, T0), MISS);
});

const REPLY_BASE = { mode: "shadow" as const, sourceRef: REF, cutoff: 0.7 };

Deno.test("withRecall fills a skipped route from the cache", () => {
  const out = withRecall(
    { ...REPLY_BASE, choice: "", confidence: 0 },
    { ...MISS, hasRoute: true, choice: "decision", confidence: 0.95 },
  );
  assertEquals(out.args.choice, "decision");
  assertEquals(out.args.confidence, 0.95);
  assertEquals(out.cached, true);
});

Deno.test("withRecall fills yes and the pick, with the cached candidates", () => {
  const out = withRecall(
    { ...REPLY_BASE, choice: "deterministic", confidence: 0.9, yes: null },
    {
      ...MISS,
      hasDecision: true,
      yes: 0.97,
      hasPick: true,
      pickChoice: "c1",
      pickConfidence: 0.9,
      candidates: [{ name: "@a/b", description: "d" }],
    },
  );
  assertEquals(out.args.yes, 0.97);
  assertEquals(out.args.pickChoice, "c1");
  assertEquals(out.args.candidates, [{ name: "@a/b", description: "d" }]);
  assertEquals(out.cached, true);
});

Deno.test("withRecall keeps fresh answers and reports no hit", () => {
  const out = withRecall(
    {
      ...REPLY_BASE,
      choice: "llm",
      confidence: 0.8,
      yes: 0.2,
      pickChoice: "none",
      pickConfidence: 0.9,
      candidates: [{ name: "@x/y", description: "" }],
    },
    {
      ...MISS,
      hasRoute: true,
      choice: "decision",
      confidence: 0.99,
      hasDecision: true,
      yes: 0.9,
      hasPick: true,
      pickChoice: "c1",
    },
  );
  assertEquals(out.args.choice, "llm");
  assertEquals(out.args.confidence, 0.8);
  assertEquals(out.args.yes, 0.2);
  assertEquals(out.args.pickChoice, "none");
  assertEquals(out.args.candidates, [{ name: "@x/y", description: "" }]);
  assertEquals(out.cached, false);
});

Deno.test("withRecall with a miss changes nothing", () => {
  const out = withRecall({ ...REPLY_BASE, choice: "" }, MISS);
  assertEquals(out.cached, false);
  assertEquals(out.args.choice, "");
});

Deno.test("recall reads the cache and always writes fixed-shape fields", async () => {
  const written: Written[] = [];
  await model.methods.recall.execute(
    { sourceRef: REF },
    fakeContext(written),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "recall");
  assertEquals(written[0].data.hasRoute, false);
  assertEquals(written[0].data.candidates, []);
});

Deno.test("reply stores the merged answers in the route cache and says cached", async () => {
  const written: Written[] = [];
  const ctx = fakeContext(written);
  await model.methods.reply.execute(
    { sourceRef: REF, choice: "llm", confidence: 0.9 } as never,
    ctx,
  );
  const cache = written.find((w) => w.spec === "routeCache");
  assertEquals(cache?.name, routeCacheKey(REF));
  assertEquals(cache?.data.choice, "llm");
  assertEquals(written.find((w) => w.spec === "reply")?.data.cached, false);
});

Deno.test("reply from a full cache hit writes no cache entry and says cached", async () => {
  const written: Written[] = [];
  const ctx = fakeContext(written);
  await model.methods.reply.execute(
    {
      sourceRef: REF,
      choice: "",
      recalled: { ...MISS, hasRoute: true, choice: "llm", confidence: 0.9 },
    } as never,
    ctx,
  );
  assertEquals(written.some((w) => w.spec === "routeCache"), false);
  const reply = written.find((w) => w.spec === "reply")!;
  assertEquals(reply.data.cached, true);
  assertEquals(reply.data.choice, "llm");
});

Deno.test("reply does not cache a turn Jev gave no route for", async () => {
  const written: Written[] = [];
  const ctx = fakeContext(written);
  await model.methods.reply.execute(
    { sourceRef: REF, choice: "" } as never,
    ctx,
  );
  assertEquals(written.some((w) => w.spec === "routeCache"), false);
});

// search cache

const SEARCH = {
  "model type search": JSON.stringify({ results: [{ raw: "@acme/local" }] }),
  "extension search": JSON.stringify({
    extensions: [{ name: "@swamp/reg", description: "r" }],
  }),
};

Deno.test("findMatch serves a repeated search from the cache", async () => {
  const { store, writes } = fakeStore();
  const first = fakeExec(SEARCH);
  const a = await findMatch(
    "list the hetzner servers",
    first.exec,
    T0,
    REF,
    parseConfig("allow: ['@acme/*']"),
    store,
  );
  assertEquals(first.calls.length, 2);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "searchCache");
  const second = fakeExec({});
  const b = await findMatch(
    "list the hetzner servers",
    second.exec,
    new Date(T0.getTime() + 3600_000),
    REF,
    parseConfig("allow: ['@acme/*']"),
    store,
  );
  assertEquals(second.calls.length, 0);
  assertEquals(b.candidates, a.candidates);
});

Deno.test("findMatch searches again once the cached search is a day old", async () => {
  const { store } = fakeStore();
  await findMatch(
    "list the hetzner servers",
    fakeExec(SEARCH).exec,
    T0,
    REF,
    undefined,
    store,
  );
  const later = fakeExec(SEARCH);
  await findMatch(
    "list the hetzner servers",
    later.exec,
    new Date(T0.getTime() + DAY + 1000),
    REF,
    undefined,
    store,
  );
  assertEquals(later.calls.length, 2);
});

Deno.test("findMatch does not cache when a search failed", async () => {
  const { store, writes } = fakeStore();
  await findMatch(
    "list the hetzner servers",
    fakeExec({ "extension search": SEARCH["extension search"] }).exec,
    T0,
    REF,
    undefined,
    store,
  );
  assertEquals(writes.length, 0);
});

Deno.test("findMatch applies the allowlist after the cache", async () => {
  const { store } = fakeStore();
  const open = parseConfig("allow: ['@acme/*']");
  await findMatch(
    "list the hetzner servers",
    fakeExec(SEARCH).exec,
    T0,
    REF,
    open,
    store,
  );
  const strict = await findMatch(
    "list the hetzner servers",
    fakeExec({}).exec,
    T0,
    REF,
    parseConfig(""),
    store,
  );
  assertEquals(
    strict.candidates.map((c) => c.name).includes("@acme/local"),
    false,
  );
});

Deno.test("match passes a resource-backed cache to findMatch", async () => {
  const written: Written[] = [];
  await model.methods.match.execute(
    { text: "git status", repoDir: "/nonexistent" },
    fakeContext(written),
  );
  assertEquals(written.length, 1);
});

// result cache

const CACHED_RECIPE = parseConfig(`
recipes:
  - id: gh-open-prs
    extension: '@webframp/github'
    method: list_prs
    definition: github
    dataName: prs
    pattern: '^list the open prs in ([\\w.-]+/[\\w.-]+)$'
    inputs: { repo: { capture: 1, as: repo } }
    cacheFor: 5m
    template: "ok"
`);

Deno.test("cacheFor is parsed to milliseconds; a bad value drops the recipe", () => {
  assertEquals(CACHED_RECIPE.errors, []);
  assertEquals(CACHED_RECIPE.recipes[0].cacheFor, 300_000);
  const bad = parseConfig(`
recipes:
  - id: x
    extension: '@webframp/github'
    method: m
    definition: d
    dataName: n
    pattern: '^x$'
    cacheFor: forever
    template: t
`);
  assertEquals(bad.recipes.length, 0);
  assertEquals(bad.errors.length, 1);
});

Deno.test("no built-in recipe is cached", async () => {
  const { RECIPES } = await import("./_lib/recipes.ts");
  assertEquals(RECIPES.filter((r) => r.cacheFor !== undefined), []);
});

Deno.test("executeRecipe without cacheFor never touches the store", async () => {
  const { store, writes } = fakeStore();
  await executeRecipe(
    "nope",
    [],
    fakeExec({}).exec,
    "/repo",
    undefined,
    store,
    T0,
  );
  assertEquals(writes.length, 0);
});

Deno.test("executeRecipe with cacheFor stores a success and serves the repeat", async () => {
  const { store, writes } = fakeStore();
  const exec = fakeExec({
    "behavior run": JSON.stringify({
      dataArtifacts: [{ name: "prs", attributes: {} }],
    }),
  });
  const first = await executeRecipe(
    "gh-open-prs",
    ["a/b"],
    exec.exec,
    "/repo",
    CACHED_RECIPE,
    store,
    T0,
  );
  assertEquals(first.ok, true);
  assertEquals(first.cached ?? false, false);
  assertEquals(writes.map((w) => w.spec), ["resultCache"]);
  const second = await executeRecipe(
    "gh-open-prs",
    ["a/b"],
    exec.exec,
    "/repo",
    CACHED_RECIPE,
    store,
    new Date(T0.getTime() + 60_000),
  );
  assertEquals(exec.calls.length, 1);
  assertEquals(second, { ok: true, text: "ok", error: "", cached: true });
});

Deno.test("executeRecipe does not cache a failed run", async () => {
  const { store, writes } = fakeStore();
  const r = await executeRecipe(
    "gh-open-prs",
    ["a/b"],
    fakeExec({}).exec,
    "/repo",
    CACHED_RECIPE,
    store,
    T0,
  );
  assertEquals(r.ok, false);
  assertEquals(writes.length, 0);
});

Deno.test("executeRecipe serves a cached result and expires it after cacheFor", async () => {
  const k = await resultCacheKey("gh-open-prs", ["a/b"]);
  const { store } = fakeStore({
    [k]: { text: "cached answer", cachedAt: T0.toISOString() },
  });
  const calls = fakeExec({});
  const fresh = await executeRecipe(
    "gh-open-prs",
    ["a/b"],
    calls.exec,
    "/repo",
    CACHED_RECIPE,
    store,
    new Date(T0.getTime() + 60_000),
  );
  assertEquals(fresh, {
    ok: true,
    text: "cached answer",
    error: "",
    cached: true,
  });
  assertEquals(calls.calls.length, 0);
  const stale = await executeRecipe(
    "gh-open-prs",
    ["a/b"],
    calls.exec,
    "/repo",
    CACHED_RECIPE,
    store,
    new Date(T0.getTime() + 6 * 60_000),
  );
  assertEquals(stale.cached ?? false, false);
  assert(calls.calls.length > 0);
});

// ---- recipe packs ----

const PACK_RAW = {
  id: "github-open-prs",
  extension: "@webframp/github",
  method: "list_prs",
  definition: "github",
  dataName: "prs-{repo}-{state}",
  pattern: "^open prs in ([\\w.-]+/[\\w.-]+)$",
  inputs: { repo: { capture: 1, as: "repo" } },
  fixed: { state: "open" },
  template: "ok",
};

function indexAt(syncedAt: Date, recipes: unknown[] = [PACK_RAW]) {
  return {
    recipes: recipes.map((recipe) => ({ pack: "@puddleworks/p", recipe })),
    packs: [{ name: "@puddleworks/p", version: "1" }],
    errors: [],
    syncedAt: syncedAt.toISOString(),
  };
}

Deno.test("withPacks adds pack recipes after the local ones", async () => {
  const local = parseConfig(`
recipes:
  - id: mine
    extension: '@webframp/github'
    method: list_prs
    definition: github
    dataName: prs
    pattern: '^mine$'
    template: t
`);
  const { store } = fakeStore({ "recipe-index": indexAt(T0) });
  const { config, notes } = await withPacks(local, store, T0);
  assertEquals(config.recipes.map((r) => r.id), ["mine", "github-open-prs"]);
  assertEquals(notes, []);
  assertEquals(config.allowlist, local.allowlist);
});

Deno.test("withPacks with no index, a broken index or a failing store adds nothing", async () => {
  const none = await withPacks(parseConfig(""), fakeStore().store, T0);
  assertEquals(none.config.recipes, []);
  assertEquals(none.notes, []);
  const broken = await withPacks(
    parseConfig(""),
    fakeStore({ "recipe-index": { recipes: "x" } }).store,
    T0,
  );
  assertEquals(broken.config.recipes, []);
  assertEquals(broken.notes.length, 1);
  const failing: Store = {
    read: () => Promise.reject(new Error("down")),
    write: () => Promise.resolve(),
  };
  assertEquals(
    (await withPacks(parseConfig(""), failing, T0)).config.recipes,
    [],
  );
});

Deno.test("withPacks still uses an index older than a day and says it is stale", async () => {
  const old = new Date(T0.getTime() - 2 * DAY);
  const { store } = fakeStore({ "recipe-index": indexAt(old) });
  const { config, notes } = await withPacks(parseConfig(""), store, T0);
  assertEquals(config.recipes.length, 1);
  assertEquals(notes.length, 1);
  assertMatch(notes[0], /stale/);
});

Deno.test("withPacks drops a pack recipe that clashes, is no longer allowed or is bad, and says so", async () => {
  const clash = { ...PACK_RAW, id: "git-status" };
  const evil = { ...PACK_RAW, id: "evil", extension: "@evil/x" };
  const bad = { ...PACK_RAW, id: "bad", pattern: "^(" };
  const { store } = fakeStore({
    "recipe-index": indexAt(T0, [clash, evil, bad, PACK_RAW]),
  });
  const { config, notes } = await withPacks(parseConfig(""), store, T0);
  assertEquals(config.recipes.map((r) => r.id), ["github-open-prs"]);
  assertEquals(notes.length, 3);
});

Deno.test("a pack recipe is matched by findMatch and run by executeRecipe", async () => {
  const { store } = fakeStore({ "recipe-index": indexAt(T0) });
  const { config } = await withPacks(parseConfig(""), store, T0);
  const m = await findMatch(
    "open prs in a/b",
    fakeExec({}).exec,
    T0,
    REF,
    config,
    store,
  );
  assertEquals(m.kind, "recipe");
  assertEquals(m.recipeId, "github-open-prs");
  const exec = fakeExec({
    "behavior run": JSON.stringify({
      dataArtifacts: [{ name: "prs-a-b-open", attributes: {} }],
    }),
  });
  const r = await executeRecipe(
    m.recipeId,
    m.captures,
    exec.exec,
    "/repo",
    config,
    store,
    T0,
  );
  assertEquals(r.ok, true);
  const call = exec.calls[0];
  assertEquals(call.slice(2, 5), ["@webframp/github", "list_prs", "github"]);
  assert(call.includes("repo=a/b") && call.includes("state=open"));
});

Deno.test("match reads the recipe index through the resource store", async () => {
  const written: Written[] = [];
  const context = {
    ...fakeContext(written),
    readResource: (name: string) =>
      Promise.resolve(name === "recipe-index" ? indexAt(new Date()) : null),
  };
  await model.methods.match.execute(
    { text: "open prs in a/b", repoDir: "/nonexistent" },
    context,
  );
  assertEquals(written[0].data.recipeId, "github-open-prs");
});

Deno.test("the model has a recipeIndex resource and a sync method", () => {
  assertEquals(model.resources.recipeIndex.lifetime, "7d");
  assert("sync" in model.methods);
});
