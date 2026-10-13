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
import {
  buildReply,
  cleanTurn,
  decisionAnswer,
  effectiveRoute,
  loadTurn,
  model,
  normalise,
  sourceRef,
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

Deno.test("load fails when the turn file is missing", async () => {
  await assertRejects(() =>
    model.methods.load.execute(
      { turnFile: "/nonexistent/puddlerouter-turn", maxChars: 2000 },
      fakeContext([]),
    )
  );
});

Deno.test("reply writes one reply resource", async () => {
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
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "reply");
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
    "log Reply {action} for {sourceRef} ({reason})",
  ]);
});
