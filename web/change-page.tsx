import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@fungi.computer/caps/components/tooltip";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert } from "@fungi.computer/caps/components/alert";
import { Button } from "@fungi.computer/caps/components/button";
import {
  DataList,
  DataListHeading,
  DataRow,
} from "@fungi.computer/caps/components/data-list";
import { InlineCode } from "@fungi.computer/caps/components/inline-code";
import { Status } from "@fungi.computer/caps/components/status";
import type { MergeResult, PolicyDecision } from "../shared/contract.js";
import {
  useAgents,
  useChange,
  useChanges,
  useEvents,
  useGraph,
  useRepo,
  mergeChange,
  approveChange,
  closeChange,
} from "./api.js";
import { BonsaiBoard, type BoardTile } from "./board.js";
import { NetworkGraph } from "./network-graph.js";
import {
  AgentMark,
  AgentName,
  agentColors,
  Failure,
  Loading,
} from "./parts.js";
import { firstLine, relativeTime, shortHash } from "./format.js";
import { href, Link, useRouter } from "./router.js";
import {
  changeStatusLabel,
  changeStatusTone,
  needsAttention,
} from "./change-rows.js";
import { RepoNavigation } from "./repo-navigation.js";
import { useWorkingNow } from "./working-now.js";
import { DiffView, Markdown } from "./views.js";

function policyMessage(
  reason: Extract<PolicyDecision, { allowed: false }>["reason"],
  head: string,
): string {
  const messages = {
    "not-open": "This Change is no longer open.",
    merging: "A merge is already in progress.",
    moved: "The proposed head moved. Review the latest commit.",
    conflict: "Resolve the conflicts and push the source branch again.",
    "needs-approval":
      "Needs one approval from someone who did not write this work.",
    "self-approval": "Someone who did not write this work must approve it.",
    "checks-failed": `Checks failed on ${shortHash(head)}.`,
    "checks-running": `Checks are still running on ${shortHash(head)}.`,
    "not-maintainer": "Only a repository maintainer can do this.",
    "agents-cannot-merge": "A person must merge this Change.",
    "agents-cannot-approve":
      "A person must approve this Change. Agent reviews are checks.",
    "not-source-writer": "You need write access to the source repository.",
    "not-authorized": "You do not have permission to do this.",
  } satisfies Record<
    Extract<PolicyDecision, { allowed: false }>["reason"],
    string
  >;
  return messages[reason];
}

function mergeMessage(result: MergeResult, head: string): string {
  switch (result.kind) {
    case "merging":
      return "Merging…";
    case "merged":
      return `Merged as ${shortHash(result.after)}.`;
    case "moved":
      // Covers both a moved source head and an exhausted stale-CAS retry
      // against a moved target: `result.head` is only meaningful for the
      // former, so the wording names neither specifically.
      return "The merge did not complete because the branch moved. Review the refreshed Change and merge again.";
    case "conflict":
      return `Conflicts in ${result.paths.join(", ")}. Update the source branch, resolve and push again.`;
    case "refused":
      return `Merge refused: ${policyMessage(result.reason, head)}`;
  }
}

