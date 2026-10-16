import { useMemo } from "react";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { CopyField } from "@fungi.computer/caps/components/copy-field";
import {
  DataList,
  DataListHeading,
  DataRow,
} from "@fungi.computer/caps/components/data-list";
import { inspectIssueTree } from "@fungi.computer/issues";
import type { RepoDetail } from "../shared/contract.js";
import { tileTitles, type TileId } from "../shared/insights.js";
import {
  useChanges,
  useGraph,
  useAgents,
  useEvents,
  useFiles,
  useFile,
  useIssueFiles,
  type LiveState,
} from "./api.js";
import { OverviewBoard } from "./insights.js";
import { InsightTile } from "./insight-tiles.js";
import { NetworkGraph } from "./network-graph.js";
import { ActivityFeed, Failure, Loading, type AgentColors } from "./parts.js";
import { WorkingNow, workingNow } from "./working-now.js";
import { ChangeGroups } from "./change-rows.js";
import { Markdown } from "./views.js";
import { href, Link, useRouter, type Route } from "./router.js";
import type { BoardTile } from "./board.js";

export function Overview({
  route,
  detail,
  colors,
  live,
  controlsTarget,
}: {
  route: Extract<Route, { page: "repo" }>;
  detail: RepoDetail;
  colors: AgentColors;
  live: LiveState;
  controlsTarget: HTMLElement | null;
}) {
  const { go } = useRouter();
  const family = detail.repo.parent ?? route.repo;
  const refName = route.ref ?? detail.defaultBranch;
  const graph = useGraph(family, !detail.empty);
  const actors = useAgents();
  const events = useEvents(family);
  const changes = useChanges(family);
  const files = useFiles(route.repo, refName, !detail.empty);
  const readmePath =
    files.data?.paths.find((path) => /^readme(\.md)?$/iu.test(path)) ?? null;
  const readme = useFile(route.repo, refName, readmePath);
  const issueFiles = useIssueFiles(route.repo, refName);
  const issues = useMemo(
    () => (issueFiles.data ? inspectIssueTree(issueFiles.data.files) : null),
    [issueFiles.data],
  );
  const next =
    issues?.records
      .filter((issue) => issues.frontier.includes(issue.id))
      .sort((a, b) => a.priority.localeCompare(b.priority)) ?? [];
  const activity = events.data?.events ?? [];
  const working = workingNow(activity);
  const recentHeads = new Set(
    activity
      .filter(
        (event) =>
          event.type === "push" && event.at >= Date.now() - 15 * 60_000,
      )
      .flatMap((event) =>
        event.type === "push"
          ? event.data.updates.map((update) => update.after)
          : [],
      ),
  );
  const repoLink = (
    tab: Extract<Route, { page: "repo" }>["tab"],
    file: string | null = null,
  ) => href({ ...route, tab, file, path: "" });
  if (detail.empty)
    return (
      <div className="space-y-3">
        <p>
          Push a first commit to start this repository. Add a README to
          introduce the project.
        </p>
        <CopyField value={`git clone ${detail.cloneUrl}`} />
      </div>
    );
  const tiles: BoardTile[] = [];
  const add = (
    id: TileId,
    body: BoardTile["body"],
    status?: BoardTile["status"],
  ) => {
    tiles.push({ id, title: tileTitles[id], body, status, autoHeight: true });
  };
  add(
    "network",
    graph.isPending ? (
      <Loading label="Loading network" />
    ) : graph.isError ? (
      <Failure
        error={graph.error}
        retry={() => {
          void graph.refetch();
        }}
      />
    ) : (
      <>
        <NetworkGraph
          graph={graph.data}
          colors={colors}
          fresh={recentHeads}
          laneDetails={
            new Map(
              (changes.data?.changes ?? []).map((change) => [
                change.sourceRepo,
                `${String(change.ahead)} ahead · ${String(change.behind)} behind`,
              ]),
            )
          }
          onLaneSelect={(lane) => {
            const change = changes.data?.changes.find(
              (item) =>
                item.sourceRepo === lane.repo &&
                item.sourceRef === lane.ref &&
                item.state === "open",
            );
            if (change)
              go(
                href({
                  page: "change",
                  repo: change.repo,
                  number: change.number,
                }),
              );
            else
              go(
                href({
                  ...route,
                  repo: lane.repo,
                  tab: "commits",
                  ref: lane.ref,
                  file: null,
                }),
              );
          }}
          onSelect={(node) => {
            go(
              href({
                ...route,
                repo: family,
                tab: "commits",
                ref: null,
                commit: node.hash,
              }),
            );
          }}
        />
        <p className="text-xs text-[var(--stipe-fg-muted)]">
          Branches and forks · hollow nodes are merges · select a lane for its
          change, or a commit to read it
        </p>
      </>
    ),
  );
  if (events.isPending) add("live", <Loading label="Loading activity" />);
  else if (events.isError)
    add(
      "live",
      <Failure
        error={events.error}
        retry={() => {
          void events.refetch();
        }}
      />,
    );
  else if (activity.length > 0)
    add(
      "live",
      <>
        {working.length > 0 ? (
          <>
            <DataListHeading>Working now</DataListHeading>
            <WorkingNow events={activity} colors={colors} />
          </>
        ) : null}
        <ActivityFeed
          events={activity.slice(0, 5)}
          colors={colors}
          fresh={live.fresh}
        />
      </>,
    );
  if (changes.isPending) add("changes", <Loading label="Loading changes" />);
  else if (changes.isError)
    add(
      "changes",
      <Failure
        error={changes.error}
        retry={() => {
          void changes.refetch();
        }}
      />,
    );
  else if (changes.data.changes.length)
    add(
      "changes",
      <ChangeGroups changes={changes.data.changes} colors={colors} limit={3} />,
      <Link to={repoLink("changes")}>All {changes.data.changes.length} ›</Link>,
    );
  else
    add(
      "changes",
      <EmptyState
        variant="quiet"
        headingLevel={3}
        title="No changes yet"
        description="Proposed updates will appear here."
      />,
    );
  // Nothing real to show yet: render nothing rather than a stuck loader (a
  // read a visitor can't complete, such as an anonymous one, never
  // resolves). The tile appears once the read settles.
  if (issueFiles.isError)
    add(
      "next",
      <Failure
        error={issueFiles.error}
        retry={() => {
          void issueFiles.refetch();
        }}
      />,
    );
  else if (next.length > 0)
    add(
      "next",
      <>
        <DataList>
          {next.slice(0, 3).map((issue) => (
            <DataRow key={issue.id}>
              <Link to={repoLink("issues", issue.path)}>{issue.title}</Link>
            </DataRow>
          ))}
        </DataList>
        <p className="text-xs text-[var(--stipe-fg-muted)]">
          {issues?.records.filter((issue) => issue.blocked).length ?? 0} blocked
        </p>
      </>,
      <Link to={repoLink("issues")}>Issues ›</Link>,
    );
  else if (!issueFiles.isPending)
    add(
      "next",
      <EmptyState
        variant="quiet"
        headingLevel={3}
        title="Nothing next"
        description="No open issues are waiting on anyone."
      />,
    );
  if (files.isError)
    add(
      "readme",
      <Failure
        error={files.error}
        retry={() => {
          void files.refetch();
        }}
      />,
    );
  else if (files.isPending || readmePath !== null)
    add(
      "readme",
      files.isPending || readme.isPending ? (
        <Loading label="Loading README" />
      ) : readme.isError ? (
        <Failure
          error={readme.error}
          retry={() => {
            void readme.refetch();
          }}
        />
      ) : (
        <div className="line-clamp-6">
          <Markdown text={readme.data.text ?? "README is not a text file."} />
        </div>
      ),
      <Link to={repoLink("code", readmePath)}>Open in Code ›</Link>,
    );
  for (const id of [
    "actors",
    "contributors",
    "ages",
    "churn",
    "calendar",
  ] as const)
    add(
      id,
      <div className="bonsai-tile-content">
        {graph.isPending || actors.isPending ? (
          <Loading label={`Loading ${tileTitles[id].toLowerCase()}`} />
        ) : graph.isError ? (
          <Failure
            error={graph.error}
            retry={() => {
              void graph.refetch();
            }}
          />
        ) : actors.isError ? (
          <Failure
            error={actors.error}
            retry={() => {
              void actors.refetch();
            }}
          />
        ) : (
          <InsightTile
            id={id}
            repo={route.repo}
            refName={refName}
            graph={graph.data}
            actors={actors.data.agents}
          />
        )}
      </div>,
    );
  return (
    <OverviewBoard
      repo={route.repo}
      definitions={tiles}
      controlsTarget={controlsTarget}
    />
  );
}
