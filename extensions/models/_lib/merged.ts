/**
 * The "merged" check: a turn that only says a PR has merged ("merged",
 * "12 is merged", "18 and 19 merged") always asks for the same clean-up. This
 * finds the PR, checks it is merged and finds the worktree it was built in,
 * through `@swamp/git` and `@webframp/github`. It only reads: the steps are
 * written out for Claude (live mode) or the log (shadow mode), never run.
 *
 * A worktree only counts as safe to remove when its HEAD is the merged PR's
 * head commit and it has no uncommitted changes, so no commit can be orphaned.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** One call to another model's method; `runModel` in a method context. */
export interface ModelCall {
  modelType: string;
  name: string;
  method: string;
  arguments?: Record<string, unknown>;
}
/** What `runModel` gives back: the data written, or why it failed. */
export type RunResult =
  | {
    ok: true;
    resources: {
      name: string;
      specName?: string;
      attributes?: Record<string, unknown>;
    }[];
  }
  | { ok: false; error: { message: string } };
/** Runs another model's method in process. */
export type RunModel = (call: ModelCall) => Promise<RunResult>;

const GIT = { modelType: "@swamp/git", name: "git" };
const GITHUB = { modelType: "@webframp/github", name: "github" };

/** Most PRs one turn may name. */
const MAX_NUMBERS = 5;
/** Merged PRs a bare "merged" looks at, newest first. */
const LATEST = 3;
/** Worktrees checked for commits after a numbered PR's head. */
const MAX_ANCESTRY = 10;

const PR = String.raw`(?:pr ?)?#?\d{1,6}`;
const TIDY = String
  .raw`(?:,? (?:please )?(?:clean|tidy) up(?: the)? worktrees?)?`;
const BARE = new RegExp(
  String
    .raw`^merged(?: (?:both|all(?: (?:two|three|four|five|of them))?))?${TIDY}$`,
);
const AFTER = new RegExp(String.raw`^merged,? (${PR})${TIDY}$`);
const BEFORE = new RegExp(
  String
    .raw`^(${PR}(?:(?:,? and |, | & )${PR})*) (?:is |are |was |were |has been |have been |both |all )?merged${TIDY}$`,
);

/**
 * The PR numbers a turn that only says "merged" names (none for a bare
 * "merged"), or null if the turn says or asks anything else.
 */
export function matchMerged(text: string): { numbers: number[] } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ").replace(
    /[.!]+$/,
    "",
  );
  if (BARE.test(t)) return { numbers: [] };
  const m = AFTER.exec(t) ?? BEFORE.exec(t);
  if (!m) return null;
  const numbers = [...m[1].matchAll(/\d+/g)].map((d) => Number(d[0]));
  return numbers.length <= MAX_NUMBERS ? { numbers } : null;
}

/** What was found for one PR. */
export const MergedPrSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  /** GitHub's state: MERGED, OPEN or CLOSED; empty if it could not be read. */
  state: z.string(),
  /**
   * clean: safe to remove; dirty: uncommitted changes; ahead: commits after
   * the PR's head; primary: the main checkout is on the PR's branch; absent:
   * no worktree at or after its head; locked: its worktree is locked;
   * open/closed: not merged; error.
   */
  verdict: z.enum([
    "clean",
    "dirty",
    "locked",
    "ahead",
    "primary",
    "absent",
    "open",
    "closed",
    "error",
  ]),
  worktree: z.string(),
  branch: z.string(),
  /** True when `worktree` is the main checkout. */
  primary: z.boolean(),
  /** Why the check failed (error), or "head on main" (absent). */
  note: z.string(),
});
/** One PR's findings. */
export type MergedPr = z.infer<typeof MergedPrSchema>;

/** What the check found, and the text for Claude. */
export const MergedCheckSchema = z.object({
  /** False when the repo or its worktrees could not be read. */
  ok: z.boolean(),
  /** owner/name of origin on GitHub. */
  repo: z.string(),
  mainCheckout: z.string(),
  prs: z.array(MergedPrSchema),
  /** The PR numbers looked up. */
  checked: z.array(z.number().int()),
  /** One line per PR for the reply's reason, e.g. "#12 clean". */
  summary: z.string(),
  /** What was found and the steps to finish; empty when `ok` is false. */
  text: z.string(),
  error: z.string(),
});
/** The check's result. */
export type MergedCheck = z.infer<typeof MergedCheckSchema>;

interface Worktree {
  path: string;
  head: string;
  branch: string;
  primary: boolean;
  detached: boolean;
  bare: boolean;
  locked?: boolean;
}

