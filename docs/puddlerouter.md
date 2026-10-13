# puddlerouter: step 0 checks

Step 0 of the plan checks the assumptions the router rests on before any code
is written. Each check says what was found, how it was found, and what it
changes in the design.

| # | Check | Status |
|---|---|---|
| 1 | `UserPromptSubmit` input, output and timeout | Done (Claude Code docs) |
| 2 | Does `workflow run --input` evaluate `${{ }}` / `@file`? | Done (live) |
| 3 | Jev `choice` route accuracy on 30 labelled turns | Pending: needs the Jev key in this repo |
| 4a | Can packaged workflow tags hold a regex? | Done (schema) |
| 4b | Can `extension search` filter by label `puddlerouter-recipe`? | Done (live) |

## 1. The `UserPromptSubmit` hook

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
- **Hook timeout:** set `"timeout": 20`. Swamp's start-up plus two Jev calls has
  to fit inside it; step 1 records the real delay.

## 2. Are workflow inputs evaluated?

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

## 3. Jev route accuracy

**Pending.** It needs `TYPESAFE_API_KEY` in this repo's `typesafe` vault and a
`jev` model instance here.

The labelled set is ready: [`route-eval/turns.yaml`](route-eval/turns.yaml), 30
turns, 10 per route. The run asks Jev the same question the router will ask:

- `state`: the turn text
- `instructions`: "Route this request typed into a coding assistant. deterministic: a program could answer it exactly by calling an API or CLI, with no judgement. decision: it asks for a yes/no judgement about text given in the request. llm: anything else, such as writing, changing or explaining code."
- `criteria`: `deterministic`, `decision`, `llm`, each with the description above

Accuracy is scored at cut-offs 0.5, 0.6, 0.7, 0.8 and 0.9. A turn below the
cut-off counts as `llm`. The cut-off chosen is the lowest one where **no**
`llm` turn is routed elsewhere: a wrong `llm` → `deterministic` or `decision`
costs the user a turn, while a wrong route → `llm` only costs Claude tokens.

**Threshold until the run:** 0.7, as in the plan. The router is in shadow mode
for steps 1 to 4, so the cut-off only decides what is logged.

## 4. Recipe packs in the registry

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

## Repo setup

The repo was created from the template without step 5 of the template README
(`swamp repo init --force --tool claude`). Without it the repo had the
template's `repoId` and no `.claude/settings.local.json`, and Claude Code's
auto-mode classifier refused swamp commands that change the repo
(`workflow create`, `model list`, `repo init` elsewhere). After the user ran
`swamp repo init --force --tool claude`, those commands ran. The new `repoId`,
the refreshed managed section of `CLAUDE.md` and the `vaults/` definitions
(no secrets) are committed with this step.
