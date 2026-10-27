#!/usr/bin/env bash
# puddlerouter: Claude Code UserPromptSubmit hook.
#
# Hands each typed turn to the `@puddleworks/puddlerouter` swamp workflow. The turn goes in
# a mktemp file and only its path is passed: swamp reads an `--input` value
# starting with `@` as a file, and records every input in its run history.
#
# Both modes wait for the workflow and read its `reply`.
# shadow: Claude always runs and gets no added context. When live mode would
#   block or hint, a systemMessage tells the user what it would do.
# live (default since step 5): acts on the reply:
#   block -> {"decision":"block","reason":text}   (Claude does not run)
#   hint  -> a note with the text                 (Claude runs with it)
#   pass  -> a note of the route and why          (Claude runs as normal)
#   A note goes in a systemMessage and in additionalContext, which asks
#   Claude to start its reply with it: in focus mode the user sees only
#   Claude's reply, not hook messages. Skipped turns get a note too, except
#   empty turns, `!` shell turns and messages from the harness.
#
# Fails open: on any error or timeout it exits 0 and Claude runs as normal
# (live mode says so in a note). It never exits 2.
#
# Settings (environment):
#   PUDDLEROUTER=off         skip every turn
#   PUDDLEROUTER_MODE        live (default) or shadow
#   PUDDLEROUTER_REPO        swamp repo to run in (default ~/dev/puddlerouter)
#   PUDDLEROUTER_TIMEOUT     seconds to wait for swamp (default 15)
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
# A `capture:` prefix is routed: `load` takes it off and the workflow logs
# the turn in Capture without asking Jev.
# These rules look at the typed text only: `<pasted_content>` blocks are left
# out, so a turn that is only a paste is skipped and a long paste doesn't
# count towards the limit. The turn file still holds the whole turn; `load`
# strips the pastes.

set -u
exec 2>/dev/null

[ "${PUDDLEROUTER:-on}" = "off" ] && exit 0

MODE="${PUDDLEROUTER_MODE:-live}"
REPO="${PUDDLEROUTER_REPO:-$HOME/dev/puddlerouter}"
LIMIT="${PUDDLEROUTER_TIMEOUT:-15}"
SWAMP="${PUDDLEROUTER_SWAMP:-swamp}"
MAX_CHARS=2000

case "$MODE" in shadow | live) ;; *) exit 0 ;; esac
command -v jq >/dev/null || exit 0
started=$(jq -n 'now * 1000 | floor') || exit 0
command -v "$SWAMP" >/dev/null || exit 0

# Live mode only: shows the user a note of what the router did, as a
# systemMessage and through Claude's reply.
note() {
  [ "$MODE" = live ] || return 0
  jq -nc --arg note "$1" '{
    hookSpecificOutput: {hookEventName: "UserPromptSubmit",
      additionalContext: ("puddlerouter: the user'"'"'s view does not show hook messages, so start your reply with this note exactly as written, then answer as normal:\n\n"
        + ($note | split("\n") | map(if . == "" then ">" else "> " + . end)
           | join("\n")))},
    systemMessage: $note}'
}

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

# {prompt} to route, {skip: why} for a skipped typed turn, or {} for a turn
# that is skipped without a note.
parsed=$(jq -c --argjson max "$MAX_CHARS" '
  def trim: gsub("^\\s+|\\s+$"; "");
  (.prompt // "") | trim as $p
  | $p
  | gsub("<pasted_content id=\"[^\"]*\">[\\s\\S]*?(</pasted_content id=\"[^\"]*\">|\\z)"; "")
  | trim as $typed
  | if $p == "" or ($typed | test("^(!|<)")) then {}
    elif $typed == "" then {skip: "only a paste"}
    elif ($typed | test("^/")) then {skip: "a /command"}
    elif ($typed | test("^llm:"; "i")) then {skip: "an llm: prefix"}
    elif ($typed | length) > $max then {skip: "over 2,000 characters"}
    else {prompt: $p} end
') || exit 0
skip=$(jq -r '.skip // empty' <<<"$parsed") || exit 0
if [ -n "$skip" ]; then
  note "puddlerouter: not routed ($skip)"
  exit 0
fi
prompt=$(jq -r '.prompt // empty' <<<"$parsed") || exit 0
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

# Exits 0 after a note of why the router has no answer.
fail_open() {
  if [ "$SECONDS" -ge "$deadline" ]; then
    note "puddlerouter: no answer within $LIMIT s, so this went to Claude as normal"
  else
    note "puddlerouter: the workflow failed, so this went to Claude as normal"
  fi
  exit 0
}

swamp_until_deadline "${run_args[@]}" --json || fail_open
run_id=$(jq -r 'select(.status == "succeeded") | .id // empty' "$out") ||
  fail_open
[ -n "$run_id" ] || fail_open

swamp_until_deadline workflow history outputs "$run_id" --repo-dir "$REPO" \
  --json || fail_open

if [ "$MODE" = live ]; then
  result=$(jq -c --argjson started "$started" '
    def secs: (. / 100 | floor) as $d | "\($d / 10 | floor).\($d % 10)";
    (now * 1000 - $started | secs) as $s
    | .reply // {} | (.text // "") as $t | (.reason // "") as $why
    | if .action == "block" and $t != "" then {decision: "block", reason: $t}
      elif .action == "hint" and $t != "" then
        {note: "puddlerouter added this to Claude'"'"'s context (\(if $why == "" then "" else $why + ", " end)\($s) s):\n\n\($t)"}
      else
        {note: "puddlerouter: sent to Claude (\(if $why == "" then "" else $why
          + (if .confidence | type == "number" then " at \(.confidence)" else "" end)
          + ", " end)\($s) s)"}
      end
  ' "$out") || fail_open
  if jq -e 'has("note")' <<<"$result" >/dev/null; then
    note "$(jq -r .note <<<"$result")"
  else
    printf '%s\n' "$result"
  fi
  exit 0
fi

jq -c '
  .reply // {} | (.wouldText // "") as $w
  | ((.reason // "") | sub("^shadow: "; "")) as $why
  | if .wouldAction == "hint" and $w != "" then
      {systemMessage: "puddlerouter (shadow mode) would add this to Claude'"'"'s context:\n\n\($w)"}
    elif .wouldAction == "block" and $w != "" then
      {systemMessage: "puddlerouter (shadow mode) would answer this without Claude:\n\n\($w)"}
    elif .wouldAction == "block" then
      {systemMessage: "puddlerouter (shadow mode) would answer this without Claude (\($why))."}
    else empty end
' "$out"
exit 0
