#!/usr/bin/env node
// Pack Bonsai as an App Release and install it (or replace its Release) on an
// Oyster. The canonical builder compiles UI and backend from the requested commit.
//
//   OYSTER_URL=https://… OYSTER_OWNER_KEY=… node scripts/release.mjs
import { execFileSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";
import { log } from "node:console";
import { installRelease, packRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const url = process.env.OYSTER_URL;
const key = process.env.OYSTER_OWNER_KEY;
if (!url || !key) throw new Error("Set OYSTER_URL and OYSTER_OWNER_KEY");
const installationId = process.env.BONSAI_INSTALLATION ?? "bonsai";
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const bonsai = standaloneAppSet.find((app) => app.installationId === "bonsai");
if (!bonsai) throw new Error("The standalone App set must include Bonsai");
const stamp = Date.now().toString(36);
const outDirectory = `${root}.botanical/release`;

await packRelease({
  appId: "app_bonsai",
  releaseId: `rel_${revision.slice(0, 12)}${stamp}`,
  sourceDirectory: repository,
  sourceRevision: `git:${revision}`,
  packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  recipe: bonsai.recipe,
  outDirectory,
});

const response = await installRelease({
  directory: outDirectory,
  url,
  key,
  installationId,
});
log(
  response.status === 201 ? "installed" : "replaced",
  response.status,
  await response.text(),
);
if (!response.ok) process.exitCode = 1;
