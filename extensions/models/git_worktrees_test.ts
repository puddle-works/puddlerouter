/**
 * Tests for the `worktree_list` method added to @swamp/git.
 *
 * Run with: make test
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  extension,
  listWorktrees,
  parseWorktreeList,
} from "./git_worktrees.ts";

const PORCELAIN = [
  "worktree /home/me/dev/repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /home/me/orca/repo-feature",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/me/feature",
  "locked",
  "",
  "worktree /home/me/orca/repo-detached",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

Deno.test("parseWorktreeList reads each worktree; the first is the primary", () => {
  assertEquals(parseWorktreeList(PORCELAIN), [
    {
      path: "/home/me/dev/repo",
      head: "1111111111111111111111111111111111111111",
      branch: "main",
      primary: true,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    {
      path: "/home/me/orca/repo-feature",
      head: "2222222222222222222222222222222222222222",
      branch: "me/feature",
      primary: false,
      detached: false,
      bare: false,
      locked: true,
      prunable: false,
    },
    {
      path: "/home/me/orca/repo-detached",
      head: "3333333333333333333333333333333333333333",
      branch: "",
      primary: false,
      detached: true,
      bare: false,
      locked: false,
      prunable: true,
    },
  ]);
});

Deno.test("parseWorktreeList reads a bare primary and empty output", () => {
  assertEquals(parseWorktreeList("worktree /srv/repo.git\nbare\n"), [{
    path: "/srv/repo.git",
    head: "",
    branch: "",
    primary: true,
    detached: false,
    bare: true,
    locked: false,
    prunable: false,
  }]);
  assertEquals(parseWorktreeList(""), []);
});

Deno.test("listWorktrees runs git worktree list --porcelain in the repo path", async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const list = await listWorktrees(
    "/home/me/dev/repo",
    (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      return Promise.resolve({ code: 0, stdout: PORCELAIN, stderr: "" });
    },
  );
  assertEquals(calls, [{
    args: ["worktree", "list", "--porcelain"],
    cwd: "/home/me/dev/repo",
  }]);
  assertEquals(list.map((w) => w.path), [
    "/home/me/dev/repo",
    "/home/me/orca/repo-feature",
    "/home/me/orca/repo-detached",
  ]);
});

Deno.test("listWorktrees fails with git's message outside a repo", async () => {
  await assertRejects(
    () =>
      listWorktrees(".", () =>
        Promise.resolve({
          code: 128,
          stdout: "",
          stderr: "fatal: not a git repository",
        })),
    Error,
    "not a git repository",
  );
});

Deno.test("the extension adds worktree_list to @swamp/git and writes worktree-list", async () => {
  assertEquals(extension.type, "@swamp/git");
  const method = extension.methods[0].worktree_list;
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const ctx = {
    globalArgs: { repoPath: "/nonexistent/puddlerouter-test" },
    logger: { info: () => {} },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  // The repo path does not exist, so git cannot start there.
  await assertRejects(() => method.execute({}, ctx));
  assertEquals(written, []);
  assertEquals(Object.keys(extension.resources), ["worktreeList"]);
});
