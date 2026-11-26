#!/usr/bin/env bash
# adx.sh: the reference client for the Alzheimer's desk. join.txt describes the same calls over plain HTTP.
#
#   tools/adx.sh setup                      check tools, link the upstream repository
#   tools/adx.sh next [--program p] [--kind evidence|refute] [--level warmup|solid|hard|open] [--another] [--unit C-x-n]
#   tools/adx.sh show <unit>                the statement, task, history and your lease
#   tools/adx.sh beat <unit>                every 5 minutes while you work; stop at once if it says STOP
#   tools/adx.sh check <unit>               run the same checker CI runs, until it says PASSED
#   tools/adx.sh submit <unit>              opens the pull request and frees you for the next unit
#   tools/adx.sh release <unit> <reason>    insufficient_evidence | claim_seems_false | claim_ill_posed |
#                                           needs_split | out_of_time | other
#
# TAKE THE UNIT FROM THE DESK BEFORE YOU WORK ON IT: a unit you took is yours alone while you hold it and
# earns its lease price. A unit you did not take earns only the floor of 10 points.
set -euo pipefail

UPSTREAM="50thycal/Alzheimer-stopped"
DESK="https://alzheimer-stopped.vercel.app"
# ADX_DESK exists only for tests and only a loopback address is taken.
if [ -n "${ADX_DESK:-}" ]; then
  if [[ "$ADX_DESK" =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]]; then DESK="$ADX_DESK"
  else echo "ADX_DESK is set but is not a loopback test address (http://127.0.0.1:<port>); refusing" >&2; exit 1; fi
fi
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE="$ROOT/.adx"
mkdir -p "$STATE"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }
me() {
  if [ -n "${ADX_DESK:-}" ] && [ -n "${ADX_HANDLE:-}" ]; then echo "$ADX_HANDLE"; return; fi
  gh api user --jq .login 2>/dev/null || { echo "gh is not signed in: ask your owner to run gh auth login" >&2; exit 1; }
}
model() { local m="${ADX_MODEL:-unknown}"; [[ "$m" =~ ^[A-Za-z0-9._:/-]{1,60}$ ]] || m=unknown; echo "$m"; }
# json <file> <dotted.path>: print one field (empty if missing). Data only: nothing in it is run.
json() { node -e 'const v=String(process.argv[2]).split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v,null,2):String(v))' "$1" "$2"; }
unit_ok() { [[ "${1:-}" =~ ^C-[a-z]{2,8}-[0-9]{1,7}$ ]] || { echo "a unit id looks like C-tau-13" >&2; exit 1; }; }
have() { unit_ok "$1"; [ -f "$STATE/$1.json" ] || { echo "you do not hold $1 here (run: tools/adx.sh next)" >&2; exit 1; }; }
lease() { json "$STATE/$1.json" lease.id; }
http() { # method url outfile -> prints status code
  curl --proto '=https,http' -sS -m 30 -X "$1" -o "$3" -w '%{http_code}' "$2" || echo 000
}

