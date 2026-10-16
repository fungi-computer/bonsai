/** Bonsai owns saved text, revision CAS and file-specific Git conflict decisions. */
import * as z from "zod";
import { AppError } from "@fungi.computer/agar/errors";
import { deterministicReplayKey, replayKey } from "@fungi.computer/cairn";
import {
  begin,
  runStep,
  gitStepSchema,
  sqliteGitStepMaterial,
  dropMaterial,
  GitStepMaterialError,
} from "@fungi.computer/agar/git-steps";
import {
  actorLane,
  mayEnqueueBackground,
  backgroundOriginSchema,
  type BackgroundOrigin,
  type BackgroundBinding,
} from "@fungi.computer/puffball/background-replay";
import type {
  ConcurrentWatchdogRuntime,
  WatchdogRunningJob,
  WatchdogExecutionDecision,
  WatchdogTransactionalProjection,
  WatchdogQueuedJob,
  WatchdogSqliteOwner,
  WatchdogQueueTransition,
  WatchdogSettledJob,
} from "@fungi.computer/watchdog";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import {
  fileSaveInput,
  fileSaveResult,
  fileSyncResult,
  pendingFileEdit,
  repositoryFileByteLimit,
  type FileSaveInput,
  type FileSaveResult,
} from "@fungi.computer/agar/roles/files";
import { invalidateFilesCopies } from "./files-copy.js";
import { mayPush } from "./policy.js";
import { isBinary } from "./diff.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import type { Bonsai } from "./service.js";

const storedEdit = fileSaveInput.omit({ revision: true }).extend({
  lane: z.string(),
  revision: z.number().int().positive(),
  state: pendingFileEdit.shape.state,
  theirs: pendingFileEdit.shape.theirs,
  failure: pendingFileEdit.shape.failure,
  commit: fileSaveInput.shape.baseCommit.optional(),
  retryOrder: z.number().int().positive().optional(),
  origin: z.optional(backgroundOriginSchema),
  publishing: z.literal(true).optional(),
  retryable: z.literal(false).optional(),
});
/** One member-private saved edit row as stored. */
export type StoredEdit = z.output<typeof storedEdit>;
const row = z.strictObject({
  revision: z.number().int().positive(),
  body: z.string().nullable(),
});
/** The repository, branch and path that key one saved edit. */
export type EditKey = Pick<FileSaveInput, "repo" | "branch" | "path">;
// At 64 KiB per row, a member retains at most 8 MiB of saved file text.
const savedFileRowsPerMember = 128;
const countRow = z.strictObject({ count: z.number().int().nonnegative() });
const retryOrderRow = z.strictObject({ next: z.number().int().positive() });

function decodeEdit(raw: unknown): StoredEdit {
  const saved = row.parse(raw);
  if (saved.body === null) throw new Error("Discarded file has no saved text");
  const body: unknown = JSON.parse(saved.body);
  return storedEdit.parse({
    ...storedEdit.omit({ revision: true }).parse(body),
    revision: saved.revision,
  });
}

/** Rows use globally monotonic revisions, including across discard/recreate. */
export class FileEdits {
  constructor(readonly owner: WatchdogSqliteOwner) {
    owner.sql.exec(`CREATE TABLE IF NOT EXISTS file_edits (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL, lane TEXT NOT NULL,
      body TEXT, UNIQUE(repo, branch, path, lane)) STRICT;`);
    owner.sql.exec(
      "CREATE INDEX IF NOT EXISTS file_edits_lane ON file_edits(lane)",
    );
  }

  private row(lane: string, key: EditKey) {
    const raw = this.owner.sql
      .exec(
        "SELECT revision, body FROM file_edits WHERE repo=? AND branch=? AND path=? AND lane=?",
        key.repo,
        key.branch,
        key.path,
        lane,
      )
      .toArray()[0];
    return raw === undefined ? null : row.parse(raw);
  }

  /** A discarded path retains its private CAS baseline without text or state. */
  revision(lane: string, key: EditKey): number | null {
    return this.row(lane, key)?.revision ?? null;
  }

