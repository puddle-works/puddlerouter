# puddlerouter

`@puddleworks/puddlerouter` checks each turn typed into Claude Code before Claude
spends effort on it. A `UserPromptSubmit` hook hands the turn to a swamp
workflow, and Jev (TypeSafe's System One model) picks a route:

| Route | Meaning | What happens (once built) |
|---|---|---|
| `deterministic` | A program could answer it exactly through an API or CLI | A swamp extension runs and its answer is shown |
| `decision` | A yes/no judgement about text in the turn | Jev answers it (built in step 2) |
| `llm` | Anything else, or Jev is unsure | Claude runs as normal |

**Status: shadow mode, decision route built (step 2).** The hook logs what
live mode would do and never blocks: Claude always runs. In live mode
(`PUDDLEROUTER_MODE=live`) a yes/no question Jev answers confidently is
blocked and Jev's answer is shown instead. Shadow mode stays the default until
step 5, after a week of shadow data. See [`docs/puddlerouter.md`](docs/puddlerouter.md) for the plan
and the step 0 findings.

## How a turn flows

```
prompt ─▶ hooks/puddlerouter.sh
           skips /commands, ! shell turns, "llm:" prefix, turns starting
           with "<", turns over 2,000 characters, PUDDLEROUTER=off
           writes the turn to a mktemp file; passes only its path
        ─▶ swamp workflow run @puddleworks/puddlerouter --input turnFile=<path>
             load   strip pasted and fenced blocks, cap, hash (sourceRef) → turn
             route  jev.choice over deterministic / decision / llm (cut-off 0.7)
             decide jev.noul, only for a decision turn with nothing pasted,
                    fenced or cut; yes at ≥ 0.8, no at ≤ 0.2, else unsure
             reply  {action: block|hint|pass, text} → reply
```

The hook fails open: any error, timeout or missing tool lets Claude run, with
no output and exit 0. An unsure answer, or a failed `decide` step, also lets
Claude run.

A blocked decision shows, in place of Claude's reply:

```
Jev: no (96% sure).
Answered by puddlerouter without Claude. To ask Claude instead, send the prompt again starting with llm:
```

## Set up

The runtime repo is the clone at `~/dev/puddlerouter`.

```sh
cd ~/dev/puddlerouter
swamp extension install                          # @swamp/typesafe-ai, pinned
swamp vault put typesafe TYPESAFE_API_KEY        # the Jev key
make test
```

Then add the hook to `~/.claude/settings.json` under
`hooks.UserPromptSubmit`:

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
`PUDDLEROUTER_MODE=shadow|live` (default `shadow`);
`PUDDLEROUTER_REPO` (default `~/dev/puddlerouter`);
`PUDDLEROUTER_TIMEOUT` seconds for live mode (default 15). Start a turn with
`llm:` to skip the router for that turn.

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

`elapsedMs` runs from the hook starting to the reply being stored. In live
mode the hook then reads the reply, which adds about 1.2 s.

## Develop

```sh
make test                                   # extension and hook tests
make contracts-check
make guardrails-check
make publish VISIBILITY=private DRY_RUN=1   # stops after the dry run
```
