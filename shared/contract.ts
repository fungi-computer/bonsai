/**
 * The Bonsai HTTP contract. The Worker produces these shapes and the web UI
 * (or any other client) parses them at its boundary. Nothing here knows about
 * Cloudflare, Fungi or React.
 */
import * as z from "zod";
import {
  gitRepositoryNameSchema as repoName,
  gitSha1Schema as hash,
} from "@fungi.computer/puffball/git-representation";
import { commit } from "@fungi.computer/agar/roles/files";

export const productName = "Bonsai";

/** An explicit owner action starts the same published build/install Workflow. */
export const appBuildWorkflowInput = z.strictObject({
  repo: repoName,
  sourceRevision: z.string().min(1).max(256),
  installationId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
});
export type AppBuildWorkflowInput = z.infer<typeof appBuildWorkflowInput>;

/** Any JSON value: App method inputs and results travel as JSON. */
export const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;

const agent = z.strictObject({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  kind: z.enum(["agent", "human"]),
  createdAt: z.number(),
});
export type Agent = z.infer<typeof agent>;

export const ref = z.strictObject({
  name: z.string(),
  hash,
});
export type Ref = z.infer<typeof ref>;

export const repoSummary = z.strictObject({
  name: repoName,
  description: z.string().nullable(),
  parent: repoName.nullable(),
  owner: z.string().nullable(),
  createdAt: z.number(),
  lastPushAt: z.number().nullable(),
  forks: z.array(repoName),
  /** Locally stored open or merging Changes; canonical summaries include their family. */
  openChanges: z.number().int().nonnegative(),
  /** Pushes per hour bucket for the last 24 hours, oldest first. */
  activity: z.array(z.number()),
});
export type RepoSummary = z.infer<typeof repoSummary>;

export const repoDetail = z.strictObject({
  repo: repoSummary,
  defaultBranch: z.string(),
  refs: z.array(ref),
  cloneUrl: z.string(),
  empty: z.boolean(),
});
export type RepoDetail = z.infer<typeof repoDetail>;

const fileDiff = z.strictObject({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "removed", "modified"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  /** True when the file was too large to show. */
  truncated: z.boolean(),
  /** Both sides in full, for the diff viewer; null when binary or too large. */
  oldText: z.string().nullable(),
  newText: z.string().nullable(),
});
export type FileDiff = z.infer<typeof fileDiff>;

const diff = z.strictObject({
  files: z.array(fileDiff),
  additions: z.number(),
  deletions: z.number(),
  /** Files beyond the response limit, counted but not listed. */
  omittedFiles: z.number(),
});
export type Diff = z.infer<typeof diff>;

export const commitDetail = z.strictObject({
  commit,
  agent: z.string().nullable(),
  diff,
});
export type CommitDetail = z.infer<typeof commitDetail>;

export const readCopyPageInput = z.strictObject({
  limit: z.number().int().min(1).max(100).default(100),
  after: z.string().optional(),
});
export type ReadCopyPageInput = z.input<typeof readCopyPageInput>;

/** One lane of the network graph: a branch in the canonical repo or a fork. */
const graphLane = z.strictObject({
  id: z.string(),
  repo: repoName,
  ref: z.string(),
  owner: z.string().nullable(),
  head: hash,
  canonical: z.boolean(),
});
export type GraphLane = z.infer<typeof graphLane>;

const graphNode = z.strictObject({
  hash,
  parents: z.array(hash),
  message: z.string(),
  author: z.string(),
  agent: z.string().nullable(),
  /** The repository the commit was first pushed to, when Bonsai saw the push. */
  origin: repoName.nullable(),
  committedAt: z.number(),
  /** Lanes whose history contains this commit, canonical lanes first. */
  lanes: z.array(z.string()),
});
export type GraphNode = z.infer<typeof graphNode>;

export const graph = z.strictObject({
  lanes: z.array(graphLane),
  nodes: z.array(graphNode),
});
export type Graph = z.infer<typeof graph>;

const refUpdate = z.strictObject({
  ref: z.string(),
  before: hash,
  after: hash,
});

/** Identity included in every Change event, pinned to the proposed head. */
export const changeIdentity = z.strictObject({
  repo: repoName,
  number: z.number().int().positive(),
  sourceRepo: repoName,
  sourceRef: z.string(),
  targetRef: z.string(),
  head: hash,
});

