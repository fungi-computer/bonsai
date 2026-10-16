/** Lease admission, source-pinned Git CAS, settlement and recovery. */
import * as z from "zod";
import {
  begin,
  runStep,
  sqliteGitStepMaterial,
  dropMaterial,
  gitStepSchema,
  GitStepMaterialError,
} from "@fungi.computer/agar/git-steps";
import { gitSha1Schema } from "@fungi.computer/puffball/git-representation";
import type { GitMergeOutcome } from "@fungi.computer/agar/git-commit";
import { mergeBranch } from "@fungi.computer/agar/git-commit";
import { replayKey } from "@fungi.computer/cairn";
import {
  changeRecord,
  changeIdentityOf,
  mergeResult,
  type ChangeRecord,
  type MergeResult,
} from "../shared/contract.js";
import { activityEnvelope, type HookEvent } from "../shared/hooks.js";
import { changeCopyKey } from "./state.js";
import { refreshChangeCopy } from "./change-copy.js";
import { readCopyFrame } from "./git.js";
import { ReadCopyBudgetExceeded } from "@fungi.computer/agar/read-copy";
import { approvalKind, callerActor, decide } from "./policy.js";
import { authorsAtHead, reachableCommits } from "./history.js";
import type { Bonsai, BonsaiActor } from "./service.js";

import type {
  ConcurrentWatchdogRuntime,
  WatchdogRunningJob,
  WatchdogSettledJob,
  WatchdogExecutionDecision,
  WatchdogQueueTransition,
  WatchdogTransactionalProjection,
} from "@fungi.computer/watchdog";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import {
  actorLane,
  mayEnqueueBackground,
  backgroundSyncRefusalSchema,
  backgroundOriginSchema,
  type BackgroundBinding,
} from "@fungi.computer/puffball/background-replay";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";

const ZERO = "0".repeat(40);
const leaseAdmission = z.union([
  mergeResult,
  z.strictObject({ kind: z.literal("lease"), change: changeRecord }),
]);
const LEASE_MS = 120_000;

/** Durable intent; the replay resolves authority and review facts again. */
export const mergeJobSchema = z.strictObject({
  kind: z.literal("merge"),
  repo: changeRecord.shape.repo,
  number: changeRecord.shape.number,
  head: changeRecord.shape.head,
  leaseId: z.string().min(1).max(128),
  lane: backgroundSyncRefusalSchema.shape.lane,
  step: z.number().int().nonnegative(),
  /** How many full merge attempts this lease has made; bounds stale-CAS retry. */
  attempt: z.number().int().min(1).max(3),
  origin: backgroundOriginSchema,
  checkpoint: gitStepSchema.nullable(),
  reviewedCommits: z.array(gitSha1Schema),
});

function savedReviewHashes(
  bonsai: Bonsai,
  row: ChangeRecord,
): readonly string[] {
  const copy = bonsai.state.changeCopies.read(changeCopyKey(row));
  if (
    bonsai.state.repositoryRefStatus(row.repo).pending ||
    bonsai.state.repositoryRefStatus(row.sourceRepo).pending ||
    copy.kind !== "ready" ||
    copy.head !== row.head ||
    copy.value.target !== row.target
  )
    throw new AppMethodRefusal("unavailable", "The review copy is rebuilding");
  return copy.value.aheadHashes;
}

function savedAuthors(bonsai: Bonsai, row: ChangeRecord): readonly string[] {
  return [
    ...new Set(
      [...bonsai.state.origins(savedReviewHashes(bonsai, row)).values()].map(
        (origin) => origin.agent,
      ),
    ),
  ];
}

