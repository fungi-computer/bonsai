/**
 * Bonsai's view of git: the host's GIT binding (agar's `GitBinding`, the
 * Artifacts binding surface scoped to this installation) wrapped as a
 * GitStore whose results are parsed into the shared contract. Bonsai never
 * holds a credential or a provider remote.
 */
import * as z from "zod";
import { countingGit } from "@fungi.computer/agar/read-copy";
import { ref as refSchema, type Ref } from "../shared/contract.js";
import {
  commit as commitSchema,
  treeEntry as treeEntrySchema,
  type Commit,
  type TreeEntry,
} from "@fungi.computer/agar/roles/files";

import type {
  GitBinding,
  GitExchangeRequest,
  GitExchangeResponse,
  GitRepositoryInfo as RepoInfo,
} from "@fungi.computer/agar/git";

export type { GitBinding, GitExchangeRequest, GitExchangeResponse, RepoInfo };

export type GitStore = Readonly<{
  binding: GitBinding;
  cloneUrl(name: string): Promise<string>;
  create(name: string, description: string): Promise<RepoInfo>;
  fork(source: string, target: string, description: string): Promise<RepoInfo>;
  info(name: string): Promise<RepoInfo | null>;
  log(
    name: string,
    ref: string,
    limit: number,
    offset?: number,
  ): Promise<readonly Commit[]>;
  commit(name: string, hash: string): Promise<Commit | null>;
  tree(name: string, hash: string): Promise<readonly TreeEntry[] | null>;
  blob(name: string, hash: string): Promise<Uint8Array | null>;
  refs(name: string): Promise<readonly Ref[]>;
  exchange(
    name: string,
    request: GitExchangeRequest,
  ): Promise<GitExchangeResponse>;
}>;

const repoInfoSchema = z.object({
  name: z.string(),
  defaultBranch: z.string(),
  lastPushAt: z.string().nullable(),
  source: z.string().nullable(),
});

const exchangeSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.instanceof(Uint8Array),
});

/** Parse every binding result: the binding is an I/O boundary. */
export function gitStore(binding: GitBinding): GitStore {
  return {
    binding,
    async cloneUrl(name) {
      return z.url().parse(await binding.cloneUrl(name));
    },
    async create(name, description) {
      return repoInfoSchema.parse(
        await binding.create(name, { description, defaultBranch: "main" }),
      );
    },
    async fork(source, target, description) {
      return repoInfoSchema.parse(
        await binding.fork(source, target, { description }),
      );
    },
    async info(name) {
      const raw = await binding.info(name);
      return raw === null ? null : repoInfoSchema.parse(raw);
    },
    async log(name, ref, limit, offset = 0) {
      return z
        .array(commitSchema)
        .parse(await binding.log(name, { ref, limit, offset }));
    },
    async commit(name, hash) {
      const raw = await binding.readCommit(name, hash);
      return raw === null ? null : commitSchema.parse(raw);
    },
    async tree(name, hash) {
      const raw = await binding.readTree(name, hash);
      return raw === null ? null : z.array(treeEntrySchema).parse(raw);
    },
    async blob(name, hash) {
      const raw = await binding.readBlob(name, hash);
      return raw === null ? null : z.instanceof(Uint8Array).parse(raw);
    },
    async refs(name) {
      return z.array(refSchema).parse(await binding.refs(name));
    },
    async exchange(name, request) {
      return exchangeSchema.parse(await binding.exchange(name, request));
    },
  };
}

/** One provider budget and lifetime for an App-owned projection frame. */
export async function readCopyFrame<T>(
  store: GitStore,
  body: (store: GitStore, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController();
  try {
    const counted = countingGit(store.binding, {
      limit: 40,
      signal: lifetime.signal,
    });
    return await body(gitStore(counted.git), lifetime.signal);
  } finally {
    lifetime.abort();
  }
}
