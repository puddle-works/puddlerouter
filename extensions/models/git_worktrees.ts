/**
 * Adds `worktree_list` to `@swamp/git`: the worktrees of the repo at
 * `repoPath`, each with its path, HEAD and branch. `@swamp/git` can remove a
 * worktree but has no way to list them.
 *
 * puddlerouter's `merged` step uses it to find the worktree a merged PR was
 * built in, from the main checkout as well as from the worktree itself.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** One worktree, as `git worktree list --porcelain` gives it. */
export const WorktreeSchema = z.object({
  path: z.string(),
  /** The commit checked out; empty for a bare repo. */
  head: z.string(),
  /** The branch without `refs/heads/`; empty when detached or bare. */
  branch: z.string(),
  /** True for the first entry: the main checkout, not a linked worktree. */
  primary: z.boolean(),
  detached: z.boolean(),
  bare: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
});
/** One worktree. */
export type Worktree = z.infer<typeof WorktreeSchema>;

/** What `worktree_list` stores. */
export const WorktreeListSchema = z.object({
  repoPath: z.string(),
  worktrees: z.array(WorktreeSchema),
  listedAt: z.iso.datetime(),
});

/** The worktrees in `git worktree list --porcelain` output, in its order. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l !== "");
    const path = lines.find((l) => l.startsWith("worktree "));
    if (!path) continue;
    const value = (key: string) =>
      lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? "";
    const flag = (key: string) =>
      lines.some((l) => l === key || l.startsWith(`${key} `));
    out.push({
      path: path.slice("worktree ".length),
      head: value("HEAD"),
      branch: value("branch").replace(/^refs\/heads\//, ""),
      primary: out.length === 0,
      detached: flag("detached"),
      bare: flag("bare"),
      locked: flag("locked"),
      prunable: flag("prunable"),
    });
  }
  return out;
}

/** Runs `git <args>` in `cwd`; tests pass a fake. */
export type GitExec = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const gitExec: GitExec = async (args, cwd) => {
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

/** The worktrees of the repo at `repoPath`; throws with git's message. */
export async function listWorktrees(
  repoPath: string,
  exec: GitExec = gitExec,
): Promise<Worktree[]> {
  const res = await exec(["worktree", "list", "--porcelain"], repoPath);
  if (res.code !== 0) {
    throw new Error(
      `git worktree list failed (exit ${res.code}): ${res.stderr.trim()}`,
    );
  }
  return parseWorktreeList(res.stdout);
}

interface Context {
  globalArgs: Record<string, unknown>;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The `@swamp/git` extension: one read-only method and its resource. */
export const extension = {
  type: "@swamp/git",
  resources: {
    worktreeList: {
      description: "The repo's worktrees: path, HEAD, branch and flags.",
      schema: WorktreeListSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 10,
    },
  },
  methods: [{
    worktree_list: {
      description:
        "List the repo's worktrees (read-only, via git worktree list --porcelain).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const repoPath = typeof ctx.globalArgs.repoPath === "string"
          ? ctx.globalArgs.repoPath
          : ".";
        const worktrees = await listWorktrees(repoPath);
        ctx.logger.info("Found {count} worktrees", {
          count: worktrees.length,
        });
        const handle = await ctx.writeResource(
          "worktreeList",
          "worktree-list",
          {
            repoPath,
            worktrees,
            listedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