/** Accept a member's merge intent and its job in the same row transaction. */
export function queueMergeChange(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  input: { repo: string; number: number; head: string },
  runtime: ConcurrentWatchdogRuntime,
): MergeResult {
  if (!mayEnqueueBackground(caller))
    return { kind: "refused", reason: "not-authorized" };
  if (caller.actor.kind !== "member")
    return { kind: "refused", reason: "agents-cannot-merge" };
  const actor = callerActor(caller);
  const requestKey = caller.idempotencyKey ?? replayKey();
  const key = `merge:${requestKey}`;
  const digest = JSON.stringify({ actor, input });
  const cached = bonsai.state.receipt(key, digest, mergeResult);
  if (cached !== null) return cached.result;
  const initial = bonsai.state.requireChange(input.repo, input.number);
  const authors = savedAuthors(bonsai, initial);
  const source = bonsai.state.repositoryCopies.read(initial.sourceRepo);
  if (source.kind !== "ready")
    throw new AppMethodRefusal(
      "unavailable",
      "The source repository copy is rebuilding",
    );
  return bonsai.state.transition(key, digest, mergeResult, () => {
    const row = bonsai.state.requireChange(input.repo, input.number);
    if (row.head !== input.head)
      return { result: { kind: "moved", head: row.head }, events: [] };
    const facts = bonsai.state.reviewFacts(actor, row, input.head, authors);
    const decision = decide("merge", facts);
    if (!decision.allowed)
      return {
        result: { kind: "refused", reason: decision.reason },
        events: [],
      };
    bonsai.state.seeActor(actor.name, actor.kind);
    const at = Date.now();
    const leaseId = replayKey();
    const implicit =
      decide("approve", facts).allowed &&
      !facts.approvals.some(
        (approval) =>
          approval.actor === actor.name && approval.head === row.head,
      );
    if (implicit)
      bonsai.state.approve(row.repo, row.number, {
        actor: actor.name,
        kind: approvalKind(facts),
        head: row.head,
        at,
      });
    const next = bonsai.state.reviseChange(
      {
        ...row,
        state: "merging",
        mergeFailure: undefined,
        updatedAt: at,
        lease: { id: leaseId, by: actor.name, head: row.head, at },
      },
      row.revision,
    );
    const lane = actorLane(caller.actor);
    runtime.transactional.enqueueAcceptedJob({
      state: "queued",
      jobId: `merge:${leaseId}`,
      queue: `merge:${leaseId}`,
      lane,
      priority: 0,
      recovery: { maxRecoveries: 1 },
      payload: mergeJobSchema.parse({
        kind: "merge",
        ...input,
        leaseId,
        lane,
        step: 0,
        attempt: 1,
        origin: caller.backgroundOrigin,
        checkpoint: null,
        reviewedCommits: savedReviewHashes(bonsai, row),
      }),
    });
    return {
      result: { kind: "merging" },
      events: implicit
        ? [
            bonsai.state.changeEvent(
              next,
              actor.name,
              "change.approved",
              source.value.cloneUrl,
            ),
          ]
        : [],
    };
  });
}

/** Repair screen copies after an accepted merge or lease settlement, in this frame. */
async function repairCopies(bonsai: Bonsai, row: ChangeRecord): Promise<void> {
  const repo = bonsai.state.repositoryCopies.read(row.repo);
  if (repo.kind === "ready") {
    const name = `refs/heads/${row.targetRef}`;
    const refs = repo.value.refs.filter((ref) => ref.name !== name);
    if (row.target !== ZERO) refs.push({ name, hash: row.target });
    bonsai.state.repositoryCopies.write(
      row.repo,
      row.targetRef === repo.value.defaultBranch
        ? row.target === ZERO
          ? null
          : row.target
        : repo.head,
      { ...repo.value, refs, empty: refs.length === 0 },
    );
  }
  try {
    await readCopyFrame(bonsai.store, (store) =>
      refreshChangeCopy({ ...bonsai, store }, row),
    );
  } catch (error) {
    if (!(error instanceof ReadCopyBudgetExceeded)) throw error;
    bonsai.state.changeCopies.stale(changeCopyKey(row));
  }
}

