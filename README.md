# puddlerouter

`@puddleworks/puddlerouter` checks each turn typed into Claude Code before
Claude spends effort on it. A `UserPromptSubmit` hook hands the turn to a swamp
workflow, and Jev (TypeSafe's System One model) picks a route:

| Route           | Meaning                                                 | What happens (once built)                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deterministic` | A program could answer it exactly through an API or CLI | A built-in recipe runs and its answer is shown (`@swamp/git` status, log, branch); otherwise Claude gets a hint naming an extension, or, if none fits, one GitHub issue is raised and its link shown (live mode) |
| `decision`      | A yes/no judgement about text in the turn               | Jev answers it (built in step 2)                                                                                                                                                                                 |
| `llm`           | Anything else, or Jev is unsure                         | Claude runs as normal                                                                                                                                                                                            |

**Status: shadow mode, decision and deterministic routes built (steps 2 and
3).** The hook logs what live mode would do and never blocks: Claude always
runs. In live mode (`PUDDLEROUTER_MODE=live`) a yes/no question Jev answers
confidently is blocked and Jev's answer is shown instead, and so is a git
status, log or branch question a recipe answers. Shadow mode stays the default
until step 5, after a week of shadow data. See
[`docs/puddlerouter.md`](docs/puddlerouter.md) for the plan and the step 0
findings.

## How a turn flows

```
prompt ─▶ hooks/puddlerouter.sh
           skips /commands, ! shell turns, "llm:" prefix, turns starting
           with "<", turns over 2,000 characters, PUDDLEROUTER=off
           writes the turn to a mktemp file; passes only its path
        ─▶ swamp workflow run @puddleworks/puddlerouter --input turnFile=<path>
             load   strip pasted and fenced blocks, cap, hash (sourceRef) → turn;
                    a turn that looks like it holds a secret is stored as a
                    placeholder and never sent to Jev
             route  jev.choice over deterministic / decision / llm (cut-off 0.7)
             decide jev.noul, only for a decision turn with nothing pasted,
                    fenced or cut; yes at ≥ 0.8, no at ≤ 0.2, else unsure
             match  deterministic turn: a built-in recipe, else search extensions
             pick   jev.choice over up to 3 allowlisted candidates, or none
             execute run the recipe through swamp (@swamp/git), read-only
             raise  live mode, nothing can answer: one issue per turn (sourceRef)
                    in puddle-works/puddleworks-apps via @webframp/github
             reply  {action: block|hint|pass, text} → reply
```

The hook fails open: any error, timeout or missing tool lets Claude run, with no
output and exit 0. An unsure answer, or a failed `decide` step, also lets Claude
run.

A blocked decision shows, in place of Claude's reply:

```
Jev: no (96% sure).
Answered by puddlerouter without Claude. To ask Claude instead, send the prompt again starting with llm:
```

## Subprocesses

`match` and `execute` run `swamp` as a subprocess (`Deno.Command`, no shell),
because a model method has no way to call another model type. Every argument is
checked first:

- A recipe's arguments are fixed words, the runtime repo path and its captured
  inputs. The pattern captures digits only, and they go in as
  `--input k=v --literal-inputs`.
- A search passes at most four words, each matching `[a-z0-9][a-z0-9_-]*` and
  three or more characters, from `searchQuery` in `_lib/recipes.ts`.
- Only allowlisted extensions are pulled or run (`@swamp/*`, `@mesgme/*`,
  `@webframp/*`, `@puddleworks/*`, plus whatever `puddlerouter.yaml` adds), and
  only recipes marked read-only.

## Local config

`<repoDir>/puddlerouter.yaml` (gitignored; copy `puddlerouter.example.yaml`) is
read on every `match` and `execute`. It has two optional keys:

- `allow:` extra extension names or `@scope/*` scopes. They add to the defaults.
- `recipes:` local recipes, tried before the built-in ones. Fields: `id`,
  `extension`, `method`, `definition`, `dataName`, `pattern` (must match the
  whole turn), `readOnly` (only `true`), `inputs` (`name: {capture: 1..9, as:
  int|repo|word}`), `fixed`, `each {path, line}`, `template` (`{count}`,
  `{lines}` and any attribute path) and `empty`. `dataName` may use `{input}`
  placeholders when the method names its data per input.

A captured piece must fit its declared shape before it becomes a method input
(run with `--literal-inputs`). A bad entry, an unreadable file or a recipe for
an extension that is not allowed is dropped and logged; the rest still applies.

## Issues

In live mode, a deterministic turn that no recipe or allowlisted extension can
answer raises one GitHub issue ("Recipe wanted: …", with the cleaned turn text)
in `puddle-works/puddleworks-apps`, and the hook shows its link instead of
running Claude. `@webframp/github`'s `create_issue` de-duplicates on the turn's
`sourceRef`, so sending the same turn again reuses the issue. It runs `gh` with
your logged-in `gh auth` (no token in the vault) and is the only third-party
extension used: it is not pulled by the allowlist, only by this repo. Shadow
mode never raises an issue; `wouldAction` records that it would.

## Set up

The runtime repo is the clone at `~/dev/puddlerouter`.

```sh
cd ~/dev/puddlerouter
swamp extension install                          # @swamp/typesafe-ai, pinned
swamp vault put typesafe TYPESAFE_API_KEY        # the Jev key
make test
```

Then add the hook to `~/.claude/settings.json` under `hooks.UserPromptSubmit`:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "bash \"$HOME/dev/puddlerouter/hooks/puddlerouter.sh\"",
      "timeout": 20
    }
  ]
}
```

Hook settings (environment): `PUDDLEROUTER=off` skips every turn;
`PUDDLEROUTER_MODE=shadow|live` (default `shadow`); `PUDDLEROUTER_REPO` (default
`~/dev/puddlerouter`); `PUDDLEROUTER_TIMEOUT` seconds for live mode (default
15). Start a turn with `llm:` to skip the router for that turn.

## Read the shadow log

Every routed turn is a run of `@puddleworks/puddlerouter`, with a `turn` and a
`reply` resource kept for 14 days. Turns logged before the rename are runs of
`@mesgme/puddlerouter`; the first query includes both names.

```sh
# Each turn: when, text, route, Jev's choice and confidence, the decision
# answer, what live mode would do, delay in ms
swamp data query 'modelName == "puddlerouter" && version >= 0 && workflowName in ["@puddleworks/puddlerouter", "@mesgme/puddlerouter"]' --json \
  | jq -c '[.results[] | {run: .workflowRunId, name, content}] | group_by(.run)[]
      | (map({(.name): .content}) | add) as $d | select($d.reply)
      | {at: $d.reply.repliedAt, text: $d.turn.text, route: $d.reply.route,
         choice: $d.reply.choice, confidence: $d.reply.confidence,
         answer: $d.reply.answer, yes: $d.reply.yes, would: $d.reply.wouldAction,
         ms: $d.reply.elapsedMs}'

# Totals: turns per route and per live action, median and 95th percentile delay
swamp data query 'modelName == "puddlerouter" && name == "reply" && version >= 0' --select content --json \
  | jq -c '[.results[] | .content // .] | {turns: length,
      routes: (group_by(.route) | map({(.[0].route): length}) | add),
      would: (map(.wouldAction // "pass") | group_by(.) | map({(.[0]): length}) | add),
      ms: ([.[].elapsedMs | numbers] | sort
           | {median: .[length/2|floor], p95: .[(length*0.95)|floor]})}'
```

`elapsedMs` runs from the hook starting to the reply being stored. In live mode
the hook then reads the reply, which adds about 1.2 s.

## Develop

```sh
make test                                   # extension and hook tests
make contracts-check
make guardrails-check
make publish VISIBILITY=private DRY_RUN=1   # stops after the dry run
```