  read(lane: string, key: EditKey): StoredEdit | null {
    const saved = this.row(lane, key);
    return saved?.body == null ? null : decodeEdit(saved);
  }

  save(
    lane: string,
    input: FileSaveInput,
    enqueue: (edit: StoredEdit) => void,
    origin?: BackgroundOrigin,
  ): FileSaveResult {
    return this.owner.transactionSync(() => {
      const { revision, ...inputBody } = input;
      const previous = this.read(lane, input);
      const baseline = this.revision(lane, input);
      if (baseline !== revision)
        return { kind: "conflict", revision: baseline ?? 0 };
      if (previous?.state === "pending" && previous.publishing === true)
        return { kind: "conflict", revision: previous.revision };
      if (previous === null) {
        const rows = countRow.parse(
          this.owner.sql
            .exec(
              "SELECT count(*) AS count FROM file_edits WHERE lane=? AND body IS NOT NULL",
              lane,
            )
            .toArray()[0],
        );
        if (rows.count >= savedFileRowsPerMember)
          throw new AppMethodRefusal(
            "invalid",
            "Discard a saved file before adding another.",
          );
      }
      this.owner.sql.exec(
        "DELETE FROM file_edits WHERE repo=? AND branch=? AND path=? AND lane=?",
        input.repo,
        input.branch,
        input.path,
        lane,
      );
      this.owner.sql.exec(
        "INSERT INTO file_edits(repo,branch,path,lane,body) VALUES(?,?,?,?,?)",
        input.repo,
        input.branch,
        input.path,
        lane,
        JSON.stringify({ ...inputBody, lane, state: "pending", origin }),
      );
      const edit = this.read(lane, input);
      if (edit === null) throw new Error("Saved file edit is missing");
      enqueue(edit);
      return { kind: "saved", revision: edit.revision, state: "pending" };
    });
  }

  pending(lane: string, key: EditKey) {
    const edit = this.read(lane, key);
    if (edit === null || edit.state === "synced") return undefined;
    const pending: z.output<typeof pendingFileEdit> = {
      text: edit.text,
      revision: edit.revision,
      state: edit.state,
    };
    if (edit.theirs !== undefined) pending.theirs = edit.theirs;
    if (edit.failure !== undefined) pending.failure = edit.failure;
    return pending;
  }

  /** Fence replacement once a built write may reach the provider. */
  markPublishing(edit: StoredEdit): void {
    const current = this.read(edit.lane, edit);
    if (current?.revision !== edit.revision || current.state !== "pending")
      return;
    const { revision, ...body } = current;
    this.owner.sql.exec(
      "UPDATE file_edits SET body=? WHERE revision=?",
      JSON.stringify({ ...body, publishing: true }),
      revision,
    );
  }

  settle(edit: StoredEdit, result: FileSaveResult, retryable = true): void {
    this.owner.transactionSync(() => {
      if (this.read(edit.lane, edit)?.revision !== edit.revision) return;
      const next =
        result.kind === "synced"
          ? { ...edit, state: "synced", commit: result.commit }
          : result.kind === "conflict"
            ? { ...edit, state: "conflict", theirs: result.theirs }
            : result.kind === "failed"
              ? { ...edit, state: "failed", failure: result.reason }
              : edit;
      const { revision, ...body } = next;
      delete body.publishing;
      if (retryable) delete body.retryable;
      else body.retryable = false;
      this.owner.sql.exec(
        "UPDATE file_edits SET body=? WHERE revision=?",
        JSON.stringify(body),
        revision,
      );
    });
  }