/** Record the actual accepted write once until the host journal owns this fact. */
function mergedEvents(
  bonsai: Bonsai,
  proposed: ChangeRecord,
  by: string,
  before: string,
  after: string,
  sourceUrl: string,
  targetUrl: string,
  wrote: boolean,
  recordChange: boolean,
): HookEvent[] {
  const at = Date.now();
  const events: HookEvent[] = [];
  if (wrote) {
    const push = bonsai.state.record({
      at,
      type: "push",
      repo: proposed.repo,
      actor: by,
      data: {
        updates: [{ ref: `refs/heads/${proposed.targetRef}`, before, after }],
        commits: [
          {
            hash: after,
            message: `Merge #${String(proposed.number)}: ${proposed.title}`,
          },
        ],
        paths: [],
      },
    });
    events.push(
      activityEnvelope(push, {
        name: proposed.repo,
        canonical: proposed.repo,
        cloneUrl: targetUrl,
      }),
    );
  }
  if (recordChange) {
    const merged = bonsai.state.record({
      at,
      type: "merge",
      repo: proposed.repo,
      actor: by,
      data: {
        change: changeIdentityOf(proposed),
        from: proposed.sourceRepo,
        ref: proposed.targetRef,
        before,
        after,
      },
    });
    events.push(
      activityEnvelope(merged, {
        name: proposed.sourceRepo,
        canonical: proposed.repo,
        cloneUrl: sourceUrl,
      }),
    );
  }
  return events;
}

export async function recoverExpiredLease(
  bonsai: Bonsai,
  initial: ChangeRecord,
): Promise<ChangeRecord> {
  const lease = initial.lease;
  if (lease === null || Date.now() - lease.at < LEASE_MS) return initial;
  const [refs, sourceUrl, targetUrl] = await Promise.all([
    bonsai.store.refs(initial.repo),
    bonsai.store.cloneUrl(initial.sourceRepo),
    bonsai.store.cloneUrl(initial.repo),
  ]);
  const target =
    refs.find((ref) => ref.name === `refs/heads/${initial.targetRef}`)?.hash ??
    ZERO;
  const reachable =
    target === ZERO
      ? new Set<string>()
      : await reachableCommits(bonsai.store, initial.repo, target);
  const result = bonsai.state.transition(
    `lease-recovery:${lease.id}:${String(initial.revision)}:${target}`,
    JSON.stringify({ lease, target, revision: initial.revision }),
    changeRecord,
    () => {
      const row = bonsai.state.requireChange(initial.repo, initial.number);
      if (
        row.lease?.id !== lease.id ||
        (row.target !== initial.target && row.target !== target)
      )
        return { result: row, events: [] };
      const accepted = reachable.has(lease.head);
      const sameHead = row.head === lease.head;
      let next: ChangeRecord = {
        ...row,
        state: row.state === "closed" ? "closed" : "open",
        lease: null,
        target,
        conflict: null,
        updatedAt: Date.now(),
      };
      // A lease this old settled by expiry, not by a settlement this
      // function recorded, so the fallback below needs its own typed
      // outcome here too: reopening with neither a conflict nor a
      // failure would be exactly the silent drop these races elsewhere
      // were already fixed not to do.
      if (accepted && sameHead)
        next = {
          ...next,
          state: "merged",
          mergedCommit: target,
          mergedBy: lease.by,
        };
      else if (accepted)
        next = {
          ...next,
          mergeFailure: "head_moved",
          mergedCommit: target,
          mergedBy: lease.by,
        };
      else if (!sameHead) next = { ...next, mergeFailure: "head_moved" };
      else next = { ...next, mergeFailure: "sync_failed" };
      const result = bonsai.state.reviseChange(next, row.revision);
      const proposed = { ...row, head: lease.head };
      return {
        result,
        events: accepted
          ? mergedEvents(
              bonsai,
              proposed,
              lease.by,
              initial.target,
              target,
              sourceUrl,
              targetUrl,
              false,
              true,
            )
          : [],
      };
    },
  );
  await repairCopies(bonsai, result);
  return result;
}

