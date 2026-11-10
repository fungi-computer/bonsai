import { useEffect, useMemo, useState } from "react";
import { DataListHeading } from "@fungi.computer/caps/components/data-list";
import { Status } from "@fungi.computer/caps/components/status";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { GitBranch } from "lucide-react";
import { Button } from "@fungi.computer/caps/components/button";
import { SetupNotice } from "@fungi.computer/caps/blocks/setup-notice";
import { NewRepositoryDialog } from "./new-repository.js";
import { useHostGitAccess } from "./host-access.js";
import { requestGitAccess } from "./transport.js";
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
const nextSteps = [
  [
    "Create a repository",
    "Name your collection of files. Bonsai saves a README to start its history.",
  ],
  [
    "Work in separate copies",
    "Each AI helper gets a fork: its own copy, separate from the shared version.",
  ],
  [
    "Review and combine",
    "Merge the changes you want into main, the shared version.",
  ],
] as const;

/** What happens after the first repository, so the empty state shows its product. */
function NextSteps() {
  return (
    <section aria-label="What happens next" className="bonsai-next-steps">
      <h2 className="text-sm font-semibold">What happens next</h2>
      <ol>
        {nextSteps.map(([title, text], index) => (
          <li key={title}>
            <span aria-hidden="true">{index + 1}</span>
            <div>
              <p className="font-semibold">{title}</p>
              <p className="text-sm">{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The card's facts, saying only what is true of this repository. */
function repoMeta(repo: RepoSummary, openChanges: number): string {
  const forks = repo.forks.length;
  return [
    repo.lastPushAt === null
      ? "Nothing pushed yet"
      : `Pushed ${relativeTime(repo.lastPushAt)}`,
    forks === 0
      ? "No forks yet"
      : `${String(forks)} ${forks === 1 ? "fork" : "forks"}`,
    openChanges > 0
      ? `${String(openChanges)} open ${openChanges === 1 ? "change" : "changes"}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function RepoCard({
  repo,
  colors,
}: {
  repo: RepoSummary;
  colors: AgentColors;
}) {
  const changes = useChanges(repo.name);
  const openChanges =
    changes.data?.changes.filter(
      (change) => change.state === "open" || change.state === "merging",
    ).length ?? 0;
  return (
    <div className="space-y-3">
      {repo.description ? <p>{repo.description}</p> : null}
      <p className="text-xs text-[var(--stipe-fg-muted)]">
        {repoMeta(repo, openChanges)}
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
  const [creating, setCreating] = useState(false);
  // A suggested name from the empty state; each choice restarts the dialog.
  const [preset, setPreset] = useState<{ name: string; count: number }>({
    name: "",
    count: 0,
  });
  const startWith = (name: string) => {
    setPreset((current) => ({ name, count: current.count + 1 }));
    setCreating(true);
  };
  const [asking, setAsking] = useState(false);
  const hostGit = useHostGitAccess();
  const [approved, setApproved] = useState(false);
  const missing = hostGit === "missing" && !approved;
  async function approveAccess(): Promise<void> {
    setAsking(true);
    try {
      // The host's setup fact turns ready by itself; this flips the screen now.
      if ((await requestGitAccess()) === "granted") setApproved(true);
    } finally {
      setAsking(false);
    }
  }
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
  // Activity belongs to repositories; with none listed there is nothing to show.
  const hasRepos = (repos.data?.repos.length ?? 0) > 0;
  if (
    hasRepos &&
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
  if (!hasRepos) {
    // No Live tile before the first repository.
  } else if (events.isError)
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
        missing ? (
          <SetupNotice
            className="bonsai-onboarding"
            variant="panel"
            need="Bonsai needs Git access to save your repositories"
            cause="Keep files and their history, with a separate working copy for each AI helper."
            visual={<GitBranch aria-hidden="true" />}
            fix={{
              label: "Approve Git access",
              onSelect: () => void approveAccess(),
              pending: asking,
            }}
            waitingFor="your answer"
          />
        ) : (
          <div className="bonsai-onboarding">
            <EmptyState
              variant="plain"
              visual="blobs"
              title="Start your first repository"
              description="Keep files and their history, with a separate working copy for each AI helper."
              primaryAction={{
                label: "New repository",
                onSelect: () => {
                  startWith("");
                },
              }}
              suggestions={["notes", "website", "experiments"].map((label) => ({
                label,
                onSelect: () => {
                  startWith(label);
                },
              }))}
            />
            <NextSteps />
          </div>
        )
      ) : (
        <div className="flex items-center justify-between gap-3">
          <h1 className="caps-card-title">Repositories</h1>
          <Button
            size="sm"
            variant="outline"
            disabled={missing}
            title={missing ? "Approve Git access first" : undefined}
            onClick={() => {
              setCreating(true);
            }}
          >
            New repository
          </Button>
        </div>
      )}
      <NewRepositoryDialog
        key={preset.count}
        open={creating}
        onOpenChange={setCreating}
        initialName={preset.name}
      />
      <BonsaiBoard
        rowHeight={0}
        placements={placements}
        tiles={tiles}
        phoneOrder={tiles.map((tile) => tile.id)}
      />
    </div>
  );
}
