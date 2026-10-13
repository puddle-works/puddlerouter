# puddlerouter: findings by step

- [Step 0: checks](#step-0-checks)
- [Step 1: shadow mode](#step-1-shadow-mode)
- [Step 2: decision route](#step-2-decision-route)
- [Step 3: deterministic route](#step-3-deterministic-route)
- [Step 4: raise an issue when nothing can answer](#step-4-raise-an-issue-when-nothing-can-answer)
- [Step 6: local config and a wider allowlist](#step-6-local-config-and-a-wider-allowlist)
- [Step 6b: caches](#step-6b-caches)
- [Step 6c: recipe packs, `recipeIndex` and the sync workflow](#step-6c-recipe-packs-recipeindex-and-the-sync-workflow)

## Step 0: checks

Step 0 of the plan checks the assumptions the router rests on before any code
is written. Each check says what was found, how it was found, and what it
changes in the design.

| # | Check | Status |
|---|---|---|
| 1 | `UserPromptSubmit` input, output and timeout | Done (Claude Code docs) |
| 2 | Does `workflow run --input` evaluate `${{ }}` / `@file`? | Done (live) |
| 3 | Jev `choice` route accuracy on 30 labelled turns | Done (live): 30/30; cut-off 0.7 |
| 4a | Can packaged workflow tags hold a regex? | Done (schema) |
| 4b | Can `extension search` filter by label `puddlerouter-recipe`? | Done (live) |

### 1. The `UserPromptSubmit` hook

Source: <https://code.claude.com/docs/en/hooks>, read 2026-10-13 against
Claude Code 2.1.296.

**Input on stdin:**

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../<session>.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Write a function to calculate the factorial of a number"
}
```

- `prompt` is the typed text. Pasted text that collapsed to `[Pasted text #N]`
  arrives expanded. Where Claude Code marks paste for Claude, it sits between
  `<pasted_content id="…">` and `</pasted_content id="…">` lines.
- `session_title` is added when the session has a custom title.

**Output:**

| Hook does | Effect |
|---|---|
| Exit 0, JSON `{"decision":"block","reason":"…"}` | Prompt never reaches Claude. `reason` is shown to the user and **not** added to Claude's context. The block message ends with `Original prompt:` and the text unless `hookSpecificOutput.suppressOriginalPrompt` is `true`. |
| Exit 0, JSON `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}` | Prompt goes to Claude with the text added as a system reminder. Not shown in the transcript. |
| Exit 0, plain stdout | Added to Claude's context like `additionalContext`. |
| Exit 0, no output | Prompt goes to Claude unchanged. |
| Exit 2 | Blocked; stderr is the reason. |
| Any other exit code | Prompt goes to Claude; the user sees a "hook error" notice with the first line of stderr. |
| Times out | Output discarded; prompt goes to Claude. |

- `additionalContext`, plain stdout and `reason` are each capped at 10,000
  characters. Longer text is saved to a file and only a 2,000-character preview
  is passed on.
- `timeout` is in seconds. For `UserPromptSubmit` the default is **30**.
  `"onFailure": "block"` (2.1.295+) would block on failure; we never set it.
- Hooks get the parent environment plus `CLAUDE_PROJECT_DIR`.

**What this changes:**

- **Fail open is the default.** A timeout or a non-zero exit other than 2 lets
  Claude run. The hook must never exit 2, and must exit 0 with no output on any
  error, so the user doesn't get a "hook error" notice on every turn.
- **Not every `UserPromptSubmit` is typed.** It also fires when a scheduled task
  or `/loop` iteration runs, when a background subagent reports back, and when
  another session sends a message. Nothing in the input marks these. The hook
  skips any prompt whose first non-blank character is `<`, which covers
  subagent reports wrapped in tags such as `<task-notification>`, and `load`
  strips `<pasted_content>` blocks. A scheduled task whose prompt is plain text
  can't be told apart; in shadow mode it is only logged. Step 1's week of logs
  shows whether these need another rule.
- **A block answer is shown, not read.** `reason` reaches the user only, so a
  routed answer doesn't pollute Claude's context, and Claude has no memory of
  it on the next turn. That is the intent.
- **Hook timeout:** set `"timeout": 20`. Swamp's start-up (1.2 s) plus Jev
  (median 0.5 s per call, slow tail to 12 s) has to fit inside it; step 1
  records the real delay.

### 2. Are workflow inputs evaluated?

Checked live with a throwaway workflow (one assert step that echoes
`inputs.x`), swamp 20261013.025835.0, and against the swamp skill's
`references/workflow/reference.md` ("Inputs Are Inert and Recorded").

| `--input` value | `inputs.x` in the run |
|---|---|
| `x=${{ 1 + 1 }}` | `${{ 1 + 1 }}`, literal (12 characters) |
| `x=${{ env.HOME }}` | `${{ env.HOME }}`, literal |
| `x=@/etc/hosts` | **the contents of `/etc/hosts`** |
| `x=@file=/etc/hosts` | error: `Input file not found … Values starting with @ are read as file paths; use \@ for a literal @` |

- **`${{ }}` is never evaluated** in workflow inputs.
- **A value starting with `@` is read as a file path.** Prompt text passed as
  an input could read any file the user can read, just by starting with `@`.
  Prompts starting with `@` are common in Claude Code (file mentions).
- **Inputs are recorded:** in the run record, the history index that
  `workflow history search --input` filters on, child runs, and evaluated model
  definitions.
- **`swamp model method run --input`** values *are* evaluated (`vault.get`,
  `env.X` resolve, per `references/model/reference.md`). Text from a prompt
  must only reach a method with `--literal-inputs`.
- **Delay:** a one-step workflow run takes 1.2 s wall clock (three runs, all
  1.21 s). That is swamp's fixed cost per turn before any Jev call.

**What this changes:**

- The hook passes only the turn file's path, as planned. That is now required
  for two reasons: an `@` prompt would otherwise be read as a file, and the text
  would otherwise be copied into the run index. The path is one the hook
  creates with `mktemp`, so it never starts with `@`.
- `load` reads the file and writes a `turn` resource. That resource holds the
  cleaned text, so the text is still kept as swamp data. The `turn` resource
  gets a short `lifetime` (7 days) so it expires with the route cache.
- `execute` must always call `swamp model … method run … --literal-inputs`,
  because recipe captures come from the prompt.

### 3. Jev route accuracy

Run 2026-10-13 with the `puddlerouter-route-eval` workflow over
[`route-eval/turns.yaml`](route-eval/turns.yaml) (30 turns, 10 per route). Jev
is `jev-1.13-free` at `https://opencode.ai/zen` (OpenCode's free tier), the
same settings as `~/dev/puddleworks-apps`. Run `fa02dfbc`.

```sh
swamp workflow run puddlerouter-route-eval --input-file docs/route-eval/turns.yaml
swamp data query 'workflowRunId == latestRun("puddlerouter-route-eval") && modelName == "jev"' --select content --json
```

The question Jev is asked (kept identical in `workflow-puddlerouter.yaml`):

- `state`: the turn text
- `instructions`: "Route this request typed into a coding assistant. Pick deterministic only if a program could answer it exactly by calling an API or CLI, with no judgement. Pick decision only if it asks for a yes/no judgement about text given in the request. Pick llm for anything else, such as writing, changing, reviewing or explaining code."
- `criteria`: `deterministic`, `decision`, `llm`, each with a one-line description

**Result:** Jev's top choice was right for all 30 turns. A turn whose
`confidence` is below the cut-off is treated as `llm`:

| Cut-off | Correct | deterministic | decision | llm | `llm` sent elsewhere |
|---|---|---|---|---|---|
| ≤ 0.6 | 30/30 | 10 | 10 | 10 | 0 |
| 0.7 | 29/30 | 9 | 10 | 10 | 0 |
| 0.8 | 29/30 | 9 | 10 | 10 | 0 |
| 0.9 | 28/30 | 8 | 10 | 10 | 0 |

The low-confidence turns were:

| Turn | Label | Jev | Confidence | Probabilities |
|---|---|---|---|---|
| t30 "summarise what changed in the last week across puddle-works repos…" | llm | llm | 0.48 | llm 0.65, deterministic 0.35 |
| t06 "which swamp extensions have the label github?" | deterministic | deterministic | 0.64 | deterministic 0.76, llm 0.21 |
| t09 "what's the current status of the mted19 server?" | deterministic | deterministic | 0.86 | deterministic 0.91, llm 0.09 |

All the others were at 0.95 or above.

**Cut-off chosen: 0.7.** No `llm` turn is misrouted at any cut-off, but t30 is
an `llm` turn with 35% on `deterministic`, so a different summary-style prompt
could cross over. 0.7 keeps a margin and costs one borderline deterministic
turn (t06), which then just goes to Claude. The set was written by hand and is
cleaner than real prompts, so step 1's week of real turns decides the final
value. In shadow mode the cut-off only changes what is logged.

**Delay per `choice` call:** median 0.49 s, but 4 of 30 took 4.7–11.8 s
(three calls ran at a time against the free tier). With swamp's 1.2 s start-up,
a typical routed turn costs about 2 s. The slow tail is why the hook has a
20 s timeout and fails open.

**Aside:** the `@swamp/typesafe-ai` `models` method fails against OpenCode,
which returns an OpenAI-style `{object, data}` list rather than `{models}`. The
router doesn't use that method.

### 4. Recipe packs in the registry

**4a. Tags can hold a regex.** `swamp workflow schema get` gives `tags` as
`{ type: object, additionalProperties: { type: string } }`. A regex is a
string, so any pattern fits. YAML quoting is the only care needed: write
patterns in single quotes so `\d` and `\s` are not escapes. Confirming that the
registry ships tags unchanged needs a publish, so it is checked with the first
pack in step 6.
**Checked in step 6c: tags come back byte for byte** (see below).

**4b. Search can filter by label.** `swamp extension search` has `--label`.
Checked live:

```console
$ swamp extension search --label aws --json | jq .meta.total
361
$ swamp extension search --label puddlerouter-recipe --json | jq .meta.total
0
```

Manifests carry `labels:` and `workflows:` (see `@mesgme/control-plane` in
`~/dev/swamplane/manifest.yaml`), so a pack is a manifest with
`labels: [puddlerouter-recipe]` and one workflow per recipe.
`--content-type workflows` narrows it further.

### Repo setup

The repo was created from the template without step 5 of the template README
(`swamp repo init --force --tool claude`). Without it the repo had the
template's `repoId` and no `.claude/settings.local.json`, and Claude Code's
auto-mode classifier refused swamp commands that change the repo
(`workflow create`, `model list`, `repo init` elsewhere). After the user ran
`swamp repo init --force --tool claude`, those commands ran. The new `repoId`,
the refreshed managed section of `CLAUDE.md` and the `vaults/` definitions
(no secrets) are committed with this step.

## Step 1: shadow mode

Built in step 1: `load` and `reply` in `extensions/models/puddlerouter.ts`,
the `@puddleworks/puddlerouter` workflow (load → route → reply) and
`hooks/puddlerouter.sh`. The [README](../README.md) has the set-up and the
queries that read the log.

### Decisions

- **Shadow runs in the background.** In shadow mode the hook starts the
  workflow detached and exits at once (31 ms measured), so a week of shadow
  data costs no delay per turn. Live mode waits for the run, then reads its
  `reply` with `swamp workflow history outputs` (about 1.2 s more); `swamp
  workflow run --json` does not include step data. The mode is set in one
  place, the hook (`PUDDLEROUTER_MODE`, default `shadow`), which passes it
  to the workflow. In step 1 `reply` always passes; from step 2 it must still
  pass whenever the mode is `shadow`.
- **Delay is measured from the hook.** The hook passes `hookStartedAt` (ms,
  from `jq now`) and `reply` stores `elapsedMs`. This covers swamp's start-up,
  `load`, Jev and `reply`, which is the delay a live turn waits for apart from
  reading the reply. A run's own `duration` in `workflow history` leaves out
  swamp's start-up. First live runs: 1.0–1.4 s.
- **Retention.** `turn` and `reply` keep 14 days (not 7) and up to 2,000
  versions, so a week of turns is still there when it is reviewed. Jev's
  `choice` data is stored by `@swamp/typesafe-ai` with no expiry, so the
  route step always uses the name `route`: only the last 20 versions, and so
  only the last 20 turns' text, are kept there.
- **Skips.** Besides the plan's skips the hook also skips turns starting with
  `!` (Claude Code's shell mode), and a turn that is only pasted text or code
  is stored with `empty: true` and not sent to Jev.
- **Workflow name.** The publish quality gate requires every workflow in the
  extension to use the extension's collective, so the workflow is
  `@puddleworks/puddlerouter`, not `puddlerouter`.
- **Fail open.** The route step has `allowFailure`, and `reply` runs whether
  or not Jev answered (`dependsOn … condition: always`); a skipped or failed
  route is recorded as `llm` with reason `no route answer`. `steps.route` is
  absent when the step was skipped, so the reply inputs test
  `has(steps.route) && has(steps.route.outputs)` first.
- **Same question as the eval.** `tests/workflows_test.ts` fails if the route
  instructions or criteria differ from `puddlerouter-route-eval`.

### Publishing

The extension is `@puddleworks/puddlerouter`, published privately. It started
as `@mesgme/puddlerouter`, but the `@mesgme` collective is on swamp's Free plan,
which cannot publish privately; `@puddleworks` is on the Team plan. Renaming
keeps the model's id, so turns logged before the rename stay in the log under
the workflow name `@mesgme/puddlerouter` until they expire. The README queries
include both names.

`make publish VISIBILITY=private DRY_RUN=1` passes the tests, `deno check`,
formatting, quality (85%; the missing 15% is a verified public repository),
the registry checks and the adversarial review in `swamp-extension-review/`.
The router does not need publishing to run (the runtime repo is a clone of
this one). CI's publish job reads `SWAMP_API_KEY` and `SWAMP_SIGNIN_TOKEN`
from puddle-works organisation secrets, which are shared only with the
repositories selected for them; this repo must be one of them.

### A week of real turns

To fill in after a week of shadow mode, with the queries in the README. Label
a sample of turns by hand (as in `route-eval/turns.yaml`) and score Jev at the
0.7 cut-off.

| Measure | Value |
|---|---|
| Dates | |
| Turns routed | |
| Routes (deterministic / decision / llm) | |
| Accuracy on the labelled sample | |
| `llm` turns sent elsewhere | |
| Delay, median / 95th percentile (`elapsedMs`) | |
| Turns that are not typed (scheduled tasks, agent reports) | |

## Step 2: decision route

Built in step 2: a `decide` step in the `@puddleworks/puddlerouter` workflow
(`jev.noul`) and the decision branch of `reply`. In live mode a yes/no turn
that Jev answers confidently is blocked, and the user sees Jev's answer
instead of Claude's. Shadow mode is still the default, so the hook installed
in step 1 keeps passing every turn and now also logs what live mode would do.

### How a decision is answered

1. `route` picks `decision` at or above the 0.7 cut-off.
2. `decide` asks Jev `noul`, its probability that the answer is yes:
   - `state`: the turn text
   - `instructions`: "Answer the yes/no question asked in this request,
     judging only the text given in it."
   - `yes` / `no`: "The answer to the question is yes." / "… no."
3. `reply` turns the probability into an answer with the answer cut-off
   (0.8): `yes` at ≥ 0.8, `no` at ≤ 0.2, `unsure` in between.
4. In live mode `yes` and `no` block with this text, which Claude Code shows
   in place of a reply (followed by the original prompt):

   ```
   Jev: no (96% sure).
   Answered by puddlerouter without Claude. To ask Claude instead, send the prompt again starting with llm:
   ```

   `unsure`, a failed `decide` step and every other route pass, so Claude
   runs as normal.

### Decisions

- **Only complete turns are decided.** `load` replaces pasted and fenced blocks
  with placeholders before anything reaches Jev, so in "is this a good commit
  message? *(pasted)*" the text to judge is gone. `load` now stores
  `complete` (nothing pasted, fenced or cut), and `decide` is skipped for an
  incomplete turn; `reply` records the reason `decision text not in the turn`
  and passes. Sending pasted text to Jev would mean storing it in Jev's
  `noul` data, which `load` avoids on purpose.
- **Shadow records the live action.** `reply` has a new `wouldAction` field:
  what live mode would do. In live mode it equals `action`; in shadow mode
  `action` is always `pass`. `answer` and `yes` hold Jev's answer. The README
  queries show both, so the week of shadow data shows how many turns would
  have been blocked and with what answer.
- **Decide always runs in shadow mode** for a decision turn, so the log holds
  the answer. It runs in the background, so it costs no delay there.
- **One stored answer.** Like `route`, `decide` always uses the name `decide`,
  so Jev's `noul` data keeps only the last 20 decisions' text.
- **Same question as the eval.** `tests/workflows_test.ts` fails if the
  `decide` question differs from `puddlerouter-decision-eval`.
- **Version.** The model and manifest stay at `2026.10.13.1`: nothing has
  been published yet (`swamp extension version` gives that as the next
  version), and the global arguments did not change, so no upgrade entry is
  needed.

### Secrets are not sent to Jev

Jev is an outside service (`https://opencode.ai/zen`), and `load` only removes
pasted and fenced blocks, so a token typed inline would have gone to it and
into the stored data. `load` now checks the raw turn with `looksSecret`: GitHub,
`sk-`, AWS and Slack tokens, bearer tokens, JWTs, private-key headers,
`password=`/`token:` assignments, emails and hex strings of 32+ characters.
There is no redaction. A matching turn gets `withheld: true`, its stored text
becomes `[withheld: looks like it contains a secret]`, and the `route` and
`decide` steps are skipped, so Claude runs as normal. Patterns catch common
shapes only; a plain-English password is not caught. Turns logged before this
change may hold secrets in `turn` and Jev's `choice` data (14 days; last 20).

### Decision accuracy

Run 2026-10-13 with the `puddlerouter-decision-eval` workflow over
[`route-eval/decisions.yaml`](route-eval/decisions.yaml): the ten decision
turns from step 0, each labelled with the right answer. Three runs
(`1898336d`, `4e2da4ef`, `fcdad681`) gave the same answers to within 0.02.

```sh
swamp workflow run puddlerouter-decision-eval --input-file docs/route-eval/decisions.yaml
swamp data query 'workflowRunId == latestRun("puddlerouter-decision-eval") && modelName == "jev"' --select content --json
```

| Turn | Label | `noul` (yes) |
|---|---|---|
| t11 "is this a good commit message: 'fix stuff'?" | no | 0.04 |
| t12 "does this sentence read as British English…" | yes | 0.96 |
| t13 "should 'retry on 429' be treated as a transient error?" | yes | 0.91–0.92 |
| t14 "is 'Add hook for routing prompts' … imperative mood?" | yes | 0.95 |
| t15 "is this PR title under 70 characters and descriptive…" | yes | 0.83–0.84 |
| t16 "is this error message friendly … 'ENOENT…'?" | no | 0.14 |
| t17 "is the following a question about billing…" | yes | 0.98 |
| t18 "does this log line indicate an error: 'INFO …'?" | no | 0.03–0.04 |
| t19 "is 'utilise' plain English, yes or no?" | no | 0.22–0.24 |
| t20 "is this variable name descriptive enough: 'x2'?" | no | 0.09–0.10 |

Jev leans the right way on all ten. By answer cut-off:

| Answer cut-off | Answered | Wrong | Sent to Claude |
|---|---|---|---|
| 0.75 | 10 | 0 | 0 |
| 0.8 | 9 | 0 | t19 |
| 0.85 | 8 | 0 | t15, t19 |
| 0.9 | 7 | 0 | t15, t16, t19 |

**Answer cut-off chosen: 0.8.** A wrong block is worse than a missed one: the
user has to notice it and resend with `llm:`. 0.8 answers 9 of 10 and keeps a
margin above t19 (0.24, the closest call, and a matter of taste). As with the
route cut-off, the set is small and hand-written, so the shadow week decides
the final value.

### Questions about the conversation

The main risk in live mode is a yes/no question about the conversation rather
than about text in the turn, such as "does that fix look right to you?". Jev
can't see the conversation, so it should not answer these. Probed live:

| Turn | Route (`choice`, confidence) | `noul` (yes) | Live result |
|---|---|---|---|
| "does that fix look right to you?" | decision, 0.59 | 0.42 | pass (below route cut-off) |
| "is it safe to merge PR 3 now?" | decision, 0.41 | 0.26 | pass (below route cut-off) |
| "should we branch step 2 off main?" | decision, 0.61 | 0.49 | pass (below route cut-off) |
| "yes" | llm, 0.30 | — | pass |
| "ok go ahead" | llm, 0.86 | — | pass |

Jev's top route for all three questions is `decision`, so only the 0.7 route
cut-off stops them, with a margin of about 0.1. If one did get through, its
`noul` would most likely be unsure at the 0.8 answer cut-off (0.26 is the
closest to a no). Both cut-offs are guarding here, which is why the shadow
week should count decision turns that refer to the conversation before step 5
turns blocking on.

### End to end

Live mode, run in this repo with the hook
(`echo '{"prompt":"…"}' | PUDDLEROUTER_MODE=live PUDDLEROUTER_REPO=$PWD bash hooks/puddlerouter.sh`):

| Turn | Hook output | `reply.reason` | `elapsedMs` |
|---|---|---|---|
| "is 'Add hook for routing prompts' written in the imperative mood?" | block, "Jev: yes (95% sure)." | decision answered yes | 1,903 |
| "is this a good commit message: 'fix stuff'?" | block, "Jev: no (96% sure)." | decision answered no | 1,761 |
| "is 'utilise' plain English, yes or no?" | none | decision unsure (yes 0.25) | 2,001 |
| "is this a good commit message?" + a pasted block | none | decision text not in the turn | 1,252 |
| "refactor the reply method so the hint text comes from a template" | none | llm route | 1,367 |
| "list the open pull requests in puddle-works/puddleworks" | none | no extension found (no allowlisted candidate) | n/a |
| "is this variable name descriptive enough: 'x2'?" (shadow) | none | shadow: decision answered no, `wouldAction` block | 1,800 |

A decision turn costs about 0.5 s more than other turns (the second Jev call).
Live mode then reads the reply (about 1.2 s), so a blocked decision appears
about 3 s after the prompt is sent, inside the hook's 20 s timeout.

## Step 3: deterministic route

A turn Jev routes to `deterministic` (at 0.7 or more) is answered by a program,
not Claude, in one of three ways.

1. **Recipe.** `match` tries the built-in recipes in
   `extensions/models/_lib/recipes.ts`: a regex that must match the whole turn,
   the read-only method it runs, and how the data is shown as text. The first
   recipes use `@swamp/git` (no credentials): `git status`, `git log` (with
   "last N commits", N up to 99) and `git branch`. The regex captures digits
   only; they become method inputs run with `--literal-inputs`, so turn text
   never reaches swamp as input. `execute` runs
   `swamp behavior run @swamp/git <method> git --repo-dir <runtime repo>`, pulls
   the extension once if it is missing, and stores `result`. Live mode blocks
   with the answer and the `llm:` footer. A failed recipe passes.
2. **Extension hint.** With no recipe, `match` searches the local types and the
   registry (`swamp model type search`, `swamp extension search`, on the turn's
   content words, never the whole turn), keeps only allowlisted extensions
   (`@swamp/*`, `@mesgme/*`, `@webframp/*`, `@puddleworks/*`, plus the config's `allow:`), and Jev's `pick` step chooses one (or none) from up to three.
   A pick at or above the cut-off adds a hint telling Claude which extension to
   describe and use, and to ask the user about a "recipe wanted" issue (step 4
   will raise it).
3. **Nothing found.** The turn passes to Claude (`no extension found`).

Recipes run in the Claude session's working directory, because the hook's swamp
inherits it and `@swamp/git`'s `repoPath "."` resolves there. Shadow mode runs
all of this and records it in `reply.recipe`, `reply.extension` and
`wouldAction`; it still never blocks.

Run in live mode from `~/dev/swamplab` (a git repo) with this repo as the
runtime:

| Turn | Hook output | `reply.reason` | `elapsedMs` |
|---|---|---|---|
| "git status" | block, "1 changed file: ?? swamp/" | recipe git-status answered | 2,651 |
| "show me the last 3 commits" | block, three commits | recipe git-log answered | 2,480 |
| "what branch am I on" | block, "On branch main. Other branches: …" | recipe git-branch answered | 2,580 |
| "list the hetzner servers in my account" | hint (a hint naming an extension; third-party ones are now filtered out) | extension …, no recipe | 4,760 |

Step 4 adds the third outcome below. Not yet built: recipes from the local `recipes.yaml` and registry packs (step 6)
and GitHub recipes (waiting on a decision about `@webframp/github`).

## Step 4: raise an issue when nothing can answer

`@webframp/github` (a model definition `github` in `models/@webframp/github/`)
already has `create_issue` with an idempotency key, so no extension of our own
was needed (the plan expected to write one). In live mode only, when the route is
`deterministic` and there is neither a recipe nor a confident allowlisted pick,
the `raise` step calls `create_issue` on `puddle-works/puddleworks-apps` with a
title `Recipe wanted: <first 80 characters>`, a body quoting the turn and what
the search found, and the turn's `sourceRef` as the key. The reply blocks with
the issue link. If `raise` fails, the turn passes. In shadow mode `raise` is
skipped and the reply records `wouldAction: block` ("would raise an issue").

Tested live from `~/dev/swamplab`: "what is the current weather in Utrecht" raised
issue #95 and blocked; sending it again reused #95 (no second issue). #95 was
closed afterwards with `close_issue`. `create_issue` takes no labels, so test
issues are marked by their title rather than a `puddlerouter-test` label.

## Step 6: local config and a wider allowlist

The allowlist is now `@swamp/*`, `@mesgme/*`, `@webframp/*` and `@puddleworks/*`,
and `puddlerouter.yaml` in the runtime repo can add more (`allow:`) and define
local recipes (see the README, "Local config"). Local recipes run before the
built-in ones, are read-only, and take only captures of a declared shape.
Checked live: "open prs in puddle-works/puddlerouter" answered from a local
`@webframp/github` `list_prs` recipe with no Claude call.

### Not done in this step

The plan's registry side of step 6 is deferred:

- recipe packs published to the registry (a public pack needs explicit approval)
- the `puddlerouter-recipes-sync` workflow and `recipeIndex`

A fresh checkout therefore gets the built-in recipes, not registry packs.
(Done in step 6c.)

## Step 6b: caches

Three caches, all kept as this model's own swamp resources (read with
`readResource`, so nothing shells out to `swamp data`). Each entry holds
`cachedAt` and the code checks its age, so reuse does not depend on when swamp
garbage-collects the data.

| Cache | Key | Lifetime | Saves |
|---|---|---|---|
| `routeCache` | `route-v1-<hex of sourceRef>` | 7 days | Jev's route, decide and pick answers |
| `searchCache` | `search-<hash of the query>` | 1 day | `model type search` + `extension search` |
| `resultCache` | `result-<hash of recipe id + captures>` | per recipe `cacheFor`, default none | a recipe's answer |

- **Route cache.** A new `recall` step after `load` reads the entry and always
  writes fixed-shape flags (`hasRoute`, `hasDecision`, `hasPick`, ...). The
  `route`, `decide` and `pick` steps are skipped when their flag is set. `reply`
  merges fresh and recalled answers (fresh wins), stores the merged answers, and
  sets `reply.cached` when any answer came from the cache. The raw choice and
  confidence are stored and the cut-offs apply at use, so changing a cut-off needs
  no flush. Bump `ROUTE_CACHE_VERSION` when the route, decide or pick question
  changes. `match`, `execute` and `raise` always run.
- **Search cache.** Stores the merged result before the allowlist filter, so
  allowlist changes apply at once. Written only when both searches succeeded. A
  newly pulled extension can take up to a day to show.
- **Result cache.** Opt-in per local recipe with `cacheFor: 30s | 5m | 1h`. No
  built-in recipe sets it. Only a successful run is stored.

Checked live in the larvacean-caches worktree (shadow mode, real Jev):

| Turn | Run | Steps | Time | Result |
|---|---|---|---|---|
| "is 7 a prime number?" | first | `route` ran | 2.1 s | route decision at 0.28, below the cut-off, so llm |
| same | repeat | `route` skipped | 1.2 s | same answer, `reply.cached` true |
| "Is the word 'banana' a fruit? Answer yes or no." | first | `route` and `decide` ran | 2.6 s | decision 0.92, yes 0.91, answered yes |
| same | repeat | `route` and `decide` skipped | 1.2 s | same answer, `reply.cached` true |
| "list the hetzner servers" | first | `match` ran both searches | 3.7 s | |
| same | repeat | `match` served from `searchCache` | 1.2 s | |

The 1.2 s floor is swamp starting and the workflow's own steps. The deterministic
route's cached `pick` (route cache seeded, since Jev gave no deterministic turn
here) was not run with real Jev.

## Step 6c: recipe packs, `recipeIndex` and the sync workflow

The first pack is `@puddleworks/puddlerouter-recipes-github` (repo
`puddle-works/puddlerouter-recipes-github`, private, label `puddlerouter-recipe`),
one workflow per recipe. See the README, "Recipe packs", for the format.

### Live checks of step 0 (closes check 4a)

Published the pack as `2026.10.13.1`, then:

| Check | Result |
|---|---|
| `swamp extension search --label puddlerouter-recipe --collective puddleworks --json` | finds the **private** pack (signed in as a puddleworks member); a plain `search puddlerouter-recipe` finds it too |
| `swamp extension pull` in a fresh repo, then compare the tag | the `puddlerouterRecipe` tag, regex included, is identical to the source file |
| `swamp workflow get <pulled workflow> --json` | sees the pulled workflow with its tags, inputs and step (swamp copies it to `workflows/workflow-<id>.yaml`) |
| `swamp extension list --json` | gives each pack's `version` and `files`, including `workflows/*.yaml`, so sync reads the files and spawns no `workflow get` per recipe |

`swamp extension pull` over an installed pack needs `--yes` when stdin is not a
terminal, so `sync` passes it.

### Decisions

- **The tag names the extension.** A step names a model *definition*
  (`github`), not the extension that holds its type, and `behavior run` needs the
  type. The plan took it from the step; it cannot be, so the tag carries
  `extension` (pack `2026.10.13.2`). The step still gives method, definition and
  fixed inputs.
- **`recipeIndex`** (instance `recipe-index`, 7 days) holds the checked raw
  recipes, the packs and versions, the errors and `syncedAt`. `match` and
  `execute` compile it with the same `parseRecipe` as the local file, against
  the current allowlist, so a shrunk allowlist applies at once.
- **Sync throws only when the registry cannot be searched**, so the old index
  stays. Anything wrong with one pack, workflow or recipe is an entry in
  `errors` and the rest still loads.
- A pack name must pass the allowlist like an extension name, so a stranger's
  pack labelled `puddlerouter-recipe` is never pulled.

### Live hook check (2026-10-13)

With the Jev key in this repo's `typesafe` vault, the turn `open prs in
puddle-works/puddlerouter` went through `hooks/puddlerouter.sh` (shadow mode).
The `reply` data: `route` deterministic, `recipe` `github-open-prs`, no pick,
no search, not cached, confidence 0.92, `elapsedMs` 3148, `action` pass
(`wouldAction` block). The reply was readable about 10 s after the hook was
started.

### Setting up the runtime repo

`match` never pulls, so a runtime repo (the one the hook runs in) answers from
packs only after `swamp workflow run @puddleworks/puddlerouter-recipes-sync`
has run in it once. Re-run it by hand when a pack changes, or run
`swamp serve` for the daily `0 6 * * *` schedule. Sync pulls the pack's
extensions, so it dirties the tracked `extensions/models/upstream_extensions.json`
there; `git checkout` it before a `git pull --ff-only`.
