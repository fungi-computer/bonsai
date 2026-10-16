/** Files projections consume the composer's bounded store; they never open a frame. */
import * as z from "zod";
import {
  fileContent,
  fileList,
  treeListing,
  type Commit,
} from "@fungi.computer/agar/roles/files";
import { decodeText, isBinary } from "./diff.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import { projectionStore } from "./history.js";
import { readRepositoryRefs } from "./repository-copy.js";
import type { Bonsai } from "./service.js";

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("list"),
    repo: z.string(),
    ref: z.string(),
  }),
  z.strictObject({
    kind: z.literal("tree"),
    repo: z.string(),
    ref: z.string(),
    path: z.string(),
  }),
  z.strictObject({
    kind: z.literal("file"),
    repo: z.string(),
    ref: z.string(),
    path: z.string(),
  }),
]);
export type FilesCopyRequest = z.infer<typeof requestSchema>;
const registrySchema = z.strictObject({
  epoch: z.number().int().nonnegative(),
  entries: z
    .array(z.strictObject({ key: z.string(), request: requestSchema }))
    .max(3000),
});
const storedFile = fileContent.omit({
  text: true,
  pending: true,
  version: true,
});
const MAX_VIEW_BYTES = 512_000;

/** One key is one foreground page. Existing views remain discoverable after invalidation. */
export function filesCopyRequests(
  bonsai: Bonsai,
  repo: string,
): FilesCopyRequest[] {
  return registry(bonsai, repo).entries.map((entry) => entry.request);
}

function registryKey(bonsai: Bonsai, repo: string): string {
  return JSON.stringify([repo, bonsai.state.repositoryGeneration(repo)]);
}

function registry(bonsai: Bonsai, repo: string) {
  const saved = bonsai.state.copies
    .open("bonsai-files-keys", registrySchema)
    .read(registryKey(bonsai, repo));
  return saved.kind === "ready" ? saved.value : { epoch: 0, entries: [] };
}

/** Invoke before ANY provider await, including repository/Change preparation. */
export function invalidateFilesCopies(bonsai: Bonsai, repo: string): void {
  const lists = bonsai.state.copies.open("bonsai-files-list", fileList);
  const trees = bonsai.state.copies.open("bonsai-files-tree", treeListing);
  const files = bonsai.state.copies.open("bonsai-files-file", storedFile);
  const saved = registry(bonsai, repo);
  bonsai.state.copies
    .open("bonsai-files-keys", registrySchema)
    .write(registryKey(bonsai, repo), null, {
      ...saved,
      epoch: saved.epoch + 1,
    });
  for (const { key, request } of saved.entries) {
    if (/^[0-9a-f]{40}$/u.test(request.ref)) continue;
    if (request.kind === "list") lists.stale(key);
    else if (request.kind === "tree") trees.stale(key);
    else files.stale(key);
  }
}

async function remember(
  bonsai: Bonsai,
  request: FilesCopyRequest,
): Promise<string> {
  const normalized = requestSchema.parse(request);
  const generation = bonsai.state.repositoryGeneration(request.repo);
  const identity = JSON.stringify([generation, normalized]);
  const found = registry(bonsai, request.repo).entries.find(
    (entry) => JSON.stringify([generation, entry.request]) === identity,
  );
  if (found !== undefined) return found.key;
  // Public file paths may exceed R0's 1024-character storage-key bound.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const key = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (bonsai.state.repositoryGeneration(request.repo) !== generation)
    throw new AppMethodRefusal(
      "unavailable",
      "Repository changed during Files key registration.",
    );
  const saved = registry(bonsai, request.repo);
  if (!saved.entries.some((entry) => entry.key === key)) {
    if (saved.entries.length === 3000)
      throw new AppMethodRefusal("invalid", "Too many Files read-copy keys.");
    bonsai.state.copies
      .open("bonsai-files-keys", registrySchema)
      .write(registryKey(bonsai, request.repo), null, {
        ...saved,
        entries: [...saved.entries, { key, request: normalized }],
      });
  }
  return key;
}

