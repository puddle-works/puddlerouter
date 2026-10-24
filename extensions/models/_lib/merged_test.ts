/**
 * Tests for the "merged" check.
 *
 * Run with: make test
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  checkMerged,
  matchMerged,
  type ModelCall,
  type RunResult,
} from "./merged.ts";

Deno.test("matchMerged reads a bare merged and the numbered shapes", () => {
  const cases: [string, number[]][] = [
    ["merged", []],
    ["Merged.", []],
    ["merged!", []],
    ["merged both", []],
    ["merged all three, clean up the worktrees", []],
    ["merged both, clean up the worktree", []],
    ["12 is merged", [12]],
    ["12 is merged.", [12]],
    ["#12 merged", [12]],
    ["PR 12 merged", [12]],
    ["107 merged", [107]],
    ["merged 13", [13]],
    ["merged #13", [13]],
    ["18 and 19 merged", [18, 19]],
    ["18, 19 and 20 are merged", [18, 19, 20]],
  ];
  for (const [text, numbers] of cases) {
    assertEquals(matchMerged(text), { numbers }, text);
  }
});

Deno.test("matchMerged leaves turns that ask for more to the LLM", () => {
  for (
    const text of [
      "merged, next",
      "merged next issue",
      "merged, then update the changelog",
      "merged - can you start on the release notes?",
      "I think I merged it",
      "12 is merged.  What is left on the board?",
      "is 12 merged?",
      "not merged",
      "1 2 3 4 5 6 merged",
    ]
  ) assertEquals(matchMerged(text), null, text);
});

const MAIN = "/home/me/dev/repo";
const WT = "/home/me/orca/repo-feature";
const HEAD = "2".repeat(40);

function worktrees(extra: Record<string, unknown>[] = []) {
  return [
    {
      path: MAIN,
      head: "1".repeat(40),
      branch: "main",
      primary: true,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    {
      path: WT,
      head: HEAD,
      branch: "me/feature",
      primary: false,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    ...extra,
  ];
}

interface Fake {
  url?: string;
  worktrees?: Record<string, unknown>[];
  prs?: Record<number, Record<string, unknown> | Error>;
  merged?: { number: number; updatedAt: string }[];
  dirty?: string[];
  ancestors?: [string, string][];
}

/** A runModel over canned answers; `calls` records each call. */
function fakeRun(fake: Fake) {
  const calls: ModelCall[] = [];
  const res = (specName: string, attributes: Record<string, unknown>) =>
    Promise.resolve<RunResult>({
      ok: true,
      resources: [{ name: specName, specName, attributes }],
    });
  const fail = (message: string) =>
    Promise.resolve<RunResult>({ ok: false, error: { message } });
  const run = (call: ModelCall): Promise<RunResult> => {
    calls.push(call);
    const a = call.arguments ?? {};
    switch (`${call.modelType} ${call.method}`) {
      case "@swamp/git config":
        return res("configResult", {
          key: "remote.origin.url",
          value: fake.url ?? "git@github.com:me/repo.git",
        });
      case "@swamp/git worktree_list":
        return res("worktreeList", {
          repoPath: ".",
          worktrees: fake.worktrees ?? worktrees(),
        });
      case "@swamp/git status": {
        const dirty = (fake.dirty ?? []).includes(a.repoPath as string);
        return res("statusResult", {
          clean: !dirty,
          entries: dirty ? [{ status: " M", path: "x" }] : [],
        });
      }
      case "@swamp/git is_ancestor": {
        const pairs = fake.ancestors ?? [];
        return res("isAncestorResult", {
          isAncestor: pairs.some(([x, y]) =>
            x === a.ancestor && y === a.descendant
          ),
        });
      }
      case "@webframp/github list_prs":
        return res("pull_requests", {
          pullRequests: (fake.merged ?? []).map((p) => ({
            ...p,
            title: `PR ${p.number}`,
            state: "MERGED",
          })),
        });
      case "@webframp/github get_pull_request_context": {
        const pr = fake.prs?.[a.number as number];
        if (pr instanceof Error) return fail(pr.message);
        if (!pr) return fail(`no pull request ${a.number}`);
        return res("triagePullRequest", {
          context: {
            number: a.number,
            title: `PR ${a.number}`,
            url: `https://github.com/me/repo/pull/${a.number}`,
            ...pr,
          },
        });
      }
    }
    return fail(`unexpected ${call.modelType} ${call.method}`);
  };
  return { run, calls };
}

