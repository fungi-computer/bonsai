import {
  decodeGillOptionsResponse,
  type GillOptionsResponse,
} from "@fungi.computer/gills";
import type { PickerOptionsInput } from "../shared/picker-options.js";
import { readRepositoryRefs } from "./repository-copy.js";
import {
  copyListSnapshot,
  readCopyPageOffset,
  sliceReadCopyPage,
} from "./read-copy-page.js";
/**
 * Bonsai's operations, independent of how they are called: App methods (for
 * Agents and the host), the App's own UI, and push facts from the host all
 * land here. Git goes through the GIT binding, events leave through the
 * host's emit, and state lives in the App's SQLite.
 */
import * as z from "zod";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import { replayKey } from "@fungi.computer/cairn";
import {
  appGitPushFactSchema,
  type AppGitPushFact,
} from "@fungi.computer/agar/git";
import { ReadCopyBudgetExceeded } from "@fungi.computer/agar/read-copy";
import type { EventSink } from "@fungi.computer/oyster/git";
import type {
  Activity,
  CommitDetail,
  Graph,
  IssueFiles,
  RepoSummary,
  ReadCopyPageInput,
} from "../shared/contract.js";
import type {
  Commit,
  CommitPage,
  FileContent,
  FileList,
  TreeListing,
} from "@fungi.computer/agar/roles/files";
import { activityEnvelope, type HookEvent } from "../shared/hooks.js";
import { drainOutbox } from "./state.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import { readCodeInsights } from "./insights.js";
import { reconcilePush } from "./changes.js";
import { refreshChangeCopy } from "./change-copy.js";
import { refreshRepositoryCopy } from "./repository-copy.js";
import { reachableCommits, projectionStore } from "./history.js";
import { changedPaths, decodeText, listPaths } from "./diff.js";
import { readCopyFrame, type GitStore } from "./git.js";
import {
  listFilesCopy,
  listTreeCopy,
  readFileCopy,
  invalidateFilesCopies,
  filesCopyRequests,
  refreshFilesCopy,
} from "./files-copy.js";
import {
  readGraph,
  readCommits,
  readCommitDetail,
  invalidateGraphCommitCopies,
  graphCommitCopyKeys,
  refreshGraphCommitCopies,
  rebuildGraphCommitCopy,
} from "./graph-commit-copies.js";
import type { ActorKind, NewActivity, BonsaiState } from "./state.js";

/**
 * Who is acting, as the host attributes the call. `soleMember` is the host's
 * attestation that this person is currently their Team's only member; Bonsai
 * never infers it from the people it has seen.
 */
export type BonsaiActor = Readonly<{
  name: string;
  kind: ActorKind;
  soleMember?: true;
}>;

/** The host's EVENTS binding (Oyster's EventSink). */
export type { EventSink };

export type Bonsai = Readonly<{
  store: GitStore;
  state: BonsaiState;
  events: EventSink;
}>;

const MAX_ISSUE_FILES = 200;
const MAX_ISSUE_BYTES = 64_000;
const HEX40 = /^[0-9a-f]{40}$/u;
const ZERO = "0".repeat(40);
export const repoNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

const recordedResult = z.literal(true);

/** Record activity and durable envelopes in the same local transaction. */
async function publish(
  bonsai: Bonsai,
  event: NewActivity,
  mutate?: () => void,
): Promise<void> {
  const cloneUrl = await bonsai.store.cloneUrl(event.repo);
  bonsai.state.transition(
    `activity:${replayKey()}`,
    JSON.stringify(event),
    recordedResult,
    () => {
      mutate?.();
      return {
        result: true,
        events: activityEvents(bonsai, bonsai.state.record(event), cloneUrl),
      };
    },
  );
}

function activityEvents(
  bonsai: Bonsai,
  stored: Activity,
  cloneUrl: string,
): HookEvent[] {
  return [
    activityEnvelope(stored, {
      name: stored.repo,
      canonical: bonsai.state.canonicalOf(stored.repo),
      cloneUrl,
    }),
  ];
}

function known(bonsai: Bonsai, name: string): RepoSummary {
  const summary = bonsai.state.repo(name);
  if (summary === null)
    throw new AppMethodRefusal("not_found", `No repository ${name}`);
  return summary;
}