function head(bonsai: Bonsai, request: FilesCopyRequest): string {
  if (bonsai.state.repo(request.repo) === null)
    throw new AppMethodRefusal("not_found", "No such repository");
  if (/^[0-9a-f]{40}$/u.test(request.ref)) return request.ref;
  const repository = readRepositoryRefs(bonsai, request.repo);
  const resolved = repository.refs.find(
    (ref) =>
      ref.name === request.ref ||
      ref.name === `refs/heads/${request.ref}` ||
      ref.name === `refs/tags/${request.ref}`,
  );
  if (resolved === undefined)
    throw new AppMethodRefusal("not_found", "Unknown ref");
  return resolved.hash;
}

/** Refresh only this view, sharing the supplied frame budget and immutable objects. */
export async function refreshFilesCopy(
  bonsai: Bonsai,
  request: FilesCopyRequest,
): Promise<void> {
  const generation = bonsai.state.repositoryGeneration(request.repo);
  const key = await remember(bonsai, request);
  try {
    const epoch = registry(bonsai, request.repo).epoch;
    const hash = head(bonsai, request);
    const checkPublication = () => {
      if (
        bonsai.state.repositoryGeneration(request.repo) !== generation ||
        (!/^[0-9a-f]{40}$/u.test(request.ref) &&
          registry(bonsai, request.repo).epoch !== epoch) ||
        head(bonsai, request) !== hash
      )
        throw new AppMethodRefusal(
          "unavailable",
          "Files copy changed during rebuild.",
        );
    };
    const store = projectionStore(bonsai);
    const commit = await store.commit(request.repo, hash);
    if (commit === null) throw new AppMethodRefusal("not_found", "Unknown ref");
    if (request.kind === "list") {
      // Preserve the ordinary listing's breadth-first ordering and 3000-path cap,
      // but consume provider operations serially within the shared frame.
      const paths: string[] = [];
      let level = [{ hash: commit.treeHash, prefix: "" }];
      while (level.length > 0 && paths.length < 3000) {
        const next: typeof level = [];
        for (const item of level) {
          const entries = await store.tree(request.repo, item.hash);
          for (const entry of entries ?? []) {
            if (entry.type === "commit") continue;
            const path = `${item.prefix}${entry.name}`;
            if (entry.type === "tree") {
              paths.push(`${path}/`);
              next.push({ hash: entry.hash, prefix: `${path}/` });
            } else paths.push(path);
          }
        }
        level = next;
      }
      checkPublication();
      bonsai.state.copies.open("bonsai-files-list", fileList).write(key, hash, {
        ref: request.ref,
        commit,
        paths: paths.slice(0, 3000),
        truncated: paths.length >= 3000,
      });
      return;
    }
    const target = await targetAt(store, request.repo, commit, request.path);
    if (request.kind === "tree") {
      if (target?.type !== "tree")
        throw new AppMethodRefusal("not_found", "No such directory");
      const entries = [
        ...((await store.tree(request.repo, target.hash)) ?? []),
      ].sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "tree"
            ? -1
            : 1,
      );
      checkPublication();
      bonsai.state.copies
        .open("bonsai-files-tree", treeListing)
        .write(key, hash, {
          ref: request.ref,
          commit,
          path: request.path,
          entries,
        });
      return;
    }
    if (target === null) {
      checkPublication();
      bonsai.state.copies
        .open("bonsai-files-file", storedFile)
        .write(key, hash, {
          ref: request.ref,
          path: request.path,
          commit: hash,
          blob: null,
          size: 0,
          binary: false,
        });
      return;
    }
    if (target.type !== "blob")
      throw new AppMethodRefusal("not_found", "No such file");
    const bytes = await store.blob(request.repo, target.hash);
    if (bytes === null) throw new AppMethodRefusal("not_found", "No such file");
    const decoded = bytes.length > MAX_VIEW_BYTES ? null : decodeText(bytes);
    checkPublication();
    bonsai.state.copies.open("bonsai-files-file", storedFile).write(key, hash, {
      ref: request.ref,
      path: request.path,
      commit: hash,
      blob: target.hash,
      size: bytes.length,
      binary: isBinary(bytes) || decoded?.kind === "invalid-utf8",
    });
  } catch (error) {
    if (error instanceof AppMethodRefusal && error.code === "not_found") {
      const saved = registry(bonsai, request.repo);
      bonsai.state.copies
        .open("bonsai-files-keys", registrySchema)
        .write(registryKey(bonsai, request.repo), null, {
          ...saved,
          entries: saved.entries.filter((entry) => entry.key !== key),
        });
    }
    throw error;
  }
}

