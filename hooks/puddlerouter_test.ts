/**
 * Tests for the UserPromptSubmit hook, run against a fake `swamp`.
 *
 * Each test feeds the hook the JSON Claude Code sends on stdin. The fake
 * swamp records its arguments and the turn file's text, then answers as told
 * by FAKE_SWAMP_REPLY (a reply action), FAKE_SWAMP_FAIL or FAKE_SWAMP_HANG.
 *
 * Run with: make test
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const HOOK = new URL("./puddlerouter.sh", import.meta.url).pathname;

const FAKE_SWAMP = `#!/usr/bin/env bash
log="$FAKE_SWAMP_LOG"
printf '%s\\n' "$*" >> "$log.args"
for arg in "$@"; do
  case "$arg" in turnFile=*) cat "\${arg#turnFile=}" > "$log.turn" ;; esac
done
[ -n "\${FAKE_SWAMP_HANG:-}" ] && sleep 30
[ -n "\${FAKE_SWAMP_FAIL:-}" ] && { echo boom >&2; exit 1; }
case "$1 $2" in
  "workflow run") echo '{"id":"run-1","status":"succeeded"}' ;;
  "workflow history")
    jq -n --arg a "$FAKE_SWAMP_REPLY" --arg t "$FAKE_SWAMP_TEXT" \\
      '{reply: {action: $a, text: $t}}' ;;
esac
`;

interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
  /** One line per swamp call. */
  calls: string[];
  /** The turn file's text as swamp saw it, if it was called. */
  turn?: string;
  /** Milliseconds the hook took to exit. */
  ms: number;
}

async function waitFor(path: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
}