export async function mergeChange(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: { repo: string; number: number; head: string },
  requestKey: string = replayKey(),
): Promise<MergeResult> {
  const resultKey = `merge:${requestKey}`;
  const digest = JSON.stringify({ actor, input });
  const cached = bonsai.state.receipt(resultKey, digest, mergeResult);
  if (cached !== null) {
    return cached.result;
  }
  const initial = bonsai.state.requireChange(input.repo, input.number);
  if (actor.kind !== "human") {
    const result = bonsai.state.transition(
      resultKey,
      digest,
      mergeResult,
      () => {
        const row = bonsai.state.requireChange(input.repo, input.number);
        const decision = decide(
          "merge",
          bonsai.state.reviewFacts(actor, row, input.head, []),
        );
        if (decision.allowed)
          throw new Error("Agent merge policy unexpectedly allowed");
        return {
          result: mergeResult.parse({
            kind: "refused",
            reason: decision.reason,
          }),
          events: [],
        };
      },
    );
    return result;
  }
  const recovered = await recoverExpiredLease(bonsai, initial);
  const [authors, sourceUrl, targetUrl] = await Promise.all([
    authorsAtHead(bonsai, recovered),
    bonsai.store.cloneUrl(recovered.sourceRepo),
    bonsai.store.cloneUrl(recovered.repo),
  ]);
  const leaseId = replayKey();
  const admission = bonsai.state.transition(
    `merge-start:${requestKey}`,
    digest,
    leaseAdmission,
    () => {
      const row = bonsai.state.requireChange(input.repo, input.number);
      if (row.head !== input.head)
        return {
          result: leaseAdmission.parse({ kind: "moved", head: row.head }),
          events: [],
        };
      const facts = bonsai.state.reviewFacts(actor, row, input.head, authors);
      const decision = decide("merge", facts);
      if (!decision.allowed)
        return {
          result: leaseAdmission.parse({
            kind: "refused",
            reason: decision.reason,
          }),
          events: [],
        };
      const at = Date.now();
      bonsai.state.seeActor(actor.name, actor.kind);
      const implicit =
        decide("approve", facts).allowed &&
        !facts.approvals.some(
          (approval) =>
            approval.head === row.head && approval.actor === actor.name,
        );
      if (implicit)
        bonsai.state.approve(row.repo, row.number, {
          actor: actor.name,
          kind: approvalKind(facts),
          head: row.head,
          at,
        });
      const next = bonsai.state.reviseChange(
        {
          ...row,
          state: "merging",
          updatedAt: at,
          lease: { id: leaseId, by: actor.name, head: row.head, at },
        },
        row.revision,
      );
      return {
        result: leaseAdmission.parse({ kind: "lease", change: next }),
        events: implicit
          ? [
              bonsai.state.changeEvent(
                next,
                actor.name,
                "change.approved",
                sourceUrl,
              ),
            ]
          : [],
      };
    },
  );
  if (admission.kind !== "lease")
    return bonsai.state.transition(resultKey, digest, mergeResult, () => ({
      result: admission,
      events: [],
    }));
  const proposed = admission.change;
  const lease = proposed.lease;
  if (lease === null) throw new Error("Merge admission lacks its stored lease");
  if (lease.id !== leaseId) {
    const physical = bonsai.state.receipt(
      `merge-settle:${lease.id}`,
      digest,
      mergeResult,
    );
    if (physical !== null)
      return bonsai.state.transition(resultKey, digest, mergeResult, () => ({
        result: physical.result,
        events: [],
      }));
    const current = bonsai.state.requireChange(input.repo, input.number);
    if (current.lease?.id === lease.id)
      return { kind: "refused", reason: "merging" };
    const result =
      current.state === "merged" && current.mergedCommit !== null
        ? mergeResult.parse({
            kind: "merged",
            before: proposed.target,
            after: current.mergedCommit,
          })
        : mergeResult.parse({ kind: "moved", head: current.head });
    return bonsai.state.transition(resultKey, digest, mergeResult, () => ({
      result,
      events: [],
    }));
  }
  return performMerge(
    bonsai,
    actor,
    proposed,
    input,
    requestKey,
    digest,
    sourceUrl,
    targetUrl,
  );
}