Deno.test("a numbered merged PR at a clean worktree's head is safe to clean up", async () => {
  const { run, calls } = fakeRun({
    prs: { 12: { state: "MERGED", headRefOid: HEAD } },
  });
  const check = await checkMerged([12], run);
  assertEquals(check.ok, true);
  assertEquals(check.repo, "me/repo");
  assertEquals(check.mainCheckout, MAIN);
  assertEquals(check.prs.length, 1);
  assertEquals(check.prs[0].number, 12);
  assertEquals(check.prs[0].verdict, "clean");
  assertEquals(check.prs[0].worktree, WT);
  assertEquals(check.prs[0].branch, "me/feature");
  assertEquals(check.summary, "#12 clean");
  assertMatch(check.text, /#12 .*is merged/);
  assertMatch(check.text, /Remove the worktree \/home\/me\/orca\/repo-feature/);
  assertMatch(
    check.text,
    /Delete the branch me\/feature, locally and on origin/,
  );
  assertMatch(check.text, /Pull main in \/home\/me\/dev\/repo/);
  assertMatch(check.text, /nothing was changed/);
  assertEquals(
    calls.find((c) => c.method === "get_pull_request_context")?.arguments,
    { repo: "me/repo", number: 12, maxComments: 1 },
  );
  assertEquals(
    calls.find((c) => c.method === "status")?.arguments,
    { repoPath: WT },
  );
});

Deno.test("a PR that is not merged gives no steps", async () => {
  const { run } = fakeRun({ prs: { 12: { state: "OPEN", headRefOid: HEAD } } });
  const check = await checkMerged([12], run);
  assertEquals(check.ok, true);
  assertEquals(check.prs[0].verdict, "open");
  assertMatch(check.text, /#12 .*is open, not merged/);
  assert(!/Remove the worktree/.test(check.text));
  assertMatch(check.text, /Nothing is ready to clean up/);
  // A PR nobody merged could be anyone's, so its title is not shown.
  assert(!/PR 12/.test(check.text));
});

Deno.test("a locked worktree is not offered for removal", async () => {
  const { run } = fakeRun({
    worktrees: worktrees().map((w) =>
      w.path === WT ? { ...w, locked: true } : w
    ),
    prs: { 12: { state: "MERGED", headRefOid: HEAD } },
  });
  const check = await checkMerged([12], run);
  assertEquals(check.prs[0].verdict, "locked");
  assertMatch(check.text, /is locked/);
  assert(!/Remove the worktree/.test(check.text));
});

Deno.test("a worktree with commits after the PR's head is not safe", async () => {
  const ahead = "3".repeat(40);
  const { run } = fakeRun({
    worktrees: worktrees().map((w) =>
      w.path === WT ? { ...w, head: ahead } : w
    ),
    prs: { 12: { state: "MERGED", headRefOid: HEAD } },
    ancestors: [[HEAD, ahead]],
  });
  const check = await checkMerged([12], run);
  assertEquals(check.prs[0].verdict, "ahead");
  assertEquals(check.prs[0].worktree, WT);
  assertMatch(check.text, /commits after #12's head/);
  assertMatch(check.text, /would be orphaned/);
  assert(!/Remove the worktree/.test(check.text));
});

Deno.test("a PR whose head is on main only counts a worktree at its head", async () => {
  // Merged with a merge commit, so every later branch of main descends from
  // the PR's head: descent says nothing about commits being orphaned.
  const later = "3".repeat(40);
  const { run, calls } = fakeRun({
    worktrees: worktrees().map((w) =>
      w.path === WT ? { ...w, head: later } : w
    ),
    prs: { 12: { state: "MERGED", headRefOid: HEAD } },
    ancestors: [[HEAD, later], [HEAD, "origin/main"]],
  });
  const check = await checkMerged([12], run);
  assertEquals(check.prs[0].verdict, "absent");
  assertMatch(check.text, /No worktree is at #12's head/);
  assertEquals(
    calls.filter((c) => c.method === "is_ancestor").map((c) =>
      c.arguments?.descendant
    ),
    ["origin/main"],
  );
});

Deno.test("a worktree with uncommitted changes is not safe", async () => {
  const { run } = fakeRun({
    prs: { 12: { state: "MERGED", headRefOid: HEAD } },
    dirty: [WT],
  });
  const check = await checkMerged([12], run);
  assertEquals(check.prs[0].verdict, "dirty");
  assertMatch(check.text, /uncommitted changes/);
  assert(!/Remove the worktree/.test(check.text));
});

Deno.test("the main checkout on the PR's branch is switched back, not removed", async () => {
  const { run } = fakeRun({
    worktrees: [{
      path: MAIN,
      head: HEAD,
      branch: "me/feature",
      primary: true,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    }],
    prs: { 12: { state: "MERGED", headRefOid: HEAD } },
  });
  const check = await checkMerged([12], run);
  assertEquals(check.prs[0].verdict, "primary");
  assertMatch(check.text, /Switch \/home\/me\/dev\/repo to main and pull/);
  assertMatch(
    check.text,
    /Delete the branch me\/feature, locally and on origin/,
  );
  assert(!/Remove the worktree/.test(check.text));
});

Deno.test("a worktree on main never counts as the PR's worktree", async () => {
  const { run } = fakeRun({
    worktrees: worktrees().map((w) =>
      w.primary ? { ...w, head: HEAD } : { ...w, head: "4".repeat(40) }
    ),
    prs: { 12: { state: "MERGED", headRefOid: HEAD } },
  });
  const check = await checkMerged([12], run);
  assertEquals(check.prs[0].verdict, "absent");
  assertMatch(check.text, /No worktree is at or after #12's head/);
});

Deno.test("bare merged checks the latest merged PRs and keeps those with a worktree", async () => {
  const { run, calls } = fakeRun({
    merged: [
      { number: 10, updatedAt: "2026-10-20T10:00:00Z" },
      { number: 12, updatedAt: "2026-10-24T10:00:00Z" },
      { number: 11, updatedAt: "2026-10-22T10:00:00Z" },
      { number: 9, updatedAt: "2026-10-19T10:00:00Z" },
    ],
    prs: {
      12: { state: "MERGED", headRefOid: HEAD },
      11: { state: "MERGED", headRefOid: "5".repeat(40) },
      10: { state: "MERGED", headRefOid: "6".repeat(40) },
    },
  });
  const check = await checkMerged([], run);
  assertEquals(
    calls.find((c) => c.method === "list_prs")?.arguments,
    { repo: "me/repo", state: "merged" },
  );
  assertEquals(
    calls.filter((c) => c.method === "get_pull_request_context").map((c) =>
      c.arguments?.number
    ),
    [12, 11, 10],
  );
  assertEquals(check.ok, true);
  assertEquals(check.prs.map((p) => [p.number, p.verdict]), [[12, "clean"]]);
  assertEquals(check.checked, [12, 11, 10]);
  // No ancestry checks for a bare "merged": only an exact head match counts.
  assert(!calls.some((c) => c.method === "is_ancestor"));
});

Deno.test("bare merged with no worktree at a merged PR's head says so", async () => {
  const { run } = fakeRun({
    merged: [{ number: 12, updatedAt: "2026-10-24T10:00:00Z" }],
    prs: { 12: { state: "MERGED", headRefOid: "7".repeat(40) } },
  });
  const check = await checkMerged([], run);
  assertEquals(check.ok, true);
  assertEquals(check.prs, []);
  assertMatch(check.text, /No worktree is at the head of #12/);
  assertEquals(check.summary, "no worktree at a merged head");
});

Deno.test("a PR lookup that fails is reported, the others still checked", async () => {
  const { run } = fakeRun({
    prs: {
      12: new Error("gh: not found"),
      13: { state: "MERGED", headRefOid: HEAD },
    },
  });
  const check = await checkMerged([12, 13], run);
  assertEquals(check.ok, true);
  assertEquals(check.prs.map((p) => p.verdict), ["error", "clean"]);
  assertMatch(check.text, /#12 could not be checked: gh: not found/);
  assertEquals(check.summary, "#12 error, #13 clean");
});

Deno.test("a remote that is not on GitHub fails the check", async () => {
  const { run, calls } = fakeRun({ url: "https://gitlab.com/me/repo.git" });
  const check = await checkMerged([12], run);
  assertEquals(check.ok, false);
  assertMatch(check.error, /not a GitHub remote/);
  assertEquals(calls.map((c) => c.method), ["config"]);
});

Deno.test("a failed git call fails the check with its message", async () => {
  const check = await checkMerged([12], () =>
    Promise.resolve<RunResult>({
      ok: false,
      error: { message: "fatal: not a git repository" },
    }));
  assertEquals(check.ok, false);
  assertMatch(check.error, /not a git repository/);
});

Deno.test("checkMerged reads https and ssh remotes", async () => {
  for (
    const url of [
      "https://github.com/me/repo.git",
      "https://github.com/me/repo",
      "git@github.com:me/repo.git",
      "ssh://git@github.com/me/repo.git",
    ]
  ) {
    const { run } = fakeRun({
      url,
      prs: { 12: { state: "MERGED", headRefOid: HEAD } },
    });
    assertEquals((await checkMerged([12], run)).repo, "me/repo", url);
  }
});