async function resolve(
  store: GitStore,
  repo: string,
  ref: string,
): Promise<Commit> {
  const commit = HEX40.test(ref)
    ? await store.commit(repo, ref)
    : ((await store.log(repo, ref, 1))[0] ?? null);
  if (commit === null)
    throw new AppMethodRefusal("not_found", `Unknown ref ${ref}`);
  return commit;
}

type TreeTarget = Readonly<{ hash: string; type: "tree" | "blob" }>;

async function treeAt(
  store: GitStore,
  repo: string,
  commit: Commit,
  path: string,
): Promise<TreeTarget | null> {
  let current: TreeTarget = { hash: commit.treeHash, type: "tree" };
  for (const segment of path.split("/").filter(Boolean)) {
    if (current.type !== "tree") return null;
    const entries = await store.tree(repo, current.hash);
    const entry = entries?.find((item) => item.name === segment);
    if (!entry) return null;
    if (entry.type === "tree") current = { hash: entry.hash, type: "tree" };
    else if (entry.type === "blob")
      current = { hash: entry.hash, type: "blob" };
    else return null;
  }
  return current;
}

export function listRepos(bonsai: Bonsai): RepoSummary[] {
  return bonsai.state.repos();
}

/** Repository placement choices come solely from the saved local catalog. */
export async function repositoryOptions(
  bonsai: Bonsai,
  input: PickerOptionsInput,
): Promise<GillOptionsResponse> {
  const rows = bonsai.state.repositoryOptions();
  const snapshot = await copyListSnapshot(
    rows.map((row) => [row.name, row.description]),
  );
  const scope = JSON.stringify(["repos.options"]);
  const selected = sliceReadCopyPage(
    rows,
    input.limit,
    readCopyPageOffset(input.after, scope, snapshot),
    scope,
    snapshot,
  );
  const result: GillOptionsResponse = {
    options: selected.items.map((row) => {
      const option: GillOptionsResponse["options"][number] = {
        value: row.name,
        label: row.name,
      };
      return row.description === null
        ? option
        : { ...option, detail: row.description };
    }),
  };
  return decodeGillOptionsResponse(
    selected.next === null ? result : { ...result, next: selected.next },
  );
}

/** Branch choices never rebuild or bypass the durable saved-ref readiness gate. */
export async function branchOptions(
  bonsai: Bonsai,
  input: PickerOptionsInput,
): Promise<GillOptionsResponse> {
  const repo = input.params.repo;
  if (!repo)
    throw new AppMethodRefusal(
      "invalid",
      "Choose a repository before choosing a branch.",
    );
  const choices = () =>
    readRepositoryRefs(bonsai, repo)
      .refs.filter(
        (ref) =>
          ref.name.startsWith("refs/heads/") &&
          ref.name.length - "refs/heads/".length <= 256,
      )
      .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  const refs = choices();
  const identity = (rows: typeof refs) =>
    rows.map((row) => [row.name, row.hash]);
  const identityJson = JSON.stringify(identity(refs));
  const snapshot = await copyListSnapshot(identity(refs));
  const scope = JSON.stringify(["branches.options", repo]);
  const selected = sliceReadCopyPage(
    refs,
    input.limit,
    readCopyPageOffset(input.after, scope, snapshot),
    scope,
    snapshot,
  );
  if (JSON.stringify(identity(choices())) !== identityJson)
    throw new AppMethodRefusal(
      "conflict",
      "Branch options changed; restart from the first page.",
    );
  const result: GillOptionsResponse = {
    options: selected.items.map((ref) => {
      const name = ref.name.slice("refs/heads/".length);
      return { value: name, label: name };
    }),
  };
  return decodeGillOptionsResponse(
    selected.next === null ? result : { ...result, next: selected.next },
  );
}

export async function createRepo(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: { name: string; description: string },
): Promise<RepoSummary> {
  if (actor.kind !== "human")
    throw new AppMethodRefusal("forbidden", "Only people create repositories");
  assertRepoName(input.name);
  bonsai.state.assertRepoAvailable(input.name);
  const revision = bonsai.state.repositoryRefStatus(input.name).revision;
  const info = await bonsai.store.create(input.name, input.description);
  return recordRepo(bonsai, actor, input, info.defaultBranch, revision);
}