/**
 * The merge git-step operation a background job begins, shared by its first
 * attempt and every stale-CAS retry. `timestamp` is the caller's already
 * fixed value (the lease's creation second), never `Date.now()`, so a crash
 * replay of the same attempt recomputes the identical commit instead of a
 * new one that could conflict with already-retained step material.
 */
function mergeStepOperation(
  row: ChangeRecord,
  actor: BonsaiActor,
  leaseId: string,
  head: string,
  timestamp: number,
) {
  return {
    kind: "merge" as const,
    requestKey: `merge:${leaseId}`,
    timestamp,
    request: {
      target: row.repo,
      source: row.sourceRepo,
      branch: row.targetRef,
      sourceBranch: row.sourceRef,
      expectedSource: head,
      message: `Merge #${String(row.number)}: ${row.title}`,
      author: { name: actor.name, email: `${actor.name}@bonsai.local` },
    },
  };
}

async function performMerge(
  bonsai: Bonsai,
  actor: BonsaiActor,
  proposed: ChangeRecord,
  input: { repo: string; number: number; head: string },
  requestKey: string,
  digest: string,
  sourceUrl: string,
  targetUrl: string,
): Promise<MergeResult> {
  const lease = proposed.lease;
  if (lease === null) throw new Error("Merge execution lacks its stored lease");
  const request = {
    target: proposed.repo,
    source: proposed.sourceRepo,
    branch: proposed.targetRef,
    sourceBranch: proposed.sourceRef,
    expectedSource: lease.head,
    message: `Merge #${String(proposed.number)}: ${proposed.title}`,
    author: { name: actor.name, email: `${actor.name}@bonsai.local` },
  };
  let outcome = await mergeBranch(bonsai.store, request);
  for (let attempt = 1; outcome.kind === "stale" && attempt < 3; attempt++)
    outcome = await mergeBranch(bonsai.store, request);
  const result = settleMerge(
    bonsai,
    actor,
    proposed,
    input,
    requestKey,
    digest,
    sourceUrl,
    targetUrl,
    outcome,
    // The foreground caller gets this MergeResult back directly and shows
    // it synchronously; no stored failure reason is needed.
    false,
  );
  await repairCopies(
    bonsai,
    bonsai.state.requireChange(input.repo, input.number),
  );
  return result;
}

/**
 * Records one Git merge outcome against a Change's stored row, inside one
 * settlement transition. Exported so a focused test can drive the specific
 * ownership and head/target races this function itself resolves, without
 * reconstructing the Watchdog's own per-frame timing to land them.
 */
