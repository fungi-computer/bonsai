#!/usr/bin/env bash
# The Bonsai demo, end to end and real: create a repository, seed it, start
# three coding agents at once (each in its own fork), merge their work as the
# owner, and when a merge conflicts, send that agent back to resolve it.
#
#   OYSTER_URL=https://… OYSTER_OWNER_KEY=… KEYS_FILE=agents.env scripts/demo.sh [repo]
#
# KEYS_FILE holds BONSAI_KEY_MOREL, BONSAI_KEY_CHANTERELLE and BONSAI_KEY_ENOKI
# (agent keys from POST /api/keys). Agents run with scripts/agent.sh, so
# AGENT_CMD picks their harness.
set -euo pipefail

url=${OYSTER_URL:?OYSTER_URL}
owner=${OYSTER_OWNER_KEY:?OYSTER_OWNER_KEY}
repo=${1:-koi-pond}
app=${BONSAI_INSTALLATION:-bonsai}
here=$(cd "$(dirname "$0")" && pwd)
work=${BONSAI_WORK:-$(mktemp -d)}
set -a
. "${KEYS_FILE:?KEYS_FILE}"
set +a

call() {
  curl -fsS -X POST -H "Authorization: Bearer $owner" -H "Content-Type: application/json" \
    -d "$2" "$url/apps/$app/methods/$1"
}

# One changes.merge call, then bounded read-only observation of that exact
# pinned Change through the existing contract (changes.get) until it
# reaches a terminal state FOR THE EXACT HEAD PROPOSED: merged, or a
# conflict pinned to that head; closed, moved to a different head, or a
# recorded mergeFailure are reported as failures rather than treated as
# still-pending (same law apps/bonsai/test/webhooks-issues.native.mjs's
# waitForMergeOutcome uses). changes.get can itself answer
# {"kind":"rebuilding"} (apps/bonsai/backend/methods.ts:446); that is not
# terminal either way, so it is read the same as "keep polling". An owner
# key is background-eligible (packages/puffball/src/background-replay.ts
# mayEnqueueBackground), so changes.merge normally answers
# {"kind":"merging"} and settles later; the merge is never resubmitted,
# only observed. The whole observation has one finite elapsed budget, and
# no single fetch's AbortSignal outlives it. Prints "merged <hash>" and
# exits 0, or "conflict <paths>" and exits 2, a "moved" line on stderr and
# exits 3 when a newer push replaced the pinned head, or a failure line on
# stderr and exits 1 (refused, closed, a recorded failure, or a timeout).
cat >"$work/merge-observe.mjs" <<'MERGE_OBSERVE'
const [url, owner, app, repo, number, head] = process.argv.slice(2);
const auth = { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" };
const deadline = Date.now() + 60_000;
const budget = (ms) => Math.max(1, Math.min(ms, deadline - Date.now()));
async function call(method, input) {
  const response = await fetch(`${url}/apps/${app}/methods/${method}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(budget(10_000)),
  });
  const text = await response.text();
  return { ok: response.ok, body: text ? JSON.parse(text) : null };
}
// Stops only on a terminal, read-only fact about the pinned head: merged,
// closed, moved off that head, a conflict pinned to that head, or a
// recorded mergeFailure. "rebuilding" and an unsettled "open"/"merging"
// Change are not terminal; keep polling until the shared deadline.
async function observe() {
  for (;;) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for Change #${number} to settle`);
    const got = await call("changes.get", { repo, number: Number(number) });
    if (!got.ok) throw new Error(`changes.get failed: ${JSON.stringify(got.body)}`);
    const detail = got.body;
    if ("change" in detail) {
      const change = detail.change;
      if (
        change.state === "merged" ||
        change.state === "closed" ||
        change.head !== head ||
        change.conflict?.head === head ||
        change.mergeFailure !== undefined
      )
        return change;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, budget(500))));
  }
}
function classify(change) {
  // A newer push under the lease is "moved", even when the stale lease
  // also recorded a mergeFailure; the caller may retry against the new head.
  if (change.head !== head) return { kind: "moved", head: change.head };
  if (change.mergeFailure !== undefined)
    return { kind: "failed", reason: change.mergeFailure };
  if (change.state === "closed")
    return { kind: "failed", reason: "closed before it could settle" };
  if (change.state === "merged")
    return { kind: "merged", after: change.mergedCommit };
  if (change.conflict?.head === head)
    return { kind: "conflict", paths: change.conflict.paths };
  return { kind: "failed", reason: `unexpected state ${change.state}` };
}
const merged = await call("changes.merge", { repo, number: Number(number), head });
if (!merged.ok) {
  console.error(`merge call failed: ${JSON.stringify(merged.body)}`);
  process.exit(1);
}
let outcome = merged.body;
if (outcome.kind === "merging") outcome = classify(await observe());
if (outcome.kind === "merged") {
  console.log(`merged ${outcome.after}`);
  process.exit(0);
}
if (outcome.kind === "conflict") {
  console.log(`conflict ${JSON.stringify(outcome.paths)}`);
  process.exit(2);
}
if (outcome.kind === "moved") {
  console.error(`Change #${number} moved from ${head} to ${outcome.head}`);
  process.exit(3);
}
console.error(`merge did not complete: ${outcome.kind} ${outcome.reason ?? JSON.stringify(outcome)}`);
process.exit(1);
MERGE_OBSERVE

merge_and_observe() {
  node "$work/merge-observe.mjs" "$url" "$owner" "$app" "$repo" "$1" "$2"
}

