/**
 * @puddleworks/puddlerouter — decides what happens to a turn typed into Claude Code
 *
 * The `puddlerouter` workflow runs these methods for each turn the hook hands
 * over: `load` reads the turn file and stores the cleaned text, Jev picks a
 * route, Jev answers a yes/no question on the decision route, and `reply`
 * turns the route into what the hook should do.
 *
 * In live mode a confident yes or no blocks the turn with Jev's answer, so
 * Claude does not run. In shadow mode every reply passes, so Claude runs as
 * normal, and the reply records what live mode would have done.
 *
 * Output: a `turn` resource (the cleaned text and its `sourceRef`) and a
 * `reply` resource (`{action, text}` plus the route it came from).
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Jev's answer to a decision: unsure when it is not past the cut-off. */
export const ANSWERS = ["yes", "no", "unsure"] as const;
/** One answer. */
export type Answer = typeof ANSWERS[number];

/** The routes Jev picks between. */
export const ROUTES = ["deterministic", "decision", "llm"] as const;
/** One route. */
export type Route = typeof ROUTES[number];

/** The model takes no settings. */
export const GlobalArgsSchema = z.object({});
/** The settings of one model instance (none). */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `load`. */
export const LoadArgsSchema = z.object({
  turnFile: z.string().min(1).describe(
    "Path of the file holding the turn text. The hook writes it with mktemp.",
  ),
  maxChars: z.number().int().positive().default(2000).describe(
    "Longest cleaned text kept; the rest is cut off.",
  ),
});
/** The arguments `load` accepts. */
export type LoadArgs = z.infer<typeof LoadArgsSchema>;

/** What `load` stores. */
export const TurnSchema = z.object({
  /** The turn with pasted and fenced blocks replaced, trimmed and capped. */
  text: z.string(),
  /** `puddlerouter:` and 16 hex characters of the normalised text's hash. */
  sourceRef: z.string(),
  /** True when nothing is left after cleaning; the route step is skipped. */
  empty: z.boolean(),
  /** Pasted blocks replaced. */
  pasted: z.number().int(),
  /** Fenced code blocks replaced. */
  fenced: z.number().int(),
  /** True when the text was cut at `maxChars`. */
  truncated: z.boolean(),
  /** True when nothing was replaced or cut, so the text is the whole turn. */
  complete: z.boolean(),
  /** True when the turn looked like it held a secret; `text` is a placeholder. */
  withheld: z.boolean(),
  loadedAt: z.iso.datetime(),
});
/** The stored turn. */
export type Turn = z.infer<typeof TurnSchema>;

/** Arguments for `reply`. */
export const ReplyArgsSchema = z.object({
  mode: z.enum(["shadow", "live"]).default("shadow").describe(
    "shadow logs the route and always passes; live acts on it.",
  ),
  sourceRef: z.string().describe("The turn's sourceRef."),
  choice: z.string().optional().describe(
    "Jev's route; empty or missing when the route step did not answer.",
  ),
  confidence: z.number().optional().describe("Jev's confidence in `choice`."),
  cutoff: z.number().min(0).max(1).default(0.7).describe(
    "Below this confidence the route is llm.",
  ),
  hookStartedAt: z.number().optional().describe(
    "When the hook started, in ms since the epoch; 0 or missing if unknown.",
  ),
  complete: z.boolean().default(false).describe(
    "The turn's `complete`. A decision is only answered for a complete turn.",
  ),
  yes: z.number().min(0).max(1).nullable().optional().describe(
    "Jev's probability that the answer is yes; null if it was not asked.",
  ),
  answerCutoff: z.number().min(0.5).max(1).default(0.8).describe(
    "A yes needs `yes` at or above this, a no at or below 1 minus this.",
  ),
});
/** The arguments `reply` accepts. */
export type ReplyArgs = z.infer<typeof ReplyArgsSchema>;

