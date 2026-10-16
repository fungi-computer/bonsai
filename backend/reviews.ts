/** Pinned approvals and check attempts, backed by native receipts. */
import { replayKey } from "@fungi.computer/cairn";
import {
  approvalResult,
  checkRequestResult,
  checkReportResult,
  type ChangeRecord,
  type ApprovalResult,
  type CheckRequestResult,
  type CheckReportResult,
  type Check,
} from "../shared/contract.js";
import type { HookEvent } from "../shared/hooks.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import { approvalKind, decide } from "./policy.js";
import { authorsAtHead } from "./history.js";
import { recoverExpiredLease } from "./merge.js";
import type { Bonsai, BonsaiActor } from "./service.js";

export async function approveChange(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: { repo: string; number: number; head: string },
  requestKey: string = replayKey(),
): Promise<ApprovalResult> {
  const key = `approve:${requestKey}`;
  const digest = JSON.stringify({ actor, input });
  const cached = bonsai.state.receipt(key, digest, approvalResult);
  if (cached !== null) {
    return cached.result;
  }
  const initial = await recoverExpiredLease(
    bonsai,
    bonsai.state.requireChange(input.repo, input.number),
  );
  const [authors, cloneUrl] = await Promise.all([
    authorsAtHead(bonsai, initial),
    bonsai.store.cloneUrl(initial.sourceRepo),
  ]);
  const result = bonsai.state.transition(key, digest, approvalResult, () => {
    const row = bonsai.state.requireChange(input.repo, input.number);
    if (row.head !== input.head)
      return {
        result: approvalResult.parse({ kind: "moved", head: row.head }),
        events: [],
      };
    const facts = bonsai.state.reviewFacts(actor, row, input.head, authors);
    const decision = decide("approve", facts);
    if (!decision.allowed)
      return {
        result: approvalResult.parse({
          kind: "refused",
          reason: decision.reason,
        }),
        events: [],
      };
    const exists = bonsai.state
      .approvals(row.repo, row.number)
      .some(
        (approval) =>
          approval.head === row.head && approval.actor === actor.name,
      );
    if (exists)
      return { result: approvalResult.parse({ kind: "approved" }), events: [] };
    const next = bonsai.state.reviseChange(
      { ...row, updatedAt: Date.now() },
      row.revision,
    );
    bonsai.state.approve(row.repo, row.number, {
      actor: actor.name,
      kind: approvalKind(facts),
      head: row.head,
      at: next.updatedAt,
    });
    return {
      result: approvalResult.parse({ kind: "approved" }),
      events: [
        bonsai.state.changeEvent(next, actor.name, "change.approved", cloneUrl),
      ],
    };
  });
  return result;
}

export async function requestChecks(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: {
    repo: string;
    number: number;
    head: string;
    names?: string[] | undefined;
  },
  requestKey: string = replayKey(),
): Promise<CheckRequestResult> {
  const key = `checks-request:${requestKey}`;
  const digest = JSON.stringify({ actor, input });
  const cached = bonsai.state.receipt(key, digest, checkRequestResult);
  if (cached !== null) {
    return cached.result;
  }
  const initial = await recoverExpiredLease(
    bonsai,
    bonsai.state.requireChange(input.repo, input.number),
  );
  const cloneUrl = await bonsai.store.cloneUrl(initial.sourceRepo);
  const result = bonsai.state.transition(
    key,
    digest,
    checkRequestResult,
    () => {
      const row = bonsai.state.requireChange(input.repo, input.number);
      if (row.head !== input.head)
        return {
          result: checkRequestResult.parse({ kind: "moved", head: row.head }),
          events: [],
        };
      const decision = decide(
        "requestChecks",
        bonsai.state.reviewFacts(actor, row, input.head, []),
      );
      if (!decision.allowed)
        return {
          result: checkRequestResult.parse({
            kind: "refused",
            reason: decision.reason,
          }),
          events: [],
        };
      const next = bonsai.state.reviseChange(
        { ...row, updatedAt: Date.now() },
        row.revision,
      );
      const names = [
        ...new Set(
          input.names ??
            bonsai.state
              .checks(row.repo, row.number)
              .filter((check) => check.head === row.head)
              .map((check) => check.name),
        ),
      ];
      const event =
        input.names === undefined
          ? bonsai.state.changeEvent(
              next,
              actor.name,
              "change.checks_requested",
              cloneUrl,
            )
          : bonsai.state.changeEvent(
              next,
              actor.name,
              "change.checks_requested",
              cloneUrl,
              { names },
            );
      for (const name of names)
        bonsai.state.reportCheck(row.repo, row.number, {
          head: row.head,
          name,
          status: "queued",
          reporter: actor.name,
          attemptId: event.data.eventId,
          runUrl: null,
          summary: null,
          updatedAt: next.updatedAt,
        });
      return {
        result: checkRequestResult.parse({
          kind: "requested",
          attemptId: event.data.eventId,
        }),
        events: [event],
      };
    },
  );
  return result;
}

