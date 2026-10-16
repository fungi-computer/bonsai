/** Bonsai's data hooks: every call is an App method, parsed at this boundary. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  activityPage,
  approvalResult,
  policyDecision,
  agentPage,
  changeDetail,
  changePage,
  commitDetail,
  graph,
  issueFiles,
  mergeResult,
  repoDetail,
  repoPage,
  type Activity,
} from "../shared/contract.js";
import { fileContent, fileList } from "@fungi.computer/agar/roles/files";
import { ApiError, callMethod, filesEditor } from "./transport.js";

export { ApiError };

/** The Team's files-role App, re-asked as the shell's role choice may change. */
export const useFilesEditor = () =>
  useQuery({ queryKey: ["role", "files"], queryFn: filesEditor });

export const useRepos = () =>
  useQuery({
    queryKey: ["repos"],
    queryFn: () => callMethod("repos.list", {}, repoPage),
  });

export const useAgents = () =>
  useQuery({
    queryKey: ["agents"],
    queryFn: () => callMethod("actors.list", {}, agentPage),
  });

export const useRepo = (name: string) =>
  useQuery({
    queryKey: ["repo", name],
    queryFn: () => callMethod("repos.get", { repo: name }, repoDetail),
  });

export const useFile = (name: string, ref: string, path: string | null) =>
  useQuery({
    queryKey: ["blob", name, ref, path],
    queryFn: () =>
      callMethod(
        "files.read",
        { repo: name, ref, path: path ?? "" },
        fileContent,
      ),
    enabled: path !== null,
  });

export const useFiles = (name: string, ref: string, enabled = true) =>
  useQuery({
    queryKey: ["files", name, ref],
    queryFn: () => callMethod("files.list", { repo: name, ref }, fileList),
    enabled,
  });

export const useIssueFiles = (name: string, ref: string) =>
  useQuery({
    queryKey: ["issues", name, ref],
    queryFn: () => callMethod("issues.read", { repo: name, ref }, issueFiles),
  });

export const useChanges = (name: string) =>
  useQuery({
    queryKey: ["changes", name],
    queryFn: () => callMethod("changes.list", { repo: name }, changePage),
  });

export const useChange = (repo: string, number: number) =>
  useQuery({
    queryKey: ["change", repo, number],
    queryFn: () => callMethod("changes.get", { repo, number }, changeDetail),
  });

export function mergeChange(repo: string, number: number, head: string) {
  return callMethod("changes.merge", { repo, number, head }, mergeResult);
}

export function approveChange(repo: string, number: number, head: string) {
  return callMethod("changes.approve", { repo, number, head }, approvalResult);
}

export function closeChange(repo: string, number: number) {
  return callMethod("changes.close", { repo, number }, policyDecision);
}

export const useCommit = (name: string, hash: string) =>
  useQuery({
    queryKey: ["commit", name, hash],
    queryFn: () =>
      callMethod("commits.get", { repo: name, hash }, commitDetail),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useGraph = (name: string, enabled = true) =>
  useQuery({
    queryKey: ["graph", name],
    queryFn: () => callMethod("graph.get", { repo: name }, graph),
    enabled,
  });

export const useEvents = (repo: string | null) =>
  useQuery({
    queryKey: ["events", repo],
    queryFn: () =>
      callMethod("activity.list", { repo, limit: 60 }, activityPage),
  });

export type LiveState = Readonly<{
  connected: boolean;
  error: string | null;
  /** Event ids that arrived while this page was open, for entrance motion. */
  fresh: ReadonlySet<number>;
}>;

const POLL_MS = 2500;
const IDLE_POLL_MS = 5000;

function touches(event: Activity, key: readonly unknown[]): boolean {
  const [kind, repo, number] = key;
  const family = event.repo.split("--")[0] ?? event.repo;
  if (kind === "events")
    return repo === null || repo === family || repo === event.repo;
  if (kind === "repos") return true;
  if (kind === "agents")
    return (
      event.type === "push" ||
      event.type === "fork" ||
      event.type === "repo.created"
    );
  if ("change" in event.data) {
    const change = event.data.change;
    if (kind === "change")
      return repo === change.repo && number === change.number;
    if (kind === "changes") return repo === change.repo;
  }
  if (event.type === "push" || event.type === "merge") {
    if (kind === "change") return repo === event.repo;
    if (kind === "graph" || kind === "changes") return repo === family;
    if (
      kind === "repo" ||
      kind === "files" ||
      kind === "blob" ||
      kind === "issues"
    )
      return repo === event.repo;
  }
  if (event.type === "fork") {
    if (kind === "graph" || kind === "repo")
      return repo === family || repo === event.data.fork;
  }
  return false;
}

/** Follow new activity and refresh whatever it touches. */
export function useLive(): LiveState {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const cursor = useRef<number | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const canPoll = () => !stopped && !document.hidden;
    const tick = async () => {
      if (!canPoll() || inFlight) return;
      inFlight = true;
      let delay = POLL_MS;
      try {
        const page = await callMethod(
          "activity.list",
          { repo: null, limit: 50, after: cursor.current ?? 0 },
          activityPage,
        );
        if (stopped) return;
        setConnected(true);
        setError(null);
        const newest = page.events[0]?.id;
        if (newest === undefined) delay = IDLE_POLL_MS;
        if (cursor.current === null) cursor.current = newest ?? 0;
        else if (newest !== undefined) {
          cursor.current = newest;
          const arrived: Activity[] = page.events;
          setFresh(
            (current) =>
              new Set([...current, ...arrived.map((event) => event.id)]),
          );
          void client.invalidateQueries({
            predicate: (query) =>
              arrived.some((event) => touches(event, query.queryKey)),
          });
        }
      } catch {
        if (stopped) return;
        setConnected(false);
        setError("Live updates are unavailable. Retrying…");
      }
      inFlight = false;
      if (canPoll()) timer = setTimeout(() => void tick(), delay);
    };
    const onVisibilityChange = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void tick();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client]);
  return { connected, error, fresh };
}
