/**
 * Bonsai's own state in the App's SQLite: the repository registry (which repo
 * is a fork of which, and whose), activity, which actor first pushed each
 * commit, and the actors Bonsai has seen (with their palette slot). Git content
 * remains the write log. The facet also owns bounded ready screen copies and
 * immutable read objects through Agar's read-copy store.
 */
import * as z from "zod";
import { FileEdits } from "./file-edits.js";
import { createReadCopies } from "@fungi.computer/agar/read-copy";
import { mayPush, type PolicyFacts } from "./policy.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import type { EventSink } from "@fungi.computer/oyster/git";
import { insightLayout, type InsightLayout } from "../shared/insights.js";
import type {
  WatchdogSqliteOwner,
  WatchdogSqliteValue,
} from "@fungi.computer/watchdog";
import {
  activityEnvelope,
  hookEvent,
  type HookEvent,
} from "../shared/hooks.js";
import {
  activity as activitySchema,
  changeRecord,
  repoDetail,
  changeDetail,
  changeIdentityOf,
  approval,
  check,
  type ChangeRecord,
  type Approval,
  type Check,
  type Activity,
  type Agent,
  type RepoSummary,
} from "../shared/contract.js";
import { commit as commitSchema } from "@fungi.computer/agar/roles/files";

export type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
/** Activity before it is stored and numbered. */
export type NewActivity = WithoutId<Activity>;

/** Which actor first pushed a commit, and to which repository. */
export type CommitOrigin = Readonly<{
  hash: string;
  agent: string;
  repo: string;
}>;

export type ActorKind = "agent" | "human";

const PALETTE_SIZE = 8;
const HOUR = 3_600_000;
const actorRow = z.object({
  name: z.string(),
  color: z.string(),
  kind: z.enum(["human", "agent"]),
  first_seen: z.number(),
});
const repoRow = z.object({
  name: z.string(),
  description: z.string().nullable(),
  parent: z.string().nullable(),
  owner: z.string().nullable(),
  created_at: z.number(),
});
const eventRow = z.object({
  id: z.number(),
  at: z.number(),
  type: z.string(),
  repo: z.string(),
  actor: z.string(),
  data: z.string(),
});
const receiptRow = z.object({ digest: z.string(), result: z.string() });
export const changeCopySchema = z.strictObject({
  target: changeRecord.shape.target,
  base: changeRecord.shape.head.nullable(),
  ahead: z.array(commitSchema),
  aheadHashes: z.array(changeRecord.shape.head),
  behind: z.number().int().nonnegative(),
  headAuthors: z.array(z.string()),
  detailHash: z.string().nullable(),
});
export const changeObjectsSchema = changeDetail.pick({
  commits: true,
  diff: true,
});
export function changeCopyKey(row: ChangeRecord): string {
  return JSON.stringify([row.repo, row.sourceRepo, row.head, row.target]);
}

function toActor(row: z.output<typeof actorRow>): Agent {
  return {
    id: row.name,
    name: row.name,
    color: row.color,
    kind: row.kind === "human" ? "human" : "agent",
    createdAt: row.first_seen,
  };
}

function toActivity(row: z.output<typeof eventRow>): Activity {
  const data: unknown = JSON.parse(row.data);
  return activitySchema.parse({
    id: row.id,
    at: row.at,
    type: row.type,
    repo: row.repo,
    actor: row.actor,
    data,
  });
}

const changeColumns = `repo, number, source_repo AS sourceRepo, source_ref AS sourceRef, target_ref AS targetRef,
  title, body, opened_by AS openedBy, opened_kind AS openedKind, created_at AS createdAt,
  updated_at AS updatedAt, state, head_sha AS head, target_sha AS target, revision,
  conflict, lease, merged_commit AS mergedCommit, merged_by AS mergedBy, closed_by AS closedBy`;
const storedChange = changeRecord
  .extend({ conflict: z.string().nullable(), lease: z.string().nullable() })
  .transform((row) => {
    const conflict: unknown =
      row.conflict === null ? null : JSON.parse(row.conflict);
    const lease: unknown = row.lease === null ? null : JSON.parse(row.lease);
    return changeRecord.parse({ ...row, conflict, lease });
  });