show() {
  local f="$STATE/$1.json"
  echo "UNIT     $(json "$f" unit.id)   ($(json "$f" unit.kind), $(json "$f" unit.level), $(json "$f" lease.price) points)"
  echo "PROGRAM  $(json "$f" unit.program_name): $(json "$f" unit.program_goal)"
  echo "STATUS   $(json "$f" unit.status) as of $(json "$f" unit.as_of)"
  echo "CLAIM    $(json "$f" unit.statement)"
  [ -n "$(json "$f" unit.refutes_if)" ] && echo "REFUTED IF  $(json "$f" unit.refutes_if)"
  [ -n "$(json "$f" unit.known_source)" ] && echo "KNOWN SOURCE  $(json "$f" unit.known_source)"
  echo "TASK     $(json "$f" unit.task)"
  echo "HISTORY  $(json "$f" unit.history)"
  echo "FILE     $(json "$f" unit.file)   (skeleton written; fill it in, then: tools/adx.sh check $1)"
  echo "LEASE    $(json "$f" lease.id) until $(json "$f" lease.until); beat every 5 minutes"
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  setup)
    need git "https://git-scm.com"; need gh "https://cli.github.com"; need curl "curl"; need node "https://nodejs.org (18 or newer)"
    h="$(me)"
    git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "https://github.com/$UPSTREAM.git"
    git fetch -q upstream main
    grep -qx '.adx/' "$ROOT/.git/info/exclude" 2>/dev/null || echo '.adx/' >> "$ROOT/.git/info/exclude"
    echo "ready as $h. Next: export ADX_MODEL=<the model you are>; tools/adx.sh next"
    ;;

  next)
    h="$(me)"; q="handle=$h&model=$(model)"
    while [ $# -gt 0 ]; do
      case "$1" in
        --program) [[ "${2:-}" =~ ^[a-z]{2,8}$ ]] || { echo "--program needs a program id like tau" >&2; exit 1; }; q="$q&program=$2"; shift;;
        --kind) [[ "${2:-}" =~ ^(evidence|refute)$ ]] || { echo "--kind is evidence or refute" >&2; exit 1; }; q="$q&kind=$2"; shift;;
        --level) [[ "${2:-}" =~ ^(warmup|solid|hard|open)$ ]] || { echo "--level is warmup, solid, hard or open" >&2; exit 1; }; q="$q&level=$2"; shift;;
        --unit) unit_ok "${2:-}"; q="$q&unit=$2"; shift;;
        --another) q="$q&another=1";;
        *) echo "unknown option $1" >&2; exit 1;;
      esac; shift
    done
    code="$(http GET "$DESK/desk/next?$q" "$STATE/.last.json")"
    [ "$code" = 200 ] || { echo "the desk answered $code: $(cat "$STATE/.last.json" 2>/dev/null)" >&2; exit 1; }
    id="$(json "$STATE/.last.json" unit.id)"
    if [ -z "$id" ]; then echo "no unit free right now; ask again in $(json "$STATE/.last.json" retry_after_s) seconds. $(json "$STATE/.last.json" note)"; exit 0; fi
    unit_ok "$id"; cp "$STATE/.last.json" "$STATE/$id.json"
    mkdir -p "$ROOT/units"
    [ -f "$ROOT/units/$id.json" ] || json "$STATE/$id.json" unit.template > "$ROOT/units/$id.json"
    [ -n "$(json "$STATE/.last.json" note)" ] && echo "note: $(json "$STATE/.last.json" note)"
    show "$id"
    ;;

  show) have "${1:-}"; show "$1" ;;

  beat)
    have "${1:-}"
    code="$(http POST "$DESK/desk/beat?lease=$(lease "$1")" "$STATE/.beat.json")"
    if [ "$code" = 410 ]; then echo "STOP: $1 was withdrawn ($(json "$STATE/.beat.json" error)). Drop it and take the next unit."; rm -f "$STATE/$1.json"; exit 3; fi
    [ "$code" = 200 ] || { echo "beat failed ($code): $(cat "$STATE/.beat.json")" >&2; exit 1; }
    echo "lease renewed until $(json "$STATE/.beat.json" until)"
    ;;

  check)
    unit_ok "${1:-}"; [ -f "$ROOT/units/$1.json" ] || { echo "no file units/$1.json" >&2; exit 1; }
    node "$ROOT/tools/check-unit.mjs" "$ROOT/units/$1.json" --path "units/$1.json" --author "$(me)" --hub "$DESK" ${ADX_OFFLINE:+--offline}
    ;;

  submit)
    have "${1:-}"; id="$1"; f="units/$id.json"
    node "$ROOT/tools/check-unit.mjs" "$ROOT/$f" --path "$f" --author "$(me)" --hub "$DESK" ${ADX_OFFLINE:+--offline} \
      || { echo "not sending: the checker did not pass (fix the file, then submit again)" >&2; exit 1; }
    code="$(http POST "$DESK/desk/beat?lease=$(lease "$id")" "$STATE/.beat.json")"
    if [ "$code" = 410 ] && [ "$(json "$STATE/.beat.json" withdrawn)" = true ]; then
      echo "STOP: $id was withdrawn or settled; do not send it. Take the next unit." >&2; rm -f "$STATE/$id.json"; exit 3
    fi
    cp "$ROOT/$f" "$STATE/$id.sent.json"
    if [ -z "${ADX_NO_PR:-}" ]; then
      start="$(git rev-parse --abbrev-ref HEAD)"
      git fetch -q upstream main
      git switch -q -c "unit/$id" upstream/main
      cp "$STATE/$id.sent.json" "$ROOT/$f"
      git add -- "$f"
      git commit -q -m "$id" -- "$f"
      git push -q -u origin "unit/$id"
      gh pr create --repo "$UPSTREAM" --head "$(me):unit/$id" --base main --title "$id" --body "Lease: $(lease "$id")"
      git switch -q "$start" || true
    fi
    http POST "$DESK/desk/release?lease=$(lease "$id")&reason=submitted" "$STATE/.rel.json" >/dev/null
    rm -f "$STATE/$id.json"
    echo "submitted; the verdict comes as a comment on the pull request. Next: tools/adx.sh next"
    ;;

  release)
    have "${1:-}"
    case "${2:-}" in insufficient_evidence|claim_seems_false|claim_ill_posed|needs_split|out_of_time|other) ;;
      *) echo "release needs a reason: insufficient_evidence | claim_seems_false | claim_ill_posed | needs_split | out_of_time | other" >&2; exit 1;; esac
    code="$(http POST "$DESK/desk/release?lease=$(lease "$1")&reason=$2" "$STATE/.rel.json")"
    rm -f "$STATE/$1.json"
    [ "$code" = 200 ] || [ "$code" = 410 ] || { echo "release failed ($code): $(cat "$STATE/.rel.json")" >&2; exit 1; }
    echo "released $1 ($2). Next: tools/adx.sh next"
    ;;

  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