/** Activity recorded by Bonsai. Hook deliveries carry the same events. */
export const activity = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.number(),
    at: z.number(),
    type: z.enum([
      "change.opened",
      "change.updated",
      "change.approved",
      "change.checks_requested",
      "change.checked",
      "change.closed",
    ]),
    repo: repoName,
    actor: z.string(),
    data: z.strictObject({
      change: changeIdentity,
      before: hash.optional(),
      after: hash.optional(),
      name: z.string().optional(),
      status: z.enum(["queued", "running", "passed", "failed"]).optional(),
      names: z.array(z.string()).optional(),
    }),
  }),
  z.strictObject({
    id: z.number(),
    at: z.number(),
    type: z.literal("push"),
    repo: repoName,
    actor: z.string(),
    data: z.strictObject({
      updates: z.array(refUpdate),
      commits: z.array(z.strictObject({ hash, message: z.string() })),
      paths: z.array(z.string()),
    }),
  }),
  z.strictObject({
    id: z.number(),
    at: z.number(),
    type: z.literal("fork"),
    repo: repoName,
    actor: z.string(),
    data: z.strictObject({ fork: repoName }),
  }),
  z.strictObject({
    id: z.number(),
    at: z.number(),
    type: z.literal("repo.created"),
    repo: repoName,
    actor: z.string(),
    data: z.strictObject({}),
  }),
  z.strictObject({
    id: z.number(),
    at: z.number(),
    type: z.literal("merge"),
    repo: repoName,
    actor: z.string(),
    data: z.strictObject({
      change: changeIdentity,
      from: repoName,
      ref: z.string(),
      before: hash,
      after: hash,
    }),
  }),
  z.strictObject({
    id: z.number(),
    at: z.number(),
    type: z.literal("merge.conflict"),
    repo: repoName,
    actor: z.string(),
    data: z.strictObject({
      change: changeIdentity,
      from: repoName,
      ref: z.string(),
      paths: z.array(z.string()),
    }),
  }),
]);
export type Activity = z.infer<typeof activity>;

/** Stored proposal identity; review facts are pinned to its head. */
export const changeRecord = z.strictObject({
  repo: repoName,
  number: z.number().int().positive(),
  sourceRepo: repoName,
  sourceRef: z.string(),
  targetRef: z.string(),
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
  openedBy: z.string(),
  openedKind: z.enum(["human", "agent"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  state: z.enum(["open", "merging", "merged", "closed"]),
  head: hash,
  target: hash,
  revision: z.number().int().nonnegative(),
  conflict: z
    .strictObject({ head: hash, target: hash, paths: z.array(z.string()) })
    .nullable(),
  lease: z
    .strictObject({
      id: z.string(),
      by: z.string(),
      head: hash,
      at: z.number(),
    })
    .nullable(),
  mergedCommit: hash.nullable(),
  mergedBy: z.string().nullable(),
  closedBy: z.string().nullable(),
  /** Present only after a queued merge could not complete. */
  mergeFailure: z
    .enum(["access_changed", "sync_failed", "head_moved"])
    .optional(),
});
export type ChangeRecord = z.infer<typeof changeRecord>;
/** Project the exact identity repeated in every Change delivery. */
export function changeIdentityOf(row: ChangeRecord) {
  return {
    repo: row.repo,
    number: row.number,
    sourceRepo: row.sourceRepo,
    sourceRef: row.sourceRef,
    targetRef: row.targetRef,
    head: row.head,
  };
}
const policyReason = z.enum([
  "not-open",
  "merging",
  "moved",
  "conflict",
  "needs-approval",
  "self-approval",
  "checks-failed",
  "checks-running",
  "not-maintainer",
  "agents-cannot-merge",
  "agents-cannot-approve",
  "not-source-writer",
  "not-authorized",
]);
export const policyDecision = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }),
  z.strictObject({ allowed: z.literal(false), reason: policyReason }),
]);
export type PolicyDecision = z.infer<typeof policyDecision>;
const changeStatus = z.enum([
  "conflict",
  "checks-failed",
  "checks-running",
  "needs-approval",
  "ready",
  "merging",
  "merged",
  "closed",
]);
/** `self` is a sole Team member's approval of their own work. */
export const approval = z.strictObject({
  actor: z.string(),
  kind: z.enum(["human", "agent", "self"]),
  head: hash,
  at: z.number(),
});
export type Approval = z.infer<typeof approval>;
export const check = z.strictObject({
  head: hash,
  name: z.string().min(1).max(100),
  status: z.enum(["queued", "running", "passed", "failed"]),
  reporter: z.string(),
  attemptId: z.string().min(1).max(512),
  runUrl: z.url().nullable(),
  summary: z.string().max(4000).nullable(),
  updatedAt: z.number(),
});
export type Check = z.infer<typeof check>;
const change = changeRecord.extend({
  status: changeStatus,
  mergeable: policyDecision,
  base: hash.nullable(),
  ahead: z.number(),
  behind: z.number(),
});
export type Change = z.infer<typeof change>;
export const changePage = z.strictObject({
  changes: z.array(change),
  next: z.string().optional(),
});
export type ChangePage = z.infer<typeof changePage>;
export const changeDetail = z.strictObject({
  change,
  actions: z.strictObject({ approve: policyDecision, close: policyDecision }),
  commits: z.array(z.strictObject({ commit, agent: z.string().nullable() })),
  diff,
  review: z.strictObject({
    approvals: z.array(approval),
    checks: z.array(check),
  }),
});
export type ChangeDetail = z.infer<typeof changeDetail>;
export const mergeResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("merging") }),
  z.strictObject({ kind: z.literal("merged"), before: hash, after: hash }),
  z.strictObject({ kind: z.literal("moved"), head: hash }),
  z.strictObject({
    kind: z.literal("conflict"),
    paths: z.array(z.string()),
    head: hash,
  }),
  z.strictObject({ kind: z.literal("refused"), reason: policyReason }),
]);
export type MergeResult = z.infer<typeof mergeResult>;

