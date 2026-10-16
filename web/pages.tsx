import { CodeTab } from "./code-tab.js";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@fungi.computer/caps/components/tabs";
import { BonsaiBoard } from "./board.js";
import { Screen } from "@fungi.computer/caps/components/surface";
import { useWorkingNow } from "./working-now.js";
import { Card } from "@fungi.computer/caps/components/card";
import { Overview } from "./overview.js";
import { ChangeGroups, needsAttention } from "./change-rows.js";
import { RepoNavigation } from "./repo-navigation.js";
import { RepoSettings } from "./repo-settings.js";
/** Bonsai's pages: the repository list, a repository, and a commit. */
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RepoDetail } from "../shared/contract.js";
import {
  useAgents,
  useCommit,
  useEvents,
  useGraph,
  useRepo,
  useChanges,
  type LiveState,
} from "./api.js";
import { DiffView } from "./views.js";
import { relativeTime, shortHash } from "./format.js";
import { CommitTree } from "./commit-tree.js";
import {
  AgentMark,
  AgentName,
  agentColors,
  Failure,
  Loading,
  type AgentColors,
} from "./parts.js";
import { href, Link, useRouter, type Route } from "./router.js";
import { IssuesPanel } from "./issues-panel.js";

function useColors(): AgentColors {
  const agents = useAgents();
  return useMemo(() => agentColors(agents.data?.agents), [agents.data]);
}

export type RepoRoute = Extract<Route, { page: "repo" }>;

function ChangesTab({ repo, colors }: { repo: string; colors: AgentColors }) {
  const changes = useChanges(repo);
  if (changes.isPending) return <Loading label="Loading changes" />;
  if (changes.isError)
    return (
      <Failure
        error={changes.error}
        retry={() => {
          void changes.refetch();
        }}
      />
    );
  if (changes.data.changes.length === 0) return null;
  return (
    <Card variant="outline" density="compact" data-tile="changes">
      <div className="min-w-0 p-3">
        <ChangeGroups changes={changes.data.changes} colors={colors} />
      </div>
    </Card>
  );
}