/** A repository name Bonsai can hold: lowercase, digits, dots, dashes; no `--`. */
export function assertRepoName(name: string): void {
  if (!repoNamePattern.test(name) || name.includes("--"))
    throw new AppMethodRefusal(
      "invalid",
      "Use lowercase letters, digits, dots, dashes; no --",
    );
}

/** Record a forked App's source repository, which the host already created
 * in this installation's Git, as an ordinary Bonsai repository its owner
 * edits and merges (each merge emits `change.merged`). */
export async function recordAppFork(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: { name: string; description: string },
  revision: number,
): Promise<RepoSummary> {
  const info = await bonsai.store.info(input.name);
  if (info === null)
    throw new AppMethodRefusal("unavailable", "The forked source is missing");
  return recordRepo(bonsai, actor, input, info.defaultBranch, revision);
}

/** The repository-availability revision a later record must still match. */
export function repoRevision(bonsai: Bonsai, name: string): number {
  bonsai.state.assertRepoAvailable(name);
  return bonsai.state.repositoryRefStatus(name).revision;
}

async function recordRepo(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: { name: string; description: string },
  defaultBranch: string,
  revision: number,
): Promise<RepoSummary> {
  const refs = await bonsai.store.refs(input.name);
  const cloneUrl = await bonsai.store.cloneUrl(input.name);
  await publish(
    bonsai,
    {
      at: Date.now(),
      type: "repo.created",
      repo: input.name,
      actor: actor.name,
      data: {},
    },
    () => {
      bonsai.state.assertRepoAvailable(input.name, revision);
      bonsai.state.registerRepo({
        name: input.name,
        description: input.description || null,
        parent: null,
        owner: null,
      });
      bonsai.state.seeActor(actor.name, actor.kind);
      bonsai.state.publishRepositoryRefs(
        input.name,
        revision,
        refs.find((ref) => ref.name === `refs/heads/${defaultBranch}`)?.hash ??
          null,
        {
          defaultBranch,
          refs: refs.filter((ref) => ref.name !== "HEAD"),
          cloneUrl,
          empty: refs.length === 0,
        },
      );
    },
  );
  return known(bonsai, input.name);
}

const deletions = new WeakMap<
  BonsaiState,
  Map<string, Promise<{ deleted: true }>>
>();

/** Withdraw local metadata, then retry provider cleanup under the same owner. */
export async function deleteRepo(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  name: string,
): Promise<{ deleted: true }> {
  if (caller.actor.kind !== "member" || caller.role !== "owner")
    throw new AppMethodRefusal(
      "forbidden",
      "Only the owner can delete repositories",
    );
  const active =
    deletions.get(bonsai.state) ??
    new Map<string, Promise<{ deleted: true }>>();
  deletions.set(bonsai.state, active);
  const existing = active.get(name);
  if (existing) return existing;
  const cleanup = async (): Promise<{ deleted: true }> => {
    try {
      const current = bonsai.state.repo(name);
      if ((current?.forks.length ?? 0) > 0)
        throw new AppMethodRefusal(
          "conflict",
          "Delete the repository's forks first",
        );
      if (current !== null) invalidateGraphCommitCopies(bonsai, name);
      invalidateFilesCopies(bonsai, name);
      bonsai.state.removeRepo(name);
      await bonsai.store.binding.delete(name);
      bonsai.state.completeRepoDeletion(name);
      return { deleted: true };
    } finally {
      active.delete(name);
    }
  };
  const pending = Promise.resolve().then(cleanup);
  active.set(name, pending);
  return pending;
}

