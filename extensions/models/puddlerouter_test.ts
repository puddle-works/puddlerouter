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
  effectiveRoute,
  loadTurn,
  model,
  normalise,
  sourceRef,
} from "./puddlerouter.ts";

const OPEN = '<pasted_content id="abc">';
const CLOSE = '</pasted_content id="abc">';

Deno.test("model type is @mesgme/puddlerouter", () => {
  assertEquals(model.type, "@mesgme/puddlerouter");
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

function fakeContext(written: Written[]) {
  return {
    globalArgs: {},
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    logger: { info: () => {} },
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
    },
    fakeContext(written),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "reply");
  assertEquals(written[0].name, "reply");
  assertEquals(written[0].data.action, "pass");
});