  retryFailed(
    lane: string,
    enqueue: WatchdogTransactionalProjection["enqueueAcceptedJob"],
  ): void {
    this.owner.transactionSync(() => {
      const edits = this.owner.sql
        .exec(
          "SELECT revision,body FROM file_edits WHERE lane=? AND json_extract(body,'$.state')='failed' AND json_extract(body,'$.failure')!='access_changed' AND COALESCE(json_extract(body,'$.retryable'),1)!=0 ORDER BY COALESCE(json_extract(body,'$.retryOrder'),0),revision LIMIT 2",
          lane,
        )
        .toArray()
        .map(decodeEdit);
      if (edits.length === 0) return;
      const order = retryOrderRow.parse(
        this.owner.sql
          .exec(
            "SELECT COALESCE(MAX(json_extract(body,'$.retryOrder')),0)+1 AS next FROM file_edits WHERE lane=?",
            lane,
          )
          .toArray()[0],
      );
      for (const edit of edits) {
        const { revision, ...body } = edit;
        this.owner.sql.exec(
          "UPDATE file_edits SET body=? WHERE revision=?",
          JSON.stringify({
            ...body,
            failure: undefined,
            state: "pending",
            retryOrder: order.next,
          }),
          revision,
        );
        enqueue(fileJob(payloadOf(edit)));
      }
    });
  }

  hasPending(lane: string): boolean {
    return (
      this.owner.sql
        .exec(
          "SELECT 1 FROM file_edits WHERE lane=? AND json_extract(body,'$.state')='pending' LIMIT 1",
          lane,
        )
        .toArray().length !== 0
    );
  }

  settled(lane: string): z.output<typeof fileSyncResult>["settled"] {
    return this.owner.sql
      .exec(
        "SELECT revision,body FROM file_edits WHERE lane=? AND json_extract(body,'$.state')!='pending' ORDER BY revision LIMIT ?",
        lane,
        savedFileRowsPerMember,
      )
      .toArray()
      .map(decodeEdit)
      .map((edit) => ({
        repo: edit.repo,
        branch: edit.branch,
        path: edit.path,
        result: this.result(edit),
      }));
  }

  result(edit: StoredEdit): FileSaveResult {
    switch (edit.state) {
      case "pending":
        return { kind: "saved", revision: edit.revision, state: "pending" };
      case "synced":
        if (edit.commit === undefined)
          throw new Error("Synced file edit has no commit");
        return { kind: "synced", revision: edit.revision, commit: edit.commit };
      case "failed":
        if (edit.failure === undefined)
          throw new Error("Failed file edit has no reason");
        return {
          kind: "failed",
          revision: edit.revision,
          reason: edit.failure,
        };
      case "conflict": {
        const result: FileSaveResult = {
          kind: "conflict",
          revision: edit.revision,
        };
        if (edit.theirs !== undefined) result.theirs = edit.theirs;
        return result;
      }
    }
  }

  discard(lane: string, key: EditKey & { revision: number }) {
    return this.owner.transactionSync(() => {
      const edit = this.read(lane, key);
      if (edit === null) return { kind: "not_found" as const };
      if (
        edit.revision !== key.revision ||
        (edit.state === "pending" && edit.publishing === true)
      )
        return { kind: "conflict" as const, revision: edit.revision };
      this.owner.sql.exec(
        "UPDATE file_edits SET body=NULL WHERE revision=?",
        edit.revision,
      );
      return { kind: "discarded" as const };
    });
  }
}

/** Only an ordinary member may read-modify-write their private saved-file lane. */
export function assertOrdinaryFileMember(caller: AppMethodCallContext): void {
  if (caller.actor.kind !== "member" || caller.workflow !== undefined)
    throw new AppMethodRefusal(
      "forbidden",
      "Saved file edits are for ordinary members only",
    );
}

function actor(caller: AppMethodCallContext) {
  return caller.actor.kind === "member"
    ? { name: caller.actor.memberId, kind: "human" as const }
    : {
        name:
          caller.actor.kind === "agent"
            ? caller.actor.agentId
            : caller.actor.keyId,
        kind: "agent" as const,
      };
}

/** A saved file is UTF-8 text, never a binary payload disguised as text. */
function admitFileEdit(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  input: FileSaveInput,
): boolean {
  if (!mayPush(actor(caller), bonsai.state.repo(input.repo))) return false;
  const bytes = new TextEncoder().encode(input.text);
  if (bytes.length > repositoryFileByteLimit || isBinary(bytes))
    throw new AppMethodRefusal(
      "invalid",
      "Save a text file within the repository file byte limit.",
    );
  return true;
}

