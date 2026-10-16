/**
 * Tree and line diffs computed from git objects. Identical subtree hashes are
 * skipped, so a diff only reads the objects that changed.
 */
import { diffLines } from "diff";
import type { Diff, FileDiff } from "../shared/contract.js";
import type { TreeEntry } from "@fungi.computer/agar/roles/files";
import type { GitStore } from "./git.js";

const MAX_FILES = 200;
const MAX_DIFF_BYTES = 200_000;
/** Encoded text one whole diff may carry: a diff is stored as one read-copy
 * row (512 KB), so the files' texts share this bound with their metadata. */
const MAX_DIFF_TEXT_BYTES = 384_000;
const encoder = new TextEncoder();
const BLOB_READS_AT_ONCE = 8;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type PathChange = Readonly<{
  path: string;
  before: string | null;
  after: string | null;
}>;

export function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8000);
  if (sample.includes(0)) return true;
  try {
    decoder.decode(sample.length === bytes.length ? bytes : sample);
    return false;
  } catch {
    return sample.length === bytes.length;
  }
}

export function decodeText(
  bytes: Uint8Array,
):
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "invalid-utf8" }> {
  try {
    return { kind: "text", text: decoder.decode(bytes) };
  } catch (error) {
    if (error instanceof TypeError) return { kind: "invalid-utf8" };
    throw error;
  }
}

/**
 * Paths whose blob changed between two trees (null tree = empty).
 *
 * Subtrees are read one at a time: a read-copy frame stops at its provider
 * budget, and each completed read is kept by the projection store, so a diff
 * too large for one frame advances across foreground pages instead of
 * launching every read at once and keeping none of them.
 */
export async function changedPaths(
  store: GitStore,
  repo: string,
  before: string | null,
  after: string | null,
  prefix = "",
): Promise<PathChange[]> {
  if (before === after) return [];
  const [left, right] = await Promise.all([
    before === null ? [] : store.tree(repo, before),
    after === null ? [] : store.tree(repo, after),
  ]);
  const index = (entries: readonly TreeEntry[] | null) =>
    new Map((entries ?? []).map((entry) => [entry.name, entry]));
  const oldEntries = index(left);
  const newEntries = index(right);
  const names = [
    ...new Set([...oldEntries.keys(), ...newEntries.keys()]),
  ].sort();
  const nested: {
    before: string | null;
    after: string | null;
    prefix: string;
  }[] = [];
  const changes: PathChange[] = [];
  for (const name of names) {
    const a = oldEntries.get(name);
    const b = newEntries.get(name);
    if (a?.hash === b?.hash && a?.type === b?.type) continue;
    const path = prefix + name;
    const aTree = a?.type === "tree" ? a.hash : null;
    const bTree = b?.type === "tree" ? b.hash : null;
    if (aTree !== null || bTree !== null)
      nested.push({ before: aTree, after: bTree, prefix: `${path}/` });
    const aBlob = a?.type === "blob" ? a.hash : null;
    const bBlob = b?.type === "blob" ? b.hash : null;
    if (aBlob !== bBlob) changes.push({ path, before: aBlob, after: bBlob });
  }
  for (const subtree of nested)
    changes.push(
      ...(await changedPaths(
        store,
        repo,
        subtree.before,
        subtree.after,
        subtree.prefix,
      )),
    );
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

async function fileDiff(
  store: GitStore,
  repo: string,
  change: PathChange,
): Promise<FileDiff> {
  const [oldBytes, newBytes] = await Promise.all([
    change.before === null ? new Uint8Array() : store.blob(repo, change.before),
    change.after === null ? new Uint8Array() : store.blob(repo, change.after),
  ]);
  const status =
    change.before === null
      ? "added"
      : change.after === null
        ? "removed"
        : "modified";
  const base = {
    path: change.path,
    oldPath: null,
    status,
    additions: 0,
    deletions: 0,
    binary: false,
    truncated: false,
    oldText: null,
    newText: null,
  } satisfies FileDiff;
  if (oldBytes === null || newBytes === null)
    return { ...base, truncated: true };
  if (isBinary(oldBytes) || isBinary(newBytes))
    return { ...base, binary: true };
  if (oldBytes.length + newBytes.length > MAX_DIFF_BYTES)
    return { ...base, truncated: true };
  const before = decodeText(oldBytes);
  const after = decodeText(newBytes);
  if (before.kind === "invalid-utf8" || after.kind === "invalid-utf8")
    return { ...base, binary: true };
  const oldText = before.text;
  const newText = after.text;
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(oldText, newText)) {
    if (part.added) additions += part.count;
    else if (part.removed) deletions += part.count;
  }
  return { ...base, additions, deletions, oldText, newText };
}

/** A full diff between two trees in one repository. */
export async function treeDiff(
  store: GitStore,
  repo: string,
  before: string | null,
  after: string | null,
): Promise<Diff> {
  const changes = await changedPaths(store, repo, before, after);
  const listed = changes.slice(0, MAX_FILES);
  // A few blob reads at a time, so a frame's completed reads are kept.
  const computed: FileDiff[] = [];
  for (let start = 0; start < listed.length; start += BLOB_READS_AT_ONCE)
    computed.push(
      ...(await Promise.all(
        listed
          .slice(start, start + BLOB_READS_AT_ONCE)
          .map((change) => fileDiff(store, repo, change)),
      )),
    );
  // Texts are kept in path order while they fit; later files stay listed,
  // with their line counts, as too large to show.
  let remaining = MAX_DIFF_TEXT_BYTES;
  const files = computed.map((file) => {
    if (file.oldText === null && file.newText === null) return file;
    const bytes = encoder.encode(
      JSON.stringify([file.oldText, file.newText]),
    ).byteLength;
    if (bytes > remaining)
      return { ...file, truncated: true, oldText: null, newText: null };
    remaining -= bytes;
    return file;
  });
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    omittedFiles: changes.length - listed.length,
  };
}

const MAX_PATHS = 3000;

/** Every path under a tree, directories with a trailing slash, bounded. */
export async function listPaths(
  store: GitStore,
  repo: string,
  tree: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let level: { hash: string; prefix: string }[] = [{ hash: tree, prefix: "" }];
  while (level.length > 0 && paths.length < MAX_PATHS) {
    const listings = await Promise.all(
      level.map(async (item) => ({
        prefix: item.prefix,
        entries: (await store.tree(repo, item.hash)) ?? [],
      })),
    );
    const next: { hash: string; prefix: string }[] = [];
    for (const listing of listings)
      for (const entry of listing.entries) {
        if (entry.type === "commit") continue;
        const path = `${listing.prefix}${entry.name}`;
        if (entry.type === "tree") {
          paths.push(`${path}/`);
          next.push({ hash: entry.hash, prefix: `${path}/` });
        } else paths.push(path);
      }
    level = next;
  }
  return {
    paths: paths.slice(0, MAX_PATHS),
    truncated: paths.length >= MAX_PATHS,
  };
}