echo "== create $repo and push the starting project"
call repos.create "{\"name\":\"$repo\",\"description\":\"A small canvas pond game that agents build together\"}" >/dev/null
seed="$work/seed"
rm -rf "$seed" && cp -r "$here/../demo/koi-pond" "$seed"
git -C "$seed" init -q -b main
git -C "$seed" add -A
git -C "$seed" -c user.name=owner -c user.email=owner@bonsai.local commit -qm "Start $repo: a pond, fish and a game loop"
git -C "$seed" -c http.extraHeader="Authorization: Bearer $owner" push -q "$url/git/$app/$repo.git" main

echo "== three agents, three forks, at the same time"
export BONSAI_URL=$url BONSAI_WORK=$work BONSAI_INSTALLATION=$app
BONSAI_KEY=$BONSAI_KEY_MOREL "$here/agent.sh" morel "$repo" \
  "Add feeding: clicking the pond drops a food pellet that sinks slowly; fish steer toward the nearest pellet and eat it. Put pellets in src/food.ts and draw them inside frame() in src/main.ts right after the pond is drawn." \
  >"$work/morel.log" 2>&1 &
BONSAI_KEY=$BONSAI_KEY_CHANTERELLE "$here/agent.sh" chanterelle "$repo" \
  "Make the pond feel alive: soft ripples expand on the water. Add src/ripples.ts and draw the ripples inside frame() in src/main.ts right after the pond is drawn." \
  >"$work/chanterelle.log" 2>&1 &
BONSAI_KEY=$BONSAI_KEY_ENOKI "$here/agent.sh" enoki "$repo" \
  "Add issues as files for future work: issues/$repo-v1/01-resize-canvas.md, 02-day-night.md and 03-expire-food.md. Each starts with YAML frontmatter: id ($repo-v1-01 and so on), title (quoted), type: enhancement, status: ready-for-agent, priority: p2, created: $(date +%F), assignee: null, areas: [game], blocked_by: [] (03 is blocked_by [$repo-v1-01]); then '# <the same title>' and the sections '## Outcome', '## Context', '## Acceptance criteria' and '## Verification' with short real content." \
  >"$work/enoki.log" 2>&1 &
wait
echo "   agents finished; logs in $work"

find_change() {
  local agent="$1"
  local fork="$repo--$agent"
  local list
  list=$(call changes.list "{\"repo\":\"$repo\"}")
  node -e '
    const page = JSON.parse(process.argv[1]);
    const fork = process.argv[2];
    const found = page.changes.find((c) => c.sourceRepo === fork);
    if (!found) throw new Error(`no Change for fork ${fork}`);
    console.log(`${found.number} ${found.head}`);
  ' "$list" "$fork"
}

# The fork's main as the git server holds it: the agent's last pushed commit.
fork_tip() {
  git -C "$work/$repo--$1" ls-remote origin refs/heads/main | cut -f1
}

# Bonsai learns about a push asynchronously, so a Change's head can trail the
# agent's last push for a while. Wait (bounded) until the Change shows the
# pushed commit; merging an older head would be refused once the newer push
# lands, which is the correct behaviour.
await_change() {
  local agent="$1" tip number head
  tip=$(fork_tip "$agent")
  if [[ -z $tip ]]; then
    echo "$agent: could not read the fork's pushed main" >&2
    return 1
  fi
  local deadline=$((SECONDS + 60))
  while :; do
    read -r number head <<<"$(find_change "$agent")"
    if [[ $head == "$tip" ]]; then
      echo "$number $head"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      echo "$agent: Change #$number still shows $head, not the pushed $tip, after 60s" >&2
      return 1
    fi
    sleep 2
  done
}

# Merge the agent's Change at its pushed head. If a newer push moves the head
# during the merge, re-read the Change and retry once against the new head.
merge_agent() {
  local agent="$1" found number head status
  found=$(await_change "$agent") || return 1
  read -r number head <<<"$found"
  if merge_and_observe "$number" "$head"; then return 0; else status=$?; fi
  [[ $status -eq 3 ]] || return "$status"
  echo "   $agent: Change #$number moved during the merge; retrying once at the new head" >&2
  found=$(await_change "$agent") || return 1
  read -r number head <<<"$found"
  merge_and_observe "$number" "$head"
}

echo "== merge the changes"
for agent in enoki morel chanterelle; do
  if out=$(merge_agent "$agent"); then
    echo "   $agent: $out"
    continue
  else
    status=$?
  fi
  if [[ $status -ne 2 ]]; then
    echo "   $agent: merge did not reach a mergeable state (see the error above)" >&2
    exit "$status"
  fi
  echo "== $agent conflicts with main ($out); sending $agent back to resolve it"
  key_var="BONSAI_KEY_$(tr '[:lower:]' '[:upper:]' <<<"$agent")"
  BONSAI_KEY=${!key_var} "$here/agent.sh" "$agent" "$repo" \
    "Bonsai could not merge your fork into main because src/main.ts conflicts with work main already has. The merge from upstream main is in progress in your working tree. Resolve the conflict so every feature keeps working, commit the merge and push." \
    >"$work/$agent-resolve.log" 2>&1
  if out=$(merge_agent "$agent"); then
    echo "   $agent: $out (after resolving)"
  else
    status=$?
    echo "   $agent: merge did not reach a mergeable state after resolving (see the error above)" >&2
    exit "$status"
  fi
done
echo "== done: $url/apps/$app/"