const fileProbe = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.literal("commit"),
    head: fileSaveInput.shape.baseCommit,
  }),
  z.strictObject({
    phase: z.literal("tree"),
    head: fileSaveInput.shape.baseCommit,
    tree: fileSaveInput.shape.baseCommit,
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    phase: z.literal("blob"),
    head: fileSaveInput.shape.baseCommit,
    blob: fileSaveInput.shape.baseCommit,
  }),
]);

/** Opaque cargo for the App's one shared actor-lane Watchdog. */
export const fileEditJobSchema = fileSaveInput
  .pick({ repo: true, branch: true, path: true })
  .extend({
    kind: z.literal("file-edit"),
    revision: z.number().int().positive(),
    lane: z.string(),
    origin: backgroundOriginSchema,
    operationKey: z.uuid({ version: "v7" }),
    timestamp: z.number().int().nonnegative(),
    probe: fileProbe.optional(),
    stage: z.number().int().nonnegative().default(0),
    failures: z.number().int().min(0).max(2).default(0),
    step: gitStepSchema.optional(),
  });
const fileStageReceipt = z.object({
  result: fileSaveResult.optional(),
  next: fileEditJobSchema.optional(),
  cleanup: gitStepSchema.optional(),
  retryable: z.literal(false).optional(),
});
const fileStageKey = (jobId: string) => `file-edit-step:${jobId}`;
const fileJob = (
  edit: z.output<typeof fileEditJobSchema>,
  jobId = `file-edit:${edit.operationKey}:${String(edit.stage)}`,
): WatchdogQueuedJob => ({
  state: "queued",
  jobId,
  queue: `file-edit:${String(edit.revision)}`,
  lane: edit.lane,
  priority: 0,
  // One fresh frame may recover a vanished claim; exhaustion preserves text as failed.
  recovery: { maxRecoveries: 1 },
  payload: edit,
});
const payloadOf = (edit: StoredEdit) =>
  fileEditJobSchema.parse({
    kind: "file-edit",
    repo: edit.repo,
    branch: edit.branch,
    path: edit.path,
    revision: edit.revision,
    lane: edit.lane,
    origin: edit.origin,
    operationKey: replayKey(),
    timestamp: Math.floor(Date.now() / 1000),
  });

function commitFileStage(
  bonsai: Bonsai,
  payload: z.output<typeof fileEditJobSchema>,
  job: WatchdogRunningJob,
  enqueue: WatchdogTransactionalProjection["enqueueAcceptedJob"],
  receipt: z.output<typeof fileStageReceipt>,
) {
  return bonsai.state.transition(
    fileStageKey(job.jobId),
    JSON.stringify(payload),
    fileStageReceipt,
    () => {
      const current = bonsai.state.fileEdits.read(payload.lane, payload);
      if (current?.revision !== payload.revision || current.state !== "pending")
        return {
          result:
            receipt.next?.step !== undefined
              ? { cleanup: receipt.next.step }
              : payload.step === undefined
                ? {}
                : { cleanup: payload.step },
          events: [],
        };
      if (receipt.next !== undefined) {
        if (receipt.next.step !== undefined && "built" in receipt.next.step)
          bonsai.state.fileEdits.markPublishing(current);
        enqueue(fileJob(receipt.next));
      }
      return { result: receipt, events: [] };
    },
  );
}
function retryFileStage(
  bonsai: Bonsai,
  payload: z.output<typeof fileEditJobSchema>,
  job: WatchdogRunningJob,
  enqueue: WatchdogTransactionalProjection["enqueueAcceptedJob"],
): WatchdogExecutionDecision {
  if (payload.failures === 2) return { kind: "failed", reason: "sync_failed" };
  const recorded = commitFileStage(bonsai, payload, job, enqueue, {
    next: {
      ...payload,
      stage: payload.stage + 1,
      failures: payload.failures + 1,
    },
  });
  return recorded.next === undefined
    ? { kind: "completed" }
    : { kind: "failed", reason: "sync_retry" };
}

