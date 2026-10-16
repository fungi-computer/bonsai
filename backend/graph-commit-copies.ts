/** Graph and Commit screen projections in the facet's bounded read copies. */
import * as z from "zod";
import {
  readCopyPageInput,
  type ReadCopyPageInput,
} from "../shared/contract.js";
import { readCopyPageOffset, sliceReadCopyPage } from "./read-copy-page.js";
import { ReadCopyBudgetExceeded } from "@fungi.computer/agar/read-copy";
import {
  commitDetail,
  graph,
  type CommitDetail,
  type Graph,
  type GraphLane,
  type GraphNode,
} from "../shared/contract.js";
import { commitPage, type CommitPage } from "@fungi.computer/agar/roles/files";
import { treeDiff } from "./diff.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import { projectionStore } from "./history.js";
import { readRepositoryRefs } from "./repository-copy.js";
import type { Bonsai } from "./service.js";

const oid = /^[0-9a-f]{40}$/u;
const pageKey = (bonsai: Bonsai, repo: string, ref: string) =>
  JSON.stringify([repo, bonsai.state.repositoryGeneration(repo), ref]);
const graphKey = (bonsai: Bonsai, repo: string) =>
  JSON.stringify([repo, bonsai.state.repositoryGeneration(repo)]);
const graphCopies = (bonsai: Bonsai) =>
  bonsai.state.copies.open("bonsai-graph", graph);
const pages = (bonsai: Bonsai) =>
  bonsai.state.copies.open("bonsai-commit-page", commitPage);
const details = (bonsai: Bonsai) =>
  bonsai.state.copies.open("bonsai-commit-detail", commitDetail);

function known(bonsai: Bonsai, repo: string) {
  const summary = bonsai.state.repo(repo);
  if (summary === null)
    throw new AppMethodRefusal("not_found", `No repository ${repo}`);
  return summary;
}
function localRefs(bonsai: Bonsai, repo: string) {
  known(bonsai, repo);
  return readRepositoryRefs(bonsai, repo).refs;
}
function refHead(bonsai: Bonsai, repo: string, ref: string) {
  if (oid.test(ref)) return ref;
  const found = localRefs(bonsai, repo).find(
    (item) =>
      item.name === ref ||
      item.name === `refs/heads/${ref}` ||
      item.name === `refs/tags/${ref}`,
  );
  return found?.hash ?? null;
}
function localLanes(bonsai: Bonsai, repo: string): GraphLane[] {
  const summary = known(bonsai, repo);
  if (summary.parent !== null)
    throw new AppMethodRefusal("invalid", "Graph the canonical repository");
  return [repo, ...summary.forks].flatMap((member) => {
    const owner = known(bonsai, member).owner;
    return localRefs(bonsai, member)
      .filter((ref) => ref.name.startsWith("refs/heads/"))
      .sort((a, b) =>
        a.name === "refs/heads/main"
          ? -1
          : b.name === "refs/heads/main"
            ? 1
            : a.name.localeCompare(b.name),
      )
      .map((ref) => ({
        id: `${member}:${ref.name.slice(11)}`,
        repo: member,
        ref: ref.name.slice(11),
        owner: member === repo ? null : owner,
        head: ref.hash,
        canonical: member === repo,
      }));
  });
}
function origins(bonsai: Bonsai, value: Graph): Graph {
  const recorded = bonsai.state.origins(value.nodes.map((node) => node.hash));
  return {
    lanes: value.lanes,
    nodes: value.nodes.map((node) => ({
      ...node,
      agent: recorded.get(node.hash)?.agent ?? null,
      origin: recorded.get(node.hash)?.repo ?? null,
    })),
  };
}

/** Caller supplies the existing bounded frame; this module never resets its budget. */
export async function readGraph(bonsai: Bonsai, repo: string): Promise<Graph> {
  const lanes = localLanes(bonsai, repo);
  const copy = graphCopies(bonsai);
  const key = graphKey(bonsai, repo);
  const saved = copy.read(key);
  if (
    saved.kind === "ready" &&
    JSON.stringify(saved.value.lanes) === JSON.stringify(lanes)
  )
    return origins(bonsai, saved.value);
  // A changed family must never retain its old ready projection if rebuilding fails.
  copy.stale(key);
  const store = projectionStore(bonsai);
  const nodes = new Map<string, GraphNode>();
  for (const lane of lanes) {
    for (const commit of await store.log(lane.repo, lane.head, 60)) {
      const existing = nodes.get(commit.hash);
      if (existing) {
        existing.lanes.push(lane.id);
        continue;
      }
      nodes.set(commit.hash, {
        hash: commit.hash,
        parents: commit.parents,
        message: commit.message.split("\n")[0] ?? "",
        author: commit.author.name,
        committedAt: commit.committedAt,
        agent: null,
        origin: null,
        lanes: [lane.id],
      });
    }
  }
  const value = {
    lanes,
    nodes: [...nodes.values()].sort((a, b) => b.committedAt - a.committedAt),
  };
  copy.write(key, null, value);
  return origins(bonsai, value);
}

