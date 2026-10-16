import { useEffect, useMemo, useState } from "react";
import { DataListHeading } from "@fungi.computer/caps/components/data-list";
import { Status } from "@fungi.computer/caps/components/status";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import {
  useAgents,
  useRepos,
  useGraph,
  useChanges,
  useEvents,
  type LiveState,
} from "./api.js";
import { BonsaiBoard, type BoardTile } from "./board.js";
import { NetworkGraph } from "./network-graph.js";
import {
  ActivityFeed,
  AgentName,
  agentColors,
  Loading,
  Failure,
  Sparkline,
  type AgentColors,
} from "./parts.js";
import { WorkingNow, workingNow } from "./working-now.js";
import { href, useRouter } from "./router.js";
import type { Graph, RepoSummary } from "../shared/contract.js";
import { relativeTime } from "./format.js";

function HomeNetwork({
  graph,
  repo,
  colors,
  live,
}: {
  graph: Graph;
  repo: string;
  colors: AgentColors;
  live: LiveState;
}) {
  const changes = useChanges(repo);
  const events = useEvents(repo);
  const { go } = useRouter();
  const fresh = new Set(
    events.data?.events.flatMap((event) =>
      event.type === "push" && live.fresh.has(event.id)
        ? event.data.commits.map((commit) => commit.hash)
        : [],
    ),
  );
  return (
    <NetworkGraph
      graph={graph}
      colors={colors}
      fresh={fresh}
      onSelect={(node) => {
        go(
          href({
            page: "repo",
            repo,
            tab: "commits",
            commit: node.hash,
            ref: null,
            file: null,
            path: "",
          }),
        );
      }}
      onLaneSelect={(lane) => {
        const change = changes.data?.changes.find(
          (item) =>
            item.sourceRepo === lane.repo &&
            item.sourceRef === lane.ref &&
            item.state === "open",
        );
        go(
          change
            ? href({ page: "change", repo: change.repo, number: change.number })
            : href({
                page: "repo",
                repo: lane.repo,
                tab: "overview",
                ref: lane.ref,
                file: null,
                path: "",
              }),
        );
      }}
    />
  );
}
function RepoCard({
  repo,
  colors,
}: {
  repo: RepoSummary;
  colors: AgentColors;
}) {
  const changes = useChanges(repo.name);
  return (
    <div className="space-y-3">
      {repo.description ? <p>{repo.description}</p> : null}
      <p className="text-xs text-[var(--stipe-fg-muted)]">
        {repo.lastPushAt !== null
          ? `Pushed ${relativeTime(repo.lastPushAt)} · `
          : ""}
        {repo.forks.length} forks
        {changes.data
          ? ` · ${String(changes.data.changes.filter((change) => change.state === "open" || change.state === "merging").length)} open changes`
          : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {repo.forks.map((fork) => (
          <AgentName
            key={fork}
            name={fork.split("--")[1] ?? fork}
            colors={colors}
          />
        ))}
      </div>
      <Sparkline values={repo.activity} />
    </div>
  );
}
export function HomePage({ live }: { live: LiveState }) {
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
  const repos = useRepos();
  const events = useEvents(null);
  const actors = useAgents();
  const colors = useMemo(() => agentColors(actors.data?.agents), [actors.data]);
  const featured = [...(repos.data?.repos ?? [])]
    .filter((repo) => repo.parent === null)
    .sort((a, b) => (b.lastPushAt ?? 0) - (a.lastPushAt ?? 0))[0];
  const network = useGraph(
    featured?.name ?? "",
    featured !== undefined && featured.lastPushAt !== null,
  );
  const tiles: BoardTile[] = [];
  if (
    featured?.lastPushAt !== null &&
    featured !== undefined &&
    (network.isPending || network.isError || network.data.nodes.length > 0)
  )
    tiles.push({
      id: "network",
      title: `Network · ${featured.name}`,
      autoHeight: true,
      body: network.isPending ? (
        <Loading label="Loading network" />
      ) : network.isError ? (
        <Failure
          error={network.error}
          retry={() => {
            void network.refetch();
          }}
        />
      ) : (
        <HomeNetwork
          graph={network.data}
          repo={featured.name}
          colors={colors}
          live={live}
        />
      ),
    });
  if (events.isError)
    tiles.push({
      id: "live",
      title: "Live",
      autoHeight: !wide || !tiles.some((tile) => tile.id === "network"),
      body: (
        <Failure
          error={events.error}
          retry={() => {
            void events.refetch();
          }}
        />
      ),
    });
  else if (events.data?.events.length)
    tiles.push({
      id: "live",
      title: "Live",
      autoHeight: !wide || !tiles.some((tile) => tile.id === "network"),
      body: (
        <>
          {workingNow(events.data.events).length ? (
            <>
              <DataListHeading>Working now</DataListHeading>
              <WorkingNow events={events.data.events} colors={colors} />
            </>
          ) : null}
          <ActivityFeed
            events={events.data.events.slice(0, 5)}
            colors={colors}
            fresh={live.fresh}
            showRepo
          />
        </>
      ),
    });
  for (const repo of repos.data?.repos ?? [])
    tiles.push({
      id: `repo:${repo.name}`,
      title: repo.name,
      to: href({
        page: "repo",
        repo: repo.name,
        tab: "overview",
        ref: null,
        file: null,
        path: "",
      }),
      autoHeight: true,
      status:
        repo.lastPushAt !== null && repo.lastPushAt > Date.now() - 900000 ? (
          <Status label="Active" tone="success" size="compact" />
        ) : undefined,
      body: <RepoCard repo={repo} colors={colors} />,
    });
  const hasHero = tiles.some(
    (tile) => tile.id === "network" || tile.id === "live",
  );
  let card = 0;
  const placements = tiles.map((tile) => {
    if (tile.id === "network")
      return { id: tile.id, col: 0, row: 0, w: 3, h: 1 };
    if (tile.id === "live") return { id: tile.id, col: 3, row: 0, w: 1, h: 1 };
    const index = card++;
    return {
      id: tile.id,
      col: index % 4,
      row: (hasHero ? 1 : 0) + Math.floor(index / 4),
      w: 1,
      h: 1,
    };
  });
  return (
    <div className="space-y-3">
      {repos.isPending ? (
        <Loading label="Loading repositories" />
      ) : repos.isError ? (
        <Failure
          error={repos.error}
          retry={() => {
            void repos.refetch();
          }}
        />
      ) : repos.data.repos.length === 0 ? (
        <EmptyState
          variant="panel"
          title="No repositories yet"
          description="Repositories you and your Agents create appear here, with every fork, push and change live."
        />
      ) : null}
      <BonsaiBoard
        rowHeight={0}
        placements={placements}
        tiles={tiles}
        phoneOrder={tiles.map((tile) => tile.id)}
      />
    </div>
  );
}