export function settleMerge(
  bonsai: Bonsai,
  actor: BonsaiActor,
  proposed: ChangeRecord,
  input: { repo: string; number: number; head: string },
  requestKey: string,
  digest: string,
  sourceUrl: string,
  targetUrl: string,
  outcome: GitMergeOutcome,
  /**
   * Background callers have no synchronous recipient for a bare "moved"
   * MergeResult, so a non-conflict, non-merged settlement must record its
   * own mergeFailure here, inside this same settlement transition. Doing it
   * here (not after this function returns) keeps it atomic with the lease
   * release: a crash replay re-admits the job before that separate write
   * could ever run, and the Change would silently reopen with no reason.
   */
  recordUnsettledAsFailure: boolean,
): MergeResult {
  const lease = proposed.lease;
  if (lease === null) throw new Error("Merge settlement lacks its lease");
  const resultKey = `merge:${requestKey}`;
  const physical = bonsai.state.transition(
    `merge-settle:${lease.id}`,
    digest,
    mergeResult,
    () => {
      const row = bonsai.state.requireChange(input.repo, input.number);
      const ownsLease = row.lease?.id === lease.id;
      if (outcome.kind === "merged" || outcome.kind === "up-to-date") {
        const before =
          outcome.kind === "merged" ? outcome.before : outcome.head;
        const after = outcome.kind === "merged" ? outcome.after : outcome.head;
        if (ownsLease) {
          let next: ChangeRecord = {
            ...row,
            state: row.head === lease.head ? "merged" : "open",
            target: after,
            lease: null,
            conflict: null,
            updatedAt: Date.now(),
          };
          // The source moved under this lease: the work that landed was
          // for an already-superseded head, so this Change cannot
          // honestly show as merged for its current head. It still
          // landed, though -- name what actually merged, rather than
          // call it a sync failure, so the Change can ask for a review
          // of the new head instead.
          if (row.head === lease.head)
            next = { ...next, mergedCommit: after, mergedBy: actor.name };
          else if (recordUnsettledAsFailure)
            next = {
              ...next,
              mergeFailure: "head_moved",
              mergedCommit: after,
              mergedBy: actor.name,
            };
          bonsai.state.reviseChange(next, row.revision);
        }
        const events = mergedEvents(
          bonsai,
          proposed,
          actor.name,
          before,
          after,
          sourceUrl,
          targetUrl,
          outcome.kind === "merged",
          ownsLease,
        );
        return {
          result: mergeResult.parse({ kind: "merged", before, after }),
          events,
        };
      }
      if (ownsLease) {
        let next: ChangeRecord = {
          ...row,
          state: row.state === "closed" ? "closed" : "open",
          lease: null,
          updatedAt: Date.now(),
        };
        // A conflict against the still-current head is always recorded,
        // even when some other write has raced the row's own cached
        // `target` to a third value: that bookkeeping field is only safe
        // to overwrite when it still matches what this attempt expected
        // or found, but the conflict itself (what the attempt actually
        // discovered) is true regardless.
        if (outcome.kind === "conflict" && row.head === lease.head) {
          next = {
            ...next,
            conflict: {
              head: lease.head,
              target: outcome.head,
              paths: [...outcome.paths],
            },
          };
          if (row.target === proposed.target || row.target === outcome.head)
            next = { ...next, target: outcome.head };
        }
        // Anything else leaves this Change with nothing to show unless
        // it records its own typed failure. A moved source -- whether
        // Git's own fetch caught it, or this lease's head no longer
        // matches the row's -- is the author's own work overtaking this
        // attempt, never a sync problem; only an exhausted stale target
        // CAS against a still-current head is that.
        else if (recordUnsettledAsFailure)
          next = {
            ...next,
            mergeFailure:
              outcome.kind === "source-moved" || row.head !== lease.head
                ? "head_moved"
                : "sync_failed",
          };
        bonsai.state.reviseChange(next, row.revision);
      }
      if (outcome.kind === "conflict") {
        const stored = bonsai.state.record({
          at: Date.now(),
          type: "merge.conflict",
          repo: proposed.repo,
          actor: actor.name,
          data: {
            change: changeIdentityOf(proposed),
            from: proposed.sourceRepo,
            ref: proposed.targetRef,
            paths: [...outcome.paths],
          },
        });
        return {
          result: mergeResult.parse({
            kind: "conflict",
            paths: [...outcome.paths],
            head: lease.head,
          }),
          events: [
            activityEnvelope(stored, {
              name: proposed.sourceRepo,
              canonical: proposed.repo,
              cloneUrl: sourceUrl,
            }),
          ],
        };
      }
      return {
        result: mergeResult.parse({
          kind: "moved",
          head: outcome.kind === "source-moved" ? outcome.head : row.head,
        }),
        events: [],
      };
    },
  );
  const result = bonsai.state.transition(
    resultKey,
    digest,
    mergeResult,
    () => ({ result: physical, events: [] }),
  );
  return result;
}