/** Give an actor its own fork of a canonical repository (idempotent). */
export async function forkFor(
  bonsai: Bonsai,
  actor: BonsaiActor,
  name: string,
): Promise<RepoSummary> {
  const source = known(bonsai, name);
  if (source.parent !== null)
    throw new AppMethodRefusal("invalid", "Fork the canonical repository");
  const forkName = `${source.name}--${actor.name}`;
  bonsai.state.assertRepoAvailable(forkName);
  const revision = bonsai.state.repositoryRefStatus(forkName).revision;
  const sourceRevision = bonsai.state.repositoryRefStatus(source.name).revision;
  const existing = bonsai.state.repo(forkName);
  if (existing !== null) return existing;
  // The store returns an existing destination (an earlier attempt may have
  // created it before failing); adopt it only when it is a fork of source.
  const info = await bonsai.store.fork(
    source.name,
    forkName,
    `${actor.name}'s fork of ${source.name}`,
  );
  if (info.source !== source.name)
    throw new AppMethodRefusal(
      "conflict",
      `A repository named ${forkName} exists and is not a fork of ${source.name}`,
    );
  const refs = await bonsai.store.refs(forkName);
  const cloneUrl = await bonsai.store.cloneUrl(forkName);
  await publish(
    bonsai,
    {
      at: Date.now(),
      type: "fork",
      repo: source.name,
      actor: actor.name,
      data: { fork: forkName },
    },
    () => {
      bonsai.state.assertRepoAvailable(forkName, revision);
      bonsai.state.assertRepoAvailable(source.name, sourceRevision);
      known(bonsai, source.name);
      bonsai.state.registerRepo({
        name: forkName,
        description: null,
        parent: source.name,
        owner: actor.name,
      });
      bonsai.state.seeActor(actor.name, actor.kind);
      bonsai.state.publishRepositoryRefs(
        forkName,
        revision,
        refs.find((ref) => ref.name === `refs/heads/${info.defaultBranch}`)
          ?.hash ?? null,
        {
          defaultBranch: info.defaultBranch,
          refs: refs.filter((ref) => ref.name !== "HEAD"),
          cloneUrl,
          empty: refs.length === 0,
        },
      );
    },
  );
  return known(bonsai, forkName);
}

export async function listTree(
  bonsai: Bonsai,
  input: { repo: string; ref: string; path: string },
): Promise<TreeListing> {
  return readCopyFrame(bonsai.store, (store) =>
    listTreeCopy({ ...bonsai, store }, input),
  );
}

export async function listFiles(
  bonsai: Bonsai,
  input: { repo: string; ref: string },
): Promise<FileList> {
  return readCopyFrame(bonsai.store, (store) =>
    listFilesCopy({ ...bonsai, store }, input),
  );
}

export async function readFile(
  bonsai: Bonsai,
  input: { repo: string; ref: string; path: string },
): Promise<FileContent> {
  return readCopyFrame(bonsai.store, (store) =>
    readFileCopy({ ...bonsai, store }, input),
  );
}

export async function readIssueFiles(
  bonsai: Bonsai,
  input: { repo: string; ref: string },
): Promise<IssueFiles> {
  const repo = known(bonsai, input.repo).name;
  const store = bonsai.store;
  const commit = await resolve(store, repo, input.ref);
  const root = await treeAt(store, repo, commit, "issues");
  const files: Record<string, string> = {};
  let truncated = false;
  if (root?.type === "tree") {
    const listing = await listPaths(store, repo, root.hash);
    const markdown = listing.paths.filter((path) => path.endsWith(".md"));
    truncated = listing.truncated || markdown.length > MAX_ISSUE_FILES;
    for (const path of markdown.slice(0, MAX_ISSUE_FILES)) {
      const target = await treeAt(store, repo, commit, `issues/${path}`);
      const bytes =
        target?.type === "blob" ? await store.blob(repo, target.hash) : null;
      const text =
        bytes === null || bytes.length > MAX_ISSUE_BYTES
          ? null
          : decodeText(bytes);
      if (text?.kind === "text") files[path] = text.text;
    }
  }
  return { ref: input.ref, commit, files, truncated };
}

export async function listCommits(
  bonsai: Bonsai,
  input: { repo: string; ref: string } & ReadCopyPageInput,
): Promise<CommitPage> {
  return readCopyFrame(bonsai.store, (store) =>
    readCommits({ ...bonsai, store }, input),
  );
}