export function ChangePage({ repo, number }: { repo: string; number: number }) {
  const detail = useChange(repo, number);
  const list = useChanges(repo);
  const graph = useGraph(repo);
  const repoDetail = useRepo(repo);
  const events = useEvents(repo);
  const recentPushes = useWorkingNow(events.data?.events ?? []);
  const agents = useAgents();
  const colors = useMemo(() => agentColors(agents.data?.agents), [agents.data]);
  const client = useQueryClient();
  const { go } = useRouter();
  const [pending, setPending] = useState<"merge" | "approve" | "close" | null>(
    null,
  );
  const merging =
    pending === "merge" || detail.data?.change.state === "merging";
  const waitingForMerge = detail.data?.change.state === "merging";
  const refreshChange = detail.refetch;
  useEffect(() => {
    if (!waitingForMerge) return;
    const timer = window.setInterval(() => {
      void refreshChange();
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [waitingForMerge, refreshChange]);
  // Tracks whether polling has actually observed this Change as "merging",
  // so a settled background merge can be told apart from the brief window
  // right after the click, before the first refetch lands.
  const sawMerging = useRef(false);
  useEffect(() => {
    if (waitingForMerge) sawMerging.current = true;
  }, [waitingForMerge]);
  useEffect(() => {
    sawMerging.current = false;
  }, [repo, number]);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const media = matchMedia("(min-width: 1024px)");
    const update = () => {
      setWide(media.matches);
    };
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, []);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // RepoNavigation only shows this target while its own route.tab is
  // "overview" (never true here, the Change page always passes "changes"),
  // so the slot stays unused; same `controlsTarget` plumbing as pages.tsx.
  const [, setControlsTarget] = useState<HTMLDivElement | null>(null);
  const changes = list.data?.changes ?? [];
  const index = changes.findIndex(
    (change) => change.repo === repo && change.number === number,
  );
  const previous = index > 0 ? changes[index - 1] : undefined;
  const next = index >= 0 ? changes[index + 1] : undefined;
  const openChangeCount = changes.filter(
    (item) => item.state === "open" || item.state === "merging",
  ).length;
  const changesNeedAttention = changes.some(needsAttention);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        pending !== null
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          "input,textarea,select,[contenteditable=true],[role=textbox]",
        )
      )
        return;
      const target =
        event.key === "[" ? previous : event.key === "]" ? next : undefined;
      if (!target) return;
      event.preventDefault();
      go(href({ page: "change", repo: target.repo, number: target.number }));
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
    };
  }, [previous, next, go, pending]);
  // A Change review is never blocked by the repo/activity reads behind the
  // nav header: those only decorate RepoNavigation, which degrades to
  // nothing on its own (below) if repos.get or activity.list is pending or
  // failed. Only the Change's own query gates this page.
  if (detail.isPending) return <Loading label="Loading change" />;
  if (detail.isError)
    return (
      <Failure
        error={detail.error}
        retry={() => {
          void detail.refetch();
        }}
      />
    );
  const { change, commits, diff, review, actions } = detail.data;
  const conflict = change.conflict;
  // A settled background merge always leaves a typed mergeFailure (caught
  // below -- access_changed, sync_failed, or head_moved) or a conflict
  // matching the current head; the last branch below is defensive, so a
  // stuck "Merging…" never has nothing to show once polling has actually
  // observed this Change as "merging" and its state has since left that.
  // (Before that observation, the row may still be showing the pre-click
  // snapshot; `sawMerging` tells the two apart.)
  const displayedOutcome =
    change.mergeFailure === "access_changed"
      ? "Merge failed: access changed"
      : change.mergeFailure === "sync_failed"
        ? "Merge failed · Retry"
        : change.mergeFailure === "head_moved"
          ? change.mergedCommit !== null
            ? `Merged as ${shortHash(change.mergedCommit)}. Review the new head before merging again.`
            : "The source moved. Review the refreshed Change and merge again."
          : outcome === "Merging…" && change.state !== "merging"
            ? change.state === "merged" && change.mergedCommit !== null
              ? `Merged as ${shortHash(change.mergedCommit)}.`
              : conflict !== null && conflict.head === change.head
                ? mergeMessage(
                    {
                      kind: "conflict",
                      paths: conflict.paths,
                      head: change.head,
                    },
                    change.head,
                  )
                : sawMerging.current
                  ? "The merge did not complete. Review the Change and try again."
                  : outcome
            : outcome;
  const perform = async (action: "merge" | "approve" | "close") => {
    setPending(action);
    setOutcome(null);
    setActionError(null);
    try {
      if (action === "merge") {
        // A second merge click starts a fresh observation window: without
        // this, a prior merge's "seen merging" would stick, and the
        // defensive fallback above could flash before this click's own
        // first poll confirms "merging" again.
        sawMerging.current = false;
        const result = await mergeChange(
          change.repo,
          change.number,
          change.head,
        );
        setOutcome(mergeMessage(result, change.head));
      } else if (action === "approve") {
        const result = await approveChange(
          change.repo,
          change.number,
          change.head,
        );
        setOutcome(
          result.kind === "approved"
            ? `Approved ${shortHash(change.head)}.`
            : result.kind === "moved"
              ? `The reviewed head moved to ${shortHash(result.head)}. Review the refreshed Change before approving.`
              : `Approval refused: ${policyMessage(result.reason, change.head)}`,
        );
      } else {
        const result = await closeChange(change.repo, change.number);
        setOutcome(
          result.allowed
            ? "Change closed."
            : `Close refused: ${policyMessage(result.reason, change.head)}`,
        );
      }
      await Promise.all(
        ["change", "changes", "graph", "events", "repo"].map((key) =>
          client.invalidateQueries({ queryKey: [key, repo] }),
        ),
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The action failed.",
      );
    } finally {
      setPending(null);
    }
  };
  const laneIds = new Set(
    graph.data?.lanes
      .filter(
        (lane) =>
          (lane.repo === change.repo && lane.ref === change.targetRef) ||
          (lane.repo === change.sourceRepo && lane.ref === change.sourceRef),
      )
      .map((lane) => lane.id),
  );
  const laneGraph = graph.data
    ? {
        ...graph.data,
        lanes: graph.data.lanes.filter((lane) => laneIds.has(lane.id)),
        nodes: graph.data.nodes.filter((node) =>
          node.lanes.some((id) => laneIds.has(id)),
        ),
      }
    : null;
  // Nothing real to draw: an empty lane graph (0 lanes and nodes) is as
  // good as none for this tile, same as `laneGraph === null`.
  const hasLaneGraph =
    laneGraph !== null &&
    (laneGraph.lanes.length > 0 || laneGraph.nodes.length > 0);
  const fileCount = diff.files.length + diff.omittedFiles;
  const sourceOwner =
    laneGraph?.lanes.find(
      (lane) =>
        lane.repo === change.sourceRepo && lane.ref === change.sourceRef,
    )?.owner ?? change.sourceRepo;
  const mergeReason = change.mergeable.allowed
    ? undefined
    : policyMessage(change.mergeable.reason, change.head);
  const mergeButton = (
    <Button
      variant="primary"
      loading={merging}
      disabled={!change.mergeable.allowed || pending !== null}
      onClick={() => void perform("merge")}
    >
      {merging ? "Merging…" : `Merge into ${change.targetRef}`}
    </Button>
  );
  const currentChecks = review.checks.filter(
    (check) => check.head === change.head,
  );
  const tiles: BoardTile[] = [
    {
      id: "head",
      title: "Change",
      autoHeight: true,
      status: (
        <Status
          label={changeStatusLabel(change.status)}
          tone={changeStatusTone[change.status]}
          size="compact"
        />
      ),
      body: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <AgentMark name={change.openedBy} colors={colors} size="lg" />
              <div className="min-w-0">
                <h1 className="caps-card-title">
                  #{change.number} {change.title}
                </h1>
                <p className="text-sm">
                  <AgentName name={change.openedBy} colors={colors} /> wants to
                  merge{" "}
                  <InlineCode>
                    {change.sourceRepo}/{change.sourceRef}
                  </InlineCode>{" "}
                  into{" "}
                  <InlineCode>
                    {change.repo}/{change.targetRef}
                  </InlineCode>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {actions.approve.allowed ? (
                <Button
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void perform("approve")}
                >
                  {pending === "approve" ? "Approving…" : "Approve"}
                </Button>
              ) : null}
              {actions.close.allowed ? (
                <Button
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void perform("close")}
                >
                  {pending === "close" ? "Closing…" : "Close"}
                </Button>
              ) : null}
              {change.mergeable.allowed ? (
                mergeButton
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} aria-label={mergeReason}>
                      {mergeButton}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{mergeReason}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
          <p className="text-sm text-[var(--stipe-fg-muted)]">
            {change.ahead} ahead · {change.behind} behind · {fileCount}{" "}
            {fileCount === 1 ? "file" : "files"} · +{diff.additions} / −
            {diff.deletions} · updated {relativeTime(change.updatedAt)} · head{" "}
            <InlineCode>{shortHash(change.head)}</InlineCode>
          </p>
          {change.body ? <Markdown text={change.body} /> : null}
          {change.conflict ? (
            <Alert
              tone="warning"
              title="Resolve conflicts before merging"
              description={`Bonsai recorded conflicts in ${change.conflict.paths.join(", ")}. Update ${sourceOwner}/${change.sourceRef} from ${change.targetRef}, resolve the files and push again.`}
            />
          ) : !change.mergeable.allowed ? (
            <p className="text-sm text-[var(--stipe-fg-muted)]">
              {mergeReason}
            </p>
          ) : null}
          {displayedOutcome ? <p role="status">{displayedOutcome}</p> : null}
          {actionError ? (
            <Alert tone="error" description={actionError} />
          ) : null}
        </div>
      ),
    },
    {
      id: "lane",
      title: "Lane",
      autoHeight: true,
      body: (
        <>
          {graph.isError ? (
            <Failure
              error={graph.error}
              retry={() => {
                void graph.refetch();
              }}
            />
          ) : graph.isPending ? (
            <Loading label="Loading lane" />
          ) : hasLaneGraph ? (
            <NetworkGraph
              shortLabels
              graph={laneGraph}
              colors={colors}
              fresh={new Set()}
              onSelect={(node) => {
                go(
                  href({
                    page: "commit",
                    repo: node.origin ?? change.sourceRepo,
                    hash: node.hash,
                  }),
                );
              }}
            />
          ) : null}
          <p className="text-xs text-[var(--stipe-fg-muted)]">
            Reviewed head <InlineCode>{shortHash(change.head)}</InlineCode> ·
            target <InlineCode>{shortHash(change.target)}</InlineCode>
            {change.base
              ? ` · base ${shortHash(change.base)}`
              : " · no shared base"}
          </p>
        </>
      ),
    },
    {
      id: "commits",
      title: "Commits",
      autoHeight: true,
      body: (
        <DataList>
          {commits.map(({ commit, agent }) => (
            <DataRow key={commit.hash}>
              <div className="min-w-0">
                <Link
                  to={href({
                    page: "commit",
                    repo: change.sourceRepo,
                    hash: commit.hash,
                  })}
                >
                  {firstLine(commit.message)}
                </Link>
                <p className="text-xs text-[var(--stipe-fg-muted)]">
                  {agent ? (
                    <AgentName name={agent} colors={colors} />
                  ) : (
                    commit.author.name
                  )}{" "}
                  · {shortHash(commit.hash)} ·{" "}
                  {relativeTime(commit.committedAt * 1000)}
                </p>
              </div>
            </DataRow>
          ))}
        </DataList>
      ),
    },
    {
      id: "files",
      title: "Files",
      autoHeight: true,
      body: (
        <>
          <DataList>
            {diff.files.map((file) => (
              <DataRow key={file.path}>
                <Button
                  variant="link"
                  size="sm"
                  className="min-w-0 max-w-full justify-start px-0"
                  onClick={() =>
                    document
                      .getElementById(`change-file-${file.path}`)
                      ?.scrollIntoView({ block: "start" })
                  }
                >
                  <span className="truncate">{file.path}</span>
                </Button>
                <span className="text-xs text-[var(--stipe-fg-muted)]">
                  +{file.additions} / −{file.deletions}
                </span>
              </DataRow>
            ))}
          </DataList>
          {diff.omittedFiles > 0 ? (
            <p>{diff.omittedFiles} files omitted from this bounded diff.</p>
          ) : null}
        </>
      ),
    },
    {
      id: "diff",
      title: "Diff",
      autoHeight: true,
      body: diff.files.length ? (
        <div className="space-y-4">
          {diff.files.map((file) => (
            <section key={file.path} id={`change-file-${file.path}`}>
              <DiffView file={file} />
            </section>
          ))}
        </div>
      ) : (
        <p>No changed files in this comparison.</p>
      ),
    },
    {
      id: "review",
      title: "Review",
      autoHeight: true,
      status:
        currentChecks.length > 0 ? (
          <span className="text-xs text-[var(--stipe-fg-muted)]">
            {currentChecks.filter((check) => check.status === "passed").length}{" "}
            of {currentChecks.length} passed
          </span>
        ) : undefined,
      body: (
        <div className="space-y-3">
          {review.checks.length > 0 ? (
            <section>
              <DataListHeading level={3}>Checks</DataListHeading>
              <DataList>
                {review.checks.map((check) => (
                  <DataRow
                    key={`${check.head}:${check.name}:${check.attemptId}`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Status
                          size="compact"
                          tone={
                            check.status === "passed"
                              ? "success"
                              : check.status === "failed"
                                ? "error"
                                : check.status === "running"
                                  ? "info"
                                  : "neutral"
                          }
                          motion={
                            check.status === "running" ? "bounce" : "none"
                          }
                          label={check.status}
                        />
                        <span>{check.name}</span>
                      </div>
                      <p className="text-xs text-[var(--stipe-fg-muted)]">
                        <AgentName name={check.reporter} colors={colors} /> ·{" "}
                        {relativeTime(check.updatedAt)}
                        {check.head !== change.head
                          ? ` · ${shortHash(check.head)} · before the latest push`
                          : ""}
                      </p>
                      {check.summary ? (
                        <p className="text-xs text-[var(--stipe-fg-muted)]">
                          {check.summary}
                        </p>
                      ) : null}
                      {check.runUrl ? (
                        <a
                          className="text-xs"
                          href={check.runUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Run ›
                        </a>
                      ) : null}
                    </div>
                  </DataRow>
                ))}
              </DataList>
            </section>
          ) : null}
          {review.approvals.length > 0 ? (
            <section>
              <DataListHeading level={3}>Approvals</DataListHeading>
              <DataList>
                {review.approvals.map((approval) => (
                  <DataRow key={`${approval.actor}:${approval.head}`}>
                    {approval.head === change.head ? (
                      <span>
                        <AgentName name={approval.actor} colors={colors} /> ·{" "}
                        {approval.kind === "self" ? "self-approved · " : null}
                        {relativeTime(approval.at)}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--stipe-fg-muted)]">
                        {approval.actor}{" "}
                        {approval.kind === "self"
                          ? "self-approved"
                          : "approved"}{" "}
                        {shortHash(approval.head)} · before the latest push
                      </span>
                    )}
                  </DataRow>
                ))}
              </DataList>
            </section>
          ) : null}
        </div>
      ),
    },
  ];
  const shown = tiles.filter(
    (tile) =>
      (tile.id !== "review" ||
        review.checks.length > 0 ||
        review.approvals.length > 0) &&
      // Nothing real to show once settled: hide the whole tile (heading,
      // zoom controls included), not just the body's inner spinner.
      (tile.id !== "lane" || graph.isPending || graph.isError || hasLaneGraph),
  );
  const board = (ids: readonly string[]) => (
    <BonsaiBoard
      placements={ids
        .filter((id) => shown.some((tile) => tile.id === id))
        .map((id, row) => ({ id, col: 0, row, w: 1, h: 1 }))}
      tiles={shown.filter((tile) => ids.includes(tile.id))}
      columns={1}
      rowHeight={0}
    />
  );
  return (
    <div className="space-y-3">
      {repoDetail.data ? (
        <RepoNavigation
          detail={repoDetail.data}
          route={{
            page: "repo",
            repo,
            tab: "changes",
            ref: null,
            path: "",
            file: null,
          }}
          working={recentPushes.length}
          changes={openChangeCount}
          needsAttention={changesNeedAttention}
          controlsTarget={setControlsTarget}
        />
      ) : null}
      <nav
        aria-label="Change neighbours"
        className="flex flex-wrap gap-4 text-sm"
      >
        {previous ? (
          <Link
            to={href({
              page: "change",
              repo: previous.repo,
              number: previous.number,
            })}
          >
            Previous change #{previous.number}
          </Link>
        ) : null}
        {next ? (
          <Link
            to={href({ page: "change", repo: next.repo, number: next.number })}
          >
            Next change #{next.number}
          </Link>
        ) : null}
      </nav>
      {board(["head"])}
      {wide ? (
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
          <div className="min-w-0">{board(["lane", "commits", "files"])}</div>
          <div className="min-w-0">{board(["diff", "review"])}</div>
        </div>
      ) : (
        board(["review", "diff", "lane", "commits", "files"])
      )}
    </div>
  );
}