/** Re-admitted calls own only their member lane and must satisfy current row policy. */
export async function executeQueuedMerge(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  job: WatchdogRunningJob,
  enqueue: WatchdogTransactionalProjection["enqueueAcceptedJob"],
  signal: AbortSignal,
  background: BackgroundBinding,
): Promise<WatchdogExecutionDecision> {
  const payload = mergeJobSchema.parse(job.payload);
  const row = bonsai.state.change(payload.repo, payload.number);
  if (row?.lease?.id !== payload.leaseId) return { kind: "completed" };
  if (
    caller.actor.kind !== "member" ||
    caller.workflow !== undefined ||
    payload.lane !== actorLane(caller.actor) ||
    job.lane !== payload.lane ||
    row.lease.by !== caller.actor.memberId
  )
    return { kind: "failed", reason: "access_changed" };
  const actor = callerActor(caller);
  // Only this job's existing lease may project merging as open for its own policy check.
  const facts = bonsai.state.reviewFacts(
    actor,
    { ...row, state: row.state === "merging" ? "open" : row.state },
    payload.head,
    [
      ...new Set(
        [...bonsai.state.origins(payload.reviewedCommits).values()].map(
          (origin) => origin.agent,
        ),
      ),
    ],
  );
  if (!decide("merge", facts).allowed)
    return { kind: "failed", reason: "access_changed" };
  const stageKey = `merge-step:${payload.leaseId}:${String(payload.step)}`;
  const stageDigest = JSON.stringify(payload);
  // A disappeared frame may repeat a completed claim, but not its exchange.
  if (bonsai.state.receipt(stageKey, stageDigest, gitStepSchema) !== null)
    return { kind: "completed" };
  const admission = await background.admit(payload.origin);
  if (admission.kind === "refused")
    return { kind: "failed", reason: "access_changed" };
  const owner = bonsai.state.backgroundOwner;
  const material = sqliteGitStepMaterial(owner.sql);
  const initialKey = `merge-start:${payload.leaseId}`;
  const initialDigest = JSON.stringify({
    lease: payload.leaseId,
    head: payload.head,
  });
  let checkpoint = payload.checkpoint;
  if (checkpoint === null) {
    const saved = bonsai.state.receipt(
      initialKey,
      initialDigest,
      gitStepSchema,
    );
    checkpoint =
      saved?.result ??
      (await begin(
        mergeStepOperation(
          row,
          actor,
          payload.leaseId,
          payload.head,
          Math.floor(row.lease.at / 1000),
        ),
        material,
      ));
    const initial = checkpoint;
    bonsai.state.transition(initialKey, initialDigest, gitStepSchema, () => ({
      result: initial,
      events: [],
    }));
  }
  let result;
  try {
    result = await runStep(checkpoint, { git: bonsai.store, material }, signal);
  } catch (error) {
    if (error instanceof GitStepMaterialError)
      return { kind: "failed", reason: "sync_failed" };
    throw error;
  }
  if (!("done" in result)) {
    const next = "next" in result ? result.next : checkpoint;
    bonsai.state.transition(stageKey, stageDigest, gitStepSchema, () => {
      enqueue({
        state: "queued",
        jobId: `merge:${payload.leaseId}:${String(payload.step + 1)}`,
        queue: `merge:${payload.leaseId}`,
        lane: payload.lane,
        priority: 0,
        recovery: { maxRecoveries: 1 },
        payload: mergeJobSchema.parse({
          ...payload,
          step: payload.step + 1,
          checkpoint: next,
        }),
      });
      return { result: next, events: [] };
    });
    return { kind: "completed" };
  }
  const outcome = result.done;
  if (outcome.kind === "too_large")
    return { kind: "failed", reason: "sync_failed" };
  if (
    outcome.kind !== "merged" &&
    outcome.kind !== "up-to-date" &&
    outcome.kind !== "stale" &&
    outcome.kind !== "source-moved" &&
    outcome.kind !== "conflict"
  )
    throw new Error("Unexpected merge step outcome");
  // A stale target CAS retries bounded, re-reading the target fresh, exactly
  // like the foreground's own retry loop in performMerge. The abandoned
  // attempt's step material is left for the Watchdog's own terminal
  // cleanup, which drops the whole shared owner prefix once this lease
  // finally settles; dropping it early here, ahead of this step's own
  // durable transition, would violate the material's own contract.
  if (outcome.kind === "stale" && payload.attempt < 3) {
    const retried = await begin(
      mergeStepOperation(
        row,
        actor,
        payload.leaseId,
        payload.head,
        Math.floor(row.lease.at / 1000),
      ),
      material,
    );
    bonsai.state.transition(stageKey, stageDigest, gitStepSchema, () => {
      enqueue({
        state: "queued",
        jobId: `merge:${payload.leaseId}:${String(payload.step + 1)}`,
        queue: `merge:${payload.leaseId}`,
        lane: payload.lane,
        priority: 0,
        recovery: { maxRecoveries: 1 },
        payload: mergeJobSchema.parse({
          ...payload,
          step: payload.step + 1,
          attempt: payload.attempt + 1,
          checkpoint: retried,
        }),
      });
      return { result: retried, events: [] };
    });
    return { kind: "completed" };
  }
  // Settlement records the Git outcome it already has; it never waits on a
  // screen read copy, which main's own movement makes rebuild routinely.
  const [sourceUrl, targetUrl] = await Promise.all([
    bonsai.store.cloneUrl(row.sourceRepo),
    bonsai.store.cloneUrl(row.repo),
  ]);
  const settled = settleMerge(
    bonsai,
    actor,
    row,
    { repo: row.repo, number: row.number, head: payload.head },
    `background:${payload.leaseId}`,
    JSON.stringify({
      actor,
      input: { repo: row.repo, number: row.number, head: payload.head },
    }),
    sourceUrl,
    targetUrl,
    outcome,
    // No synchronous caller exists for a queued job; a non-conflict
    // settlement must record its own mergeFailure, inside this same
    // settlement transition, instead of silently reopening the Change.
    true,
  );
  bonsai.state.changeCopies.stale(changeCopyKey(row));
  return settled.kind === "merged"
    ? { kind: "completed" }
    : { kind: "failed", reason: "sync_failed" };
}

