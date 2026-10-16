/** One actor-lane Watchdog dispatcher; feature modules own cargo and row settlement. */
import {
  Watchdog,
  type ConcurrentWatchdogRuntime,
  type WatchdogQueueProjector,
  type WatchdogSqliteOwner,
  type WatchdogRunningJob,
  type WatchdogSettledJob,
  type WatchdogExecutionDecision,
  type WatchdogTransactionalProjection,
} from "@fungi.computer/watchdog";
import {
  actorLane,
  backgroundSyncRefusalSchema,
  type BackgroundSyncRefusal,
  type BackgroundBinding,
} from "@fungi.computer/puffball/background-replay";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import {
  executeQueuedFileEdit,
  cleanupSettledFileEdit,
  projectQueuedFileEdit,
} from "./file-edits.js";
import type { Bonsai } from "./service.js";
import {
  executeQueuedMerge,
  cleanupQueuedMerge,
  mergeJobSchema,
  projectQueuedMerge,
} from "./merge.js";
import { readCopyFrame } from "./git.js";
import { AppError } from "@fungi.computer/agar/errors";

const invocations = new WeakMap<
  WatchdogSqliteOwner,
  WeakMap<AppMethodCallContext, Promise<ConcurrentWatchdogRuntime>>
>();
const projectors = new WeakMap<
  WatchdogSqliteOwner,
  Map<"file-edit" | "merge", WatchdogQueueProjector>
>();
// Different caller runtimes share one live-claim view of the durable owner.
const activeJobs = new WeakMap<WatchdogSqliteOwner, Set<string>>();
// Covers the claim-to-execute window before a job enters activeJobs.
const ticksInFlight = new WeakMap<WatchdogSqliteOwner, Map<string, number>>();

/** Replace a feature's synchronous row projection without opening another runner. */
export function registerBackgroundProjector(
  bonsai: Bonsai,
  feature: "file-edit" | "merge",
  project: WatchdogQueueProjector,
): void {
  const owner = bonsai.state.backgroundOwner;
  let registered = projectors.get(owner);
  if (registered === undefined) {
    registered = new Map();
    projectors.set(owner, registered);
  }
  registered.set(feature, project);
}

/**
 * Share one runner within this trusted call context. A fresh replay context opens
 * a fresh runtime over the same durable owner; it never retains old authority.
 * Hosts own frame-close wakes and abort the old facet before a click can enter.
 */
export function backgroundRuntime(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  signal: AbortSignal = new AbortController().signal,
  background?: BackgroundBinding,
): Promise<ConcurrentWatchdogRuntime> {
  registerBackgroundProjector(bonsai, "file-edit", (transition) => {
    projectQueuedFileEdit(bonsai, transition);
  });
  registerBackgroundProjector(bonsai, "merge", (transition) => {
    projectQueuedMerge(bonsai, transition);
  });
  const owner = bonsai.state.backgroundOwner;
  let calls = invocations.get(owner);
  if (calls === undefined) {
    calls = new WeakMap();
    invocations.set(owner, calls);
  }
  const existing = calls.get(caller);
  if (existing !== undefined) return existing;
  const created = openLaneRuntime(
    bonsai,
    actorLane(caller.actor),
    async (job, enqueue) => {
      if (background === undefined)
        return { kind: "failed", reason: "access_changed" };
      if (mergeJobSchema.safeParse(job.payload).success)
        return executeQueuedMerge(
          bonsai,
          caller,
          job,
          enqueue,
          signal,
          background,
        );
      return executeQueuedFileEdit(
        bonsai,
        caller,
        job,
        enqueue,
        background,
        signal,
      );
    },
  );
  calls.set(caller, created);
  return created;
}

