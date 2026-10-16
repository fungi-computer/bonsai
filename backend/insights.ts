/** Bounded first-parent line history using the existing parsed Git reader. */
import { diffLines } from "diff";
import type { Commit } from "@fungi.computer/agar/roles/files";
import { ageBandLabels, type CodeInsights } from "../shared/insights.js";
import { decodeText, isBinary } from "./diff.js";
import type { GitStore } from "./git.js";

const HISTORY = 40;
const FILES = 80;
const READS = 600;
const BYTES = 8_000_000;
const FILE_BYTES = 100_000;
class SampleLimit extends Error {}

const lineCount = (text: string) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** Preserve unchanged line ages; removed lines vanish, additions take commit time. */
export function advanceLineAges(
  before: string,
  after: string,
  ages: readonly (number | null)[],
  at: number,
): (number | null)[] | null {
  const parts = diffLines(before, after, { timeout: 40, maxEditLength: 4000 });
  if (!parts) return null;
  let offset = 0;
  const next: (number | null)[] = [];
  for (const part of parts) {
    if (part.added) next.push(...Array.from({ length: part.count }, () => at));
    else {
      if (!part.removed) next.push(...ages.slice(offset, offset + part.count));
      offset += part.count;
    }
  }
  return next;
}

/** Unchanged lines continue to age between snapshots without rereading a blob. */
function ageBandsAt(
  births: ReadonlyMap<number | null, number>,
  at: number,
): number[] {
  const bands = ageBandLabels.map(() => 0);
  for (const [born, count] of births) {
    const days = born === null ? null : Math.max(0, (at - born) / 86400);
    const band =
      days === null ? 4 : days < 7 ? 0 : days < 28 ? 1 : days < 90 ? 2 : 3;
    bands[band] = (bands[band] ?? 0) + count;
  }
  return bands;
}

