#!/usr/bin/env node
// Prove Bonsai end to end on a local runtime: start the standalone Oyster
// with `wrangler dev --config ../../packages/oyster/deploy/wrangler.celld.jsonc` (Artifacts over REST),
// install Bonsai, create a repository, push, fork, push to the fork, merge,
// and read the graph. Run it plain for workerd, or under celld:
//
//   CELLD_PLATFORM_CELLD=<celld> node --import \
//     ../../tooling/celld-platform/runtime/wrangler-on-celld.mjs scripts/runtime-proof.mjs
//
// Needs ARTIFACTS_ACCOUNT_ID and ARTIFACTS_API_TOKEN (Artifacts read/write).
// Uses the namespace bonsai-proof and deletes its repositories afterwards.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installRelease, packRelease } from "@fungi.computer/oyster/pack";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const accountId = process.env.ARTIFACTS_ACCOUNT_ID;
const apiToken = process.env.ARTIFACTS_API_TOKEN;
if (!accountId || !apiToken)
  throw new Error("Set ARTIFACTS_ACCOUNT_ID and ARTIFACTS_API_TOKEN");
const namespace = "bonsai-proof";
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
const work = await mkdtemp(join(tmpdir(), "bonsai-proof-"));
const key = randomBytes(24).toString("hex");
const repo = `proof-${Date.now().toString(36)}`;

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const origin = `http://127.0.0.1:${port}`;

const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();

await packRelease({
  appId: "app_bonsai",
  releaseId: "rel_proof",
  sourceDirectory: repository,
  sourceRevision: `git:${revision}`,
  packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  recipe: {
    entry: "apps/bonsai/web/index.html",
    assets: {
      maxManifestBytes: 1_048_576,
      maxObjects: 1024,
      maxObjectBytes: 16_777_216,
      maxTotalBytes: 67_108_864,
    },
    assetBase: "./",
    maxOutputBytes: 67_108_864,
    backend: {
      entry: "apps/bonsai/backend/index.ts",
      exportName: "BonsaiApp",
      compatibilityDate: "2026-09-04",
      runtime: { kind: "durable-facet", stateSchema: 1 },
    },
  },
  outDirectory: `${work}/release`,
});

const vars = {
  OYSTER_OWNER_KEY: key,
  OYSTER_ORIGIN: origin,
  ARTIFACTS_ACCOUNT_ID: accountId,
  ARTIFACTS_NAMESPACE: namespace,
  ARTIFACTS_API_TOKEN: apiToken,
};
const wrangler = spawn(
  `${root}../../node_modules/.bin/wrangler`,
  [
    "dev",
    "--config",
    `${root}../../packages/oyster/deploy/wrangler.celld.jsonc`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    // --var, not an env file: the celld wrapper merges --vars into its project.
    ...Object.entries(vars).flatMap(([name, value]) => [
      "--var",
      `${name}:${value}`,
    ]),
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
wrangler.stdout.on("data", (chunk) => (output += chunk));
wrangler.stderr.on("data", (chunk) => (output += chunk));
const stopped = new Promise((resolve) => wrangler.once("exit", resolve));

const owner = { Authorization: `Bearer ${key}` };
const call = async (method, input, headers = owner, signal) => {
  const response = await fetch(`${origin}/apps/bonsai/methods/${method}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const body = await response.json();
  assert.ok(response.ok, `${method}: ${JSON.stringify(body)}`);
  return body;
};
const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// One changes.merge call, then bounded read-only observation of that exact
// pinned Change through the existing contract (changes.get) until it
// reaches a terminal state FOR THE EXACT HEAD PROPOSED: merged, or closed,
// moved to a different head, or a recorded mergeFailure -- all of which
// are failures, never treated as still-pending (same law
// apps/bonsai/test/webhooks-issues.native.mjs's waitForMergeOutcome uses).
// changes.get can itself answer {kind:"rebuilding"}
// (apps/bonsai/backend/methods.ts:446); that is not terminal either way,
// so it is read the same as "keep polling". The owner key here is
// background-eligible (packages/puffball/src/background-replay.ts
// mayEnqueueBackground), so changes.merge normally answers
// {kind:"merging"} and settles later; this never resubmits the write,
// only observes. One finite elapsed budget bounds the whole observation,
// and no single fetch's AbortSignal outlives it. This proof has no second
// agent to resolve a conflict, so every terminal outcome other than a
// clean merge of the proposed head is a hard failure.
const mergeAndObserve = async (repo, number, head) => {
  const merged = await call(
    "changes.merge",
    { repo, number, head },
    owner,
    AbortSignal.timeout(10_000),
  );
  if (merged.kind !== "merging") {
    assert.equal(
      merged.kind,
      "merged",
      `changes.merge did not merge: ${JSON.stringify(merged)}`,
    );
    return merged;
  }
  const deadline = Date.now() + 60_000;
  const budget = (ms) => Math.max(1, Math.min(ms, deadline - Date.now()));
  for (;;) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for Change ${number} to settle`);
    const detail = await call(
      "changes.get",
      { repo, number },
      owner,
      AbortSignal.timeout(budget(10_000)),
    );
    if ("change" in detail) {
      const change = detail.change;
      const settled =
        change.state === "merged" ||
        change.state === "closed" ||
        change.head !== head ||
        change.conflict?.head === head ||
        change.mergeFailure !== undefined;
      if (settled) {
        assert.equal(
          change.mergeFailure,
          undefined,
          `Change ${number} merge failed: ${change.mergeFailure}`,
        );
        assert.notEqual(
          change.state,
          "closed",
          `Change ${number} closed before head ${head} could settle`,
        );
        assert.equal(
          change.head,
          head,
          `Change ${number} moved to ${change.head} before it could settle`,
        );
        assert.equal(
          change.state,
          "merged",
          `changes.merge did not merge: ${JSON.stringify(change)}`,
        );
        return { kind: "merged", after: change.mergedCommit };
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, budget(500))),
    );
  }
};