/** Mutable branch/tag pages chain on local refs; OID pages retain immutable history. */
export async function readCommits(
  bonsai: Bonsai,
  input: { repo: string; ref: string } & ReadCopyPageInput,
): Promise<CommitPage> {
  known(bonsai, input.repo);
  const options = readCopyPageInput.parse({
    limit: input.limit,
    after: input.after,
  });
  const head = refHead(bonsai, input.repo, input.ref);
  const scope = JSON.stringify(["commits", input.repo, input.ref]);
  const offset = readCopyPageOffset(options.after, scope, head);
  const copy = pages(bonsai),
    key = pageKey(bonsai, input.repo, input.ref);
  const saved = copy.read(key);
  if (
    options.after !== undefined &&
    (saved.kind !== "ready" || saved.head !== head)
  )
    throw new AppMethodRefusal(
      "conflict",
      "Saved Commit page is unavailable; restart from the first page.",
    );
  let value: CommitPage;
  if (saved.kind === "ready" && saved.head === head) value = saved.value;
  else {
    copy.stale(key);
    const commits =
      head === null
        ? []
        : await projectionStore(bonsai).log(input.repo, head, 100);
    value = {
      ref: input.ref,
      commits: commits.map((commit) => ({ commit, agent: null })),
    };
    if (!oid.test(input.ref) && refHead(bonsai, input.repo, input.ref) !== head)
      throw new AppMethodRefusal(
        "unavailable",
        "Commit refs changed during rebuild.",
      );
    copy.write(key, head, value);
  }
  const selected = sliceReadCopyPage(
    value.commits,
    options.limit,
    offset,
    scope,
    head,
  );
  const recorded = bonsai.state.origins(
    selected.items.map((item) => item.commit.hash),
  );
  const result: CommitPage = {
    ref: value.ref,
    commits: selected.items.map((item) => ({
      ...item,
      agent: recorded.get(item.commit.hash)?.agent ?? null,
    })),
  };
  if (selected.next !== null) result.next = selected.next;
  return result;
}

/** Immutable OID detail and its first-parent diff survive ref changes and restarts. */
export async function readCommitDetail(
  bonsai: Bonsai,
  input: { repo: string; hash: string },
): Promise<CommitDetail> {
  known(bonsai, input.repo);
  if (!oid.test(input.hash))
    throw new AppMethodRefusal("invalid", "Expected a commit hash");
  const copy = details(bonsai),
    key = pageKey(bonsai, input.repo, input.hash);
  const saved = copy.read(key);
  let value: CommitDetail;
  if (saved.kind === "ready") value = saved.value;
  else {
    const store = projectionStore(bonsai);
    const commit = await store.commit(input.repo, input.hash);
    if (commit === null)
      throw new AppMethodRefusal("not_found", "No such commit");
    const parent =
      commit.parents[0] === undefined
        ? null
        : await store.commit(input.repo, commit.parents[0]);
    value = {
      commit,
      agent: null,
      diff: await treeDiff(
        store,
        input.repo,
        parent?.treeHash ?? null,
        commit.treeHash,
      ),
    };
    copy.write(key, input.hash, value);
  }
  return {
    ...value,
    agent: bonsai.state.origins([input.hash]).get(input.hash)?.agent ?? null,
  };
}

/** Composer calls synchronously after receipt check and BEFORE any provider await. */
export function invalidateGraphCommitCopies(
  bonsai: Bonsai,
  repo: string,
): void {
  known(bonsai, repo);
  const canonical = bonsai.state.canonicalOf(repo);
  graphCopies(bonsai).stale(graphKey(bonsai, canonical));
  const saved = bonsai.state.repositoryCopies.read(repo);
  if (saved.kind === "ready")
    for (const ref of saved.value.refs) {
      const copy = pages(bonsai);
      copy.stale(pageKey(bonsai, repo, ref.name));
      copy.stale(
        pageKey(bonsai, repo, ref.name.replace(/^refs\/(heads|tags)\//u, "")),
      );
    }
}

const rebuildItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("graph"), repo: z.string() }),
  z.object({ kind: z.literal("commits"), repo: z.string(), ref: z.string() }),
  z.object({
    kind: z.literal("commit"),
    repo: z.string(),
    hash: z.string().regex(oid),
  }),
]);
/** Opaque cursor keys are App-owned values, not a second shared rebuild protocol. */
export function graphCommitCopyKeys(bonsai: Bonsai, repo: string): string[] {
  const canonical = bonsai.state.canonicalOf(repo);
  const family = known(bonsai, canonical);
  return [
    JSON.stringify({ kind: "graph", repo: canonical }),
    ...[canonical, ...family.forks].flatMap((member) =>
      localRefs(bonsai, member).flatMap((ref) => [
        JSON.stringify({
          kind: "commits",
          repo: member,
          ref: ref.name.replace(/^refs\/(heads|tags)\//u, ""),
        }),
        JSON.stringify({ kind: "commit", repo: member, hash: ref.hash }),
      ]),
    ),
  ];
}
/** One selected foreground key in the caller's frame; unfinished keys retain their cursor. */
export async function rebuildGraphCommitCopy(
  bonsai: Bonsai,
  key: string,
): Promise<boolean> {
  const item = rebuildItem.parse(JSON.parse(key));
  try {
    switch (item.kind) {
      case "graph":
        await readGraph(bonsai, item.repo);
        break;
      case "commits":
        await readCommits(bonsai, item);
        break;
      case "commit":
        await readCommitDetail(bonsai, item);
        break;
    }
    return true;
  } catch (error) {
    if (
      error instanceof ReadCopyBudgetExceeded ||
      (error instanceof AppMethodRefusal && error.code === "unavailable")
    )
      return false;
    throw error;
  }
}
/** Push composer runs this after Changed-Change refresh, before Files, on the same store. */
export async function refreshGraphCommitCopies(
  bonsai: Bonsai,
  repo: string,
): Promise<boolean> {
  for (const key of graphCommitCopyKeys(bonsai, repo))
    if (!(await rebuildGraphCommitCopy(bonsai, key))) return false;
  return true;
}
