/** Stored proposal lifecycle and views; Git, reviews and merges have separate owners. */
import {
  copyListSnapshot,
  readCopyPageOffset,
  sliceReadCopyPage,
} from "./read-copy-page.js";
import {
  readCopyPageInput,
  type ReadCopyPageInput,
} from "../shared/contract.js";
import { ReadCopyBudgetExceeded } from "@fungi.computer/agar/read-copy";
import { replayKey } from "@fungi.computer/cairn";
import type { AppGitPushFact } from "@fungi.computer/agar/git";
import {
  changeRecord,
  policyDecision,
  changeIdentityOf,
  type ChangeRecord,
  type Change,
  type ChangeDetail,
  type ChangePage,
  type PolicyDecision,
} from "../shared/contract.js";
import { activityEnvelope, type HookEvent } from "../shared/hooks.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import { changeCopyKey, changeObjectsSchema } from "./state.js";
import { decide, review, mayPush } from "./policy.js";
import { compareChange, projectionStore } from "./history.js";
import { recoverExpiredLease } from "./merge.js";
import type { Bonsai, BonsaiActor } from "./service.js";
import { getRepoDetail } from "./repository-copy.js";
import { loadChangeCopy, refreshChangeCopy } from "./change-copy.js";
import { readCopyFrame } from "./git.js";
const ZERO = "0".repeat(40);
function known(bonsai: Bonsai, name: string) {
  const row = bonsai.state.repo(name);
  if (row === null)
    throw new AppMethodRefusal("not_found", `No repository ${name}`);
  return row;
}
function subject(message: string): string {
  const line = (message.split("\n")[0] ?? "").slice(0, 200);
  return line.length === 0 ? "New Change" : line;
}
async function summarizeChange(
  bonsai: Bonsai,
  actor: BonsaiActor,
  row: ChangeRecord,
  signal: AbortSignal,
) {
  const saved = await loadChangeCopy(bonsai, row, signal);
  const authors = saved.headAuthors;
  const facts = bonsai.state.reviewFacts(actor, row, row.head, authors);
  const verdict = review(facts);
  const summary = {
    ...row,
    status: verdict.status,
    mergeable: verdict.decision,
    base: saved.base,
    ahead: saved.ahead.length,
    behind: saved.behind,
  } satisfies Change;
  return { saved, facts, summary };
}

async function describeChange(
  bonsai: Bonsai,
  actor: BonsaiActor,
  row: ChangeRecord,
  signal: AbortSignal,
): Promise<ChangeDetail> {
  const { saved, facts, summary } = await summarizeChange(
    bonsai,
    actor,
    row,
    signal,
  );
  const bytes =
    saved.detailHash === null
      ? null
      : bonsai.state.copies.readBlob(saved.detailHash);
  if (bytes === null) {
    bonsai.state.changeCopies.stale(changeCopyKey(row));
    const rebuilt = await loadChangeCopy(bonsai, row, signal);
    const bytes =
      rebuilt.detailHash === null
        ? null
        : bonsai.state.copies.readBlob(rebuilt.detailHash);
    if (bytes === null)
      throw new AppMethodRefusal("conflict", "Change copy is rebuilding.");
    return describeChange(bonsai, actor, row, signal);
  }
  const objects = changeObjectsSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  return {
    change: summary,
    actions: {
      approve: decide("approve", facts),
      close: decide("close", facts),
    },
    ...objects,
    review: {
      approvals: bonsai.state.approvals(row.repo, row.number),
      checks: bonsai.state.checks(row.repo, row.number),
    },
  };
}

