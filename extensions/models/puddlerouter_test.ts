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
  alwaysLlmHit,
  buildReply,
  captureSearch,
  cleanTurn,
  decisionAnswer,
  effectiveRoute,
  loadTurn,
  looksSecret,
  model,
  normalise,
  recallRoute,
  requestDraft,
  ROUTE_CACHE_VERSION,
  routeCacheKey,
  searchTurn,
  sourceRef,
  type Store,
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
  assertMatch(reply.wouldText, /^Jev: yes/);
  assertEquals(reply.answer, "yes");
  assertEquals(reply.reason, "shadow: decision answered yes");
});

Deno.test("buildReply in live mode gives the same text as wouldText", () => {
  const reply = buildReply({ ...DECIDED, mode: "live", yes: 0.95 });
  assertEquals(reply.wouldText, reply.text);
  const passed = buildReply({ ...DECIDED, mode: "live", yes: 0.5 });
  assertEquals(passed.wouldText, "");
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

Deno.test("searchTurn lists candidates from the local types and the registry", async () => {
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
  const m = await searchTurn("list the hetzner servers in my account", exec);
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

Deno.test("searchTurn fails open to none when searches fail or find nothing", async () => {
  const none = await searchTurn("list the hetzner servers", fakeExec({}).exec);
  assertEquals(none.kind, "none");
  assertEquals(none.candidates, []);
  const empty = await searchTurn("hello", fakeExec({}).exec);
  assertEquals(empty.kind, "none");
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
    assertEquals(r.reason, "no extension found, no request logged");
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

Deno.test("a matched recipe answers whatever route Jev gave or the cache holds", () => {
  const r = buildReply({
    ...detArgs,
    choice: "llm",
    matchKind: "recipe",
    recipeId: "git-status",
    resultOk: true,
    resultText: "x",
  });
  assertEquals(r.action, "block");
  assertEquals(r.route, "deterministic");
  assertEquals(r.recipe, "git-status");
});

Deno.test("searchTurn offers only allowlisted extensions", async () => {
  const { exec } = fakeExec({
    "extension search": JSON.stringify({
      extensions: [
        { name: "@hivemq/hetzner/servers", description: "third party" },
        { name: "@swamp/hetzner-cloud", description: "official" },
      ],
    }),
  });
  const m = await searchTurn("list the hetzner servers", exec);
  assertEquals(m.candidates.map((c) => c.name), ["@swamp/hetzner-cloud"]);
});

// ---- step 4: log a Capture request when nothing can answer ----

Deno.test("requestDraft makes a one-line title, a plain description with the turn, and a key", () => {
  const d = requestDraft(
    "list the hetzner servers\nin my account " + "x".repeat(200),
    "puddlerouter:0123456789abcdef",
    "hetzner servers account",
    [{ name: "@swamp/hetzner-cloud", description: "Hetzner" }],
  );
  assert(d.title.startsWith("Recipe wanted: list the hetzner servers in my"));
  assert(d.title.length <= 100, `${d.title.length}`);
  assert(!d.title.includes("\n"));
  assert(d.description.startsWith("list the hetzner servers\nin my account"));
  assert(!d.description.includes("> "), "no Markdown quoting");
  assert(!d.description.includes("`"), "no Markdown code");
  assertMatch(d.description, /puddlerouter:0123456789abcdef/);
  assertMatch(d.description, /hetzner servers account/);
  assertMatch(d.description, /@swamp\/hetzner-cloud/);
  assertEquals(d.key, "puddlerouter:0123456789abcdef");
});

Deno.test("searchTurn carries the request draft for a turn nothing can answer", async () => {
  const m = await searchTurn(
    "list the hetzner servers",
    fakeExec({}).exec,
    new Date(),
    "puddlerouter:0123456789abcdef",
  );
  assertEquals(m.kind, "none");
  assertEquals(m.requestKey, "puddlerouter:0123456789abcdef");
  assertMatch(m.requestTitle, /^Recipe wanted: list the hetzner servers/);
  assertMatch(m.requestDescription, /Logged by puddlerouter/);
});

Deno.test("buildReply blocks with the request link when one was logged", () => {
  const r = buildReply({
    ...detArgs,
    matchKind: "none",
    requestUrl: "http://localhost:3001/requests/req_7",
  });
  assertEquals(r.action, "block");
  assertMatch(
    r.text,
    /Logged a request in Capture: http:\/\/localhost:3001\/requests\/req_7/,
  );
  assertMatch(r.text, /starting with llm:/);
  assertEquals(r.request, "http://localhost:3001/requests/req_7");
  assertEquals(r.reason, "no extension found, request logged");
});

Deno.test("buildReply passes when the request could not be logged", () => {
  const r = buildReply({ ...detArgs, matchKind: "none", requestUrl: "" });
  assertEquals(r.action, "pass");
  assertEquals(r.request, "");
  assertEquals(r.reason, "no extension found, no request logged");
});

Deno.test("buildReply in shadow mode records that live would log a request", () => {
  const r = buildReply({ ...detArgs, mode: "shadow", matchKind: "none" });
  assertEquals(r.action, "pass");
  assertEquals(r.wouldAction, "block");
  assertMatch(r.reason, /would log a request/);
});

Deno.test("buildReply does not log a request for a failed recipe or a hint", () => {
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

const LOCAL = parseConfig(`allow: ['@acme/*']`);

Deno.test("searchTurn offers extensions the file allows", async () => {
  const { exec } = fakeExec({
    "extension search": JSON.stringify({
      extensions: [
        { name: "@acme/hetzner", description: "acme" },
        { name: "@other/hetzner", description: "other" },
      ],
    }),
  });
  const m = await searchTurn(
    "list the hetzner servers",
    exec,
    new Date(),
    "",
    LOCAL,
  );
  assertEquals(m.candidates.map((c) => c.name), ["@acme/hetzner"]);
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

Deno.test("searchTurn serves a repeated search from the cache", async () => {
  const { store, writes } = fakeStore();
  const first = fakeExec(SEARCH);
  const a = await searchTurn(
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
  const b = await searchTurn(
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

Deno.test("searchTurn searches again once the cached search is a day old", async () => {
  const { store } = fakeStore();
  await searchTurn(
    "list the hetzner servers",
    fakeExec(SEARCH).exec,
    T0,
    REF,
    undefined,
    store,
  );
  const later = fakeExec(SEARCH);
  await searchTurn(
    "list the hetzner servers",
    later.exec,
    new Date(T0.getTime() + DAY + 1000),
    REF,
    undefined,
    store,
  );
  assertEquals(later.calls.length, 2);
});

Deno.test("searchTurn does not cache when a search failed", async () => {
  const { store, writes } = fakeStore();
  await searchTurn(
    "list the hetzner servers",
    fakeExec({ "extension search": SEARCH["extension search"] }).exec,
    T0,
    REF,
    undefined,
    store,
  );
  assertEquals(writes.length, 0);
});

Deno.test("searchTurn applies the allowlist after the cache", async () => {
  const { store } = fakeStore();
  const open = parseConfig("allow: ['@acme/*']");
  await searchTurn(
    "list the hetzner servers",
    fakeExec(SEARCH).exec,
    T0,
    REF,
    open,
    store,
  );
  const strict = await searchTurn(
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

const MERGED_TEXT =
  "puddlerouter checked this with swamp before you ran (read-only: " +
  "nothing was changed):\n- #12 is merged.\n\nSteps to finish:\n1. Pull main in /repo.";

Deno.test("buildReply hints with the merged check's steps", () => {
  const r = buildReply({
    mode: "live",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    mergedMatched: true,
    mergedOk: true,
    mergedText: MERGED_TEXT,
    mergedSummary: "#12 clean",
  });
  assertEquals(r.action, "hint");
  assertEquals(r.text, MERGED_TEXT);
  assertEquals(r.route, "deterministic");
  assertEquals(r.recipe, "merged");
  assertEquals(r.reason, "merged: #12 clean");
});

Deno.test("buildReply in shadow mode records the merged hint and passes", () => {
  const r = buildReply({
    mode: "shadow",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    mergedMatched: true,
    mergedOk: true,
    mergedText: MERGED_TEXT,
    mergedSummary: "#12 clean",
  });
  assertEquals(r.action, "pass");
  assertEquals(r.text, "");
  assertEquals(r.wouldAction, "hint");
  assertEquals(r.wouldText, MERGED_TEXT);
  assertEquals(r.reason, "shadow: merged: #12 clean");
});

Deno.test("buildReply passes when the merged check failed", () => {
  const r = buildReply({
    mode: "live",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    mergedMatched: true,
    mergedOk: false,
    mergedError: "origin is not a GitHub remote",
  });
  assertEquals(r.action, "pass");
  assertEquals(r.route, "deterministic");
  assertEquals(r.recipe, "merged");
  assertEquals(r.reason, "merged check failed: origin is not a GitHub remote");
});

Deno.test("buildReply ignores a merged check that did not match", () => {
  const r = buildReply({
    ...detArgs,
    mergedMatched: false,
    mergedOk: true,
    mergedText: MERGED_TEXT,
  });
  assertEquals(r.recipe, "");
  assertEquals(r.reason, "no extension found, no request logged");
});

Deno.test("merged writes matched false and calls nothing for other turns", async () => {
  const written: Written[] = [];
  const calls: unknown[] = [];
  await model.methods.merged.execute({ text: "merged, next" }, {
    ...fakeContext(written),
    runModel: (call: unknown) => {
      calls.push(call);
      return Promise.resolve({ ok: false as const, error: { message: "no" } });
    },
  });
  assertEquals(calls, []);
  assertEquals(written.map((w) => [w.spec, w.name]), [["merged", "merged"]]);
  assertEquals(written[0].data.matched, false);
  assertEquals(written[0].data.ok, false);
  assertEquals(written[0].data.text, "");
});

Deno.test("merged runs the check through runModel and stores it", async () => {
  const written: Written[] = [];
  const methods: string[] = [];
  await model.methods.merged.execute({ text: "12 is merged" }, {
    ...fakeContext(written),
    runModel: (call: { method: string }) => {
      methods.push(call.method);
      return Promise.resolve({
        ok: false as const,
        error: { message: "fatal: not a git repository" },
      });
    },
  });
  assertEquals(methods, ["config"]);
  const data = written[0].data;
  assertEquals(data.matched, true);
  assertEquals(data.numbers, [12]);
  assertEquals(data.ok, false);
  assertMatch(data.error as string, /not a git repository/);
});

Deno.test("merged without runModel stores a failed check", async () => {
  const written: Written[] = [];
  await model.methods.merged.execute(
    { text: "merged" },
    fakeContext(written),
  );
  assertEquals(written[0].data.matched, true);
  assertEquals(written[0].data.ok, false);
  assertMatch(written[0].data.error as string, /runModel/);
});

// ---- capture: prefix ----

Deno.test("loadTurn strips a capture: prefix, in any case, and marks the turn", async () => {
  const turn = await loadTurn("  Capture:  add a weather recipe\n", 2000);
  assertEquals(turn.capture, true);
  assertEquals(turn.text, "add a weather recipe");
  assertEquals(turn.sourceRef, await sourceRef("add a weather recipe"));
  assertEquals(turn.complete, true);
  assertEquals((await loadTurn("capture:", 2000)).empty, true);
  for (const text of ["add a weather recipe", "captured: x", "a capture: x"]) {
    assertEquals((await loadTurn(text, 2000)).capture, false, text);
  }
});

Deno.test("loadTurn withholds a secret capture: turn but still marks it", async () => {
  const turn = await loadTurn(
    "capture: password=hunter2 is that strong?",
    2000,
  );
  assertEquals(turn.capture, true);
  assertEquals(turn.withheld, true);
});

Deno.test("captureSearch drafts the request from the turn without searching", () => {
  const m = captureSearch(
    "add a weather recipe\nfor Utrecht " + "x".repeat(200),
    "puddlerouter:0123456789abcdef",
    new Date("2026-10-27T10:00:00Z"),
  );
  assertEquals(m.kind, "none");
  assertEquals(m.candidates, []);
  assertEquals(m.query, "");
  assert(m.requestTitle.startsWith("add a weather recipe for Utrecht"));
  assert(m.requestTitle.length <= 80, `${m.requestTitle.length}`);
  assert(!m.requestTitle.includes("\n"));
  assert(m.requestDescription.startsWith("add a weather recipe\nfor Utrecht"));
  assertMatch(m.requestDescription, /capture: prefix/);
  assertMatch(m.requestDescription, /puddlerouter:0123456789abcdef/);
  assertEquals(m.requestKey, "puddlerouter:0123456789abcdef");
  assertEquals(m.searchedAt, "2026-10-27T10:00:00.000Z");
});

Deno.test("search for a capture: turn searches nothing and writes the draft", async () => {
  const w: Written[] = [];
  await model.methods.search.execute(
    {
      text: "git status",
      sourceRef: "puddlerouter:0123456789abcdef",
      repoDir: "/nonexistent",
      capture: true,
    },
    fakeContext(w),
  );
  assertEquals(w.length, 1);
  assertEquals(w[0].data.kind, "none");
  assertEquals(w[0].data.requestTitle, "git status");
});

const CAPTURED = {
  mode: "live" as const,
  sourceRef: "puddlerouter:0123456789abcdef",
  cutoff: 0.7,
  capture: true,
  // What the cache or a stray step might hold; a capture: turn ignores it.
  choice: "decision",
  confidence: 0.95,
  yes: 0.99,
  complete: true,
};

Deno.test("buildReply blocks a capture: turn with the request link", () => {
  const r = buildReply({
    ...CAPTURED,
    matchKind: "none",
    requestUrl: "http://127.0.0.1:3002/requests/req_9",
  });
  assertEquals(r.action, "block");
  assertEquals(r.route, "capture");
  assertEquals(r.answer, null);
  assertEquals(r.request, "http://127.0.0.1:3002/requests/req_9");
  assertMatch(
    r.text,
    /Logged a request in Capture: http:\/\/127\.0\.0\.1:3002\/requests\/req_9/,
  );
  assertMatch(r.text, /starting with llm:/);
  assertEquals(r.reason, "capture: prefix, request logged");
});

Deno.test("buildReply tells Claude not to act on a capture: turn it could not log", () => {
  const r = buildReply({ ...CAPTURED, requestUrl: "" });
  assertEquals(r.action, "hint");
  assertEquals(r.route, "capture");
  assertMatch(r.text, /not logged/);
  assertMatch(r.text, /do not act on it/);
  assertEquals(r.reason, "capture: prefix, no request logged");
});

Deno.test("buildReply in shadow mode records that live would log the capture: turn", () => {
  const r = buildReply({ ...CAPTURED, mode: "shadow" });
  assertEquals(r.action, "pass");
  assertEquals(r.wouldAction, "block");
  assertEquals(r.reason, "shadow: capture: prefix, would log a request");
});

// ---- recipes live in @puddleworks/recipes ----

Deno.test("the router has no recipe code of its own", async () => {
  for (const method of ["match", "execute", "sync"]) {
    assert(!(method in model.methods), `${method} should be gone`);
  }
  for (const spec of ["match", "result", "resultCache", "recipeIndex"]) {
    assert(!(spec in model.resources), `${spec} should be gone`);
  }
  assert("search" in model.methods);
  assert("search" in model.resources);
  for (const gone of ["recipes.ts", "packs.ts"]) {
    await assertRejects(() =>
      Deno.stat(new URL(`./_lib/${gone}`, import.meta.url))
    );
  }
});

Deno.test("search writes one resource and finds no recipes", async () => {
  const written: Written[] = [];
  await model.methods.search.execute(
    { text: "is it?", sourceRef: "puddlerouter:0123", repoDir: "/nonexistent" },
    fakeContext(written),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "search");
  assertEquals(written[0].data.kind, "none");
  assertEquals("recipeId" in written[0].data, false);
});

Deno.test("search reads the allow list from puddlerouter.yaml in the repo dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/puddlerouter.yaml`,
      "allow: ['@acme/*']\nreads: ['@webframp/github list_prs']\n",
    );
    const written: Written[] = [];
    await model.methods.search.execute(
      { text: "is it?", repoDir: dir },
      fakeContext(written),
    );
    assertEquals(written[0].data.kind, "none");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const ASKED =
  "gh-merge runs @webframp/github merge_pull_request on github with n=4, which " +
  "makes changes. Reply yes to run it; anything else drops it. The plan lapses " +
  "after 10 minutes.";

Deno.test("buildReply blocks with the plan when a write recipe asks first", () => {
  const r = buildReply({
    ...detArgs,
    matchKind: "recipe",
    recipeId: "gh-merge",
    resultAction: "ask",
    resultOk: true,
    resultText: ASKED,
  });
  assertEquals(r.action, "block");
  assert(r.text.startsWith(ASKED));
  assertMatch(r.text, /recipe gh-merge/);
  assertMatch(r.text, /without Claude/);
  assertMatch(r.text, /starting with llm:/);
  assert(!r.text.includes("Answered by"), "nothing was answered yet");
  assertEquals(r.recipe, "gh-merge");
  assertEquals(r.reason, "recipe gh-merge asked before running");
});

Deno.test("buildReply in shadow mode passes and records that live mode would ask", () => {
  const text = "Shadow mode: would ask before running it. gh-merge runs it.";
  const r = buildReply({
    ...detArgs,
    mode: "shadow",
    matchKind: "recipe",
    recipeId: "gh-merge",
    resultAction: "would-ask",
    resultOk: true,
    resultText: text,
  });
  assertEquals(r.action, "pass");
  assertEquals(r.text, "");
  assertEquals(r.wouldAction, "block");
  assert(r.wouldText.startsWith(text));
  assertEquals(r.reason, "shadow: recipe gh-merge would ask before running");
});

Deno.test("buildReply passes when execute did nothing", () => {
  const r = buildReply({
    ...detArgs,
    matchKind: "recipe",
    recipeId: "gh-merge",
    resultAction: "none",
    resultOk: false,
    resultText: "",
  });
  assertEquals(r.action, "pass");
  assertEquals(r.reason, "recipe gh-merge failed");
});

// `confirm` handled the turn: nothing else in the workflow ran for it.
const CONFIRMED = {
  mode: "live" as const,
  sourceRef: "puddlerouter:0123456789abcdef",
  cutoff: 0.7,
  complete: true,
  confirmRecipeId: "gh-merge",
};

Deno.test("buildReply blocks with the recipe's answer after a yes", () => {
  const r = buildReply({
    ...CONFIRMED,
    confirmAction: "ran",
    confirmOk: true,
    confirmText: "Merged #4.",
  });
  assertEquals(r.action, "block");
  assertMatch(r.text, /^Merged #4\./);
  assertMatch(r.text, /recipe gh-merge/);
  assertEquals(r.route, "deterministic");
  assertEquals(r.recipe, "gh-merge");
  assertEquals(r.reason, "recipe gh-merge answered after a yes");
});

Deno.test("buildReply tells Claude to report a recipe that failed after a yes", () => {
  const r = buildReply({
    ...CONFIRMED,
    confirmAction: "ran",
    confirmOk: false,
    confirmText: "",
    confirmError: "merge conflict",
  });
  assertEquals(r.action, "hint");
  assertMatch(r.text, /gh-merge/);
  assertMatch(r.text, /merge conflict/);
  assertMatch(r.text, /Tell the user/);
  assertEquals(r.route, "deterministic");
  assertEquals(r.reason, "recipe gh-merge failed after a yes");
});

Deno.test("buildReply tells Claude when a yes did nothing, and why", () => {
  const r = buildReply({
    ...CONFIRMED,
    confirmAction: "refused",
    confirmOk: false,
    confirmText: "",
    confirmError: "the plan expired",
  });
  assertEquals(r.action, "hint");
  assertMatch(r.text, /gh-merge/);
  assertMatch(r.text, /the plan expired/);
  assertMatch(r.text, /Tell the user/);
  assertMatch(r.text, /do not/i);
  assertEquals(r.route, "deterministic");
  assertEquals(r.reason, "a yes ran nothing: the plan expired");
});

Deno.test("buildReply routes as usual when confirm had nothing to do", () => {
  const r = buildReply({
    ...detArgs,
    choice: "llm",
    confirmAction: "none",
    confirmOk: false,
    confirmText: "",
    confirmError: "no plan to confirm",
  });
  assertEquals(r.action, "pass");
  assertEquals(r.route, "llm");
  assertEquals(r.reason, "llm route");
});

Deno.test("buildReply trusts confirm over a route recalled for the same words", () => {
  const r = buildReply({
    ...CONFIRMED,
    choice: "llm",
    confidence: 0.9,
    confirmAction: "ran",
    confirmOk: true,
    confirmText: "Merged #4.",
  });
  assertEquals(r.action, "block");
  assertEquals(r.route, "deterministic");
});

const NOT_ROUTED = "not routed (an always-LLM phrase)";

Deno.test("alwaysLlmHit tries the typed text with whitespace collapsed", () => {
  const patterns = parseConfig(
    "alwaysLlm: ['^load the handover doc\\b']\n",
  ).alwaysLlm;
  assertEquals(
    alwaysLlmHit("LOAD   the\nhandover  doc at /tmp/x.md", patterns),
    "^load the handover doc\\b",
  );
  assertEquals(alwaysLlmHit("where is the handover doc", patterns), "");
  assertEquals(alwaysLlmHit("anything", []), "");
});

Deno.test("alwaysLlmHit does not count pasted or fenced blocks", () => {
  const patterns = parseConfig(
    "alwaysLlm: ['^load the handover doc$', 'secret phrase']\n",
  ).alwaysLlm;
  assertEquals(
    alwaysLlmHit("[pasted text]\nload the handover doc\n[code block]", patterns),
    "^load the handover doc$",
  );
  assertEquals(alwaysLlmHit("[pasted text] what is this?", patterns), "");
});

Deno.test("an always-LLM turn passes in live mode with the reason, and no confidence", () => {
  const r = buildReply({
    mode: "live",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    confidence: 0,
    alwaysLlm: true,
  });
  assertEquals(r.action, "pass");
  assertEquals(r.route, "llm");
  assertEquals(r.reason, NOT_ROUTED);
  assertEquals(r.confidence, null);
});

Deno.test("an always-LLM turn passes in shadow mode and records why", () => {
  const r = buildReply({
    mode: "shadow",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    alwaysLlm: true,
  });
  assertEquals(r.wouldAction, "pass");
  assertEquals(r.reason, `shadow: ${NOT_ROUTED}`);
});

Deno.test("an always-LLM turn ignores a recipe and a route", () => {
  const r = buildReply({
    ...detArgs,
    alwaysLlm: true,
    matchKind: "recipe",
    recipeId: "git-status",
    resultOk: true,
    resultText: "x",
  });
  assertEquals(r.action, "pass");
  assertEquals(r.route, "llm");
  assertEquals(r.recipe, "");
  assertEquals(r.reason, NOT_ROUTED);
});

Deno.test("a capture: turn beats an always-LLM phrase", () => {
  const r = buildReply({
    mode: "live",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    capture: true,
    alwaysLlm: true,
    requestUrl: "http://127.0.0.1:3002/requests/x",
  });
  assertEquals(r.action, "block");
  assertEquals(r.route, "capture");
});

Deno.test("a matched recipe reports the deterministic route with no route answer", () => {
  for (const mode of ["live", "shadow"] as const) {
    const r = buildReply({
      mode,
      sourceRef: "puddlerouter:0123456789abcdef",
      cutoff: 0.7,
      confidence: 0,
      matchKind: "recipe",
      recipeId: "git-status",
      resultAction: "ran",
      resultOk: true,
      resultText: "On branch main",
    });
    assertEquals(r.wouldAction, "block");
    assertEquals(r.route, "deterministic");
    assertEquals(r.recipe, "git-status");
    assertEquals(r.choice, "");
    assertEquals(r.confidence, null);
    assertMatch(r.reason, /recipe git-status answered$/);
  }
});

Deno.test("a matched write recipe with no route answer still asks first", () => {
  const r = buildReply({
    mode: "live",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    matchKind: "recipe",
    recipeId: "write-it",
    resultAction: "ask",
    resultOk: true,
    resultText: "This would change x. Say yes.",
  });
  assertEquals(r.action, "block");
  assertEquals(r.route, "deterministic");
  assertEquals(r.reason, "recipe write-it asked before running");
});

Deno.test("a matched recipe that failed passes, naming the recipe", () => {
  const r = buildReply({
    mode: "live",
    sourceRef: "puddlerouter:0123456789abcdef",
    cutoff: 0.7,
    matchKind: "recipe",
    recipeId: "git-status",
    resultOk: false,
  });
  assertEquals(r.action, "pass");
  assertEquals(r.reason, "recipe git-status failed");
});

function methodContext(resources: Record<string, unknown> = {}) {
  const written: Record<string, Record<string, unknown>> = {};
  return {
    written,
    context: {
      globalArgs: {},
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written[name] = data;
        return Promise.resolve({ name });
      },
      readResource: (name: string) =>
        Promise.resolve(
          (resources[name] ?? null) as Record<string, unknown> | null,
        ),
      logger: { info: () => {} },
    },
  };
}

Deno.test("alwaysLlm reads puddlerouter.yaml and stores the hit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/puddlerouter.yaml`,
      "alwaysLlm: ['^load the handover doc\\b']\n",
    );
    const { written, context } = methodContext();
    await model.methods.alwaysLlm.execute(
      { text: "load the handover doc at /x", repoDir: dir },
      context,
    );
    assertEquals(written.alwaysLlm.matched, true);
    assertEquals(written.alwaysLlm.pattern, "^load the handover doc\\b");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("alwaysLlm with no file stores no hit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { written, context } = methodContext();
    await model.methods.alwaysLlm.execute(
      { text: "load the handover doc", repoDir: dir },
      context,
    );
    assertEquals(written.alwaysLlm.matched, false);
    assertEquals(written.alwaysLlm.pattern, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const REPLY_REF = "puddlerouter:0123456789abcdef";
const CACHED = {
  hasRoute: true,
  choice: "llm",
  confidence: 0.9,
  hasDecision: false,
  yes: 0,
  hasPick: false,
  pickChoice: "",
  pickConfidence: 0,
  candidates: [],
  cachedAt: "2026-11-05T00:00:00.000Z",
};

Deno.test("reply for an always-LLM turn ignores a cached deterministic route", async () => {
  const { written, context } = methodContext();
  await model.methods.reply.execute(
    {
      mode: "live",
      sourceRef: REPLY_REF,
      cutoff: 0.7,
      answerCutoff: 0.8,
      complete: true,
      alwaysLlm: true,
      recalled: { ...CACHED, choice: "deterministic" },
    },
    context,
  );
  assertEquals(written.reply.route, "llm");
  assertEquals(written.reply.choice, "");
  assertEquals(written.reply.cached, false);
  assertEquals(written.reply.reason, NOT_ROUTED);
  assertEquals(written[routeCacheKey(REPLY_REF)], undefined);
});

Deno.test("reply for a matched recipe ignores a cached llm route", async () => {
  const { written, context } = methodContext();
  await model.methods.reply.execute(
    {
      mode: "live",
      sourceRef: REPLY_REF,
      cutoff: 0.7,
      answerCutoff: 0.8,
      complete: true,
      matchKind: "recipe",
      recipeId: "git-status",
      resultAction: "ran",
      resultOk: true,
      resultText: "On branch main",
      recalled: CACHED,
    },
    context,
  );
  assertEquals(written.reply.action, "block");
  assertEquals(written.reply.route, "deterministic");
  assertEquals(written.reply.choice, "");
  assertEquals(written.reply.cached, false);
  assertEquals(written[routeCacheKey(REPLY_REF)], undefined);
});

Deno.test("reply with no match still uses a cached route", async () => {
  const { written, context } = methodContext();
  await model.methods.reply.execute(
    {
      mode: "live",
      sourceRef: REPLY_REF,
      cutoff: 0.7,
      answerCutoff: 0.8,
      complete: true,
      matchKind: "none",
      recalled: CACHED,
    },
    context,
  );
  assertEquals(written.reply.choice, "llm");
  assertEquals(written.reply.cached, true);
  assertEquals(written.reply.reason, "llm route");
});