async function attrs(
  run: RunModel,
  target: { modelType: string; name: string },
  method: string,
  args?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await run({ ...target, method, arguments: args });
  if (!res.ok) throw new Error(res.error.message.trim());
  return res.resources[0]?.attributes ?? {};
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** owner/name for a GitHub remote URL (https or ssh), else null. */
function githubRepo(url: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

const isMain = (branch: string) => branch === "main" || branch === "master";

function oneLine(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Check the PRs named (or, for none, the latest merged ones). Never throws. */
export async function checkMerged(
  numbers: number[],
  run: RunModel,
): Promise<MergedCheck> {
  const failed = (error: string): MergedCheck => ({
    ok: false,
    repo: "",
    mainCheckout: "",
    prs: [],
    checked: [],
    summary: "",
    text: "",
    error,
  });
  let repo: string;
  let worktrees: Worktree[];
  try {
    const config = await attrs(run, GIT, "config", {
      key: "remote.origin.url",
    });
    const found = githubRepo(str(config.value));
    if (!found) return failed("origin is not a GitHub remote");
    repo = found;
    const list = await attrs(run, GIT, "worktree_list");
    worktrees = Array.isArray(list.worktrees)
      ? (list.worktrees as Worktree[])
      : [];
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
  const main = worktrees.find((w) => w.primary);
  const mainCheckout = main?.path ?? "";
  const mainRef = `origin/${
    isMain(main?.branch ?? "") ? main!.branch : "main"
  }`;
  const isAncestor = async (ancestor: string, descendant: string) => {
    const res = await run({
      ...GIT,
      method: "is_ancestor",
      arguments: { ancestor, descendant },
    });
    return res.ok && res.resources[0]?.attributes?.isAncestor === true;
  };
  const branched = worktrees.filter((w) =>
    w.head && !w.bare && !w.detached && !isMain(w.branch)
  );

  const lookUp = async (n: number) => {
    const c = (await attrs(run, GITHUB, "get_pull_request_context", {
      repo,
      number: n,
      maxComments: 1,
    })).context as Record<string, unknown> | undefined;
    const base = {
      number: n,
      title: oneLine(str(c?.title)),
      url: str(c?.url),
      state: str(c?.state).toUpperCase(),
      note: "",
    };
    return { base, head: str(c?.headRefOid) };
  };

  const atHead = async (
    base: Omit<MergedPr, "verdict" | "worktree" | "branch" | "primary">,
    w: Worktree,
  ): Promise<MergedPr> => {
    const status = await attrs(run, GIT, "status", { repoPath: w.path });
    const clean = status.clean === true &&
      (!Array.isArray(status.entries) || status.entries.length === 0);
    return {
      ...base,
      verdict: !clean
        ? "dirty"
        : w.locked
        ? "locked"
        : w.primary
        ? "primary"
        : "clean",
      worktree: w.path,
      branch: w.branch,
      primary: w.primary,
    };
  };

  const errorPr = (n: number, e: unknown): MergedPr => ({
    number: n,
    title: "",
    url: "",
    state: "",
    verdict: "error",
    worktree: "",
    branch: "",
    primary: false,
    note: e instanceof Error ? e.message : String(e),
  });

  const prs: MergedPr[] = [];
  let checked = numbers;
  if (numbers.length) {
    for (const n of numbers) {
      try {
        const { base, head } = await lookUp(n);
        const none = { worktree: "", branch: "", primary: false };
        if (base.state !== "MERGED") {
          prs.push({
            ...base,
            ...none,
            verdict: base.state === "OPEN" ? "open" : "closed",
          });
          continue;
        }
        const w = head ? branched.find((w) => w.head === head) : undefined;
        if (w) {
          prs.push(await atHead(base, w));
          continue;
        }
        // A head already on main (a merge commit) is in every later branch,
        // so only a head that is not shows work carried on after the PR.
        const onMain = head ? await isAncestor(head, mainRef) : false;
        let ahead: Worktree | undefined;
        for (
          const c of head && !onMain ? branched.slice(0, MAX_ANCESTRY) : []
        ) {
          if (await isAncestor(head, c.head)) {
            ahead = c;
            break;
          }
        }
        prs.push(
          ahead
            ? {
              ...base,
              verdict: "ahead",
              worktree: ahead.path,
              branch: ahead.branch,
              primary: ahead.primary,
            }
            : {
              ...base,
              ...none,
              verdict: "absent",
              note: onMain ? "head on main" : "",
            },
        );
      } catch (e) {
        prs.push(errorPr(n, e));
      }
    }
  } else {
    let latest: number[];
    try {
      const list = await attrs(run, GITHUB, "list_prs", {
        repo,
        state: "merged",
      });
      const rows = Array.isArray(list.pullRequests)
        ? (list.pullRequests as { number: number; updatedAt?: string }[])
        : [];
      latest = rows
        .toSorted((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)))
        .slice(0, LATEST)
        .map((r) => r.number);
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
    checked = latest;
    for (const n of latest) {
      try {
        const { base, head } = await lookUp(n);
        const w = head ? branched.find((w) => w.head === head) : undefined;
        if (base.state === "MERGED" && w) prs.push(await atHead(base, w));
      } catch (e) {
        prs.push(errorPr(n, e));
      }
    }
  }
  const check = { ok: true, repo, mainCheckout, prs, checked, error: "" };
  return {
    ...check,
    summary: summarise(prs, checked),
    text: mergedText(prs, checked, mainCheckout, main?.branch ?? ""),
  };
}

function summarise(prs: MergedPr[], checked: number[]): string {
  if (prs.length) return prs.map((p) => `#${p.number} ${p.verdict}`).join(", ");
  return checked.length ? "no worktree at a merged head" : "no merged PRs";
}

function numberList(ns: number[]): string {
  const tags = ns.map((n) => `#${n}`);
  return tags.length < 2
    ? tags.join("")
    : `${tags.slice(0, -1).join(", ")} or ${tags.at(-1)}`;
}

function describe(p: MergedPr): string {
  // Only a merged PR's title is shown: anyone can title an open one.
  const title = p.state === "MERGED" && p.title ? ` (${p.title})` : "";
  const label = `#${p.number}${title}`;
  const place = p.primary
    ? `the main checkout ${p.worktree}`
    : `the worktree ${p.worktree}`;
  switch (p.verdict) {
    case "clean":
      return `${label} is merged. The worktree ${p.worktree} (branch ` +
        `${p.branch}) is at its head with no uncommitted changes, so removing ` +
        "it orphans no commits.";
    case "primary":
      return `${label} is merged. The main checkout ${p.worktree} is on its ` +
        `branch ${p.branch}, at its head, with no uncommitted changes.`;
    case "dirty":
      return `${label} is merged, but ${place} (branch ${p.branch}) has ` +
        "uncommitted changes, which removing it would lose.";
    case "locked":
      return `${label} is merged, but ${place} (branch ${p.branch}) is ` +
        "locked; unlock it first if it is safe to remove.";
    case "ahead":
      return `${label} is merged, but ${place} (branch ${p.branch}) has ` +
        `commits after #${p.number}'s head, which would be orphaned.`;
    case "absent":
      return `${label} is merged. No worktree is at ` +
        `${p.note ? "" : "or after "}#${p.number}'s head; it may be cleaned ` +
        "up already.";
    case "open":
    case "closed":
      return `${label} is ${p.verdict}, not merged.`;
    case "error":
      return `#${p.number} could not be checked: ${p.note}`;
  }
}

/** What was found, then the steps that are safe, numbered. */
function mergedText(
  prs: MergedPr[],
  checked: number[],
  mainCheckout: string,
  mainBranch: string,
): string {
  const base = isMain(mainBranch) ? mainBranch : "main";
  const lines = [
    "puddlerouter checked this with swamp before you ran (read-only: " +
    "nothing was changed):",
    ...prs.map((p) => `- ${describe(p)}`),
  ];
  if (!prs.length) {
    lines.push(
      checked.length
        ? `- No worktree is at the head of ${
          numberList(checked)
        }, the latest merged PRs; they may be cleaned up already.`
        : "- No merged PRs were found.",
    );
  }
  const steps: string[] = [];
  let switched = false;
  for (const p of prs) {
    if (p.verdict === "clean") steps.push(`Remove the worktree ${p.worktree}.`);
    if (p.verdict === "primary") {
      steps.push(`Switch ${p.worktree} to ${base} and pull.`);
      switched = true;
    }
    if (p.verdict === "clean" || p.verdict === "primary") {
      steps.push(`Delete the branch ${p.branch}, locally and on origin.`);
    }
  }
  if (steps.length && !switched && mainCheckout) {
    steps.push(`Pull ${base} in ${mainCheckout}.`);
  }
  if (steps.length) {
    lines.push(
      "",
      "Steps to finish:",
      ...steps.map((s, i) => `${i + 1}. ${s}`),
    );
  } else lines.push("", "Nothing is ready to clean up.");
  return lines.join("\n");
}