export async function getCommitDetail(
  bonsai: Bonsai,
  input: { repo: string; hash: string },
): Promise<CommitDetail> {
  return readCopyFrame(bonsai.store, (store) =>
    readCommitDetail({ ...bonsai, store }, input),
  );
}

export async function buildGraph(bonsai: Bonsai, name: string): Promise<Graph> {
  return readCopyFrame(bonsai.store, (store) =>
    readGraph({ ...bonsai, store }, name),
  );
}

export function listActivity(
  bonsai: Bonsai,
  input: { repo: string | null; limit: number; after: number },
): Activity[] {
  return bonsai.state.events(input.repo, input.limit, input.after);
}

/** Stable host principal attribution; display names never determine ownership. */
function pushActor(writer: AppGitPushFact["writer"]): BonsaiActor {
  if (writer.kind === "installation" && writer.onBehalfOf === null)
    return { name: writer.installationId, kind: "agent" };
  const actor = writer.kind === "actor" ? writer.actor : writer.onBehalfOf;
  if (actor === null)
    throw new AppMethodRefusal("invalid", "Push caller unavailable");
  switch (actor.kind) {
    case "member":
      return { name: actor.memberId, kind: "human" };
    case "agent":
      return { name: actor.agentId, kind: "agent" };
    case "team-key":
      return { name: actor.keyId, kind: "agent" };
  }
}

/**
 * A push the host accepted for one of Bonsai's repositories. Records which
 * commits are new work (commits Bonsai already saw elsewhere, such as a fork
 * catching up with main, are not), the paths touched, and emits git.push.
 */
export async function observePush(
  bonsai: Bonsai,
  fact: AppGitPushFact,
): Promise<void> {
  await readCopyFrame(bonsai.store, (store) => {
    const runtime = { ...bonsai, store };
    return observePushFrame(
      { ...runtime, store: projectionStore(runtime) },
      fact,
    );
  });
  await drainOutbox(bonsai);
}

/** A new branch's paths are the ones it changes from the repository's
 * default head, not its whole tree; the default branch itself, or a first
 * push, has no base. The head is read once per push, however many branches
 * it creates. */
function defaultBase(bonsai: Bonsai, repo: string) {
  let base:
    | Promise<Readonly<{ branch: string; commit: Commit | null }> | null>
    | undefined;
  const read = async () => {
    const info = await bonsai.store.info(repo);
    if (info === null) return null;
    const head = (await bonsai.store.refs(repo)).find(
      (ref) => ref.name === `refs/heads/${info.defaultBranch}`,
    )?.hash;
    return {
      branch: `refs/heads/${info.defaultBranch}`,
      commit: head === undefined ? null : await bonsai.store.commit(repo, head),
    };
  };
  return async (ref: string) => {
    base ??= read();
    const resolved = await base;
    return resolved === null || resolved.branch === ref
      ? null
      : resolved.commit;
  };
}