export async function changes(
  bonsai: Bonsai,
  actor: BonsaiActor,
  repo: string,
  state?: ChangeRecord["state"],
  pagination: ReadCopyPageInput = {},
): Promise<ChangePage> {
  known(bonsai, repo);
  const options = readCopyPageInput.parse(pagination);
  const listing = () =>
    bonsai.state
      .changes(repo)
      .filter((row) => state === undefined || row.state === state);
  const listed = listing();
  const identity = (rows: ChangeRecord[]) =>
    rows.map((row) => [
      row.number,
      row.head,
      row.target,
      row.state,
      row.revision,
    ]);
  const scope = JSON.stringify(["changes", repo, state ?? null]);
  const snapshot = await copyListSnapshot(identity(listed));
  const offset = readCopyPageOffset(options.after, scope, snapshot);
  const selected = sliceReadCopyPage(
    listed,
    options.limit,
    offset,
    scope,
    snapshot,
  );
  if (
    options.after !== undefined &&
    selected.items.some(
      (row) =>
        bonsai.state.changeCopies.read(changeCopyKey(row)).kind !== "ready",
    )
  )
    throw new AppMethodRefusal(
      "conflict",
      "Saved Change page is unavailable; restart from the first page.",
    );
  return readCopyFrame(bonsai.store, async (store, signal) => {
    const results: Change[] = [];
    for (const row of selected.items)
      results.push(
        (await summarizeChange({ ...bonsai, store }, actor, row, signal))
          .summary,
      );
    if ((await copyListSnapshot(identity(listing()))) !== snapshot)
      throw new AppMethodRefusal(
        "conflict",
        "The saved page changed; restart from the first page.",
      );
    return selected.next === null
      ? { changes: results }
      : { changes: results, next: selected.next };
  });
}

export function change(
  bonsai: Bonsai,
  actor: BonsaiActor,
  repo: string,
  number: number,
): Promise<ChangeDetail> {
  return readCopyFrame(bonsai.store, (store, signal) =>
    describeChange(
      { ...bonsai, store },
      actor,
      bonsai.state.requireChange(repo, number),
      signal,
    ),
  );
}

export async function openChange(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: {
    repo: string;
    sourceRef: string;
    targetRef?: string | undefined;
    title?: string | undefined;
    body?: string | undefined;
  },
  requestKey: string = replayKey(),
): Promise<ChangeRecord> {
  return readCopyFrame(bonsai.store, (store) =>
    openChangeFrame({ ...bonsai, store }, actor, input, requestKey),
  );
}