/** Async material deletion follows the Watchdog's durable terminal settlement. */
export async function cleanupQueuedMerge(
  bonsai: Bonsai,
  job: WatchdogSettledJob,
): Promise<void> {
  const parsed = mergeJobSchema.safeParse(job.payload);
  if (!parsed.success) return;
  const payload = parsed.data;
  // Intermediate step completion owns a successor and still needs its material.
  if (
    job.outcome === "completed" &&
    bonsai.state.receipt(
      `merge-step:${payload.leaseId}:${String(payload.step)}`,
      JSON.stringify(payload),
      gitStepSchema,
    ) !== null
  )
    return;
  const checkpoint =
    payload.checkpoint ??
    bonsai.state.receipt(
      `merge-start:${payload.leaseId}`,
      JSON.stringify({ lease: payload.leaseId, head: payload.head }),
      gitStepSchema,
    )?.result;
  if (checkpoint !== undefined)
    await dropMaterial(
      checkpoint,
      sqliteGitStepMaterial(bonsai.state.backgroundOwner.sql),
    );
}

/** Watchdog failures and exhausted recovery release only the failed job's lease. */
export function projectQueuedMerge(
  bonsai: Bonsai,
  transition: WatchdogQueueTransition,
): void {
  if (
    transition.settled === undefined ||
    transition.settled.outcome === "completed"
  )
    return;
  const parsed = mergeJobSchema.safeParse(transition.settled.payload);
  if (!parsed.success) return;
  bonsai.state.failMergeLease(
    parsed.data.repo,
    parsed.data.number,
    parsed.data.leaseId,
    transition.settled.failureReason === "access_changed"
      ? "access_changed"
      : "sync_failed",
  );
}