type TreeTarget = Readonly<{ hash: string; type: "tree" | "blob" }>;

async function targetAt(
  store: ReturnType<typeof projectionStore>,
  repo: string,
  commit: Commit,
  path: string,
) {
  let target: TreeTarget = {
    type: "tree",
    hash: commit.treeHash,
  };
  for (const segment of path.split("/").filter(Boolean)) {
    if (target.type !== "tree")
      throw new AppMethodRefusal("not_found", "Not a repository directory");
    const entries = await store.tree(repo, target.hash);
    if (entries === null)
      throw new AppMethodRefusal("not_found", "Directory object is missing");
    const entry = entries.find((item) => item.name === segment);
    if (entry === undefined) return null;
    if (entry.type === "commit")
      throw new AppMethodRefusal("not_found", "Unsupported repository entry");
    target = { hash: entry.hash, type: entry.type };
  }
  return target;
}

export async function listFilesCopy(
  bonsai: Bonsai,
  input: { repo: string; ref: string },
) {
  const request: FilesCopyRequest = { kind: "list", ...input };
  const key = await remember(bonsai, request);
  const copies = bonsai.state.copies.open("bonsai-files-list", fileList);
  let saved = copies.read(key);
  if (saved.kind !== "ready" || saved.head !== head(bonsai, request)) {
    await refreshFilesCopy(bonsai, request);
    saved = copies.read(key);
  }
  if (saved.kind !== "ready")
    throw new AppMethodRefusal("unavailable", "Files copy is rebuilding.");
  return saved.value;
}

export async function listTreeCopy(
  bonsai: Bonsai,
  input: { repo: string; ref: string; path: string },
) {
  const request: FilesCopyRequest = { kind: "tree", ...input };
  const key = await remember(bonsai, request);
  const copies = bonsai.state.copies.open("bonsai-files-tree", treeListing);
  let saved = copies.read(key);
  if (saved.kind !== "ready" || saved.head !== head(bonsai, request)) {
    await refreshFilesCopy(bonsai, request);
    saved = copies.read(key);
  }
  if (saved.kind !== "ready")
    throw new AppMethodRefusal("unavailable", "Files copy is rebuilding.");
  return saved.value;
}

export async function readFileCopy(
  bonsai: Bonsai,
  input: { repo: string; ref: string; path: string },
) {
  const request: FilesCopyRequest = { kind: "file", ...input };
  const key = await remember(bonsai, request);
  const copies = bonsai.state.copies.open("bonsai-files-file", storedFile);
  let saved = copies.read(key);
  if (
    saved.kind !== "ready" ||
    saved.head !== head(bonsai, request) ||
    (saved.value.blob !== null &&
      !saved.value.binary &&
      saved.value.size <= MAX_VIEW_BYTES &&
      bonsai.state.copies.readBlob(saved.value.blob) === null)
  ) {
    await refreshFilesCopy(bonsai, request);
    saved = copies.read(key);
  }
  if (saved.kind !== "ready")
    throw new AppMethodRefusal("unavailable", "File copy is rebuilding.");
  const value = saved.value;
  const bytes =
    value.blob === null || value.binary || value.size > MAX_VIEW_BYTES
      ? null
      : bonsai.state.copies.readBlob(value.blob);
  if (
    value.blob !== null &&
    !value.binary &&
    value.size <= MAX_VIEW_BYTES &&
    bytes === null
  )
    throw new AppMethodRefusal("unavailable", "File copy is rebuilding.");
  const decoded = bytes === null ? null : decodeText(bytes);
  return {
    ...value,
    version: null,
    text: decoded?.kind === "text" ? decoded.text : null,
  };
}