async function runHook(
  prompt: string | null,
  env: Record<string, string> = {},
  opts: { waitForSwamp?: boolean; stdin?: string } = {},
): Promise<HookRun> {
  const dir = await Deno.makeTempDir({ prefix: "puddlerouter-hook-test" });
  try {
    const fake = `${dir}/swamp`;
    await Deno.writeTextFile(fake, FAKE_SWAMP);
    await Deno.chmod(fake, 0o755);
    const log = `${dir}/log`;
    const stdin = opts.stdin ?? JSON.stringify({
      session_id: "abc123",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "UserPromptSubmit",
      prompt,
    });
    const started = Date.now();
    const child = new Deno.Command("bash", {
      args: [HOOK],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: {
        PUDDLEROUTER_SWAMP: fake,
        PUDDLEROUTER_REPO: dir,
        FAKE_SWAMP_LOG: log,
        FAKE_SWAMP_REPLY: "pass",
        FAKE_SWAMP_TEXT: "",
        TMPDIR: dir,
        ...env,
      },
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
    const out = await child.output();
    const ms = Date.now() - started;
    if (opts.waitForSwamp) await waitFor(`${log}.turn`, 3000);
    // Let a detached run finish removing its turn file.
    await new Promise((r) => setTimeout(r, 200));
    const read = async (p: string) => {
      try {
        return await Deno.readTextFile(p);
      } catch {
        return undefined;
      }
    };
    const args = await read(`${log}.args`);
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      calls: args ? args.trim().split("\n") : [],
      turn: await read(`${log}.turn`),
      ms,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function assertSilentPass(run: HookRun) {
  assertEquals(run.code, 0);
  assertEquals(run.stdout, "");
}

for (
  const [what, prompt, env] of [
    ["a slash command", "/review", {}],
    ["an llm: prefix", "LLM: list the open PRs", {}],
    ["a tagged message from the harness", "<task-notification>done", {}],
    ["a bash-mode prompt", "! ls", {}],
    ["an empty prompt", "   \n ", {}],
    ["a prompt over 2,000 characters", "a".repeat(2001), {}],
    ["anything when PUDDLEROUTER=off", "list the open PRs", {
      PUDDLEROUTER: "off",
    }],
  ] as Array<[string, string, Record<string, string>]>
) {
  Deno.test(`skips ${what} without calling swamp`, async () => {
    const run = await runHook(prompt, env);
    assertSilentPass(run);
    assertEquals(run.calls, []);
  });
}

Deno.test("does not count surrounding whitespace towards the limit", async () => {
  const run = await runHook(`  ${"a".repeat(2000)}  \n`, {}, {
    waitForSwamp: true,
  });
  assertSilentPass(run);
  assertEquals(run.calls.length, 1);
});

Deno.test("shadow mode runs the workflow with only the turn file's path", async () => {
  const prompt = "  is 'fix stuff' a good commit message? ${{ env.HOME }}\n";
  const run = await runHook(prompt, {}, { waitForSwamp: true });
  assertSilentPass(run);
  assertEquals(run.calls.length, 1);
  const call = run.calls[0];
  assertMatch(
    call,
    /^workflow run @puddleworks\/puddlerouter --repo-dir \S+ --input turnFile=\/\S+ --input mode=shadow --input hookStartedAt=\d{13} --input repoDir=\S+$/,
  );
  assert(
    !call.includes("fix stuff"),
    "the prompt text must not be an argument",
  );
  assertEquals(
    run.turn,
    "is 'fix stuff' a good commit message? ${{ env.HOME }}",
  );
});

Deno.test("shadow mode does not wait for swamp", async () => {
  const run = await runHook("list the open PRs", { FAKE_SWAMP_HANG: "1" });
  assertSilentPass(run);
  assert(run.ms < 2000, `took ${run.ms} ms`);
});

Deno.test("shadow mode ignores a block reply", async () => {
  const run = await runHook("is this ok?", {
    FAKE_SWAMP_REPLY: "block",
    FAKE_SWAMP_TEXT: "No.",
  }, { waitForSwamp: true });
  assertSilentPass(run);
});

Deno.test("an @ mention reaches swamp as file text, not as an @ argument", async () => {
  const run = await runHook("@/etc/hosts explain this", {}, {
    waitForSwamp: true,
  });
  assertSilentPass(run);
  assert(!run.calls[0].includes("=@"), run.calls[0]);
  assertEquals(run.turn, "@/etc/hosts explain this");
});

Deno.test("the turn file is removed after the run", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await runHook("list the open PRs", { TMPDIR: dir }, { waitForSwamp: true });
    const left = [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(left, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("live mode turns a block reply into a block decision", async () => {
  const run = await runHook("is this ok?", {
    PUDDLEROUTER_MODE: "live",
    FAKE_SWAMP_REPLY: "block",
    FAKE_SWAMP_TEXT: 'No: "fix stuff" says nothing.',
  });
  assertEquals(run.code, 0);
  assertEquals(JSON.parse(run.stdout), {
    decision: "block",
    reason: 'No: "fix stuff" says nothing.',
  });
  assertEquals(run.calls.length, 2);
  assertMatch(
    run.calls[0],
    / --input mode=live --input hookStartedAt=\d{13} --input repoDir=\S+ --json$/,
  );
  assertEquals(
    run.calls[1],
    `workflow history outputs run-1 --repo-dir ${
      run.calls[0].split(" ")[4]
    } --json`,
  );
});

Deno.test("live mode turns a hint reply into additionalContext", async () => {
  const run = await runHook("list the open PRs", {
    PUDDLEROUTER_MODE: "live",
    FAKE_SWAMP_REPLY: "hint",
    FAKE_SWAMP_TEXT: "Use @webframp/github list_prs.",
  });
  assertEquals(run.code, 0);
  assertEquals(JSON.parse(run.stdout), {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "Use @webframp/github list_prs.",
    },
  });
});

Deno.test("live mode prints nothing for a pass reply", async () => {
  const run = await runHook("refactor the reply method", {
    PUDDLEROUTER_MODE: "live",
    FAKE_SWAMP_REPLY: "pass",
  });
  assertSilentPass(run);
});

Deno.test("live mode fails open when swamp fails", async () => {
  const run = await runHook("is this ok?", {
    PUDDLEROUTER_MODE: "live",
    FAKE_SWAMP_FAIL: "1",
  });
  assertSilentPass(run);
  assertEquals(run.stderr, "");
});

Deno.test("live mode fails open when swamp hangs past the timeout", async () => {
  const run = await runHook("is this ok?", {
    PUDDLEROUTER_MODE: "live",
    PUDDLEROUTER_TIMEOUT: "1",
    FAKE_SWAMP_HANG: "1",
  });
  assertSilentPass(run);
  assert(run.ms < 4000, `took ${run.ms} ms`);
});

Deno.test("fails open on input that is not JSON", async () => {
  const run = await runHook(null, {}, { stdin: "not json" });
  assertSilentPass(run);
  assertEquals(run.calls, []);
  assertEquals(run.stderr, "");
});

Deno.test("fails open when swamp is not installed", async () => {
  const run = await runHook("list the open PRs", {
    PUDDLEROUTER_SWAMP: "/nonexistent/swamp",
  });
  assertSilentPass(run);
  assertEquals(run.stderr, "");
});

Deno.test("the hook tells the workflow which repo recipes pull extensions into", async () => {
  const run = await runHook("git status", {}, { waitForSwamp: true });
  assertEquals(run.code, 0);
  assertMatch(run.calls[0], /--input repoDir=\S+/);
  assertMatch(run.calls[0], /--repo-dir (\S+) .*--input repoDir=\1(\s|$)/);
});