/** This is the sole runner factory for admitted execution and zero-grant refusal. */
function openLaneRuntime(
  bonsai: Bonsai,
  lane: string,
  execute: (
    job: WatchdogRunningJob,
    enqueue: WatchdogTransactionalProjection["enqueueAcceptedJob"],
  ) => Promise<WatchdogExecutionDecision>,
  settled?: WatchdogSettledJob[],
): Promise<ConcurrentWatchdogRuntime> {
  const owner = bonsai.state.backgroundOwner;
  let active = activeJobs.get(owner);
  if (active === undefined) {
    active = new Set();
    activeJobs.set(owner, active);
  }
  let runtime: ConcurrentWatchdogRuntime;
  return Watchdog.make({
    owner,
    concurrentLane: lane,
    project: (transition) => {
      for (const project of projectors.get(owner)?.values() ?? [])
        project(transition);
      if (transition.settled !== undefined) settled?.push(transition.settled);
    },
    isAlive: (job) =>
      Promise.resolve(
        active.has(job.jobId) || (ticksInFlight.get(owner)?.get(lane) ?? 0) > 1,
      ),
    wake: { recompute: () => Promise.resolve() },
    execute: async (job) => {
      active.add(job.jobId);
      try {
        return await execute(job, (successor) => {
          runtime.transactional.enqueueAcceptedJob(successor);
        });
      } finally {
        active.delete(job.jobId);
      }
    },
  }).then((opened) => {
    runtime = opened;
    return opened;
  });
}

/** An available facet settles the refused lane without inventing a caller or binding authority. */
export async function refuseBackground(
  bonsai: Bonsai,
  raw: BackgroundSyncRefusal,
): Promise<void> {
  const refusal = backgroundSyncRefusalSchema.parse(raw);
  // Unavailable installations are host dead letters, never guest settlement.
  if (refusal.code !== "access_changed") return;
  registerBackgroundProjector(bonsai, "merge", (transition) => {
    projectQueuedMerge(bonsai, transition);
  });
  registerBackgroundProjector(bonsai, "file-edit", (transition) => {
    projectQueuedFileEdit(bonsai, transition);
  });
  const settled: WatchdogSettledJob[] = [];
  const runtime = await openLaneRuntime(
    bonsai,
    refusal.lane,
    () => Promise.resolve({ kind: "failed", reason: "access_changed" }),
    settled,
  );
  let result;
  do {
    result = await runtime.failLane({
      lane: refusal.lane,
      reason: "access_changed",
    });
  } while (result.more);
  // Refused jobs may hold step material with the member's file bytes.
  for (const job of settled) {
    await cleanupQueuedMerge(bonsai, job);
    await cleanupSettledFileEdit(bonsai, job);
  }
}

/** An ordinary fresh member call drains only its own lane, with one frame budget. */
export async function syncBackground(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  background?: BackgroundBinding,
): Promise<{ more: boolean }> {
  if (
    background === undefined ||
    caller.actor.kind !== "member" ||
    caller.workflow !== undefined
  )
    return { more: false };
  const lane = actorLane(caller.actor);
  await readCopyFrame(bonsai.store, async (store, signal) => {
    const runtime = await backgroundRuntime(
      { ...bonsai, store },
      caller,
      signal,
      background,
    );
    const owner = bonsai.state.backgroundOwner;
    let ticks = ticksInFlight.get(owner);
    if (ticks === undefined) {
      ticks = new Map();
      ticksInFlight.set(owner, ticks);
    }
    ticks.set(lane, (ticks.get(lane) ?? 0) + 1);
    let tick;
    try {
      tick = await runtime.tickConcurrent();
    } finally {
      const remaining = (ticks.get(lane) ?? 1) - 1;
      if (remaining === 0) ticks.delete(lane);
      else ticks.set(lane, remaining);
      if (ticks.size === 0) ticksInFlight.delete(owner);
    }
    if (
      tick.status === "settled" &&
      tick.job.outcome === "failed" &&
      tick.job.failureReason === "sync_retry"
    )
      throw new AppError(
        "Git sync is temporarily unavailable. Your changes remain saved.",
        { code: "HOST_FAILURE", retryable: true },
      );
    if (tick.status === "settled") {
      await cleanupQueuedMerge(bonsai, tick.job);
      await cleanupSettledFileEdit(bonsai, tick.job);
    }
  });
  return {
    more:
      bonsai.state.fileEdits.hasPending(lane) ||
      bonsai.state
        .changes(null)
        .some(
          (row) =>
            row.state === "merging" &&
            row.lease !== null &&
            actorLane({ kind: "member", memberId: row.lease.by }) === lane,
        ),
  };
}