async function observePushFrame(
  bonsai: Bonsai,
  raw: AppGitPushFact,
): Promise<void> {
  const fact = appGitPushFactSchema.parse(raw);
  const key = `push:${fact.eventId}`;
  const digest = JSON.stringify(fact);
  if (bonsai.state.receipt(key, digest, recordedResult) !== null) return;
  const repo = known(bonsai, fact.repository).name;
  const refsRevision = bonsai.state.invalidateRepositoryRefs(repo);
  invalidateGraphCommitCopies(bonsai, repo);
  invalidateFilesCopies(bonsai, repo);
  const actor = pushActor(fact.writer);
  const commits: { hash: string; message: string }[] = [];
  const commitsByRef = new Map<string, string[]>();
  const paths = new Set<string>();
  const branchBase = defaultBase(bonsai, repo);
  for (const update of fact.updates) {
    if (update.after === ZERO) continue;
    const history = await bonsai.store.log(repo, update.after, 50);
    const branchCommits: string[] = [];
    commitsByRef.set(update.ref, branchCommits);
    for (const commit of history) {
      if (commit.hash === update.before) break;
      branchCommits.push(commit.hash);
      commits.push({
        hash: commit.hash,
        message: commit.message.split("\n")[0] ?? "",
      });
    }
    const before =
      update.before === ZERO
        ? await branchBase(update.ref)
        : await bonsai.store.commit(repo, update.before);
    const after = history[0];
    if (after)
      for (const changed of await changedPaths(
        bonsai.store,
        repo,
        before?.treeHash ?? null,
        after.treeHash,
      ))
        paths.add(changed.path);
  }
  const cloneUrl = await bonsai.store.cloneUrl(repo);
  const canonical = bonsai.state.canonicalOf(repo);
  const summary = known(bonsai, canonical);
  const cloneUrls = new Map(
    await Promise.all(
      [canonical, ...summary.forks].map(
        async (name) => [name, await bonsai.store.cloneUrl(name)] as const,
      ),
    ),
  );
  const targetHistory = new Map<string, ReadonlySet<string>>();
  if (repo === canonical)
    for (const update of fact.updates) {
      if (update.ref.startsWith("refs/heads/") && update.after !== ZERO)
        targetHistory.set(
          update.ref,
          await reachableCommits(bonsai.store, repo, update.after),
        );
    }
  const info = await bonsai.store.info(canonical);
  if (info === null)
    throw new AppMethodRefusal("not_found", "The target repository is missing");
  const defaultTarget =
    (await bonsai.store.refs(canonical)).find(
      (ref) => ref.name === `refs/heads/${info.defaultBranch}`,
    )?.hash ?? ZERO;
  const repoInfo = repo === canonical ? info : await bonsai.store.info(repo);
  if (repoInfo === null)
    throw new AppMethodRefusal("not_found", "Repository storage is missing");
  const repoRefs = await bonsai.store.refs(repo);
  const beforeCopies = new Set(
    bonsai.state
      .changes(canonical)
      .map((row) =>
        JSON.stringify([row.repo, row.sourceRepo, row.head, row.target]),
      ),
  );
  bonsai.state.transition(key, digest, recordedResult, () => {
    if (bonsai.state.repositoryRefStatus(repo).revision !== refsRevision)
      throw new AppMethodRefusal(
        "unavailable",
        "Repository refs changed during push preparation.",
      );
    const metadata = {
      defaultBranch: repoInfo.defaultBranch,
      refs: repoRefs.filter((ref) => ref.name !== "HEAD"),
      cloneUrl,
      empty: repoRefs.length === 0,
    };
    const defaultUpdate = fact.updates.find(
      (update) => update.ref === `refs/heads/${repoInfo.defaultBranch}`,
    );
    if (defaultUpdate !== undefined)
      bonsai.state.repositoryCopies.apply(repo, {
        ...defaultUpdate,
        value: metadata,
      });
    else
      bonsai.state.repositoryCopies.write(
        repo,
        repoRefs.find(
          (ref) => ref.name === `refs/heads/${repoInfo.defaultBranch}`,
        )?.hash ?? null,
        metadata,
      );
    const ready = bonsai.state.repositoryCopies.read(repo);
    if (ready.kind === "ready")
      bonsai.state.publishRepositoryRefs(
        repo,
        refsRevision,
        ready.head,
        metadata,
      );
    const seen = bonsai.state.origins(commits.map((commit) => commit.hash));
    bonsai.state.seeActor(actor.name, actor.kind);
    const newCommits = [
      ...new Map(
        commits
          .filter((commit) => !seen.has(commit.hash))
          .map((commit) => [commit.hash, commit]),
      ).values(),
    ];
    const events = activityEvents(
      bonsai,
      bonsai.state.record({
        at: Date.now(),
        type: "push",
        repo,
        actor: actor.name,
        data: {
          updates: [...fact.updates],
          commits: newCommits,
          paths: [...paths].slice(0, 200),
        },
      }),
      cloneUrl,
    );
    events.push(
      ...reconcilePush(bonsai, {
        repo,
        canonical,
        actor,
        updates: fact.updates,
        newCommits,
        commitsByRef,
        cloneUrls,
        targetHistory,
        defaultBranch: info.defaultBranch,
        defaultTarget,
      }),
    );
    return { result: true, events };
  });
  for (const row of bonsai.state.changes(canonical)) {
    if (
      !beforeCopies.has(
        JSON.stringify([row.repo, row.sourceRepo, row.head, row.target]),
      )
    ) {
      try {
        await refreshChangeCopy(bonsai, row);
      } catch (error) {
        if (!(error instanceof ReadCopyBudgetExceeded)) throw error;
        bonsai.state.changeCopies.stale(
          JSON.stringify([row.repo, row.sourceRepo, row.head, row.target]),
        );
      }
    }
  }
  if (!bonsai.state.repositoryRefStatus(repo).pending) {
    try {
      await refreshGraphCommitCopies(bonsai, repo);
      for (const request of filesCopyRequests(bonsai, repo)) {
        try {
          await refreshFilesCopy(bonsai, request);
        } catch (error) {
          if (!(
            error instanceof AppMethodRefusal && error.code === "not_found"
          ))
            throw error;
        }
      }
    } catch (error) {
      if (
        !(error instanceof ReadCopyBudgetExceeded) &&
        !(error instanceof AppMethodRefusal && error.code === "unavailable")
      )
        throw error;
    }
  }
}