/** What `reply` stores, and what the hook reads. */
export const ReplySchema = z.object({
  /** block: answer instead of Claude; hint: add context; pass: do nothing. */
  action: z.enum(["block", "hint", "pass"]),
  /** The answer (block) or the context (hint). Empty for pass. */
  text: z.string(),
  /** What live mode does: the same as `action` unless the mode is shadow. */
  wouldAction: z.enum(["block", "hint", "pass"]),
  mode: z.enum(["shadow", "live"]),
  /** The route taken after the cut-off. */
  route: z.enum(ROUTES),
  /** Jev's own choice, before the cut-off; empty if it gave none. */
  choice: z.string(),
  confidence: z.number().nullable(),
  cutoff: z.number(),
  /** Jev's answer on the decision route; null if it was not asked. */
  answer: z.enum(ANSWERS).nullable(),
  /** Jev's probability of yes; null if it was not asked. */
  yes: z.number().nullable(),
  answerCutoff: z.number(),
  sourceRef: z.string(),
  /** Why the action was chosen. */
  reason: z.string(),
  /** Milliseconds from the hook starting to this reply; null if unknown. */
  elapsedMs: z.number().nullable(),
  repliedAt: z.iso.datetime(),
});
/** The stored reply. */
export type Reply = z.infer<typeof ReplySchema>;

/** Lowercase, trim and collapse whitespace, so trivial edits hash the same. */
export function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

const PASTED =
  /<pasted_content id="[^"]*">[\s\S]*?(?:<\/pasted_content id="[^"]*">|$)/g;
const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|(?![\s\S]))/gm;

/** The turn text without pasted or fenced blocks, trimmed and capped. */
export function cleanTurn(
  raw: string,
  maxChars: number,
): { text: string; pasted: number; fenced: number; truncated: boolean } {
  let pasted = 0;
  let fenced = 0;
  const text = raw
    .replace(PASTED, () => {
      pasted++;
      return "[pasted text]";
    })
    .replace(FENCED, () => {
      fenced++;
      return "[code block]";
    })
    .trim();
  const truncated = text.length > maxChars;
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    pasted,
    fenced,
    truncated,
  };
}

/** `puddlerouter:<hash>`, the same for the same normalised text. */
export async function sourceRef(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalise(text)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `puddlerouter:${hex.slice(0, 16)}`;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*\s*[:=]\s*\S+/i,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\b[0-9a-f]{32,}\b/i,
];

/** True if the text looks like it holds a token, key, password, email or hash. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** What `text` is replaced with when the turn looks like it holds a secret. */
export const WITHHELD_TEXT = "[withheld: looks like it contains a secret]";

const ONLY_PLACEHOLDERS = /^(\[(pasted text|code block)\]\s*)*$/;

/** The turn to store for `raw`: cleaned, hashed and stamped `now`. */
export async function loadTurn(
  raw: string,
  maxChars: number,
  now: Date = new Date(),
): Promise<Turn> {
  const withheld = looksSecret(raw);
  const cleaned = withheld
    ? { text: WITHHELD_TEXT, pasted: 0, fenced: 0, truncated: false }
    : cleanTurn(raw, maxChars);
  return {
    ...cleaned,
    sourceRef: await sourceRef(cleaned.text),
    empty: !withheld && ONLY_PLACEHOLDERS.test(cleaned.text),
    complete: !withheld && cleaned.pasted === 0 && cleaned.fenced === 0 &&
      !cleaned.truncated,
    withheld,
    loadedAt: now.toISOString(),
  };
}

/** Jev's route if it is a known one at or above the cut-off, else llm. */
export function effectiveRoute(
  choice: string | undefined,
  confidence: number | undefined,
  cutoff: number,
): Route {
  if (!ROUTES.includes(choice as Route)) return "llm";
  if (confidence === undefined || confidence < cutoff) return "llm";
  return choice as Route;
}

/** yes or no if Jev's probability of yes is past the cut-off, else unsure. */
export function decisionAnswer(yes: number, answerCutoff: number): Answer {
  if (yes >= answerCutoff) return "yes";
  if (1 - yes >= answerCutoff) return "no";
  return "unsure";
}

/** The text shown to the user when a decision blocks the turn. */
export function decisionText(answer: "yes" | "no", yes: number): string {
  const sure = Math.round((answer === "yes" ? yes : 1 - yes) * 100);
  return `Jev: ${answer} (${sure}% sure).\n` +
    "Answered by puddlerouter without Claude. To ask Claude instead, " +
    "send the prompt again starting with llm:";
}