export async function saveFileEdit(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  input: FileSaveInput,
  runtime: ConcurrentWatchdogRuntime | null,
): Promise<FileSaveResult> {
  assertOrdinaryFileMember(caller);
  if (!admitFileEdit(bonsai, caller, input))
    return { kind: "refused", reason: "not-source-writer" };
  if (!mayEnqueueBackground(caller) || runtime === null)
    return { kind: "refused", reason: "background-unavailable" };
  const lane = actorLane(caller.actor);
  const save = () => ({
    result: bonsai.state.fileEdits.save(
      lane,
      input,
      (edit) => {
        runtime.transactional.enqueueAcceptedJob(fileJob(payloadOf(edit)));
      },
      caller.backgroundOrigin,
    ),
    events: [],
  });
  if (caller.idempotencyKey === undefined) return save().result;
  return bonsai.state.transition(
    `file-edit:${lane}:${caller.idempotencyKey}`,
    await deterministicReplayKey("bonsai:file-edit-receipt:v1", [
      lane,
      JSON.stringify(input),
    ]),
    // Domain receipt and enqueue share the same transaction.
    fileSaveResult,
    save,
  );
}

function publishFileHead(
  bonsai: Bonsai,
  edit: StoredEdit,
  commit: string,
): void {
  invalidateFilesCopies(bonsai, edit.repo);
  const saved = bonsai.state.repositoryCopies.read(edit.repo);
  if (saved.kind !== "ready") return;
  const name = `refs/heads/${edit.branch}`;
  bonsai.state.repositoryCopies.write(
    edit.repo,
    saved.value.defaultBranch === edit.branch ? commit : saved.head,
    {
      ...saved.value,
      empty: false,
      refs: [
        ...saved.value.refs.filter((ref) => ref.name !== name),
        { name, hash: commit },
      ],
    },
  );
}

