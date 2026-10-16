/** Pure decisions over host identity, the stored proposal and pinned review facts. */
import type {
  RepoSummary,
  Change,
  ChangeRecord,
  PolicyDecision,
  Approval,
  Check,
} from "../shared/contract.js";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import type { BonsaiActor } from "./service.js";

export type PolicyFacts = Readonly<{
  actor: BonsaiActor;
  change: Pick<
    ChangeRecord,
    "state" | "head" | "target" | "openedBy" | "conflict"
  >;
  head: string;
  approvals: readonly Pick<Approval, "actor" | "head" | "kind">[];
  checks: readonly Pick<Check, "head" | "status">[];
  headAuthors: readonly string[];
  isMaintainer: boolean;
  mayPush: boolean;
  sourceOwner: string | null;
  /** Host-attested: the acting person is their Team's only member. */
  soleMember: boolean;
}>;
export type Action =
  "open" | "approve" | "merge" | "close" | "reportCheck" | "requestChecks";

/** Someone who neither opened the Change nor authored its head. */
function independent(facts: PolicyFacts, actor: string): boolean {
  return actor !== facts.change.openedBy && !facts.headAuthors.includes(actor);
}

/**
 * Review asks for a second person. A Team with only one member has none, so
 * the host-attested sole member may approve and merge their own work. Their
 * approval is recorded as `self` for the review history, and each decision
 * reads the attestation afresh, so it stops applying once the Team grows.
 * Agents are never members, so they never self-approve.
 */
function soleSelf(facts: PolicyFacts): boolean {
  return facts.soleMember && facts.actor.kind === "human";
}

/** How the acting person's approval of this head is recorded. */
export function approvalKind(facts: PolicyFacts): "human" | "self" {
  return independent(facts, facts.actor.name) ? "human" : "self";
}

export function decide(action: Action, facts: PolicyFacts): PolicyDecision {
  if (action === "open")
    return facts.mayPush
      ? { allowed: true }
      : { allowed: false, reason: "not-source-writer" };
  if (action === "merge" && facts.actor.kind !== "human")
    return { allowed: false, reason: "agents-cannot-merge" };
  if (action === "approve" && facts.actor.kind !== "human")
    return { allowed: false, reason: "agents-cannot-approve" };
  if (action === "reportCheck" || action === "requestChecks") {
    if (facts.head !== facts.change.head)
      return { allowed: false, reason: "moved" };
    return facts.change.state === "open" || facts.change.state === "merging"
      ? { allowed: true }
      : { allowed: false, reason: "not-open" };
  }
  if (facts.change.state === "merging")
    return { allowed: false, reason: "merging" };
  if (facts.change.state !== "open")
    return { allowed: false, reason: "not-open" };
  if (action === "close")
    return facts.isMaintainer ||
      facts.actor.name === facts.change.openedBy ||
      facts.actor.name === facts.sourceOwner
      ? { allowed: true }
      : { allowed: false, reason: "not-authorized" };
  if (facts.head !== facts.change.head)
    return { allowed: false, reason: "moved" };
  if (!facts.isMaintainer) return { allowed: false, reason: "not-maintainer" };
  if (action === "approve")
    return independent(facts, facts.actor.name) || soleSelf(facts)
      ? { allowed: true }
      : { allowed: false, reason: "self-approval" };
  const conflict = facts.change.conflict;
  if (
    conflict?.head === facts.change.head &&
    conflict.target === facts.change.target
  )
    return { allowed: false, reason: "conflict" };
  const checks = facts.checks.filter(
    (check) => check.head === facts.change.head,
  );
  if (checks.some((check) => check.status === "failed"))
    return { allowed: false, reason: "checks-failed" };
  if (
    checks.some(
      (check) => check.status === "queued" || check.status === "running",
    )
  )
    return { allowed: false, reason: "checks-running" };
  const approvers = new Set(
    facts.approvals
      .filter(
        (approval) =>
          approval.head === facts.change.head &&
          approval.kind === "human" &&
          independent(facts, approval.actor),
      )
      .map((approval) => approval.actor),
  );
  if (independent(facts, facts.actor.name) || soleSelf(facts))
    approvers.add(facts.actor.name);
  return approvers.size > 0
    ? { allowed: true }
    : { allowed: false, reason: "needs-approval" };
}

export type Review = Readonly<{
  status: Change["status"];
  decision: PolicyDecision;
}>;
export function review(facts: PolicyFacts): Review {
  const decision = decide("merge", facts);
  const state = facts.change.state;
  if (state !== "open") return { status: state, decision };
  if (decision.allowed) return { status: "ready", decision };
  switch (decision.reason) {
    case "conflict":
    case "checks-failed":
    case "checks-running":
      return { status: decision.reason, decision };
    default:
      return { status: "needs-approval", decision };
  }
}

/** Host-issued IDs own forks; display names are never authorization facts. */
export function mayPush(actor: BonsaiActor, repo: RepoSummary | null): boolean {
  return (
    repo !== null &&
    (actor.kind === "human" ||
      (repo.parent !== null && repo.owner === actor.name))
  );
}

/** The acting identity, as the host attributed the call. */
export function callerActor(caller: AppMethodCallContext): BonsaiActor {
  switch (caller.actor.kind) {
    case "member":
      return caller.soleMember === true
        ? { name: caller.actor.memberId, kind: "human", soleMember: true }
        : { name: caller.actor.memberId, kind: "human" };
    case "agent":
      return { name: caller.actor.agentId, kind: "agent" };
    case "team-key":
      return { name: caller.actor.keyId, kind: "agent" };
  }
}