/** The arguments `buildReply` needs; `complete` and `answerCutoff` default. */
export type BuildReplyArgs =
  & Omit<ReplyArgs, "mode" | "cutoff" | "complete" | "answerCutoff">
  & {
    mode: ReplyArgs["mode"];
    cutoff: number;
    complete?: boolean;
    answerCutoff?: number;
  };

/**
 * What the hook should do with the turn. Live mode blocks a decision Jev
 * answered past the answer cut-off; anything else passes. Shadow mode always
 * passes and records the live action in `wouldAction`.
 */
export function buildReply(
  args: BuildReplyArgs,
  now: Date = new Date(),
): Reply {
  const choice = args.choice ?? "";
  const route = effectiveRoute(choice, args.confidence, args.cutoff);
  const complete = args.complete ?? false;
  const answerCutoff = args.answerCutoff ?? 0.8;
  const yes = route === "decision" && complete ? args.yes ?? null : null;
  const answer = yes === null ? null : decisionAnswer(yes, answerCutoff);
  let wouldAction: Reply["action"] = "pass";
  let text = "";
  let reason: string;
  if (!choice) reason = "no route answer";
  else if (route !== choice) reason = "confidence below cut-off";
  else if (route === "llm") reason = "llm route";
  else if (route === "deterministic") reason = `${route} route not built yet`;
  else if (!complete) reason = "decision text not in the turn";
  else if (answer === null) reason = "no decision answer";
  else if (answer === "unsure") reason = "decision unsure";
  else {
    wouldAction = "block";
    text = decisionText(answer, yes as number);
    reason = `decision answered ${answer}`;
  }
  const shadow = args.mode === "shadow";
  return {
    action: shadow ? "pass" : wouldAction,
    text: shadow ? "" : text,
    wouldAction,
    mode: args.mode,
    route,
    choice,
    confidence: args.confidence ?? null,
    cutoff: args.cutoff,
    answer,
    yes,
    answerCutoff,
    sourceRef: args.sourceRef,
    reason: shadow ? `shadow: ${reason}` : reason,
    elapsedMs: args.hookStartedAt ? now.getTime() - args.hookStartedAt : null,
    repliedAt: now.toISOString(),
  };
}

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
}

/** The model type: `load` and `reply`, one resource each. */
export const model = {
  type: "@puddleworks/puddlerouter",
  version: "2026.10.13.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    turn: {
      description: "The cleaned text of the last turn and its sourceRef.",
      schema: TurnSchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
    reply: {
      description: "What the hook should do with the last turn, and why.",
      schema: ReplySchema,
      lifetime: "14d" as const,
      garbageCollection: 2000,
    },
  },
  methods: {
    load: {
      description: "Read a turn file, clean it and store it as `turn`.",
      arguments: LoadArgsSchema,
      execute: async (args: LoadArgs, context: MethodContext) => {
        context.logger.info("Loading turn", {});
        const raw = await Deno.readTextFile(args.turnFile);
        const turn = await loadTurn(raw, args.maxChars);
        const handle = await context.writeResource("turn", "turn", turn);
        context.logger.info("Loaded turn {sourceRef}", {
          sourceRef: turn.sourceRef,
        });
        return { dataHandles: [handle] };
      },
    },
    reply: {
      description: "Turn the route into a reply for the hook; store `reply`.",
      arguments: ReplyArgsSchema,
      execute: async (args: ReplyArgs, context: MethodContext) => {
        context.logger.info("Replying for {sourceRef}", {
          sourceRef: args.sourceRef,
        });
        const reply = buildReply({
          ...args,
          mode: args.mode ?? "shadow",
          cutoff: args.cutoff ?? 0.7,
        });
        const handle = await context.writeResource("reply", "reply", reply);
        context.logger.info("Reply {action} for {sourceRef} ({reason})", {
          action: reply.action,
          sourceRef: reply.sourceRef,
          reason: reply.reason,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
