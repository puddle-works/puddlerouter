# puddlerouter: findings by step

- [Step 0: checks](#step-0-checks)
- [Step 1: shadow mode](#step-1-shadow-mode)

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
the `@mesgme/puddlerouter` workflow (load → route → reply) and
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
  `@mesgme/puddlerouter`, not `puddlerouter`.
- **Fail open.** The route step has `allowFailure`, and `reply` runs whether
  or not Jev answered (`dependsOn … condition: always`); a skipped or failed
  route is recorded as `llm` with reason `no route answer`. `steps.route` is
  absent when the step was skipped, so the reply inputs test
  `has(steps.route) && has(steps.route.outputs)` first.
- **Same question as the eval.** `tests/workflows_test.ts` fails if the route
  instructions or criteria differ from `puddlerouter-route-eval`.

### Publishing

`make publish VISIBILITY=private DRY_RUN=1` passes the tests, `deno check`,
formatting and quality (85%; the missing 15% is a verified public
repository), then stops at the dry-run push: the `@mesgme` collective is on
swamp's Free plan, which cannot publish privately. The router does not need
publishing to run (the runtime repo is a clone of this one). The CI publish job
also fails because the repo has no `SWAMP_API_KEY` / `SWAMP_SIGNIN_TOKEN`
secrets.

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