try {
  for (let attempt = 0; ; attempt += 1) {
    if (
      await fetch(`${origin}/login`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (attempt > 240) throw new Error(`Oyster did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const installed = await installRelease({
    directory: `${work}/release`,
    url: origin,
    key,
    installationId: "bonsai",
  });
  assert.equal(installed.status, 201, await installed.text());

  await call("repos.create", { name: repo, description: "runtime proof" });
  const seed = join(work, "seed");
  git(["init", "-q", "-b", "main", seed]);
  await writeFile(join(seed, "a.txt"), "one\n");
  git(["add", "."], seed);
  git(
    ["-c", "user.name=owner", "-c", "user.email=o@x", "commit", "-qm", "start"],
    seed,
  );
  const auth = ["-c", `http.extraHeader=Authorization: Bearer ${key}`];
  git(
    [...auth, "push", "-q", `${origin}/git/bonsai/${repo}.git`, "main"],
    seed,
  );

  const fork = await call("repos.fork", { repo });
  await writeFile(join(seed, "b.txt"), "fork work\n");
  git(["add", "."], seed);
  git(
    [
      "-c",
      "user.name=owner",
      "-c",
      "user.email=o@x",
      "commit",
      "-qm",
      "fork work",
    ],
    seed,
  );
  git(
    [...auth, "push", "-q", `${origin}/git/bonsai/${fork.name}.git`, "main"],
    seed,
  );

  // Push facts arrive after the response; wait for the fork's push.
  for (let attempt = 0; ; attempt += 1) {
    const activity = await call("activity.list", { repo });
    if (
      activity.events.some(
        (event) => event.type === "push" && event.repo === fork.name,
      )
    )
      break;
    if (attempt > 40) throw new Error("push fact never arrived");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const page = await call("changes.list", { repo });
  const change = page.changes.find((c) => c.sourceRepo === fork.name);
  assert.ok(change, `no Change for fork ${fork.name}`);
  const merged = await mergeAndObserve(repo, change.number, change.head);
  const graph = await call("graph.get", { repo });
  assert.ok(
    graph.nodes.some(
      (node) => node.hash === merged.after && node.parents.length === 2,
    ),
  );
  const file = await call("files.read", { repo, ref: "main", path: "b.txt" });
  assert.equal(file.text, "fork work\n");
  console.log(
    `bonsai runtime proof passed on ${runtime}: create, push, fork, push, merge ${merged.after.slice(0, 7)}, graph, read`,
  );
} finally {
  wrangler.kill("SIGTERM");
  await stopped;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces/${namespace}/repos`;
  for (const name of [`bonsai--${repo}`, `bonsai--${repo}--owner`])
    await fetch(`${base}/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    });
}
