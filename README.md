# puddlerouter

`@puddleworks/puddlerouter` checks each turn typed into Claude Code before
Claude spends effort on it. A `UserPromptSubmit` hook hands the turn to a swamp
workflow, and Jev (TypeSafe's System One model) picks a route:

| Route           | Meaning                                                 | What happens (once built)                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deterministic` | A program could answer it exactly through an API or CLI | A recipe from [`@puddleworks/recipes`](#recipes) runs and its answer is shown (git status, log, branch, and your own); otherwise Claude gets a hint naming an extension, or, if none fits, one request is logged in Capture and its link shown (live mode) |
| `decision`      | A yes/no judgement about text in the turn               | Jev answers it (built in step 2)                                                                                                                                                                                 |
| `llm`           | Anything else, or Jev is unsure                         | Claude runs as normal                                                                                                                                                                                            |

**Status: live mode (step 5, 2026-10-26); every route and the recipe packs are
built (steps 2 to 6c).** A yes/no question Jev answers confidently is blocked
and Jev's answer is shown instead, and so is a git status, log or branch
question a recipe answers. A turn that only says a PR
has merged gets a read-only check and the steps to finish as a hint (see
[Merged turns](#merged-turns)). Whatever the router adds or answers is shown
to you. Shadow mode (`PUDDLEROUTER_MODE=shadow`) still works: it never blocks
or adds anything, and only shows what live mode would have done. See
[`docs/puddlerouter.md`](docs/puddlerouter.md) for the plan and the step 0
findings.

## How a turn flows

```
prompt ─▶ hooks/puddlerouter.sh
           skips /commands, ! shell turns, "llm:" prefix, turns starting
           with "<", turns over 2,000 characters, PUDDLEROUTER=off
           (judged on the typed text: pasted blocks don't count)
           writes the turn to a mktemp file; passes only its path
        ─▶ swamp workflow run @puddleworks/puddlerouter --input turnFile=<path>
             load   strip pasted and fenced blocks, cap, hash (sourceRef) → turn;
                    a turn that looks like it holds a secret is stored as a
                    placeholder and never sent to Jev; a leading "capture:"
                    is taken off and marks the turn for Capture (merged,
                    route and decide are skipped)
             recall Jev's earlier route, decision and pick for this exact turn
                    (route cache, 7 days); route, decide and pick are skipped
                    for what it holds
             confirm if the session's last turn showed a recipe's plan: run it
                    when this turn is only a yes and skip the steps below up to
                    reply; drop it otherwise (live mode with a session only)
             merged a turn that only says a PR merged ("merged", "12 is
                    merged"): check its worktree read-only and hint the steps
                    to finish; route, decide and match are skipped
             route  jev.choice over deterministic / decision / llm (cut-off 0.7)
             decide jev.noul, only for a decision turn with nothing pasted,
                    fenced or cut; yes at ≥ 0.8, no at ≤ 0.2, else unsure
             match  deterministic turn: find a recipe (@puddleworks/recipes)
             search no recipe: search extensions; capture: turn: the request
                    draft, with no recipe or search
             pick   jev.choice over up to 3 allowlisted candidates, or none
             execute run the recipe (@puddleworks/recipes), or show its plan if
                    it makes changes
             raise  live mode, nothing can answer or a capture: turn: one Capture
                    request per turn (sourceRef) via @puddleworks/capture-log-request
             reply  {action: block|hint|pass, text} → reply
```

The hook fails open: any error, timeout or missing tool lets Claude run, with
exit 0. An unsure answer, or a failed `decide` step, also lets Claude run.

In live mode every typed turn gets a note of what puddlerouter did. Claude is
asked to start its reply with it, because in focus mode you see only Claude's
reply and not hook messages; it is also the hook's `systemMessage`. For
example:

```
> puddlerouter: sent to Claude (llm route at 0.98, 3.8 s)

> puddlerouter: not routed (an llm: prefix)

> puddlerouter: no answer within 15 s, so this went to Claude as normal

> puddlerouter added this to Claude's context (merged: no worktree at a merged head, 5.8 s):
>
> puddlerouter checked this with swamp before you ran (read-only: nothing was changed):
> - No worktree is at the head of #30, #29 or #28, the latest merged PRs; …
```

Empty turns, `!` shell turns and messages from the harness get no note. A
blocked turn shows the answer in place of Claude's reply (below).

In shadow mode the message starts "puddlerouter (shadow mode) would add this
to Claude's context:" or "… would answer this without Claude:", and nothing is
added or blocked, not even a note. A turn live mode would pass shows nothing.
Shadow mode only uses `systemMessage`, so focus mode hides it. Shadow mode now
waits for the workflow like live mode (1 to 6 seconds, up to
`PUDDLEROUTER_TIMEOUT`); a run that times out is stopped, so it is missing from
the shadow log.

A recipe that makes changes, or whose extension doesn't say it only reads, runs
nothing at first. The turn is blocked and shows what would run, and the next
turn in the same session runs it if it is only a yes (`yes`, `y` or `go`). Any
other turn drops the plan and is routed as usual. A plan over 10 minutes old does
nothing, and the reply says so. Shadow mode shows the plan and never keeps it.

A blocked decision shows, in place of Claude's reply:

```
Jev: no (96% sure).
Answered by puddlerouter without Claude. To ask Claude instead, send the prompt again starting with llm:
```

## Subprocesses

`search` runs `swamp` as a subprocess (`Deno.Command`, no shell), because a model
method has no way to call another model type. Every argument is checked first:

- A search passes at most four words, each matching `[a-z0-9][a-z0-9_-]*` and
  three or more characters, from `searchQuery` in `_lib/search.ts`.
- Only allowlisted extensions are offered as candidates (`@swamp/*`, `@mesgme/*`,
  `@webframp/*`, `@puddleworks/*`, plus whatever `puddlerouter.yaml` adds).

`@puddleworks/recipes` runs recipes the same way; its README says how.

The `merged` step runs no subprocess of its own: it calls `@swamp/git` and
`@webframp/github` through `context.runModel`, with only PR numbers and the
origin repo's `owner/name` as arguments.

## Local config

`<repoDir>/puddlerouter.yaml` (gitignored; copy `puddlerouter.example.yaml`) has
three optional keys. A bad entry or an unreadable file is dropped and logged; the
rest still applies.

- `allow:` extra extension names or `@scope/*` scopes. They add to the defaults.
  `search` and `@puddleworks/recipes` both read this.
- `reads:` methods you know only read, as `"<extension> <method>"`, with no
  wildcards. Recipes that call one answer at once; any other method asks first.
  You are vouching for that method. Only this file can set it: a pack can't.
- `recipes:` your own recipes, tried before those from packs.

`@puddleworks/recipes` reads `reads:` and `recipes:`. Its README describes them.

## Recipes

puddlerouter has no recipes of its own. `match`, `execute` and `confirm` in the
workflow are methods of [`@puddleworks/recipes`](https://swamp-club.com/extensions/@puddleworks/recipes),
which holds the built-in git recipes and reads recipe packs: extensions labelled
`puddlerouter-recipe`, one workflow per recipe. The runtime repo needs an
instance of it named `recipes` (see [Set up](#set-up)). Without one, every turn
still routes, but no recipe can answer.

The first turn of each day (skipped turns included) starts
`@puddleworks/recipes-sync` in the background, which pulls the packs and stores
their recipes as an index. Until that index exists, only the built-in and local
recipes match. It starts as the hook exits, because it holds the lock the turn's
own workflow needs. A repeat sync takes about 9 seconds, and a first one with
packs to pull about 15, so a turn typed straight after may give up at
`PUDDLEROUTER_TIMEOUT` and go to Claude as normal. A sync that fails waits for the
next day; to run it by hand:

```sh
swamp workflow run @puddleworks/recipes-sync
```

## Merged turns

A turn that is only "merged", "N is merged", "merged #N", "N and M merged" (up
to five numbers), optionally followed by "clean up the worktree(s)", is answered
by the `merged` step without Jev. It reads, and changes nothing:

1. `remote.origin.url` in the session's directory, for the GitHub repo.
2. The repo's worktrees (`worktree_list`, which this extension adds to
   `@swamp/git`).
3. Each PR (`@webframp/github` `get_pull_request_context`). A bare "merged"
   checks the three most recently updated merged PRs and reports the ones a
   worktree is at.
4. For a merged PR whose head SHA is checked out in a worktree: that worktree's
   `git status`.

Each PR gets one verdict:

| Verdict          | Meaning                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `clean`          | A worktree is at the PR's head with no uncommitted changes: safe to remove |
| `dirty`          | A worktree is at the head but has uncommitted or untracked files           |
| `locked`         | The worktree is locked (`git worktree lock`)                               |
| `primary`        | The main checkout is at the head; it is switched to main, not removed      |
| `ahead`          | A worktree has commits after the PR's head: removing it would orphan them  |
| `absent`         | No worktree is at the head; it may be cleaned up already                   |
| `open`, `closed` | The PR is not merged                                                       |
| `error`          | The PR could not be looked up                                              |

Only `clean` and `primary` give steps ("Remove the worktree …", "Switch … to
main and pull", "Delete the branch …, locally and on origin", "Pull main in …").
The answer goes to Claude as a hint (`additionalContext`), so Claude does the
steps; the hook never blocks these turns, in shadow or live mode. A PR's title
is shown only once it is merged, cut to 60 characters. The check takes 1 to 4
seconds.

Known gaps: ignored files in a worktree are not seen, `origin/main` is as fresh
as the last fetch, and the steps suggest deleting the remote branch even if
GitHub already did.

puddlerouter will not do these steps itself. The cleanup becomes its own
request in Capture and its own extension, and a write recipe will call it. See
`docs/puddlerouter.md` ("Where write recipes go").


## Caches

A repeated turn makes no Jev call and no search subprocess:

- **Route cache** (7 days, by the turn's `sourceRef`): Jev's route, decision and
  pick. `reply.cached` is true when any answer came from it. If the route,
  decide or pick question changes, bump `ROUTE_CACHE_VERSION` in
  `extensions/models/puddlerouter.ts`.
- **Search cache** (1 day, by query): what `model type search` and `extension
  search` found. A newly pulled extension may not show for up to a day.
- **Result cache** (opt-in): a recipe with `cacheFor: 30s`, `5m` or `1h` reuses
  its last successful answer for that long, kept by `@puddleworks/recipes`.

## Capture requests

In live mode, a deterministic turn that no recipe or allowlisted extension can
answer logs one request in [Capture](https://github.com/puddle-works/puddleworks-capture)
("Recipe wanted: …", with the cleaned turn text and what search found), and
the hook shows its link instead of running Claude. Those requests are the
recipe backlog: they are discussed and agreed in Capture, then built. The
`raise` step runs `@puddleworks/capture-log-request` from the swamp extension
[`@puddleworks/capture`](https://github.com/puddle-works/puddleworks-capture),
which passes the turn's `sourceRef` as the idempotency key, so sending the same
turn again gives the same request. The request is logged in the repo the hook
runs puddlerouter in (`PUDDLEROUTER_REPO`), not necessarily this one: Capture's
people and requests are that repo's swamp data, in its `capture` instance,
which acts as Intake Bot (`intake-bot@example.com`, its `defaultAs`). That repo
can be a separate desk that holds only released extensions (see
[Run in a separate desk](#run-in-a-separate-desk)). There is no key. To read
them, run `swamp behavior run viewer serve --input port=3002` in that repo and
open http://127.0.0.1:3002. The link is `captureUrl` (default
`http://127.0.0.1:3002`) plus `/requests/<id>`; keep it the same as the
instance's `appUrl`. If logging fails, the turn passes to Claude ("no request
logged").
Shadow mode never logs a request; `wouldAction` records that it would.

To log a request yourself, start the turn with `capture:` (any case), for
example `capture: a recipe that lists my open PRs across repos`. Jev, the
merged check and the recipe search are skipped; the request's title is the
turn's first 80 characters (without the prefix) and its description is the
cleaned turn. The hook shows the link instead of running Claude. If logging
fails, Claude gets a hint to tell you it was not logged and not to act on the
turn. An empty `capture:` turn, or one that looks like it holds a secret, is
not logged. Pasted blocks are left out of the request, as for every turn.

`@webframp/github` is still used, read-only, by the `merged` step, and by the
key check to raise its issue. It runs `gh` with your logged-in `gh auth` (no
token in the vault) and is pulled by this repo only, not by the allowlist.

## Key check

When Jev's key expires, every route step fails with HTTP 401 and the hook
fails open, so routing stops without any sign. The first turn of each day
(skipped turns included) starts `@puddleworks/puddlerouter-key-check` in the
background. It asks Jev a small routing question (the same `choice` call a
route step makes), and if that fails it raises one issue
("Jev's API key check failed") in `puddle-works/puddlerouter`. The issue is
de-duplicated per outage: its key counts the checks that have passed, so a
new one is raised only after the key has worked again. The workflow's daily
`0 8 * * *` schedule only fires under `swamp serve`. To check by hand:

```sh
swamp workflow run @puddleworks/puddlerouter-key-check
```

## Set up

The runtime repo is the clone at `~/dev/puddlerouter`.

```sh
cd ~/dev/puddlerouter
swamp extension install                          # @swamp/typesafe-ai, pinned
swamp vault put typesafe TYPESAFE_API_KEY        # the Jev key
swamp workflow run @puddleworks/recipes-sync     # first index of recipe packs
make test
```

This repo already holds the `recipes` instance the workflow needs.

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
`PUDDLEROUTER_MODE=live|shadow` (default `live`); `PUDDLEROUTER_REPO`, the swamp
repo puddlerouter runs in and logs Capture requests in (default
`~/dev/puddlerouter`); `PUDDLEROUTER_TIMEOUT` seconds to wait for swamp
(default 15); `PUDDLEROUTER_KEY_CHECK=off` skips the daily key check and
`PUDDLEROUTER_RECIPES_SYNC=off` the daily recipes sync, whose day stamps are kept
in `PUDDLEROUTER_STATE` (default `~/.local/state/puddlerouter`).
Start a turn with `llm:` to skip the router for that turn, or with `capture:`
to log it straight in Capture without asking Jev (see
[Capture requests](#capture-requests)).

### Run in a separate desk

puddlerouter can run in a swamp repo of its own, such as a desk that only runs
Capture, using the released extensions from the registry and no local sources.
Its turns and Capture requests are then that repo's data. The hook script is
not in the extension, so keep this clone for `hooks/puddlerouter.sh`.

```sh
mkdir ~/dev/puddleworks-desk && cd ~/dev/puddleworks-desk
swamp repo init .
swamp extension pull @puddleworks/recipes --channel beta   # on the beta channel for now
swamp extension pull @puddleworks/puddlerouter   # also pulls @puddleworks/capture, @swamp/git, @webframp/github
swamp extension pull @swamp/typesafe-ai          # Jev
swamp vault create local_encryption typesafe
swamp vault put typesafe TYPESAFE_API_KEY        # the Jev key (prompts)

swamp behavior create @puddleworks/puddlerouter puddlerouter
swamp behavior create @swamp/typesafe-ai jev \
  --global-arg 'apiKey=${{ vault.get("typesafe", "TYPESAFE_API_KEY") }}' \
  --global-arg baseUrl=https://opencode.ai/zen --global-arg model=jev-1.13
swamp behavior create @swamp/git git
swamp behavior create @webframp/github github
swamp behavior create @puddleworks/capture/requests capture \
  --global-arg appUrl=http://127.0.0.1:3002 \
  --global-arg defaultAs=intake-bot@example.com
swamp behavior create @puddleworks/capture/web viewer
swamp behavior create @puddleworks/recipes recipes
swamp behavior run capture add_person \
  --input email=intake-bot@example.com --input 'name=Intake Bot'

cp ~/dev/puddlerouter/puddlerouter.example.yaml puddlerouter.yaml
echo /puddlerouter.yaml >> .gitignore
swamp workflow run @puddleworks/recipes-sync     # first index of recipe packs
```

To bring over requests already logged in another repo, run
`swamp behavior run capture export_snapshot --input path=capture-snapshot.json`
there, copy the file into the desk and run
`swamp behavior run capture import --input path=capture-snapshot.json`. Import
adds the people too, so `add_person` is then not needed, and it only adds what
is missing, so it is safe to run again. The file holds people's emails: delete
it afterwards.

Then point the hook at the desk, keeping the script path:

```json
"command": "PUDDLEROUTER_REPO=\"$HOME/dev/puddleworks-desk\" bash \"$HOME/dev/puddlerouter/hooks/puddlerouter.sh\""
```

To check it, send a turn starting with `capture:`. It skips Jev, so it shows
whether logging works on its own: the reply is "Logged a request in Capture:
http://127.0.0.1:3002/requests/…". With the desk's
`swamp behavior run viewer serve --input port=3002` running, the link opens
the request. "… but it was not logged" usually means Intake Bot is not in the
people list (`add_person` above).

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
make publish VISIBILITY=public DRY_RUN=1    # stops after the dry run
```