export const approvalResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("approved") }),
  z.strictObject({ kind: z.literal("moved"), head: hash }),
  z.strictObject({ kind: z.literal("refused"), reason: policyReason }),
]);
export const checkRequestResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("requested"), attemptId: z.string() }),
  z.strictObject({ kind: z.literal("moved"), head: hash }),
  z.strictObject({ kind: z.literal("refused"), reason: policyReason }),
]);
export const checkReportResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("recorded") }),
  z.strictObject({ kind: z.literal("moved"), head: hash }),
  z.strictObject({ kind: z.literal("settled") }),
  z.strictObject({ kind: z.literal("refused"), reason: policyReason }),
]);
export type ApprovalResult = z.infer<typeof approvalResult>;
export type CheckRequestResult = z.infer<typeof checkRequestResult>;
export type CheckReportResult = z.infer<typeof checkReportResult>;

export const activityPage = z.strictObject({ events: z.array(activity) });

export const agentPage = z.strictObject({ agents: z.array(agent) });

/** The Markdown files under issues/, keyed by path relative to issues/. */
export const issueFiles = z.strictObject({
  ref: z.string(),
  commit,
  files: z.record(z.string(), z.string()),
  truncated: z.boolean(),
});
export type IssueFiles = z.infer<typeof issueFiles>;
export const repoPage = z.strictObject({ repos: z.array(repoSummary) });

/** The host's install decision on this build, not a consent request. */
const appBuildInstallation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pending"), installationId: z.string() }),
  z.strictObject({ kind: z.literal("installed"), installationId: z.string() }),
  z.strictObject({
    kind: z.literal("needs_consent"),
    installationId: z.string(),
  }),
  z.strictObject({
    kind: z.literal("failed"),
    installationId: z.string(),
    detail: z.string(),
  }),
]);
export type AppBuildInstallation = z.infer<typeof appBuildInstallation>;

/** One App build job as its owner sees it; a settled success carries its Release. */
export const appBuildView = z.strictObject({
  jobId: z.string().min(1).max(256),
  appId: z.string().min(1).max(256),
  releaseId: z.string().min(1).max(256),
  sourceRevision: z.string().min(1).max(256),
  status: z.enum(["running", "succeeded", "failed", "interrupted", "revoked"]),
  detail: z.string().max(65_536).nullable(),
  /** The recorded Release, parsed by its owner where it is installed. */
  release: z.unknown(),
  installation: appBuildInstallation.nullable(),
});

/** Register the calling installation's repository, never a caller-supplied recipe. */
export const appRegistrationInput = z.strictObject({ repo: repoName });

/** Workflows wait for one job; Settings discovers its repository's latest job. */
export const appBuildStatusInput = z.union([
  z.strictObject({ jobId: z.string().min(1).max(256) }),
  appRegistrationInput,
]);

/** The host's App identity and exact main commit whose metadata it registered. */
export const appRegistration = appBuildView.pick({
  appId: true,
  sourceRevision: true,
});

export const errorBody = z.strictObject({ error: z.string() });
