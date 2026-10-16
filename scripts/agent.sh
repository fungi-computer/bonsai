#!/usr/bin/env bash
# Run one coding agent against a Bonsai repository: fork it, clone the fork
# through Bonsai's git door, and let the agent work and push in its own fork.
#
#   BONSAI_URL=https://<oyster> BONSAI_KEY=<agent key> scripts/agent.sh <agent-name> <repo> <task>
#
# BONSAI_URL is the Oyster that hosts Bonsai; BONSAI_INSTALLATION names Bonsai's
# installation there (default "bonsai"). The agent key comes from the Oyster
# owner (POST /api/keys).
#
# AGENT_CMD picks the harness (default: Codex on the cheap Luna model). The
# agent's key is written into the clone's git config so plain `git push` works;
# Bonsai only lets that key push to the agent's own fork.
set -euo pipefail

name=${1:?agent name}
repo=${2:?repository}
task=${3:?task}
url=${BONSAI_URL:?BONSAI_URL}
key=${BONSAI_KEY:?BONSAI_KEY}
work=${BONSAI_WORK:-$(mktemp -d)}
app=${BONSAI_INSTALLATION:-bonsai}

fork=$(curl -fsS -X POST -H "Authorization: Bearer $key" -d "{\"repo\":\"$repo\"}" -H "Content-Type: application/json" "$url/apps/$app/methods/repos.fork" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).name))')
echo "[$name] working in $fork"

dir="$work/$fork"
rm -rf "$dir"
for attempt in 1 2 3; do
  git -c http.extraHeader="Authorization: Bearer $key" clone -q "$url/git/$app/$fork.git" "$dir" && break
  [ "$attempt" = 3 ] && exit 1
  sleep 2
done
git -C "$dir" config http.extraHeader "Authorization: Bearer $key"
git -C "$dir" config user.name "$name"
git -C "$dir" config user.email "$name@agents.bonsai"
git -C "$dir" remote add upstream "$url/git/$app/$repo.git"

# Start from the canonical main so the fork carries everything already merged.
# A conflict is left in the working tree for the agent to resolve.
if git -C "$dir" pull -q --no-rebase --no-edit upstream main; then
  git -C "$dir" push -q origin HEAD
else
  echo "[$name] main conflicts with $fork; leaving the merge for the agent"
fi

prompt="You are $name, one of several agents working on this repository at the same time; each agent has its own fork.
Task: $task
The canonical repository is the 'upstream' remote; if you are asked to update from main, run 'git pull --no-rebase upstream main', resolve any conflicts so both features keep working, commit and push.
Rules: work in small steps. After each meaningful step, commit with a clear one-line message and run 'git push origin HEAD' right away so others can see your progress. Make 2 to 4 commits. Do not install packages or run builds. Stop when the task is done."

cd "$dir"
${AGENT_CMD:-codex exec -m gpt-6-luna --yolo --skip-git-repo-check} "$prompt"
echo "[$name] done"
