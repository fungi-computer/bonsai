import { defineAppGill, type AppBackendGill } from "@fungi.computer/agar/gills";
import { changePage, repoSummary } from "../shared/contract.js";
import {
  commitPage,
  readCopyRebuilding,
} from "@fungi.computer/agar/roles/files";
import {
  changeStatusLabel,
  changeStatusTone,
  relativeTime,
} from "../shared/presentation.js";

const repositoryParam = {
  key: "repo",
  label: "Repository",
  kind: "repository" as const,
  required: true,
  options: "repos.options",
};
const repository = repoSummary.shape.name;

export const openChangesGill = defineAppGill({
  id: "open-changes",
  title: "Open Changes",
  source: "changes.list",
  limit: 20,
  sizes: ["M", "L"],
  params: [repositoryParam],
  input: ({ params, limit, after }): ReturnType<AppBackendGill["input"]> => {
    const input = { repo: repository.parse(params.repo), state: "open", limit };
    return after === undefined ? input : { ...input, after };
  },
  rows: (output) => {
    const identity = { viewId: "open-changes", title: "Open Changes" };
    if (readCopyRebuilding.safeParse(output).success)
      return {
        ...identity,
        state: "error",
        rows: [],
        recovery: { kind: "open" },
        error:
          "Saved changes are rebuilding. Open Bonsai to finish the rebuild.",
      };
    const page = changePage.parse(output);
    if (page.changes.length === 0)
      return { ...identity, state: "empty", rows: [] };
    const rows = page.changes.map((change) => ({
      id: String(change.number),
      title: change.title,
      detail: `#${String(change.number)} · ${change.sourceRef} → ${change.targetRef}`,
      status: {
        label: changeStatusLabel(change.status),
        tone: changeStatusTone[change.status],
      },
      open: {
        params: [
          { key: "page", value: "change" },
          { key: "repo", value: change.repo },
          { key: "number", value: String(change.number) },
        ],
      },
    }));
    return page.next === undefined
      ? { ...identity, state: "full", rows }
      : { ...identity, state: "full", rows, next: page.next };
  },
});

export const recentCommitsGill = defineAppGill({
  id: "recent-commits",
  title: "Recent Commits",
  source: "commits.list",
  limit: 20,
  sizes: ["M", "L"],
  params: [
    repositoryParam,
    {
      key: "branch",
      label: "Branch",
      kind: "branch",
      required: false,
      options: "branches.options",
    },
  ],
  input: ({ params, limit, after }): ReturnType<AppBackendGill["input"]> => {
    const input = { repo: repository.parse(params.repo), limit };
    const selected =
      params.branch === undefined ? input : { ...input, ref: params.branch };
    return after === undefined ? selected : { ...selected, after };
  },
  rows: (output, { params }) => {
    const identity = { viewId: "recent-commits", title: "Recent Commits" };
    if (readCopyRebuilding.safeParse(output).success)
      return {
        ...identity,
        state: "error",
        rows: [],
        recovery: { kind: "open" },
        error:
          "Saved commits are rebuilding. Open Bonsai to finish the rebuild.",
      };
    const page = commitPage.parse(output);
    const repo = repository.parse(params.repo);
    if (page.commits.length === 0)
      return { ...identity, state: "empty", rows: [] };
    const rows = page.commits.map(({ commit, agent }) => ({
      id: commit.hash,
      title:
        commit.message.trim().length === 0
          ? commit.hash.slice(0, 8)
          : (commit.message.split("\n")[0] ?? commit.hash.slice(0, 8)),
      detail: `${commit.hash.slice(0, 8)} · ${agent ?? commit.author.name} · ${relativeTime(commit.committedAt * 1000)} · ${page.ref}`,
      open: {
        params: [
          { key: "page", value: "commit" },
          { key: "repo", value: repo },
          { key: "hash", value: commit.hash },
        ],
      },
    }));
    return page.next === undefined
      ? { ...identity, state: "full", rows }
      : { ...identity, state: "full", rows, next: page.next };
  },
});