function checkAttempt(
  bonsai: Bonsai,
  row: ChangeRecord,
  attemptId: string,
): HookEvent | null {
  const event = bonsai.state.event(attemptId);
  if (
    event === null ||
    (event.type !== "change.opened" &&
      event.type !== "change.updated" &&
      event.type !== "change.checks_requested")
  )
    return null;
  return event.data.change.repo === row.repo &&
    event.data.change.number === row.number &&
    event.data.change.head === row.head
    ? event
    : null;
}

export async function reportCheck(
  bonsai: Bonsai,
  actor: BonsaiActor,
  input: {
    repo: string;
    number: number;
    head: string;
    name: string;
    status: Check["status"];
    attemptId: string;
    runUrl?: string | undefined;
    summary?: string | undefined;
  },
  requestKey: string = replayKey(),
): Promise<CheckReportResult> {
  const key = `check-report:${requestKey}`;
  const digest = JSON.stringify({ actor, input });
  const cached = bonsai.state.receipt(key, digest, checkReportResult);
  if (cached !== null) {
    return cached.result;
  }
  const initial = await recoverExpiredLease(
    bonsai,
    bonsai.state.requireChange(input.repo, input.number),
  );
  const cloneUrl = await bonsai.store.cloneUrl(initial.sourceRepo);
  const result = bonsai.state.transition(key, digest, checkReportResult, () => {
    const row = bonsai.state.requireChange(input.repo, input.number);
    if (row.head !== input.head)
      return {
        result: checkReportResult.parse({ kind: "moved", head: row.head }),
        events: [],
      };
    const decision = decide(
      "reportCheck",
      bonsai.state.reviewFacts(actor, row, input.head, []),
    );
    if (!decision.allowed)
      return {
        result: checkReportResult.parse({
          kind: "refused",
          reason: decision.reason,
        }),
        events: [],
      };
    const attempt = checkAttempt(bonsai, row, input.attemptId);
    if (attempt === null)
      throw new AppMethodRefusal(
        "invalid",
        "Checks require an actual Change trigger event identity",
      );
    const previous = bonsai.state
      .checks(row.repo, row.number)
      .find((check) => check.head === row.head && check.name === input.name);
    const runUrl = input.runUrl ?? null;
    const summary = input.summary ?? null;
    if (previous !== undefined) {
      const previousAttempt = checkAttempt(bonsai, row, previous.attemptId);
      if (
        previousAttempt !== null &&
        previousAttempt.data.activity.id > attempt.data.activity.id
      )
        return {
          result: checkReportResult.parse({ kind: "settled" }),
          events: [],
        };
      if (previous.attemptId === input.attemptId) {
        if (previous.status === "passed" || previous.status === "failed") {
          const same =
            previous.status === input.status &&
            previous.runUrl === runUrl &&
            previous.summary === summary &&
            previous.reporter === actor.name;
          return {
            result: checkReportResult.parse({
              kind: same ? "recorded" : "settled",
            }),
            events: [],
          };
        }
        if (previous.status === "running" && input.status === "queued")
          return {
            result: checkReportResult.parse({ kind: "settled" }),
            events: [],
          };
      }
    }
    const next = bonsai.state.reviseChange(
      { ...row, updatedAt: Date.now() },
      row.revision,
    );
    bonsai.state.reportCheck(row.repo, row.number, {
      head: row.head,
      name: input.name,
      status: input.status,
      reporter: actor.name,
      attemptId: input.attemptId,
      runUrl,
      summary,
      updatedAt: next.updatedAt,
    });
    const events =
      input.status === "passed" || input.status === "failed"
        ? [
            bonsai.state.changeEvent(
              next,
              actor.name,
              "change.checked",
              cloneUrl,
              { name: input.name, status: input.status },
            ),
          ]
        : [];
    return { result: checkReportResult.parse({ kind: "recorded" }), events };
  });
  return result;
}