/** The shared runner supplies its enqueue port; this module never constructs Watchdog. */
export async function executeQueuedFileEdit(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  job: WatchdogRunningJob,
  enqueue: WatchdogTransactionalProjection["enqueueAcceptedJob"],
  background: BackgroundBinding | undefined,
  signal: AbortSignal,
): Promise<WatchdogExecutionDecision> {
  const decoded = fileEditJobSchema.safeParse(job.payload);
  if (
    !decoded.success ||
    caller.actor.kind !== "member" ||
    caller.workflow !== undefined
  )
    return { kind: "failed", reason: "access_changed" };
  const payload = decoded.data;
  if (payload.lane !== actorLane(caller.actor) || job.lane !== payload.lane)
    return { kind: "failed", reason: "access_changed" };
  if (background === undefined || signal.aborted)
    return { kind: "failed", reason: "access_changed" };
  let admission;
  try {
    admission = await background.admit(payload.origin);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppError && !error.retryable)
      return { kind: "failed", reason: "access_changed" };
    return retryFileStage(bonsai, payload, job, enqueue);
  }
  if (admission.kind !== "admitted")
    return { kind: "failed", reason: "access_changed" };
  const edit = bonsai.state.fileEdits.read(payload.lane, payload);
  if (edit?.revision !== payload.revision || edit.state !== "pending")
    return { kind: "completed" };
  if (!mayPush(actor(caller), bonsai.state.repo(edit.repo)))
    return { kind: "failed", reason: "access_changed" };
  const digest = JSON.stringify(payload);
  if (
    bonsai.state.receipt(fileStageKey(job.jobId), digest, fileStageReceipt) !==
    null
  )
    return { kind: "completed" };
  const material = sqliteGitStepMaterial(bonsai.state.backgroundOwner.sql);
  const content = new TextEncoder().encode(edit.text);
  let receipt: z.output<typeof fileStageReceipt>;
  try {
    signal.throwIfAborted();
    if (payload.step === undefined) {
      const nextProbe = (probe: z.output<typeof fileProbe>) => ({
        next: { ...payload, stage: payload.stage + 1, failures: 0, probe },
      });
      const finishProbe = async (
        head: string,
        blob: string | null,
        bytes: Uint8Array | null,
      ): Promise<z.output<typeof fileStageReceipt>> => {
        signal.throwIfAborted();
        const retained = bonsai.state.fileEdits.read(edit.lane, edit);
        if (
          retained?.revision !== edit.revision ||
          retained.state !== "pending"
        )
          return {};
        if (
          blob !== edit.baseBlob &&
          !(
            bytes !== null &&
            bytes.length === content.length &&
            bytes.every((byte, index) => byte === content[index])
          )
        )
          return {
            result: {
              kind: "conflict",
              revision: edit.revision,
              theirs: { blob, commit: head },
            },
          };
        const author = actor(caller);
        const step = await begin(
          {
            kind: "commit",
            requestKey: payload.operationKey,
            timestamp: payload.timestamp,
            request: {
              repository: edit.repo,
              branch: edit.branch,
              expectedHead: head,
              changes: [{ path: edit.path, content }],
              message: `Edit ${edit.path}`,
              author: {
                name: author.name,
                email: `${author.name}@bonsai.invalid`,
              },
            },
          },
          material,
        );
        return {
          next: { ...payload, stage: payload.stage + 1, failures: 0, step },
        };
      };
      const probe = payload.probe;
      if (probe === undefined) {
        const head = (await bonsai.store.refs(edit.repo)).find(
          (ref) => ref.name === `refs/heads/${edit.branch}`,
        )?.hash;
        receipt =
          head === undefined
            ? {
                result: {
                  kind: "failed",
                  revision: edit.revision,
                  reason: "branch_missing",
                },
              }
            : nextProbe({ phase: "commit", head });
      } else if (probe.phase === "commit") {
        const commit = await bonsai.store.commit(edit.repo, probe.head);
        if (commit === null)
          throw new AppMethodRefusal("not_found", "Branch commit is missing");
        receipt = nextProbe({
          phase: "tree",
          head: probe.head,
          tree: commit.treeHash,
          index: 0,
        });
      } else if (probe.phase === "tree") {
        const parts = edit.path.split("/");
        const part = parts.at(probe.index);
        if (part === undefined)
          throw new AppMethodRefusal("invalid", "Invalid file frontier");
        const entries = await bonsai.store.tree(edit.repo, probe.tree);
        if (entries === null)
          throw new AppMethodRefusal(
            "not_found",
            "Directory object is missing",
          );
        const entry = entries.find((item) => item.name === part);
        if (entry === undefined)
          receipt = await finishProbe(probe.head, null, null);
        else if (probe.index === parts.length - 1) {
          if (entry.type !== "blob")
            throw new AppMethodRefusal("not_found", "Not a repository file");
          receipt = nextProbe({
            phase: "blob",
            head: probe.head,
            blob: entry.hash,
          });
        } else {
          if (entry.type !== "tree")
            throw new AppMethodRefusal(
              "not_found",
              "Not a repository directory",
            );
          receipt = nextProbe({
            phase: "tree",
            head: probe.head,
            tree: entry.hash,
            index: probe.index + 1,
          });
        }
      } else {
        const bytes = await bonsai.store.blob(edit.repo, probe.blob);
        if (bytes === null)
          throw new AppMethodRefusal("not_found", "File object is missing");
        receipt = await finishProbe(probe.head, probe.blob, bytes);
      }
    } else {
      const outcome = await runStep(
        payload.step,
        { git: bonsai.store.binding, material },
        signal,
      );
      if ("next" in outcome)
        receipt = {
          next: {
            ...payload,
            stage: payload.stage + 1,
            failures: 0,
            step: outcome.next,
          },
        };
      else if ("yield" in outcome)
        receipt = { next: { ...payload, stage: payload.stage + 1 } };
      else {
        const done = outcome.done;
        receipt = {
          cleanup: payload.step,
          result:
            done.kind === "committed" || done.kind === "unchanged"
              ? { kind: "synced", revision: edit.revision, commit: done.commit }
              : done.kind === "stale"
                ? { kind: "conflict", revision: edit.revision }
                : {
                    kind: "failed",
                    revision: edit.revision,
                    reason: "sync_failed",
                  },
        };
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GitStepMaterialError) {
      const terminal: z.output<typeof fileStageReceipt> = {
        result: {
          kind: "failed",
          revision: edit.revision,
          reason: "permanent_material",
        },
        retryable: false,
      };
      if (payload.step !== undefined) terminal.cleanup = payload.step;
      commitFileStage(bonsai, payload, job, enqueue, terminal);
      return { kind: "failed", reason: "sync_failed" };
    }
    if (
      error instanceof AppMethodRefusal ||
      (error instanceof AppError && !error.retryable)
    )
      return { kind: "failed", reason: "sync_failed" };
    return retryFileStage(bonsai, payload, job, enqueue);
  }
  commitFileStage(bonsai, payload, job, enqueue, receipt);
  return { kind: "completed" };
}