export function getCodeInsights(
  bonsai: Bonsai,
  input: { repo: string; ref: string },
) {
  known(bonsai, input.repo);
  return readCodeInsights(bonsai.store, input.repo, input.ref);
}

/** One selected foreground key shares a single frame and resumes after exhaustion. */
export async function rebuildCopies(bonsai: Bonsai, cursor: string | null) {
  const repos = bonsai.state
    .repos()
    .flatMap((repo) => [repo.name, ...repo.forks]);
  const pending = repos.find(
    (repo) =>
      bonsai.state.repositoryRefStatus(repo).pending ||
      bonsai.state.repositoryCopies.read(repo).kind !== "ready",
  );
  const items = [
    ...repos.map((repo) => ({
      key: `0:repo:${repo}`,
      run: async (runtime: Bonsai, signal: AbortSignal) => {
        const detail = await refreshRepositoryCopy(runtime, repo, signal);
        for (const ref of detail.refs)
          if (ref.name.startsWith("refs/heads/"))
            await reachableCommits(runtime.store, repo, ref.hash);
        return true;
      },
    })),
    ...bonsai.state.changes(null).map((row) => ({
      key: `1:change:${row.repo}:${String(row.number).padStart(10, "0")}`,
      run: async (runtime: Bonsai) => {
        await refreshChangeCopy(runtime, row);
        return true;
      },
    })),
    ...(pending === undefined
      ? bonsai.state.repos().flatMap((repo) =>
          graphCommitCopyKeys(bonsai, repo.name).map((key) => ({
            key: `2:graph:${key}`,
            run: (runtime: Bonsai) => rebuildGraphCommitCopy(runtime, key),
          })),
        )
      : []),
    ...repos.flatMap((repo) =>
      filesCopyRequests(bonsai, repo).map((request) => ({
        key: `3:files:${JSON.stringify(request)}`,
        run: async (runtime: Bonsai) => {
          try {
            await refreshFilesCopy(runtime, request);
          } catch (error) {
            if (!(
              error instanceof AppMethodRefusal && error.code === "not_found"
            ))
              throw error;
          }
          return true;
        },
      })),
    ),
  ].sort((a, b) => a.key.localeCompare(b.key));
  const start = pending === undefined ? cursor : `0:repo:${pending}`;
  const index =
    start === null
      ? 0
      : items.findIndex((item) => item.key.localeCompare(start) >= 0);
  const item = items[index];
  if (item === undefined) return { done: true, cursor: null };
  try {
    const complete = await readCopyFrame(bonsai.store, (store, signal) => {
      const runtime = { ...bonsai, store };
      return item.run({ ...runtime, store: projectionStore(runtime) }, signal);
    });
    if (!complete) return { done: false, cursor: item.key };
  } catch (error) {
    if (
      error instanceof ReadCopyBudgetExceeded ||
      (error instanceof AppMethodRefusal && error.code === "unavailable")
    )
      return { done: false, cursor: item.key };
    throw error;
  }
  // Re-enumerate after metadata pages so newly discovered refs enter the later phase.
  if (pending !== undefined) return { done: false, cursor: item.key };
  const next = items[index + 1];
  return { done: next === undefined, cursor: next?.key ?? null };
}