async function analyze(
  store: GitStore,
  repo: string,
  head: Commit | null,
  now: number,
): Promise<CodeInsights> {
  const result: CodeInsights = {
    head: head?.hash ?? null,
    commits: 0,
    files: [],
    ageHistory: [],
    omittedFiles: 0,
    partial: false,
  };
  if (!head) return result;
  let reads = 0;
  let bytesRead = 0;
  let entriesRead = 0;
  const spend = () => {
    if (++reads > READS) throw new SampleLimit();
  };
  const history: Commit[] = [head];
  while (history.length < HISTORY) {
    const parent = history.at(-1)?.parents[0];
    if (!parent) break;
    spend();
    const commit = await store.commit(repo, parent);
    if (!commit) {
      result.partial = true;
      break;
    }
    history.push(commit);
  }
  result.commits = history.length;
  result.partial ||= (history.at(-1)?.parents.length ?? 0) > 0;
  const chronological = [...history].reverse();
  const snapshotTimes = chronological.map((commit) => commit.committedAt);
  if (now / 1000 > head.committedAt) snapshotTimes.push(now / 1000);
  result.ageHistory = snapshotTimes.map((at) => ({
    at,
    lines: ageBandLabels.map(() => 0),
  }));
  // Cache trees within this analysis; no cross-repository Git object assumptions.
  const trees = new Map<string, Awaited<ReturnType<GitStore["tree"]>>>();
  const tree = async (hash: string) => {
    if (trees.has(hash)) return trees.get(hash) ?? null;
    spend();
    const entries = await store.tree(repo, hash);
    if (!entries) throw new Error("Git tree is missing");
    entriesRead += entries.length;
    if (entriesRead > 20_000) throw new SampleLimit();
    trees.set(hash, entries);
    return entries;
  };
  const paths: string[] = [];
  const queue = [{ hash: head.treeHash, prefix: "", depth: 0 }];
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      for (const entry of (await tree(item.hash)) ?? []) {
        if (entry.type === "blob" && entry.mode !== "120000") {
          if (paths.length < FILES) paths.push(item.prefix + entry.name);
          else result.omittedFiles++;
        } else if (entry.type === "tree") {
          if (item.depth >= 20 || queue.length >= 200) {
            result.partial = true;
            continue;
          }
          queue.push({
            hash: entry.hash,
            prefix: `${item.prefix}${entry.name}/`,
            depth: item.depth + 1,
          });
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SampleLimit)) throw error;
    result.partial = true;
  }
  const blobAt = async (commit: Commit, path: string) => {
    let hash = commit.treeHash;
    const segments = path.split("/");
    for (const [index, segment] of segments.entries()) {
      const entry = (await tree(hash))?.find((item) => item.name === segment);
      if (!entry) return null;
      if (index === segments.length - 1)
        return entry.type === "blob" ? entry.hash : null;
      if (entry.type !== "tree") return null;
      hash = entry.hash;
    }
    return null;
  };
  const text = async (hash: string | null) => {
    if (hash === null) return "";
    spend();
    const bytes = await store.blob(repo, hash);
    if (bytes === null) throw new Error("Git blob is missing");
    bytesRead += bytes.length;
    if (bytesRead > BYTES) throw new SampleLimit();
    if (bytes.length > FILE_BYTES || isBinary(bytes)) return null;
    const decoded = decodeText(bytes);
    return decoded.kind === "text" ? decoded.text : null;
  };
  for (const [pathIndex, path] of paths.entries()) {
    try {
      let previousHash: string | null | undefined;
      let previousText = "";
      let ages: (number | null)[] = [];
      let changes = 0;
      let usable = true;
      const samples: number[][] = [];
      let births = new Map<number | null, number>();
      for (const [index, commit] of chronological.entries()) {
        const hash = await blobAt(commit, path);
        if (hash !== previousHash) {
          const current = await text(hash);
          if (current === null) {
            usable = false;
            break;
          }
          if (index === 0 && commit.parents.length > 0) {
            ages = Array.from({ length: lineCount(current) }, () => null);
          } else {
            const next = advanceLineAges(
              previousText,
              current,
              ages,
              commit.committedAt,
            );
            if (next === null) {
              usable = false;
              break;
            }
            ages = next;
            if (!(index === 0 && hash === null)) changes++;
          }
          births = new Map();
          for (const at of ages) births.set(at, (births.get(at) ?? 0) + 1);
          previousText = current;
          previousHash = hash;
        }
        samples.push(ageBandsAt(births, commit.committedAt));
      }
      if (snapshotTimes.length > chronological.length)
        samples.push(ageBandsAt(births, now / 1000));
      if (!usable) {
        result.omittedFiles++;
        continue;
      }
      result.files.push({ path, lines: ages.length, changes });
      for (const [index, bands] of samples.entries()) {
        const snapshot = result.ageHistory[index];
        if (snapshot)
          bands.forEach((count, band) => {
            snapshot.lines[band] = (snapshot.lines[band] ?? 0) + count;
          });
      }
    } catch (error) {
      if (!(error instanceof SampleLimit)) throw error;
      result.omittedFiles += paths.length - pathIndex;
      result.partial = true;
      break;
    }
  }
  result.partial ||= result.omittedFiles > 0;
  return result;
}

// Each live installation owns at most eight recent snapshots. Failed work is
// evicted; simultaneous readers share one promise. Heads are resolved afresh.
const caches = new WeakMap<
  GitStore,
  Map<string, { until: number; value: Promise<CodeInsights> }>
>();
export async function readCodeInsights(
  store: GitStore,
  repo: string,
  ref: string,
  now = Date.now(),
): Promise<CodeInsights> {
  const head = (await store.log(repo, ref, 1))[0] ?? null;
  let cache = caches.get(store);
  if (!cache) {
    cache = new Map();
    caches.set(store, cache);
  }
  const key = JSON.stringify([repo, head?.hash ?? null]);
  const cached = cache.get(key);
  if (cached && cached.until > now) return cached.value;
  if (cache.size >= 8) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const owner = cache;
  const value = analyze(store, repo, head, now).catch((error: unknown) => {
    if (owner.get(key)?.value === value) owner.delete(key);
    throw error;
  });
  cache.set(key, { until: now + 60_000, value });
  return value;
}