function CommitsTab({
  route,
  detail,
  colors,
}: {
  route: RepoRoute;
  detail: RepoDetail;
  colors: AgentColors;
}) {
  const graph = useGraph(detail.repo.parent ?? route.repo);
  const actors = useAgents();
  const { go } = useRouter();
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | undefined>(route.commit);
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
  useEffect(() => {
    setSelected(route.commit);
  }, [route.commit]);
  const selectedRef =
    route.ref ?? (detail.repo.parent === null ? null : detail.defaultBranch);
  const selectedLane = graph.data?.lanes.find(
    (lane) => lane.repo === route.repo && lane.ref === selectedRef,
  );
  const nodes =
    graph.data?.nodes.filter(
      (node) =>
        (selectedRef === null ||
          (selectedLane !== undefined &&
            node.lanes.includes(selectedLane.id))) &&
        (filter === "all" ||
          actors.data?.agents.find((actor) => actor.id === node.agent)?.kind ===
            filter),
    ) ?? [];
  const current = nodes.find((node) => node.hash === selected) ?? nodes[0];
  const open = (node: (typeof nodes)[number]) => {
    if (wide) setSelected(node.hash);
    else
      go(
        href({
          page: "commit",
          repo: node.origin ?? route.repo,
          hash: node.hash,
        }),
      );
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],[role=tab]",
          ))
      )
        return;
      const index = nodes.findIndex((node) => node.hash === current?.hash);
      if (event.key === "j" || event.key === "k") {
        const next =
          nodes[
            Math.max(
              0,
              Math.min(nodes.length - 1, index + (event.key === "j" ? 1 : -1)),
            )
          ];
        if (next) {
          event.preventDefault();
          setSelected(next.hash);
        }
      } else if (
        event.key === "Enter" &&
        current &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest("a,button")
        )
      ) {
        event.preventDefault();
        go(
          href({
            page: "commit",
            repo: current.origin ?? route.repo,
            hash: current.hash,
          }),
        );
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
    };
  }, [nodes, current, go]);
  if (detail.empty) return null;
  if (graph.isPending || actors.isPending)
    return <Loading label="Loading history" />;
  if (graph.isError)
    return (
      <Failure
        error={graph.error}
        retry={() => {
          void graph.refetch();
        }}
      />
    );
  if (actors.isError)
    return (
      <Failure
        error={actors.error}
        retry={() => {
          void actors.refetch();
        }}
      />
    );
  const shown = { ...graph.data, nodes };
  return (
    <div className="grid items-start gap-3 lg:grid-cols-2">
      {/* The repository nav already says "History"; no inner title repeats it. */}
      <Screen data-tile="history" className="min-w-0">
        <div className="min-w-0 p-3">
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList variant="segmented" aria-label="Commit authors">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="agent">Agents</TabsTrigger>
              <TabsTrigger value="human">People</TabsTrigger>
            </TabsList>
            <TabsContent value={filter}>
              <p
                className="my-3 text-xs text-[var(--stipe-fg-muted)]"
                title="J/K selects a commit; Enter opens it"
              >
                {selectedRef === null
                  ? "main + forks"
                  : `${route.repo}/${selectedRef}`}{" "}
                · newest first
              </p>
              <CommitTree
                graph={shown}
                colors={colors}
                selected={current?.hash}
                onSelect={open}
              />
            </TabsContent>
          </Tabs>
        </div>
      </Screen>
      {wide && current ? (
        <div className="sticky top-3 min-w-0">
          <BonsaiBoard
            columns={1}
            rowHeight={0}
            placements={[{ id: "commit", col: 0, row: 0, w: 1, h: 1 }]}
            tiles={[
              {
                id: "commit",
                title: "Commit",
                autoHeight: true,
                body: (
                  <CommitPage
                    repo={current.origin ?? route.repo}
                    hash={current.hash}
                  />
                ),
              },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

export function RepoPage({
  route,
  live,
}: {
  route: RepoRoute;
  live: LiveState;
}) {
  if (route.tab === "settings")
    return <RepoSettings key={route.repo} repo={route.repo} />;
  return <RepoContent route={route} live={live} />;
}

function RepoContent({ route, live }: { route: RepoRoute; live: LiveState }) {
  const [controlsTarget, setControlsTarget] = useState<HTMLElement | null>(
    null,
  );
  const detail = useRepo(route.repo);
  const family = route.repo.split("--")[0] ?? route.repo;
  const events = useEvents(family);
  const recentPushes = useWorkingNow(events.data?.events ?? []);
  const changeList = useChanges(family);
  const openChanges =
    changeList.data?.changes.filter(
      (item) => item.state === "open" || item.state === "merging",
    ).length ?? 0;
  const colors = useColors();
  if (detail.isPending) return <Loading label="Loading repository" />;
  if (detail.isError)
    return (
      <Failure
        error={detail.error}
        retry={() => {
          void detail.refetch();
        }}
      />
    );
  const tab = route.tab;
  return (
    <div className="bonsai-repo">
      <RepoNavigation
        detail={detail.data}
        route={route}
        working={recentPushes.length}
        changes={openChanges}
        needsAttention={changeList.data?.changes.some(needsAttention) ?? false}
        controlsTarget={setControlsTarget}
      />
      <div className="min-w-0">
        <section className="bonsai-main">
          {tab === "code" ? (
            <>
              <CodeTab route={route} detail={detail.data} />
            </>
          ) : null}
          {tab === "commits" ? (
            <>
              <CommitsTab route={route} detail={detail.data} colors={colors} />
            </>
          ) : null}
          {tab === "overview" ? (
            <>
              <Overview
                route={route}
                detail={detail.data}
                colors={colors}
                live={live}
                controlsTarget={controlsTarget}
              />
            </>
          ) : null}
          {tab === "changes" ? (
            <>
              <ChangesTab repo={route.repo} colors={colors} />
            </>
          ) : null}
          {tab === "issues" ? (
            <>
              <IssuesPanel
                repo={route.repo}
                refName={route.ref ?? detail.data.defaultBranch}
                open={route.file}
              />
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export function CommitPage({ repo, hash }: { repo: string; hash: string }) {
  const detail = useCommit(repo, hash);
  const changes = useChanges(repo.split("--")[0] ?? repo);
  const openChange = changes.data?.changes.find(
    (change) =>
      change.sourceRepo === repo &&
      change.head === hash &&
      change.state === "open",
  );
  const colors = useColors();
  if (detail.isPending) return <Loading label="Loading commit" />;
  if (detail.isError)
    return (
      <Failure
        error={detail.error}
        retry={() => {
          void detail.refetch();
        }}
      />
    );
  const { commit, agent, diff } = detail.data;
  const [title = "", ...rest] = commit.message.trim().split("\n");
  const family = repo.split("--")[0] ?? repo;
  return (
    <div className="bonsai-commit">
      <nav className="bonsai-crumbs" aria-label="Repository">
        <Link
          to={href({
            page: "repo",
            repo: family,
            tab: "commits",
            ref: null,
            path: "",
            file: null,
          })}
        >
          {family}
        </Link>
        {repo !== family ? (
          <span>
            <ChevronRight aria-hidden="true" size={13} />
            <Link
              to={href({
                page: "repo",
                repo,
                tab: "commits",
                ref: null,
                path: "",
                file: null,
              })}
            >
              {repo}
            </Link>
          </span>
        ) : null}
      </nav>
      <header className="bonsai-commit-head">
        <h1 className="caps-card-title">{title}</h1>
        {rest.join("\n").trim() ? (
          <pre className="bonsai-commit-body">{rest.join("\n").trim()}</pre>
        ) : null}
        <p className="bonsai-commit-meta">
          {agent ? <AgentMark name={agent} colors={colors} /> : null}
          <span>
            {agent ? (
              <AgentName name={agent} colors={colors} />
            ) : (
              commit.author.name
            )}
            <span className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
              {" "}
              committed {relativeTime(commit.committedAt * 1000)}
            </span>
          </span>
          <code className="font-mono text-sm text-[var(--stipe-fg-muted)] bonsai-hash">
            {shortHash(commit.hash)}
          </code>
          {commit.parents[0] ? (
            <span className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
              parent{" "}
              <Link
                to={href({ page: "commit", repo, hash: commit.parents[0] })}
              >
                <code>{shortHash(commit.parents[0])}</code>
              </Link>
            </span>
          ) : null}
        </p>
        <p className="bonsai-diff-summary">
          <span>
            {diff.files.length + diff.omittedFiles}{" "}
            {diff.files.length + diff.omittedFiles === 1 ? "file" : "files"}{" "}
            changed
          </span>
          <span className="font-mono text-success bonsai-add">
            +{diff.additions}
          </span>
          <span className="font-mono text-error bonsai-remove">
            −{diff.deletions}
          </span>
        </p>
      </header>
      {openChange ? (
        <Link
          to={href({
            page: "change",
            repo: openChange.repo,
            number: openChange.number,
          })}
        >
          Open Change ›
        </Link>
      ) : null}
      {diff.files.map((file) => (
        <DiffView key={file.path} file={file} />
      ))}
      {diff.omittedFiles > 0 ? (
        <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
          {diff.omittedFiles} more files not shown.
        </p>
      ) : null}
    </div>
  );
}
