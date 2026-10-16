/** Bounded Git ancestry and host-recorded commit origins for proposals. */
import type { ChangeRecord } from "../shared/contract.js";
import type { Commit } from "@fungi.computer/agar/roles/files";
import type { GitStore } from "./git.js";
import type { Bonsai } from "./service.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import * as z from "zod";
import {
  commit as commitSchema,
  treeEntry,
} from "@fungi.computer/agar/roles/files";

const HISTORY = 300;
const MAX_SIDE_BRANCHES = 24;

/** Immutable Git objects survive frame boundaries while a bounded rebuild advances. */
export function projectionStore(bonsai: Bonsai): GitStore {
  const store = bonsai.store;
  const commits = bonsai.state.copies.open("bonsai-commit", commitSchema);
  const trees = bonsai.state.copies.open("bonsai-tree", z.array(treeEntry));
  const logs = bonsai.state.copies.open(
    "bonsai-history",
    z.array(commitSchema),
  );
  return {
    ...store,
    async commit(repo, hash) {
      const key = JSON.stringify([
        repo,
        bonsai.state.repositoryGeneration(repo),
        hash,
      ]);
      const saved = commits.read(key);
      if (saved.kind === "ready") return saved.value;
      const value = await store.commit(repo, hash);
      if (value !== null) commits.write(key, hash, value);
      return value;
    },
    async tree(repo, hash) {
      const key = JSON.stringify([
        repo,
        bonsai.state.repositoryGeneration(repo),
        hash,
      ]);
      const saved = trees.read(key);
      if (saved.kind === "ready") return saved.value;
      const value = await store.tree(repo, hash);
      if (value !== null) trees.write(key, hash, [...value]);
      return value;
    },
    async blob(repo, hash) {
      const saved = bonsai.state.copies.readBlob(hash);
      if (saved !== null) return saved;
      const value = await store.blob(repo, hash);
      if (value !== null && value.byteLength <= 512_000)
        bonsai.state.copies.putBlob(hash, value);
      return value;
    },
    async log(repo, ref, limit, offset = 0) {
      if (!/^[0-9a-f]{40}$/u.test(ref))
        return store.log(repo, ref, limit, offset);
      const key = JSON.stringify([
        repo,
        bonsai.state.repositoryGeneration(repo),
        ref,
        limit,
        offset,
      ]);
      const saved = logs.read(key);
      if (saved.kind === "ready") return saved.value;
      const value = await store.log(repo, ref, limit, offset);
      logs.write(key, ref, [...value]);
      return value;
    },
  };
}

/**
 * Commits reachable from `ref`: the first-parent history plus the histories
 * merged into it, bounded so a listing stays a handful of reads.
 */
async function ancestry(
  store: GitStore,
  repo: string,
  ref: string,
): Promise<{ firstParent: readonly Commit[]; all: ReadonlySet<string> }> {
  const firstParent = await store.log(repo, ref, HISTORY);
  const all = new Set(firstParent.map((commit) => commit.hash));
  const pending = firstParent.flatMap((commit) => commit.parents.slice(1));
  let reads = 0;
  while (pending.length > 0 && reads < MAX_SIDE_BRANCHES) {
    const next = pending.shift();
    if (next === undefined || all.has(next)) continue;
    reads += 1;
    for (const commit of await store.log(repo, next, HISTORY)) {
      if (all.has(commit.hash)) break;
      all.add(commit.hash);
      pending.push(...commit.parents.slice(1));
    }
  }
  return { firstParent, all };
}

export type ChangeHistory = Readonly<{
  /** Fork commits the canonical repository does not contain, newest first. */
  ahead: readonly Commit[];
  aheadHashes: readonly string[];
  base: string | null;
  behind: number;
  head: string;
}>;

export async function compareChange(
  store: GitStore,
  canonical: string,
  fork: string,
  head: string,
  target: string,
): Promise<ChangeHistory | null> {
  const [main, branch] = await Promise.all([
    ancestry(store, canonical, target),
    ancestry(store, fork, head),
  ]);
  const tip = branch.firstParent[0];
  if (tip === undefined) return null;
  const ahead: Commit[] = [];
  let base: string | null = null;
  for (const commit of branch.firstParent) {
    if (main.all.has(commit.hash)) {
      base = commit.hash;
      break;
    }
    ahead.push(commit);
  }
  let behind = 0;
  for (const commit of main.firstParent) {
    if (branch.all.has(commit.hash)) break;
    behind += 1;
  }
  return {
    ahead,
    aheadHashes: [...branch.all].filter((hash) => !main.all.has(hash)),
    base,
    behind,
    head: tip.hash,
  };
}

/** Bounded target reachability, prepared once per accepted target update. */
export async function reachableCommits(
  store: GitStore,
  repo: string,
  target: string,
): Promise<ReadonlySet<string>> {
  return (await ancestry(store, repo, target)).all;
}

export async function authorsAtHead(
  bonsai: Bonsai,
  row: ChangeRecord,
): Promise<readonly string[]> {
  const history = await compareChange(
    bonsai.store,
    row.repo,
    row.sourceRepo,
    row.head,
    row.target,
  );
  if (history === null)
    throw new AppMethodRefusal("not_found", "The proposed head is missing");
  return [
    ...new Set(
      [...bonsai.state.origins(history.aheadHashes).values()].map(
        (origin) => origin.agent,
      ),
    ),
  ];
}