async function openChangeFrame(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: {
    repo: string;
    sourceRef: string;
    targetRef?: string | undefined;
    title?: string | undefined;
    body?: string | undefined;
  },
  requestKey: string = replayKey(),
): Promise<ChangeRecord> {
  const key = `open:${requestKey}`;
  const digest = JSON.stringify({ actor, input });
  const cached = bonsai.state.receipt(key, digest, changeRecord);
  if (cached !== null) {
    return cached.result;
  }
  const source = known(bonsai, input.repo);
  const repo = source.parent ?? source.name;
  const [targetRepo, sourceRepo] = await Promise.all([
    getRepoDetail(bonsai, repo),
    getRepoDetail(bonsai, source.name),
  ]);
  const targetRef = input.targetRef ?? targetRepo.defaultBranch;
  if (source.name === repo && input.sourceRef === targetRef)
    throw new AppMethodRefusal("invalid", "Choose a different source branch");
  const head = sourceRepo.refs.find(
    (ref) => ref.name === `refs/heads/${input.sourceRef}`,
  )?.hash;
  const target = targetRepo.refs.find(
    (ref) => ref.name === `refs/heads/${targetRef}`,
  )?.hash;
  if (!head || !target)
    throw new AppMethodRefusal(
      "not_found",
      "The repository branch is unavailable",
    );
  const history = await compareChange(
    projectionStore(bonsai),
    repo,
    source.name,
    head,
    target,
  );
  if (history === null)
    throw new AppMethodRefusal("not_found", "The proposed head is missing");
  const tip =
    history.ahead[0] ?? (await bonsai.store.commit(source.name, head));
  if (tip === null)
    throw new AppMethodRefusal("not_found", "The proposed head is missing");
  const cloneUrl = sourceRepo.cloneUrl;
  const result = bonsai.state.transition(key, digest, changeRecord, () => {
    const decision = decide("open", {
      actor,
      change: {
        state: "open",
        head: head,
        target: target,
        openedBy: actor.name,
        conflict: null,
      },
      head: head,
      approvals: [],
      checks: [],
      headAuthors: [],
      isMaintainer: actor.kind === "human",
      mayPush: mayPush(actor, bonsai.state.repo(source.name)),
      sourceOwner: source.owner,
      soleMember: false,
    });
    if (!decision.allowed)
      throw new AppMethodRefusal(
        "forbidden",
        "Only the source writer can open this Change",
      );
    const existing = bonsai.state
      .changes(repo)
      .find(
        (row) =>
          row.sourceRepo === source.name &&
          row.sourceRef === input.sourceRef &&
          row.targetRef === targetRef &&
          (row.state === "open" || row.state === "merging"),
      );
    if (existing !== undefined) return { result: existing, events: [] };
    const at = Date.now();
    const candidate = {
      repo,
      sourceRepo: source.name,
      sourceRef: input.sourceRef,
      targetRef,
      title: input.title ?? subject(tip.message),
      body: input.body ?? "",
      openedBy: actor.name,
      openedKind: actor.kind,
      createdAt: at,
      updatedAt: at,
      state: "open",
      head: head,
      target: target,
      conflict: null,
      lease: null,
      mergedCommit: null,
      mergedBy: null,
      closedBy: null,
    };
    const row = bonsai.state.insertChange(
      changeRecord.omit({ number: true, revision: true }).parse(candidate),
    );
    return {
      result: row,
      events: [
        bonsai.state.changeEvent(row, actor.name, "change.opened", cloneUrl),
      ],
    };
  });
  try {
    await refreshChangeCopy(bonsai, result, history);
  } catch (error) {
    if (!(error instanceof ReadCopyBudgetExceeded)) throw error;
    bonsai.state.changeCopies.stale(changeCopyKey(result));
  }
  return result;
}

export async function closeChange(
  bonsai: Bonsai,
  actor: BonsaiActor,
  repo: string,
  number: number,
  requestKey: string = replayKey(),
): Promise<PolicyDecision> {
  const key = `close:${requestKey}`;
  const digest = JSON.stringify({ actor, repo, number });
  const cached = bonsai.state.receipt(key, digest, policyDecision);
  if (cached !== null) {
    return cached.result;
  }
  const initial = await recoverExpiredLease(
    bonsai,
    bonsai.state.requireChange(repo, number),
  );
  const cloneUrl = await bonsai.store.cloneUrl(initial.sourceRepo);
  const result = bonsai.state.transition(key, digest, policyDecision, () => {
    const row = bonsai.state.requireChange(repo, number);
    const decision = decide(
      "close",
      bonsai.state.reviewFacts(actor, row, row.head, []),
    );
    if (!decision.allowed) return { result: decision, events: [] };
    const next = bonsai.state.reviseChange(
      {
        ...row,
        state: "closed",
        closedBy: actor.name,
        updatedAt: Date.now(),
      },
      row.revision,
    );
    return {
      result: decision,
      events: [
        bonsai.state.changeEvent(next, actor.name, "change.closed", cloneUrl),
      ],
    };
  });
  return result;
}