/** Foreground sync requests retry rows; the declared replay continuation owns claims. */
export function syncFileEdits(
  bonsai: Bonsai,
  caller: AppMethodCallContext,
  runtime: ConcurrentWatchdogRuntime,
): Promise<z.output<typeof fileSyncResult>> {
  assertOrdinaryFileMember(caller);
  const lane = actorLane(caller.actor);
  if (mayEnqueueBackground(caller))
    bonsai.state.fileEdits.retryFailed(
      lane,
      runtime.transactional.enqueueAcceptedJob,
    );
  return Promise.resolve({
    settled: bonsai.state.fileEdits.settled(lane),
    more: bonsai.state.fileEdits.hasPending(lane),
  });
}

/** Watchdog's terminal recovery/failure projection preserves the member's text. */
export function projectQueuedFileEdit(
  bonsai: Bonsai,
  transition: WatchdogQueueTransition,
): void {
  const settled = transition.settled;
  if (settled === undefined) return;
  const payload = fileEditJobSchema.safeParse(settled.payload);
  if (!payload.success) return;
  const edit = bonsai.state.fileEdits.read(payload.data.lane, payload.data);
  if (edit?.revision !== payload.data.revision || edit.state !== "pending")
    return;
  const recorded = bonsai.state.receipt(
    fileStageKey(settled.jobId),
    JSON.stringify(payload.data),
    fileStageReceipt,
  );
  if (recorded?.result.result !== undefined) {
    bonsai.state.fileEdits.settle(
      edit,
      recorded.result.result,
      recorded.result.retryable !== false,
    );
    if (recorded.result.result.kind === "synced")
      publishFileHead(bonsai, edit, recorded.result.result.commit);
    return;
  }
  if (recorded?.result.next !== undefined || settled.outcome === "completed")
    return;
  bonsai.state.fileEdits.settle(edit, {
    kind: "failed",
    revision: edit.revision,
    reason:
      settled.failureReason === "access_changed"
        ? "access_changed"
        : "sync_failed",
  });
}

/** Dispose Git material only after Watchdog has durably settled a terminal file stage. */
export async function cleanupSettledFileEdit(
  bonsai: Bonsai,
  job: WatchdogSettledJob,
): Promise<void> {
  const parsed = fileEditJobSchema.safeParse(job.payload);
  if (!parsed.success) return;
  const payload = parsed.data;
  const digest = JSON.stringify(payload);
  const receipt = bonsai.state.receipt(
    fileStageKey(job.jobId),
    digest,
    fileStageReceipt,
  );
  if (receipt?.result.next !== undefined) return;
  const step = receipt?.result.cleanup ?? payload.step;
  if (step !== undefined)
    await dropMaterial(
      step,
      sqliteGitStepMaterial(bonsai.state.backgroundOwner.sql),
    );
}
