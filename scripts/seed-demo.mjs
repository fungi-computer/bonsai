#!/usr/bin/env node
// Public Oyster client only. Credentials are files; stdout is a secret-free receipt.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { log, error } from "node:console";
import * as z from "zod";
import {
  repoPage,
  repoSummary,
  repoDetail,
  changePage,
  changeDetail,
  changeRecord,
  checkRequestResult,
  checkReportResult,
  mergeResult,
  graph,
} from "../shared/contract.ts";

import { pushSeedStep } from "./seed-step.mjs";

const names = ["morel", "chanterelle", "enoki"];
const stateSchema = z.object({
  origin: z.url(),
  installation: z.string(),
  repo: z.string(),
  keys: z.record(z.string(), z.string()),
  finished: z.boolean(),
  baseHead: z.string().nullable(),
  lastPushAt: z.number().nonnegative(),
});
const keyResponse = z.object({
  key: z.object({ name: z.string() }),
  plaintext: z.string().min(1),
});

export async function seedDemo({
  origin,
  work,
  ownerKeyFile,
  agentKeysFile,
  phase = "seed",
  installation = "bonsai",
  repo = "koi-pond",
  pushIntervalMinutes = 0,
}) {
  assert.ok(
    Number.isFinite(pushIntervalMinutes) && pushIntervalMinutes >= 0,
    "Push interval must be nonnegative minutes",
  );
  const url = new URL(origin);
  assert.ok(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password,
    "Use an HTTP origin without embedded credentials",
  );
  origin = url.origin;
  const agentsOnly = phase === "agents";
  assert.ok(
    agentsOnly ? agentKeysFile && !ownerKeyFile : ownerKeyFile,
    "Agents phase takes only scoped agent credentials",
  );
  const owner = agentsOnly
    ? null
    : (await readFile(ownerKeyFile, "utf8")).trim();
  assert.ok(agentsOnly || owner, "Owner credential file is empty");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const stateFile = join(work, "credentials.json");
  let state;
  try {
    state = stateSchema.parse(JSON.parse(await readFile(stateFile, "utf8")));
  } catch (cause) {
    if (cause?.code !== "ENOENT")
      throw new Error("Cannot read seed checkpoint", { cause });
    state = stateSchema.parse({
      origin,
      installation,
      repo,
      keys: {},
      finished: false,
      baseHead: null,
      lastPushAt: 0,
    });
  }
  assert.ok(
    state.origin === origin &&
      state.repo === repo &&
      state.installation === installation,
    "Checkpoint belongs to a different target",
  );
  if (agentsOnly) {
    assert.equal(
      (await stat(agentKeysFile)).mode & 0o777,
      0o600,
      "Scoped keys must be in a 0600 file",
    );
    state.keys = z
      .strictObject({
        morel: z.string().min(1),
        chanterelle: z.string().min(1),
        enoki: z.string().min(1),
      })
      .parse(JSON.parse(await readFile(agentKeysFile, "utf8")));
  }
  const save = () =>
    writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  const request = async (path, body, key) => {
    const response = await globalThis.fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "oyster-koi-seed/1.0",
      },
      body: JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Public request ${path} failed (${response.status}); no response body logged`,
      );
    return response.json();
  };
  const call = async (method, input, schema, key = owner ?? state.keys.morel) =>
    schema.parse(
      await request(`/apps/${installation}/methods/${method}`, input, key),
    );
  const git = async (directory, args, key) => {
    const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    delete environment.GIT_AUTHOR_DATE;
    delete environment.GIT_COMMITTER_DATE;
    delete environment.GIT_TRACE;
    delete environment.GIT_TRACE_CURL;
    delete environment.GIT_CURL_VERBOSE;
    delete environment.GIT_TRACE_PACKET;
    delete environment.GIT_TRACE_REDACT;

    if (key) {
      environment.GIT_CONFIG_COUNT = "1";
      environment.GIT_CONFIG_KEY_0 = "http.extraHeader";
      environment.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${key}`;
    }
    try {
      const result = await promisify(execFile)("git", args, {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      return result.stdout.trim();
    } catch (cause) {
      const parsed = z.string().safeParse(cause?.stderr);
      let diagnostic = parsed.success ? parsed.data : "No Git stderr";
      for (const secret of [owner, ...Object.values(state.keys)].filter(
        Boolean,
      ))
        diagnostic = diagnostic.split(secret).join("[redacted]");
      await writeFile(join(work, "git-error.log"), diagnostic, { mode: 0o600 });
      throw new Error(`Git ${args[0]} failed; see the redacted git-error.log`, {
        cause,
      });
    }
  };
  const gitUrl = (name) =>
    `${origin}/git/${encodeURIComponent(installation)}/${encodeURIComponent(name)}.git`;
  const until = async (read, accepts, label) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const value = await read();
      if (accepts(value)) return value;
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const repositories = await call("repos.list", {}, repoPage);
  if (!repositories.repos.some((item) => item.name === repo)) {
    assert.ok(
      owner,
      "Owner must prepare canonical repository before agent drip",
    );
    await call(
      "repos.create",
      {
        name: repo,
        description:
          "A living canvas pond, built together by Morel, Chanterelle and Enoki.",
      },
      repoSummary,
    );
  }
  const base = await call("repos.get", { repo }, repoDetail);
  if (base.empty) {
    assert.ok(owner, "Owner must push canonical base before agent drip");
    const directory = join(work, "base");
    await cp(
      fileURLToPath(new URL("../demo/koi-pond/", import.meta.url)),
      directory,
      { recursive: true },
    );
    await git(directory, ["init", "-q", "-b", "main"]);
    await git(directory, ["add", "."]);
    await git(directory, [
      "-c",
      "user.name=owner",
      "-c",
      "user.email=owner@bonsai.local",
      "commit",
      "-qm",
      "Start the koi pond canvas game",
    ]);
    await git(directory, ["push", "-q", gitUrl(repo), "main"], owner);
    await until(
      () => call("repos.get", { repo }, repoDetail),
      (value) => !value.empty,
      "base push",
    );
  }
  if (state.baseHead === null) {
    const current = await call("repos.get", { repo }, repoDetail);
    state.baseHead =
      current.refs.find((ref) => ref.name === "refs/heads/main")?.hash ?? null;
    assert.ok(state.baseHead, "Starting main ref is required");
  }
  await save();
  if (phase === "prepare") return { origin, repo, phase: "prepared" };
  const readChanges = () => call("changes.list", { repo }, changePage);
  const recordFirstTwo = async () => {
    if (!agentsOnly) return;
    let lines;
    try {
      lines = await readFile(join(work, "pushes.jsonl"), "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return;
      throw cause;
    }
    const pushes = lines
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        z
          .object({
            actor: z.string(),
            repo: z.string(),
            head: z.string(),
            at: z.iso.datetime(),
          })
          .parse(JSON.parse(line)),
      );
    if (pushes.length < 2) return;
    try {
      await stat(join(work, "first-two-pushes.json"));
      return;
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    const page = await readChanges();
    await writeFile(
      join(work, "first-two-pushes.json"),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          origin,
          pushes: pushes.slice(0, 2),
          changes: page.changes.map(
            ({ repo, number, sourceRepo, sourceRef, head, state, status }) => ({
              repo,
              number,
              sourceRepo,
              sourceRef,
              head,
              state,
              status,
            }),
          ),
          ownerOperations: false,
          browser: false,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  };
  await recordFirstTwo();
  if (!state.finished) {
    const folders = {};
    // Fork every lane from the same actual head before any lane is merged.
    for (const name of names) {
      if (!state.keys[name]) {
        assert.ok(owner, "Owner provisions scoped agent keys");
        const created = keyResponse.parse(
          await request(
            "/api/keys",
            {
              name,
              grants: [{ capability: "apps.use", targets: { kind: "all" } }],
            },
            owner,
          ),
        );
        assert.equal(created.key.name, name);
        state.keys[name] = created.plaintext;
        await save();
      }
      const fork = await call(
        "repos.fork",
        { repo },
        repoSummary,
        state.keys[name],
      );
      const directory = join(work, name);
      try {
        await readFile(join(directory, ".git", "HEAD"));
      } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
        await git(
          work,
          ["clone", "-q", gitUrl(fork.name), directory],
          state.keys[name],
        );
      }
      await git(directory, ["config", "user.name", name]);
      await git(directory, ["config", "user.email", `${name}@agents.bonsai`]);
      folders[name] = { directory, fork: fork.name };
    }
    const replace = async (directory, path, before, after) => {
      const target = join(directory, path);
      const content = await readFile(target, "utf8");
      if (content.includes(after)) return;
      assert.ok(
        content.includes(before),
        `Demo source no longer matches ${path}; refusing an invented patch`,
      );
      await writeFile(target, content.replace(before, after));
    };
    const append = async (directory, path, text) => {
      const target = join(directory, path);
      const content = await readFile(target, "utf8");
      if (!content.includes(text)) await writeFile(target, content + text);
    };
    const commit = async (name, message) => {
      const { directory, fork } = folders[name];
      const result = await pushSeedStep({
        git: (args) => git(directory, args, state.keys[name]),
        message,
        remote: gitUrl(fork),
        baseHead: state.baseHead,
        lastPushAt: state.lastPushAt,
        pushIntervalMinutes,
      });
      if (!result) return;
      state.lastPushAt = result.at;
      await save();
      const pushed = {
        actor: name,
        repo: fork,
        head: result.head,
        at: new Date(state.lastPushAt).toISOString(),
      };
      await appendFile(
        join(work, "pushes.jsonl"),
        `${JSON.stringify(pushed)}\n`,
        { mode: 0o600 },
      );
      log(JSON.stringify({ pushed }));
      await recordFirstTwo();
    };
    const alreadyMerged = (await readChanges()).changes.some(
      (change) =>
        change.sourceRepo === folders.morel.fork && change.state === "merged",
    );
    const morel = folders.morel.directory;
    if (!alreadyMerged) {
      await replace(morel, "src/pond.ts", '"#0b3d4f"', '"#164e63"');
      await commit("morel", "Give the pond a brighter morning palette");
      await replace(
        morel,
        "src/pond.ts",
        "ctx.fillRect(0, 0, pond.width, pond.height);",
        "ctx.fillRect(0, 0, pond.width, pond.height);\n  ctx.strokeStyle = '#ffffff18';\n  for (const pad of pond.pads) {\n    ctx.beginPath();\n    ctx.arc(pad.x, pad.y, 24 + (performance.now() / 80) % 32, 0, Math.PI * 2);\n    ctx.stroke();\n  }",
      );
      await commit("morel", "Draw gentle ripples around the lily pads");
      await append(
        morel,
        "README.md",
        "\n## Morning water\nMorel added expanding ripples around the lily pads and a brighter water palette.\n",
      );
      await commit("morel", "Document the morning water and ripple animation");
    }
    const chanterelle = folders.chanterelle.directory;
    await replace(
      chanterelle,
      "src/fish.ts",
      "speed: 0.6 + Math.random() * 0.8",
      "speed: 0.4 + Math.random() * 0.6",
    );
    await commit("chanterelle", "Slow the koi to a calmer swimming pace");
    await replace(
      chanterelle,
      "src/main.ts",
      "const school = spawnFish(pond, 12);",
      "const school = spawnFish(pond, 12);\naddEventListener('resize', () => {\n  canvas.width = pond.width = innerWidth;\n  canvas.height = pond.height = innerHeight;\n});",
    );
    await commit(
      "chanterelle",
      "Keep the pond canvas fitted when the window resizes",
    );
    await replace(
      chanterelle,
      "README.md",
      "plain TypeScript with no framework.\n",
      "plain TypeScript with no framework.\n\n## A calmer school\nChanterelle slowed the koi and keeps the canvas fitted to the window.\n",
    );
    await commit("chanterelle", "Document the resizing pond and calmer koi");
    const enoki = folders.enoki.directory;
    await replace(enoki, "src/pond.ts", '"#0b3d4f"', '"#272640"');
    await commit("enoki", "Try a twilight palette for the pond");
    await replace(enoki, "src/fish.ts", '"#f2994a"', '"#ffd166"');
    await commit("enoki", "Make the koi visible against twilight water");
    await append(
      enoki,
      "README.md",
      "\n## Twilight experiment\nEnoki is exploring evening water and golden koi; the water palette needs a decision against Morel’s morning palette.\n",
    );
    await commit(
      "enoki",
      "Explain the twilight experiment and palette decision",
    );
    const pushedHeads = new Map(
      await Promise.all(
        names.map(async (name) => [
          name,
          await git(folders[name].directory, ["rev-parse", "HEAD"]),
        ]),
      ),
    );
    await until(
      readChanges,
      (value) =>
        names.every((name) =>
          value.changes.some(
            (change) =>
              change.sourceRepo === folders[name].fork &&
              change.head === pushedHeads.get(name),
          ),
        ),
      "three Changes at their final pushed heads",
    );
    // Explicit public open is idempotent for a still-open source branch.
    for (const name of names) {
      if (name === "morel" && alreadyMerged) continue;
      await call(
        "changes.open",
        {
          repo: folders[name].fork,
          sourceRef: "main",
          title: {
            morel: "Morning water and lily-pad ripples",
            chanterelle: "Calmer koi and a responsive pond",
            enoki: "Twilight water and golden koi",
          }[name],
        },
        changeRecord,
        state.keys[name],
      );
    }
    const proposed = (await readChanges()).changes;
    if (agentsOnly) {
      const receipt = {
        origin,
        installation,
        repo,
        phase: "awaiting-owner",
        changes: proposed.map(
          ({ number, sourceRepo, sourceRef, head, state, status }) => ({
            number,
            sourceRepo,
            sourceRef,
            head,
            state,
            status,
          }),
        ),
      };
      await writeFile(
        join(work, "receipt.json"),
        JSON.stringify(receipt, null, 2),
      );
      return receipt;
    }
    const morelChange = proposed.find(
      (change) => change.sourceRepo === folders.morel.fork,
    );
    assert.ok(morelChange);
    const input = { repo, number: morelChange.number, head: morelChange.head };
    if (morelChange.state !== "merged") {
      const attempt = await call(
        "checks.request",
        { ...input, names: ["koi TypeScript"] },
        checkRequestResult,
        state.keys.morel,
      );
      assert.equal(attempt.kind, "requested");
      assert.equal(
        await git(morel, ["rev-parse", "HEAD"]),
        input.head,
        "Compiler must check the exact reported head",
      );
      // A real compiler runs on the exact proposed working tree before reporting passed.
      try {
        execFileSync(
          fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)),
          [
            "--noEmit",
            "--strict",
            "--target",
            "ES2022",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--lib",
            "ES2022,DOM",
            "--skipLibCheck",
            "src/main.ts",
          ],
          { cwd: morel, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (cause) {
        throw new Error(
          "Koi TypeScript check failed; no passed check was reported",
          { cause },
        );
      }
      const report = await call(
        "checks.report",
        {
          ...input,
          name: "koi TypeScript",
          status: "passed",
          attemptId: attempt.attemptId,
          summary:
            "tsc --noEmit --strict passed on the proposed koi canvas source.",
        },
        checkReportResult,
        state.keys.morel,
      );
      assert.equal(report.kind, "recorded");
      const merged = await call("changes.merge", input, mergeResult);
      if (merged.kind === "merging") {
        // Queued; observe it to a terminal state instead of assuming an
        // immediate kind.
        let settled = null;
        for (let attempt = 0; attempt < 40; attempt++) {
          const polled = (await readChanges()).changes.find(
            (change) => change.number === input.number,
          );
          if (polled?.status !== "merging") {
            settled = polled;
            break;
          }
          await delay(250);
        }
        assert.ok(settled, "A queued merge must reach a terminal state");
        assert.equal(settled.state, "merged");
      } else {
        assert.equal(merged.kind, "merged");
      }
    }
    const conflict = proposed.find(
      (change) => change.sourceRepo === folders.enoki.fork,
    );
    assert.ok(conflict);
    if (conflict.status !== "conflict") {
      const result = await call(
        "changes.merge",
        { repo, number: conflict.number, head: conflict.head },
        mergeResult,
      );
      if (result.kind === "merging") {
        // Queued; observe it to a terminal state instead of assuming an
        // immediate kind.
        let settled = null;
        for (let attempt = 0; attempt < 40; attempt++) {
          const polled = (await readChanges()).changes.find(
            (change) => change.number === conflict.number,
          );
          if (polled?.status !== "merging") {
            settled = polled;
            break;
          }
          await delay(250);
        }
        assert.ok(settled, "A queued merge must reach a terminal state");
        assert.equal(settled.status, "conflict");
      } else {
        assert.equal(result.kind, "conflict");
      }
    }
    state.finished = true;
    await save();
  }
  const changes = (await readChanges()).changes;
  const selected = names.map((name) =>
    changes.find((change) => change.sourceRepo === `${repo}--${name}`),
  );
  assert.ok(selected.every(Boolean));
  for (const [index, name] of names.entries()) {
    const commits = await git(join(work, name), [
      "rev-list",
      "--count",
      `${state.baseHead}..${selected[index].head}`,
    ]);
    assert.equal(
      Number(commits),
      3,
      `${name} must contribute exactly three real commits`,
    );
  }
  assert.equal(selected[0].state, "merged");
  assert.equal(selected[1].state, "open");
  assert.equal(selected[2].status, "conflict");
  const merged = await call(
    "changes.get",
    { repo, number: selected[0].number },
    changeDetail,
  );
  assert.ok(
    merged.review.checks.some(
      (check) => check.head === merged.change.head && check.status === "passed",
    ),
  );
  const network = await call("graph.get", { repo }, graph);
  for (const name of names)
    assert.ok(network.lanes.some((lane) => lane.owner === name));
  const receipt = {
    origin,
    installation,
    repo,
    changes: selected.map((change) => ({
      number: change.number,
      sourceRepo: change.sourceRepo,
      head: change.head,
      state: change.state,
      status: change.status,
    })),
    commits: network.nodes.length,
  };
  await writeFile(join(work, "receipt.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}

async function runSeedCommand(values) {
  try {
    assert.ok(
      values.origin &&
        values.work &&
        (values["owner-key-file"] || values["agent-keys-file"]),
      "Supply --origin, --work and the credential file for the selected phase",
    );
    assert.ok(
      ["prepare", "seed", "agents"].includes(values.phase),
      "Phase must be prepare, seed or agents",
    );
    log(
      JSON.stringify(
        await seedDemo({
          origin: values.origin,
          work: values.work,
          ownerKeyFile: values["owner-key-file"],
          agentKeysFile: values["agent-keys-file"],
          phase: values.phase,
          pushIntervalMinutes: Number(values["push-interval-minutes"]),
        }),
        null,
        2,
      ),
    );
    return { ok: true };
  } catch (cause) {
    // Only fixed classifications cross the CLI boundary; causes may contain keys.
    return {
      ok: false,
      message:
        cause instanceof z.ZodError
          ? "Bonsai demo seed failed: invalid public response or checkpoint."
          : "Bonsai demo seed failed; no credentials or subprocess output logged.",
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      work: { type: "string" },
      "owner-key-file": { type: "string" },
      "agent-keys-file": { type: "string" },
      phase: { type: "string", default: "seed" },
      "push-interval-minutes": { type: "string", default: "0" },
    },
  });
  const result = await runSeedCommand(values);
  if (!result.ok) {
    error(result.message);
    process.exitCode = 1;
  }
}
