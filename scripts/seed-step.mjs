import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function pushSeedStep({
  git,
  message,
  remote,
  baseHead,
  lastPushAt,
  pushIntervalMinutes,
}) {
  // Seed messages are unique step identities within this owned branch.
  // Check history before touching the index: a later step may already be staged.
  const history = await git(["log", "--format=%H%x09%s", `${baseHead}..HEAD`]);
  const completed = history
    .split("\n")
    .find((line) => line.slice(line.indexOf("\t") + 1) === message);
  if (completed) {
    const head = await git(["rev-parse", "HEAD"]);
    if (!completed.startsWith(`${head}\t`)) return null;
    const advertised = await git(["ls-remote", remote, "refs/heads/main"]);
    if (advertised.startsWith(`${head}\t`)) return null;
  } else {
    await git(["add", "."]);
    assert.ok(
      await git(["diff", "--cached", "--name-only"]),
      "Seed step has no change and no matching commit",
    );
  }
  const remaining = lastPushAt + pushIntervalMinutes * 60_000 - Date.now();
  if (remaining > 0) await delay(remaining);
  if (!completed) {
    await git(["commit", "-qm", message]);
  }
  await git(["push", "-q", remote, "main"]);
  return { head: await git(["rev-parse", "HEAD"]), at: Date.now() };
}
