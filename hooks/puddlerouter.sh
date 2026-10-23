#!/usr/bin/env bash
# puddlerouter: Claude Code UserPromptSubmit hook.
#
# Hands each typed turn to the `@puddleworks/puddlerouter` swamp workflow. The turn goes in
# a mktemp file and only its path is passed: swamp reads an `--input` value
# starting with `@` as a file, and records every input in its run history.
#
# shadow (default): starts the workflow in the background and exits at once.
#   Claude always runs; the run is a log of the route Jev would take.
# live: waits for the workflow and acts on its `reply`:
#   block -> {"decision":"block","reason":text}   (Claude does not run)
#   hint  -> additionalContext text                (Claude runs with it)
#   pass  -> nothing
#
# Fails open: on any error or timeout it exits 0 with no output, so Claude
# runs as normal. It never exits 2.
#
# Settings (environment):
#   PUDDLEROUTER=off         skip every turn
#   PUDDLEROUTER_MODE        shadow (default) or live
#   PUDDLEROUTER_REPO        swamp repo to run in (default ~/dev/puddlerouter)
#   PUDDLEROUTER_TIMEOUT     live mode: seconds to wait for swamp (default 15)
#   PUDDLEROUTER_SWAMP       swamp binary (default swamp; tests use a fake)
#   PUDDLEROUTER_KEY_CHECK=off  skip the daily key check
#   PUDDLEROUTER_STATE       where the key check's day stamp is kept
#                            (default ~/.local/state/puddlerouter)
#
# Key check: the first turn of each day, skipped or not, also starts the
# `@puddleworks/puddlerouter-key-check` workflow in the background. It raises
# an issue when Jev's key stops working, which this hook would otherwise
# hide by failing open.
#
# Not routed (swamp is called for the key check only): empty turns,
# /commands, `!` shell turns, an `llm:` prefix, turns starting with `<`
# (messages from the harness, such as background task reports), and turns
# over 2,000 characters after trimming.
# These rules look at the typed text only: `<pasted_content>` blocks are left
# out, so a turn that is only a paste is skipped and a long paste doesn't
# count towards the limit. The turn file still holds the whole turn; `load`
# strips the pastes.

set -u
exec 2>/dev/null

[ "${PUDDLEROUTER:-on}" = "off" ] && exit 0

MODE="${PUDDLEROUTER_MODE:-shadow}"
REPO="${PUDDLEROUTER_REPO:-$HOME/dev/puddlerouter}"
LIMIT="${PUDDLEROUTER_TIMEOUT:-15}"
SWAMP="${PUDDLEROUTER_SWAMP:-swamp}"
MAX_CHARS=2000

case "$MODE" in shadow | live) ;; *) exit 0 ;; esac
command -v jq >/dev/null || exit 0
started=$(jq -n 'now * 1000 | floor') || exit 0
command -v "$SWAMP" >/dev/null || exit 0

if [ "${PUDDLEROUTER_KEY_CHECK:-on}" != off ]; then
  state="${PUDDLEROUTER_STATE:-$HOME/.local/state/puddlerouter}"
  stamp="$state/key-check-day"
  today=$(date +%F)
  if [ "$(cat "$stamp" 2>/dev/null)" != "$today" ] &&
    mkdir -p "$state" && printf '%s\n' "$today" > "$stamp"; then
    "$SWAMP" workflow run @puddleworks/puddlerouter-key-check \
      --repo-dir "$REPO" </dev/null >/dev/null 2>&1 &
  fi
fi

# The trimmed prompt, or nothing if this turn is skipped.
prompt=$(jq -r --argjson max "$MAX_CHARS" '
  def trim: gsub("^\\s+|\\s+$"; "");
  (.prompt // "") | trim as $p
  | $p
  | gsub("<pasted_content id=\"[^\"]*\">[\\s\\S]*?(</pasted_content id=\"[^\"]*\">|\\z)"; "")
  | trim as $typed
  | if $typed == "" or ($typed | length) > $max
      or ($typed | test("^(/|!|<)"))
      or ($typed | test("^llm:"; "i"))
    then empty else $p end
') || exit 0
[ -n "$prompt" ] || exit 0

turn=$(mktemp "${TMPDIR:-/tmp}/puddlerouter-turn.XXXXXX") || exit 0
case "$turn" in
  /*) ;;
  *) rm -f "$turn"; exit 0 ;;
esac
printf '%s' "$prompt" > "$turn" || { rm -f "$turn"; exit 0; }

run_args=(workflow run @puddleworks/puddlerouter --repo-dir "$REPO"
  --input "turnFile=$turn" --input "mode=$MODE"
  --input "hookStartedAt=$started" --input "repoDir=$REPO")

if [ "$MODE" = shadow ]; then
  (
    "$SWAMP" "${run_args[@]}"
    rm -f "$turn"
  ) </dev/null >/dev/null 2>&1 &
  exit 0
fi

out=$(mktemp "${TMPDIR:-/tmp}/puddlerouter-run.XXXXXX") || { rm -f "$turn"; exit 0; }
trap 'rm -f "$turn" "$out"' EXIT
deadline=$((SECONDS + LIMIT))

# Runs swamp with its output in $out; gives up at the deadline.
swamp_until_deadline() {
  local left=$((deadline - SECONDS)) pid watch status
  [ "$left" -gt 0 ] || return 1
  "$SWAMP" "$@" > "$out" </dev/null &
  pid=$!
  ( sleep "$left"; kill "$pid" ) </dev/null >/dev/null 2>&1 &
  watch=$!
  wait "$pid"
  status=$?
  kill "$watch" 2>/dev/null
  return "$status"
}

swamp_until_deadline "${run_args[@]}" --json || exit 0
run_id=$(jq -r 'select(.status == "succeeded") | .id // empty' "$out") || exit 0
[ -n "$run_id" ] || exit 0

swamp_until_deadline workflow history outputs "$run_id" --repo-dir "$REPO" \
  --json || exit 0
jq -c '
  .reply // {} | (.text // "") as $t
  | if .action == "block" and $t != "" then {decision: "block", reason: $t}
    elif .action == "hint" and $t != "" then
      {hookSpecificOutput: {hookEventName: "UserPromptSubmit",
                            additionalContext: $t}}
    else empty end
' "$out"
exit 0