/** Create the tables; the App's state schema version 1. */
export function ensureBonsaiTables(sql: WatchdogSqliteOwner["sql"]): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS insight_layouts (
      actor TEXT NOT NULL, repo TEXT NOT NULL, tiles TEXT NOT NULL,
      PRIMARY KEY (actor, repo)) STRICT;
    CREATE TABLE IF NOT EXISTS changes (
      repo TEXT NOT NULL, number INTEGER NOT NULL, source_repo TEXT NOT NULL,
      source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      opened_by TEXT NOT NULL, opened_kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','merging','merged','closed')),
      head_sha TEXT NOT NULL, target_sha TEXT NOT NULL, revision INTEGER NOT NULL,
      conflict TEXT, lease TEXT, merged_commit TEXT, merged_by TEXT, closed_by TEXT,
      PRIMARY KEY(repo, number)) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS changes_open_source ON changes(source_repo, source_ref, target_ref) WHERE state IN ('open','merging');
    CREATE TABLE IF NOT EXISTS approvals (
      repo TEXT NOT NULL, number INTEGER NOT NULL, head_sha TEXT NOT NULL, actor TEXT NOT NULL,
      actor_kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(repo,number,head_sha,actor)) STRICT;
    CREATE TABLE IF NOT EXISTS checks (
      repo TEXT NOT NULL, number INTEGER NOT NULL, head_sha TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','passed','failed')),
      reporter TEXT NOT NULL, attempt_id TEXT NOT NULL, run_url TEXT, summary TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(repo,number,head_sha,name)) STRICT;
    CREATE TABLE IF NOT EXISTS actors (
      name TEXT PRIMARY KEY, color TEXT NOT NULL, kind TEXT NOT NULL,
      first_seen INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS repository_ref_readiness (
      repo TEXT PRIMARY KEY, revision INTEGER NOT NULL, pending INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS repos (
      name TEXT PRIMARY KEY, description TEXT, parent TEXT, owner TEXT,
      created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS repo_deletions (
      name TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS repo_lifetimes (
      name TEXT PRIMARY KEY, generation INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL,
      repo TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS events_repo ON events(repo, id);
    CREATE TABLE IF NOT EXISTS merge_failures (repo TEXT NOT NULL, number INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(repo,number)) STRICT;
    CREATE TABLE IF NOT EXISTS receipts (
      key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, emitted INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(emitted);
    CREATE TABLE IF NOT EXISTS commits (
      hash TEXT NOT NULL, repo TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (hash, repo)) STRICT;
    CREATE INDEX IF NOT EXISTS commits_hash ON commits(hash);
  `);
}

export class BonsaiState {
  /** Shared SQLite owner for Bonsai's actor-lane background jobs and file rows. */
  readonly backgroundOwner: WatchdogSqliteOwner;
  readonly fileEdits;
  readonly copies;
  readonly repositoryCopies;
  readonly changeCopies;
  constructor(
    private readonly sql: WatchdogSqliteOwner["sql"],
    private readonly commit: <T>(body: () => T) => T,
  ) {
    this.backgroundOwner = { sql, transactionSync: commit };
    this.fileEdits = new FileEdits(this.backgroundOwner);
    this.copies = createReadCopies(sql, {
      version: 1,
      maxRows: 10_000,
      maxValueBytes: 512_000,
      maxBlobBytes: 512_000,
      maxBlobTotalBytes: 32 * 1024 * 1024,
    });
    this.repositoryCopies = this.copies.open(
      "bonsai-repository",
      repoDetail.omit({ repo: true }),
    );
    this.changeCopies = this.copies.open("bonsai-change", changeCopySchema);
  }

  repositoryRefStatus(repo: string) {
    const row = this.rows(
      z.object({
        revision: z.number().int().nonnegative(),
        pending: z.number().int(),
      }),
      "SELECT revision, pending FROM repository_ref_readiness WHERE repo = ?",
      repo,
    )[0];
    return { revision: row?.revision ?? 0, pending: row?.pending === 1 };
  }

  /** A push blocks mutable readers before any provider work can fail. */
  invalidateRepositoryRefs(repo: string): number {
    this.sql.exec(
      "INSERT INTO repository_ref_readiness(repo, revision, pending) VALUES(?,1,1) ON CONFLICT(repo) DO UPDATE SET revision=revision+1,pending=1",
      repo,
    );
    return this.repositoryRefStatus(repo).revision;
  }

  /** Publish refs and clear only the invalidation this refresh observed. */
  publishRepositoryRefs(
    repo: string,
    revision: number,
    head: string | null,
    value: Omit<z.output<typeof repoDetail>, "repo">,
  ) {
    return this.commit(() => {
      if (this.repositoryRefStatus(repo).revision !== revision) return false;
      this.repositoryCopies.write(repo, head, value);
      this.sql.exec(
        "UPDATE repository_ref_readiness SET pending=0 WHERE repo=? AND revision=?",
        repo,
        revision,
      );
      return true;
    });
  }

  private rows<R>(
    schema: z.ZodType<R>,
    statement: string,
    ...bindings: WatchdogSqliteValue[]
  ): R[] {
    return this.sql
      .exec(statement, ...bindings)
      .toArray()
      .map((row) => schema.parse(row));
  }

  layout(actor: string, repo: string): InsightLayout | null {
    const row = this.rows(
      z.object({ tiles: z.string() }),
      "SELECT tiles FROM insight_layouts WHERE actor = ? AND repo = ?",
      actor,
      repo,
    )[0];
    if (!row) return null;
    const decoded = insightLayout.safeParse(JSON.parse(row.tiles));
    return decoded.success ? decoded.data : null;
  }

  saveLayout(actor: string, repo: string, tiles: InsightLayout): void {
    this.sql.exec(
      "INSERT INTO insight_layouts (actor, repo, tiles) VALUES (?, ?, ?) ON CONFLICT(actor, repo) DO UPDATE SET tiles = excluded.tiles",
      actor,
      repo,
      JSON.stringify(insightLayout.parse(tiles)),
    );
  }

  /** Remember an actor; the first sighting assigns its palette slot. */
  seeActor(name: string, kind: ActorKind): void {
    const count = z
      .object({ n: z.number() })
      .parse(
        this.rows(
          z.object({ n: z.number() }),
          "SELECT COUNT(*) AS n FROM actors",
        )[0],
      ).n;
    this.sql.exec(
      "INSERT OR IGNORE INTO actors (name, color, kind, first_seen) VALUES (?, ?, ?, ?)",
      name,
      `c${String(count % PALETTE_SIZE)}`,
      kind,
      Date.now(),
    );
  }

  actors(): Agent[] {
    return this.rows(
      actorRow,
      "SELECT name, color, kind, first_seen FROM actors ORDER BY first_seen",
    ).map(toActor);
  }

  registerRepo(input: {
    name: string;
    description: string | null;
    parent: string | null;
    owner: string | null;
  }): void {
    this.commit(() => {
      const present =
        this.rows(
          z.object({ name: z.string() }),
          "SELECT name FROM repos WHERE name = ?",
          input.name,
        ).length > 0;
      if (!present)
        this.sql.exec(
          "INSERT INTO repo_lifetimes(name, generation) VALUES (?,1) ON CONFLICT(name) DO UPDATE SET generation=generation+1",
          input.name,
        );
      this.sql.exec(
        "INSERT OR IGNORE INTO repos (name, description, parent, owner, created_at) VALUES (?, ?, ?, ?, ?)",
        input.name,
        input.description,
        input.parent,
        input.owner,
        Date.now(),
      );
    });
  }

  /** Stable across pushes; advances only when an absent name is registered again. */
  repositoryGeneration(name: string): number {
    return (
      this.rows(
        z.object({ generation: z.number().int().nonnegative() }),
        "SELECT generation FROM repo_lifetimes WHERE name = ?",
        name,
      )[0]?.generation ?? 0
    );
  }

  /** Pending provider cleanup reserves the name; old publications cannot reuse it. */
  assertRepoAvailable(name: string, revision?: number): void {
    const pending =
      this.rows(
        z.object({ name: z.string() }),
        "SELECT name FROM repo_deletions WHERE name = ?",
        name,
      ).length > 0;
    if (
      pending ||
      (revision !== undefined &&
        this.repositoryRefStatus(name).revision !== revision)
    )
      throw new AppMethodRefusal(
        "conflict",
        "Repository changed or deletion is pending; retry after cleanup",
      );
  }

  /** Release the reserved name only after the provider confirms absence. */
  completeRepoDeletion(name: string): void {
    this.sql.exec("DELETE FROM repo_deletions WHERE name = ?", name);
  }

  /** Withdraw a repository atomically; keep its ref revision to fence old rebuilds. */
  removeRepo(name: string): void {
    this.commit(() => {
      if (
        this.rows(
          z.object({ name: z.string() }),
          "SELECT name FROM repo_deletions WHERE name = ?",
          name,
        ).length > 0
      )
        return;
      if ((this.repo(name)?.forks.length ?? 0) > 0)
        throw new AppMethodRefusal(
          "conflict",
          "Delete the repository's forks first",
        );
      this.sql.exec("INSERT INTO repo_deletions(name) VALUES (?)", name);
      this.invalidateRepositoryRefs(name);
      this.repositoryCopies.stale(name);
      this.sql.exec(
        "DELETE FROM outbox WHERE json_extract(envelope, '$.data.repository.name') = ? OR json_extract(envelope, '$.data.repository.canonical') = ?",
        name,
        name,
      );
      this.sql.exec(
        "DELETE FROM approvals WHERE (repo, number) IN (SELECT repo, number FROM changes WHERE repo = ? OR source_repo = ?)",
        name,
        name,
      );
      this.sql.exec(
        "DELETE FROM checks WHERE (repo, number) IN (SELECT repo, number FROM changes WHERE repo = ? OR source_repo = ?)",
        name,
        name,
      );
      this.sql.exec(
        "DELETE FROM changes WHERE repo = ? OR source_repo = ?",
        name,
        name,
      );
      this.sql.exec(
        "DELETE FROM events WHERE repo = ? OR json_extract(data, '$.fork') = ? OR json_extract(data, '$.change.sourceRepo') = ?",
        name,
        name,
        name,
      );
      this.sql.exec("DELETE FROM commits WHERE repo = ?", name);
      this.sql.exec("DELETE FROM insight_layouts WHERE repo = ?", name);
      this.sql.exec("DELETE FROM repos WHERE name = ?", name);
    });
  }

  private summaries(where: string, ...args: string[]): RepoSummary[] {
    const rows = this.rows(
      repoRow,
      `SELECT name, description, parent, owner, created_at FROM repos ${where} ORDER BY created_at`,
      ...args,
    );
    const since = Date.now() - 24 * HOUR;
    return rows.map((row) => {
      const forks = this.rows(
        z.object({ name: z.string() }),
        "SELECT name FROM repos WHERE parent = ? ORDER BY created_at",
        row.name,
      ).map((fork) => fork.name);
      const family = [row.name, ...forks];
      const marks = family.map(() => "?").join(",");
      const pushes = this.rows(
        z.object({ at: z.number() }),
        `SELECT at FROM events WHERE type = 'push' AND repo IN (${marks}) AND at >= ?`,
        ...family,
        since,
      );
      const activity = Array.from({ length: 24 }, () => 0);
      for (const push of pushes) {
        const bucket = Math.min(23, Math.floor((push.at - since) / HOUR));
        activity[bucket] = (activity[bucket] ?? 0) + 1;
      }
      const last =
        this.rows(
          z.object({ at: z.number().nullable() }),
          `SELECT MAX(at) AS at FROM events WHERE type = 'push' AND repo IN (${marks})`,
          ...family,
        )[0]?.at ?? null;
      return {
        name: row.name,
        description: row.description,
        parent: row.parent,
        owner: row.owner,
        createdAt: row.created_at,
        lastPushAt: last,
        forks,
        openChanges:
          this.rows(
            z.object({ n: z.number() }),
            "SELECT COUNT(*) AS n FROM changes WHERE (repo = ? OR source_repo = ?) AND state IN ('open', 'merging')",
            row.name,
            row.name,
          )[0]?.n ?? 0,
        activity,
      };
    });
  }

  repos(): RepoSummary[] {
    return this.summaries("WHERE parent IS NULL");
  }

  /** Saved canonical picker facts without summary, family or provider fan-out. */
  repositoryOptions(): Pick<RepoSummary, "name" | "description">[] {
    return this.rows(
      repoRow.pick({ name: true, description: true }),
      "SELECT name, description FROM repos WHERE parent IS NULL ORDER BY name",
    );
  }

  repo(name: string): RepoSummary | null {
    return this.summaries("WHERE name = ?", name)[0] ?? null;
  }

  /** The canonical repository a repository belongs to. */
  canonicalOf(repo: string): string {
    const row = this.rows(
      z.object({ parent: z.string().nullable() }),
      "SELECT parent FROM repos WHERE name = ?",
      repo,
    )[0];
    return row?.parent ?? repo;
  }

  change(repo: string, number: number): ChangeRecord | null {
    const row =
      this.rows(
        storedChange,
        `SELECT ${changeColumns} FROM changes WHERE repo = ? AND number = ?`,
        repo,
        number,
      )[0] ?? null;
    return row === null ? null : this.mergeStatus(row);
  }

  private mergeStatus(row: ChangeRecord): ChangeRecord {
    const failure = this.rows(
      z.object({ reason: changeRecord.shape.mergeFailure.unwrap() }),
      "SELECT reason FROM merge_failures WHERE repo=? AND number=?",
      row.repo,
      row.number,
    )[0];
    return failure === undefined
      ? row
      : { ...row, mergeFailure: failure.reason };
  }

  /** Terminal job projection can release only the lease belonging to that job. */
  failMergeLease(
    repo: string,
    number: number,
    leaseId: string,
    reason: NonNullable<ChangeRecord["mergeFailure"]>,
  ): boolean {
    return this.commit(() => {
      const row = this.change(repo, number);
      if (row?.lease?.id !== leaseId) return false;
      this.reviseChange(
        {
          ...row,
          state: row.state === "closed" ? "closed" : "open",
          lease: null,
          mergeFailure: reason,
          updatedAt: Date.now(),
        },
        row.revision,
      );
      return true;
    });
  }

  changes(repo: string | null): ChangeRecord[] {
    return this.rows(
      storedChange,
      `SELECT ${changeColumns} FROM changes WHERE (? IS NULL OR repo = ?) ORDER BY updated_at DESC, number DESC`,
      repo,
      repo,
    ).map((row) => this.mergeStatus(row));
  }

  insertChange(input: Omit<ChangeRecord, "number" | "revision">): ChangeRecord {
    const latest = this.rows(
      z.object({ number: z.number() }),
      "SELECT COALESCE(MAX(number),0) AS number FROM changes WHERE repo = ?",
      input.repo,
    )[0];
    if (latest === undefined)
      throw new Error("Missing Change number allocation");
    const row = changeRecord.parse({
      ...input,
      number: latest.number + 1,
      revision: 0,
    });
    this.sql.exec(
      `INSERT INTO changes (repo, number, source_repo, source_ref, target_ref, title, body, opened_by, opened_kind, created_at, updated_at, state, head_sha, target_sha, revision, conflict, lease, merged_commit, merged_by, closed_by) VALUES (${Array.from({ length: 20 }, () => "?").join(",")})`,
      row.repo,
      row.number,
      row.sourceRepo,
      row.sourceRef,
      row.targetRef,
      row.title,
      row.body,
      row.openedBy,
      row.openedKind,
      row.createdAt,
      row.updatedAt,
      row.state,
      row.head,
      row.target,
      row.revision,
      row.conflict === null ? null : JSON.stringify(row.conflict),
      row.lease === null ? null : JSON.stringify(row.lease),
      row.mergedCommit,
      row.mergedBy,
      row.closedBy,
    );
    this.sql.exec(
      "DELETE FROM merge_failures WHERE repo=? AND number=?",
      row.repo,
      row.number,
    );
    return row;
  }

  reviseChange(next: ChangeRecord, expectedRevision: number): ChangeRecord {
    const row = changeRecord.parse({ ...next, revision: expectedRevision + 1 });
    const changed = this.rows(
      z.object({ number: z.number() }),
      `UPDATE changes SET head_sha = ?, target_sha = ?, state = ?, conflict = ?, lease = ?, merged_commit = ?, merged_by = ?, closed_by = ?, updated_at = ?, revision = ? WHERE repo = ? AND number = ? AND revision = ? RETURNING number`,
      row.head,
      row.target,
      row.state,
      row.conflict === null ? null : JSON.stringify(row.conflict),
      row.lease === null ? null : JSON.stringify(row.lease),
      row.mergedCommit,
      row.mergedBy,
      row.closedBy,
      row.updatedAt,
      row.revision,
      row.repo,
      row.number,
      expectedRevision,
    );
    if (changed.length !== 1) throw new Error("Change revision moved");
    if (row.mergeFailure === undefined)
      this.sql.exec(
        "DELETE FROM merge_failures WHERE repo=? AND number=?",
        row.repo,
        row.number,
      );
    else
      this.sql.exec(
        "INSERT INTO merge_failures(repo,number,reason) VALUES(?,?,?) ON CONFLICT(repo,number) DO UPDATE SET reason=excluded.reason",
        row.repo,
        row.number,
        row.mergeFailure,
      );
    return row;
  }

  approvals(repo: string, number: number): Approval[] {
    return this.rows(
      approval,
      "SELECT actor, actor_kind AS kind, head_sha AS head, at FROM approvals WHERE repo = ? AND number = ? ORDER BY at",
      repo,
      number,
    );
  }

  approve(repo: string, number: number, raw: Approval): void {
    const row = approval.parse(raw);
    this.sql.exec(
      "INSERT OR IGNORE INTO approvals (repo,number,head_sha,actor,actor_kind,at) VALUES (?,?,?,?,?,?)",
      repo,
      number,
      row.head,
      row.actor,
      row.kind,
      row.at,
    );
  }

  checks(repo: string, number: number): Check[] {
    return this.rows(
      check,
      "SELECT head_sha AS head, name, status, reporter, attempt_id AS attemptId, run_url AS runUrl, summary, updated_at AS updatedAt FROM checks WHERE repo = ? AND number = ? ORDER BY name",
      repo,
      number,
    );
  }

  reportCheck(repo: string, number: number, raw: Check): void {
    const row = check.parse(raw);
    this.sql.exec(
      "INSERT INTO checks (repo,number,head_sha,name,status,reporter,attempt_id,run_url,summary,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo,number,head_sha,name) DO UPDATE SET status=excluded.status,reporter=excluded.reporter,attempt_id=excluded.attempt_id,run_url=excluded.run_url,summary=excluded.summary,updated_at=excluded.updated_at",
      repo,
      number,
      row.head,
      row.name,
      row.status,
      row.reporter,
      row.attemptId,
      row.runUrl,
      row.summary,
      row.updatedAt,
    );
  }

  requireChange(repo: string, number: number): ChangeRecord {
    const row = this.change(repo, number);
    if (row === null)
      throw new AppMethodRefusal(
        "not_found",
        `No Change ${repo}#${String(number)}`,
      );
    return row;
  }

  changeEvent(
    row: ChangeRecord,
    actor: string,
    type:
      | "change.opened"
      | "change.updated"
      | "change.approved"
      | "change.checks_requested"
      | "change.checked"
      | "change.closed",
    cloneUrl: string,
    details: Readonly<{
      before?: string;
      after?: string;
      name?: string;
      status?: "queued" | "running" | "passed" | "failed";
      names?: string[];
    }> = {},
  ): HookEvent {
    const stored = this.record(
      activitySchema.parse({
        id: 0,
        at: row.updatedAt,
        type,
        repo: row.repo,
        actor,
        data: { change: changeIdentityOf(row), ...details },
      }),
    );
    return activityEnvelope(stored, {
      name: row.sourceRepo,
      canonical: row.repo,
      cloneUrl,
    });
  }

  reviewFacts(
    actor: PolicyFacts["actor"],
    row: ChangeRecord,
    head: string,
    headAuthors: readonly string[],
  ): PolicyFacts {
    return {
      actor,
      change: row,
      head,
      headAuthors,
      approvals: this.approvals(row.repo, row.number),
      checks: this.checks(row.repo, row.number),
      isMaintainer: actor.kind === "human",
      mayPush: mayPush(actor, this.repo(row.sourceRepo)),
      sourceOwner: this.repo(row.sourceRepo)?.owner ?? null,
      soleMember: actor.kind === "human" && actor.soleMember === true,
    };
  }

  /** Read a committed result and refuse a replay key with different input. */
  receipt<R>(
    key: string,
    digest: string,
    schema: z.ZodType<R>,
  ): Readonly<{ result: R }> | null {
    const row = this.rows(
      receiptRow,
      "SELECT digest, result FROM receipts WHERE key = ?",
      key,
    )[0];
    if (row === undefined) return null;
    if (row.digest !== digest)
      throw new Error("Receipt key reused with different contents");
    return { result: schema.parse(JSON.parse(row.result)) };
  }

  /** Commit domain changes, the replay result and every event atomically. */
  transition<R>(
    key: string,
    digest: string,
    schema: z.ZodType<R>,
    build: () => Readonly<{ result: R; events: readonly HookEvent[] }>,
  ): R {
    return this.commit(() => {
      const recorded = this.receipt(key, digest, schema);
      if (recorded !== null) return recorded.result;
      const built = build();
      const result = schema.parse(built.result);
      this.sql.exec(
        "INSERT INTO receipts (key, digest, result) VALUES (?, ?, ?)",
        key,
        digest,
        JSON.stringify(result),
      );
      for (const raw of built.events) {
        const event = hookEvent.parse(raw);
        this.sql.exec(
          "INSERT INTO outbox (event_id, envelope) VALUES (?, ?)",
          event.data.eventId,
          JSON.stringify(event),
        );
      }
      return result;
    });
  }

  /** Resolve an opaque attempt identity against an actual committed envelope. */
  event(eventId: string): HookEvent | null {
    const row = this.rows(
      z.object({ envelope: z.string() }),
      "SELECT envelope FROM outbox WHERE event_id = ?",
      eventId,
    )[0];
    return row === undefined ? null : hookEvent.parse(JSON.parse(row.envelope));
  }

  /** A delivery page, not a bound on how many envelopes a transition accepts. */
  pendingEvents(): HookEvent[] {
    return this.rows(
      z.object({ envelope: z.string() }),
      "SELECT envelope FROM outbox WHERE emitted = 0 ORDER BY rowid LIMIT 32",
    ).map((row) => hookEvent.parse(JSON.parse(row.envelope)));
  }

  acknowledge(eventId: string): void {
    this.sql.exec("UPDATE outbox SET emitted = 1 WHERE event_id = ?", eventId);
  }

  record(event: NewActivity): Activity {
    const row = this.rows(
      z.object({ id: z.number() }),
      "INSERT INTO events (at, type, repo, actor, data) VALUES (?, ?, ?, ?, ?) RETURNING id",
      event.at,
      event.type,
      event.repo,
      event.actor,
      JSON.stringify(event.data),
    )[0];
    const stored = activitySchema.parse({
      ...event,
      id: z.object({ id: z.number() }).parse(row).id,
    });
    if (stored.type === "push")
      for (const item of stored.data.commits)
        this.sql.exec(
          "INSERT OR IGNORE INTO commits (hash, repo, agent, at) VALUES (?, ?, ?, ?)",
          item.hash,
          stored.repo,
          stored.actor,
          event.at,
        );
    return stored;
  }

  /** Activity for a repository family (the repo and its forks), newest first. */
  events(repo: string | null, limit: number, after = 0): Activity[] {
    const bounded = Math.max(1, Math.min(200, limit));
    if (repo === null)
      return this.rows(
        eventRow,
        "SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?",
        after,
        bounded,
      ).map(toActivity);
    return this.rows(
      eventRow,
      "SELECT * FROM events WHERE id > ? AND (repo = ? OR repo IN (SELECT name FROM repos WHERE parent = ?)) ORDER BY id DESC LIMIT ?",
      after,
      repo,
      repo,
      bounded,
    ).map(toActivity);
  }

  /** Where each commit was first pushed, for the commits Bonsai has seen. */
  origins(hashes: readonly string[]): ReadonlyMap<string, CommitOrigin> {
    const result = new Map<string, CommitOrigin>();
    for (let start = 0; start < hashes.length; start += 90) {
      const chunk = hashes.slice(start, start + 90);
      const marks = chunk.map(() => "?").join(",");
      for (const row of this.rows(
        z.object({ hash: z.string(), agent: z.string(), repo: z.string() }),
        `SELECT hash, agent, repo FROM commits WHERE hash IN (${marks}) ORDER BY at, rowid`,
        ...chunk,
      ))
        if (!result.has(row.hash))
          result.set(row.hash, {
            hash: row.hash,
            agent: row.agent,
            repo: row.repo,
          });
    }
    return result;
  }
}

/** Deliver one page with stable IDs; failed delivery stays pending for the next write. */
export async function drainOutbox(
  bonsai: Readonly<{ state: BonsaiState; events: EventSink }>,
): Promise<
  | { kind: "delivered"; delivered: number }
  | { kind: "deferred"; delivered: number; cause: unknown }
> {
  let delivered = 0;
  try {
    for (const event of bonsai.state.pendingEvents()) {
      await bonsai.events.emit(
        event.type,
        {
          type: event.type,
          timestamp: event.timestamp,
          data: z.json().parse(event.data),
        },
        event.data.eventId,
      );
      bonsai.state.acknowledge(event.data.eventId);
      delivered += 1;
    }
    return { kind: "delivered", delivered };
  } catch (cause) {
    // Domain changes are already committed; preserve the failure for the delivery caller.
    return { kind: "deferred", delivered, cause };
  }
}