/** Apply every prepared ref update within the host push receipt transaction. */
export function reconcilePush(
  bonsai: Bonsai,
  prepared: Readonly<{
    repo: string;
    canonical: string;
    actor: BonsaiActor;
    updates: AppGitPushFact["updates"];
    newCommits: readonly Readonly<{ hash: string; message: string }>[];
    commitsByRef: ReadonlyMap<string, readonly string[]>;
    cloneUrls: ReadonlyMap<string, string>;
    targetHistory: ReadonlyMap<string, ReadonlySet<string>>;
    defaultBranch: string;
    defaultTarget: string;
  }>,
): HookEvent[] {
  const {
    repo,
    canonical,
    actor,
    newCommits,
    commitsByRef,
    cloneUrls,
    targetHistory,
    defaultBranch,
    defaultTarget,
  } = prepared;
  const events: HookEvent[] = [];
  for (const update of prepared.updates) {
    if (!update.ref.startsWith("refs/heads/")) continue;
    const sourceRef = update.ref.slice("refs/heads/".length);
    const branchWork = newCommits.filter((commit) =>
      commitsByRef.get(update.ref)?.includes(commit.hash),
    );
    const at = Date.now();
    const rows = bonsai.state.changes(canonical);
    for (const row of rows) {
      if (row.state !== "open" && row.state !== "merging") continue;
      const url = cloneUrls.get(row.sourceRepo);
      if (url === undefined)
        throw new Error("Missing prepared source clone URL");
      if (
        row.sourceRepo === repo &&
        row.sourceRef === sourceRef &&
        row.head !== update.after
      ) {
        let revised: ChangeRecord = {
          ...row,
          head: update.after === ZERO ? row.head : update.after,
          updatedAt: at,
          conflict: null,
        };
        if (update.after === ZERO)
          revised = {
            ...revised,
            state: "closed",
            closedBy: actor.name,
          };
        const next = bonsai.state.reviseChange(revised, row.revision);
        events.push(
          bonsai.state.changeEvent(
            next,
            actor.name,
            update.after === ZERO ? "change.closed" : "change.updated",
            url,
            { before: row.head, after: update.after },
          ),
        );
      } else if (
        row.repo === repo &&
        row.targetRef === sourceRef &&
        row.target !== update.after
      ) {
        const merged = targetHistory.get(update.ref)?.has(row.head) ?? false;
        let revised: ChangeRecord = {
          ...row,
          target: update.after,
          updatedAt: at,
          conflict: null,
        };
        if (merged)
          revised = {
            ...revised,
            state: "merged",
            mergedBy: actor.name,
            mergedCommit: update.after,
            lease: null,
          };
        const next = bonsai.state.reviseChange(revised, row.revision);
        if (merged) {
          const stored = bonsai.state.record({
            at,
            type: "merge",
            repo: row.repo,
            actor: actor.name,
            data: {
              change: changeIdentityOf(next),
              from: row.sourceRepo,
              ref: row.targetRef,
              before: row.target,
              after: update.after,
            },
          });
          events.push(
            activityEnvelope(stored, {
              name: row.sourceRepo,
              canonical: row.repo,
              cloneUrl: url,
            }),
          );
        }
      }
    }
    if (
      repo !== canonical &&
      update.after !== ZERO &&
      branchWork.length > 0 &&
      !bonsai.state
        .changes(canonical)
        .some(
          (row) =>
            row.sourceRepo === repo &&
            row.sourceRef === sourceRef &&
            row.targetRef === defaultBranch &&
            (row.state === "open" || row.state === "merging"),
        )
    ) {
      const row = bonsai.state.insertChange({
        repo: canonical,
        sourceRepo: repo,
        sourceRef,
        targetRef: defaultBranch,
        title: subject(branchWork[0]?.message ?? ""),
        body: "",
        openedBy: actor.name,
        openedKind: actor.kind,
        createdAt: at,
        updatedAt: at,
        state: "open",
        head: update.after,
        target: defaultTarget,
        conflict: null,
        lease: null,
        mergedCommit: null,
        mergedBy: null,
        closedBy: null,
      });
      const url = cloneUrls.get(repo);
      if (url === undefined)
        throw new Error("Missing prepared source clone URL");
      events.push(
        bonsai.state.changeEvent(row, actor.name, "change.opened", url),
      );
    }
  }
  return events;
}
