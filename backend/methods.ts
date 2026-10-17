import { resultRows } from "@fungi.computer/agar/method-presentation";
import { openChangesGill, recentCommitsGill } from "./gills.js";
import {
  pickerOptionsInput,
  pickerOptionsPage,
} from "../shared/picker-options.js";
import { getRepoDetail } from "./repository-copy.js";
import { ReadCopyBudgetExceeded } from "@fungi.computer/agar/read-copy";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import {
  backgroundRuntime,
  registerBackgroundProjector,
  syncBackground,
} from "./background.js";
import {
  assertOrdinaryFileMember,
  saveFileEdit,
  syncFileEdits,
  projectQueuedFileEdit,
} from "./file-edits.js";
import {
  actorLane,
  mayEnqueueBackground,
  type BackgroundBinding,
} from "@fungi.computer/puffball/background-replay";
/**
 * Bonsai's App methods: the one API for Agents, the host and Bonsai's own UI.
 * Runtime-neutral: no Cloudflare imports here (see agar's backend rules).
 */
import {
  defineAppBackend,
  defineAppMethod,
  pending,
  type AppBackendMethod,
} from "@fungi.computer/agar/backend-definition";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import * as z from "zod";
import {
  gitSha1Schema,
  gitRepositoryNameSchema,
} from "@fungi.computer/puffball/git-representation";
import {
  activityPage,
  appBuildView,
  approvalResult,
  checkRequestResult,
  checkReportResult,
  mergeResult,
  changeRecord,
  readCopyPageInput,
  policyDecision,
  agentPage,
  changeDetail,
  changePage,
  commitDetail,
  graph,
  issueFiles,
  repoDetail,
  repoPage,
  repoSummary,
} from "../shared/contract.js";
import {
  readCopyRebuilding,
  copyRebuildPage,
  commitPage,
  fileContent,
  fileSaveInput,
  fileSaveResult,
  fileSyncResult,
  fileDiscardInput,
  fileDiscardResult,
  fileList,
  treeListing,
} from "@fungi.computer/agar/roles/files";
import { hookEventFor } from "../shared/hooks.js";
import { repositoryDeletion } from "../shared/repository-deletion.js";
import {
  codeInsights,
  insightLayout,
  savedLayout,
} from "../shared/insights.js";
import * as changes from "./changes.js";
import * as reviews from "./reviews.js";
import { mergeChange, queueMergeChange } from "./merge.js";
import { drainOutbox } from "./state.js";
import * as service from "./service.js";
import { callerActor } from "./policy.js";
import type { Bonsai } from "./service.js";

/** The closed result `APPS.fork` answers with. */
export type AppSourceForkBindingResult =
  | Readonly<{ kind: "forked"; appId: string; repository: string }>
  | Readonly<{
      kind: "unauthorized" | "conflict" | "provider_unavailable";
    }>;

/** A host binding call's wire reply: the owner route's status and body, never a key. */
export type AppsBindingReply = Readonly<{
  status: number;
  body: z.core.util.JSONType;
}>;

/** The host `APPS` binding: fork a source, build it, and install a Release. */
export type BonsaiAppsBinding = Readonly<{
  fork(input: {
    platformAppId: string;
    name: string;
  }): Promise<AppSourceForkBindingResult>;
  build(input: {
    appId: string;
    sourceRevision: string;
  }): Promise<AppsBindingReply>;
  buildStatus(input: { jobId: string }): Promise<AppsBindingReply>;
  select(input: {
    installationId: string;
    release: unknown;
  }): Promise<AppsBindingReply>;
}>;

/** What a Bonsai method runs against: the facet supplies it. */
type BonsaiMethodContext = Readonly<{
  bonsai: Bonsai;
  env?: Readonly<{
    BACKGROUND?: BackgroundBinding;
    APPS?: BonsaiAppsBinding;
  }>;
}>;

const bindingErrorBody = z.object({ error: z.string() });

/** Translate a refused owner-route reply into the method's typed refusal. */
function refuseBindingReply(reply: AppsBindingReply): never {
  const parsed = bindingErrorBody.safeParse(reply.body);
  const message = parsed.success ? parsed.data.error : "Request refused";
  throw new AppMethodRefusal(
    reply.status === 404
      ? "not_found"
      : reply.status === 409
        ? "conflict"
        : reply.status === 403
          ? "forbidden"
          : "invalid",
    message,
  );
}

/** Install the file projection for fresh replay contexts as well as enqueue frames. */
function fileBackgroundRuntime(bonsai: Bonsai, caller: AppMethodCallContext) {
  assertOrdinaryFileMember(caller);
  registerBackgroundProjector(bonsai, "file-edit", (transition) => {
    projectQueuedFileEdit(bonsai, transition);
  });
  return backgroundRuntime(bonsai, caller);
}

async function readCopyResponse<T>(
  read: () => Promise<T>,
): Promise<T | { kind: "rebuilding" }> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof ReadCopyBudgetExceeded ||
      (error instanceof AppMethodRefusal && error.code === "unavailable")
    )
      return { kind: "rebuilding" };
    throw error;
  }
}
const repo = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/u);
const ref = z.string().min(1).max(256).default("main");
const path = z.string().max(4096).default("");

const definition = defineAppBackend<BonsaiMethodContext>({
  events: {
    "git.push": {
      description: "A repository accepted a push.",
      payload: hookEventFor("git.push"),
    },
    "git.fork": {
      description: "A repository was forked.",
      payload: hookEventFor("git.fork"),
    },
    "change.opened": {
      description:
        "A fork received its first push since it was created or merged.",
      payload: hookEventFor("change.opened"),
    },
    "change.updated": {
      description: "The proposed source head changed.",
      payload: hookEventFor("change.updated"),
    },
    "change.approved": {
      description: "A person approved the proposed head.",
      payload: hookEventFor("change.approved"),
    },
    "change.checks_requested": {
      description: "Checks were requested at the proposed head.",
      payload: hookEventFor("change.checks_requested"),
    },
    "change.checked": {
      description: "A check finished at the proposed head.",
      payload: hookEventFor("change.checked"),
    },
    "change.closed": {
      description: "A Change was closed.",
      payload: hookEventFor("change.closed"),
    },
    "change.merged": {
      description: "A fork was merged into its canonical repository.",
      payload: hookEventFor("change.merged"),
    },
    "change.conflicted": {
      description: "A merge found conflicting paths.",
      payload: hookEventFor("change.conflicted"),
    },
    "repo.created": {
      description: "A canonical repository was created.",
      payload: hookEventFor("repo.created"),
    },
  },
  methods: {
    "apps.build": defineAppMethod({
      description:
        "Build an App's registered source at one exact commit on this Oyster's Computer; the job keeps running after this call returns. Owner only.",
      effect: "write",
      // The host scopes APPS.build to a method that declares the operation's
      // own requirements; the owner check below still gates every call.
      requires: ["git.repository", "computer.execute"],
      input: z.strictObject({
        appId: z.string().min(1).max(256),
        sourceRevision: z.string().min(1).max(256),
      }),
      output: appBuildView,
      handler: async (input, context: BonsaiMethodContext, caller) => {
        if (caller.role !== "owner")
          throw new AppMethodRefusal("forbidden", "Owner only");
        if (!context.env?.APPS)
          throw new AppMethodRefusal("unavailable", "Build is unavailable");
        const reply = await context.env.APPS.build(input);
        if (reply.status >= 400) refuseBindingReply(reply);
        return appBuildView.parse(reply.body);
      },
    }),
    "apps.buildStatus": defineAppMethod({
      description:
        "Wait for one build job: Pending while it runs, then its settled status and Release. Owner only.",
      effect: "read",
      // The host grants its APPS operation only under these approvals.
      requires: ["git.repository", "computer.execute"],
      // A Workflow step waits on the job by polling this same call.
      pending: true,
      input: z.strictObject({ jobId: z.string().min(1).max(256) }),
      output: appBuildView,
      handler: async (input, context: BonsaiMethodContext, caller) => {
        if (caller.role !== "owner")
          throw new AppMethodRefusal("forbidden", "Owner only");
        if (!context.env?.APPS)
          throw new AppMethodRefusal("unavailable", "Build is unavailable");
        const reply = await context.env.APPS.buildStatus(input);
        if (reply.status >= 400) refuseBindingReply(reply);
        const build = appBuildView.parse(reply.body);
        return build.status === "running" ? pending(5_000) : build;
      },
    }),
    "apps.install": defineAppMethod({
      description:
        "Install a built Release at an installation id, or switch an already-live one onto it. Owner only.",
      effect: "write",
      // The host grants its APPS operation only under these approvals.
      requires: ["git.repository", "computer.execute"],
      input: z.strictObject({
        installationId: z.string().min(1).max(256),
        release: z.unknown(),
      }),
      output: z.unknown(),
      handler: async (input, context: BonsaiMethodContext, caller) => {
        if (caller.role !== "owner")
          throw new AppMethodRefusal("forbidden", "Owner only");
        if (!context.env?.APPS)
          throw new AppMethodRefusal("unavailable", "Install is unavailable");
        const reply = await context.env.APPS.select(input);
        if (reply.status >= 400) refuseBindingReply(reply);
        return reply.body;
      },
    }),
    "insights.code": defineAppMethod({
      description:
        "Sample current text files and their first-parent line history (up to 40 commits, 80 files).",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo, ref }),
      output: codeInsights,
      handler: (input, context) =>
        service.getCodeInsights(context.bonsai, input),
    }),
    "insights.layout.get": defineAppMethod({
      description: "Read the caller's repository insight layout.",
      effect: "read",
      requires: [],
      input: z.strictObject({ repo }),
      output: savedLayout,
      handler: (input, context, caller) => ({
        tiles: context.bonsai.state.layout(
          JSON.stringify(caller.actor),
          input.repo,
        ),
      }),
    }),
    "insights.layout.save": defineAppMethod({
      description: "Save the caller's repository insight layout.",
      effect: "write",
      requires: [],
      input: z.strictObject({ repo, tiles: insightLayout }),
      output: savedLayout,
      handler: (input, context, caller) => {
        context.bonsai.state.saveLayout(
          JSON.stringify(caller.actor),
          input.repo,
          input.tiles,
        );
        return { tiles: input.tiles };
      },
    }),
    rebuildCopies: defineAppMethod({
      description:
        "Rebuild one page of local repository, Change, Graph, Commit and Files copies, within this frame's provider budget.",
      effect: "read",
      // Each page reads Git; the host scopes GIT to methods that declare it.
      requires: ["git.repository"],
      input: z.strictObject({ cursor: z.string().nullable().default(null) }),
      output: copyRebuildPage,
      handler: (input, context) =>
        service.rebuildCopies(context.bonsai, input.cursor),
    }),
    "repos.list": defineAppMethod({
      description:
        "List canonical repositories with their forks and recent push activity.",
      effect: "read",
      requires: [],
      input: z.strictObject({}),
      output: repoPage,
      present: {
        rows: resultRows,
        verb: "listed",
        row: ({ output }) => ({
          id: "repos.list",
          title: `Bonsai listed ${String(output.repos.length)} ${output.repos.length === 1 ? "repository" : "repositories"}`,
          detail: output.repos
            .slice(0, 5)
            .map((repo) => repo.name)
            .join(" · "),
        }),
      },
      handler: (_input, context) => ({
        repos: service.listRepos(context.bonsai),
      }),
    }),
    "repos.options": defineAppMethod({
      description: "Choose a repository from the saved canonical catalog.",
      effect: "read",
      requires: [],
      input: pickerOptionsInput,
      output: pickerOptionsPage,
      handler: (input, context) =>
        service.repositoryOptions(context.bonsai, input),
    }),
    "branches.options": defineAppMethod({
      description: "Choose a branch from a repository's ready saved refs.",
      effect: "read",
      requires: [],
      input: pickerOptionsInput,
      output: pickerOptionsPage,
      handler: (input, context) => service.branchOptions(context.bonsai, input),
    }),
    "repos.get": defineAppMethod({
      description:
        "Read one repository: default branch, refs, clone URL and forks.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo }),
      output: z.union([repoDetail, readCopyRebuilding]),
      handler: (input, context) =>
        readCopyResponse(() => getRepoDetail(context.bonsai, input.repo)),
    }),
    "repos.create": defineAppMethod({
      description: "Create a canonical repository. People only.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({
        name: z.string().regex(service.repoNamePattern),
        description: z.string().max(280).default(""),
      }),
      output: repoSummary,
      handler: (input, context, caller) =>
        service.createRepo(context.bonsai, callerActor(caller), input),
    }),
    "repos.delete": defineAppMethod({
      description:
        "Delete a repository and its provider content. Owner only; retry-safe.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({ repo: gitRepositoryNameSchema }),
      output: repositoryDeletion,
      handler: (input, context, caller) =>
        service.deleteRepo(context.bonsai, caller, input.repo),
    }),
    "repos.fork": defineAppMethod({
      description:
        "Give the caller its own fork of a canonical repository (returns the existing one if present). Push work there, then ask a person to merge.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({ repo }),
      output: repoSummary,
      handler: (input, context, caller) =>
        service.forkFor(context.bonsai, callerActor(caller), input.repo),
    }),
    "apps.fork": defineAppMethod({
      description:
        "Fork an App's published source into its own Team-owned App: a new Bonsai repository the owner edits and merges, registered as that App's build source. Owner only.",
      effect: "write",
      // It records the fork as a Bonsai repository in this installation's Git.
      requires: ["git.repository"],
      input: z.strictObject({
        appId: z.string().min(1).max(256),
        name: z.string().min(1).max(63),
      }),
      output: z.strictObject({
        appId: z.string(),
        repository: z.string(),
      }),
      handler: async (input, context, caller) => {
        if (caller.role !== "owner")
          throw new AppMethodRefusal("forbidden", "Owner only");
        if (!context.env?.APPS)
          throw new AppMethodRefusal(
            "unavailable",
            "App source forking is unavailable",
          );
        service.assertRepoName(input.name);
        const revision = service.repoRevision(context.bonsai, input.name);
        const result = await context.env.APPS.fork({
          platformAppId: input.appId,
          name: input.name,
        });
        const parsed = z
          .union([
            z.strictObject({
              kind: z.literal("forked"),
              appId: z.string(),
              repository: z.string(),
            }),
            z.strictObject({
              kind: z.enum([
                "unauthorized",
                "conflict",
                "provider_unavailable",
              ]),
            }),
          ])
          .parse(result);
        if (parsed.kind === "forked") {
          await service.recordAppFork(
            context.bonsai,
            callerActor(caller),
            {
              name: parsed.repository,
              description: `Source of ${parsed.appId}, forked from ${input.appId}`,
            },
            revision,
          );
          return { appId: parsed.appId, repository: parsed.repository };
        }
        throw new AppMethodRefusal(
          parsed.kind === "unauthorized"
            ? "forbidden"
            : parsed.kind === "conflict"
              ? "conflict"
              : "unavailable",
          `App source fork ${parsed.kind}`,
        );
      },
    }),
    "files.tree": defineAppMethod({
      description: "List one directory of a repository at a ref.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo, ref, path }),
      output: z.union([treeListing, readCopyRebuilding]),
      handler: (input, context) =>
        readCopyResponse(() => service.listTree(context.bonsai, input)),
    }),
    "files.list": defineAppMethod({
      description:
        "List every path in a repository at a ref (directories end with /).",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo, ref }),
      output: z.union([fileList, readCopyRebuilding]),
      handler: (input, context) =>
        readCopyResponse(() => service.listFiles(context.bonsai, input)),
    }),
    "files.read": defineAppMethod({
      description:
        "Read one file at a ref; text is null for binary or very large files.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo, ref, path: z.string().min(1).max(4096) }),
      output: z.union([fileContent, readCopyRebuilding]),
      handler: (input, context, caller) =>
        readCopyResponse(async () => {
          const file = await service.readFile(context.bonsai, input);
          if (caller.actor.kind !== "member" || caller.workflow !== undefined)
            return file;
          const lane = actorLane(caller.actor);
          const key = {
            repo: input.repo,
            branch: input.ref.replace(/^refs\/heads\//u, ""),
            path: input.path,
          };
          const version = context.bonsai.state.fileEdits.revision(lane, key);
          const pending = context.bonsai.state.fileEdits.pending(lane, key);
          return pending === undefined
            ? { ...file, version }
            : { ...file, version, pending };
        }),
    }),
    "files.save": defineAppMethod({
      description:
        "Save bounded text as a private member row with revision CAS; eligible edits sync in the background.",
      effect: "write",
      requires: ["git.repository"],
      input: fileSaveInput,
      output: fileSaveResult,
      handler: async (input, context, caller) =>
        saveFileEdit(
          context.bonsai,
          caller,
          input,
          mayEnqueueBackground(caller)
            ? await fileBackgroundRuntime(context.bonsai, caller)
            : null,
        ),
    }),
    "files.sync": defineAppMethod({
      description:
        "Retry eligible failed edits and report this member's saved-file status; background sync owns Git work.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({}),
      output: fileSyncResult,
      handler: async (_input, context, caller) =>
        syncFileEdits(
          context.bonsai,
          caller,
          await fileBackgroundRuntime(context.bonsai, caller),
        ),
    }),
    "files.discard": defineAppMethod({
      description:
        "Discard only this caller's saved file revision and reload Git's text.",
      effect: "write",
      requires: ["git.repository"],
      input: fileDiscardInput,
      output: fileDiscardResult,
      handler: (input, context, caller) => {
        assertOrdinaryFileMember(caller);
        return context.bonsai.state.fileEdits.discard(
          actorLane(caller.actor),
          input,
        );
      },
    }),
    "issues.read": defineAppMethod({
      description: "Read the Markdown issue files under issues/ at a ref.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo, ref }),
      output: issueFiles,
      handler: (input, context) =>
        service.readIssueFiles(context.bonsai, input),
    }),
    "commits.list": defineAppMethod({
      description:
        "List recent commits on a ref with the agent that pushed each.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo, ref, ...readCopyPageInput.shape }),
      output: z.union([commitPage, readCopyRebuilding]),
      handler: (input, context) =>
        readCopyResponse(() => service.listCommits(context.bonsai, input)),
    }),
    "commits.get": defineAppMethod({
      description: "Read one commit and its diff against its first parent.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({
        repo,
        hash: z.string().regex(/^[0-9a-f]{40}$/u),
      }),
      output: z.union([commitDetail, readCopyRebuilding]),
      handler: (input, context) =>
        readCopyResponse(() => service.getCommitDetail(context.bonsai, input)),
    }),
    "graph.get": defineAppMethod({
      description:
        "The network: every branch and agent fork as lanes with their commits.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo }),
      output: z.union([graph, readCopyRebuilding]),
      handler: (input, context) =>
        readCopyResponse(() => service.buildGraph(context.bonsai, input.repo)),
    }),
    "changes.list": defineAppMethod({
      description:
        "Stored proposals for a canonical repository, with pinned review status.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({
        repo,
        ...readCopyPageInput.shape,
        state: z.enum(["open", "merging", "merged", "closed"]).optional(),
      }),
      output: z.union([changePage, readCopyRebuilding]),
      handler: (input, context, caller) =>
        readCopyResponse(() =>
          changes.changes(
            context.bonsai,
            callerActor(caller),
            input.repo,
            input.state,
            { limit: input.limit, after: input.after },
          ),
        ),
    }),
    "changes.get": defineAppMethod({
      description:
        "Read a numbered Change, pinned diff and review facts; push fixes on checks-failed.",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({ repo, number: z.number().int().positive() }),
      output: z.union([changeDetail, readCopyRebuilding]),
      handler: (input, context, caller) =>
        readCopyResponse(() =>
          changes.change(
            context.bonsai,
            callerActor(caller),
            input.repo,
            input.number,
          ),
        ),
    }),
    "changes.open": defineAppMethod({
      description:
        "Open a proposal from your source branch; pushes of new fork work also open Changes.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({
        repo,
        sourceRef: ref,
        targetRef: z.string().min(1).max(256).optional(),
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(20_000).optional(),
      }),
      output: changeRecord,
      handler: (input, context, caller) =>
        changes.openChange(
          context.bonsai,
          callerActor(caller),
          input,
          caller.idempotencyKey,
        ),
    }),
    "changes.approve": defineAppMethod({
      description:
        "Approve the exact proposed head if you did not open or author it, or as your Team's only member. Agents report reviews as checks.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({
        repo,
        number: z.number().int().positive(),
        head: gitSha1Schema,
      }),
      output: approvalResult,
      handler: (input, context, caller) =>
        reviews.approveChange(
          context.bonsai,
          callerActor(caller),
          input,
          caller.idempotencyKey,
        ),
    }),
    sync: defineAppMethod({
      description:
        "Continue this member's pending writes after fresh host admission.",
      effect: "write",
      // The continuation covers every write's requirements (apps.build's
      // computer.execute included); it only replays queued Git writes.
      requires: ["git.repository", "computer.execute"],
      input: z.strictObject({}),
      output: z.strictObject({ more: z.boolean() }),
      handler: (_input, context, caller) =>
        syncBackground(context.bonsai, caller, context.env?.BACKGROUND),
    }),
    "changes.merge": defineAppMethod({
      description:
        "A person maintainer merges the exact reviewed head; eligible Merge counts as approval. Failing or pending checks block it.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({
        repo,
        number: z.number().int().positive(),
        head: gitSha1Schema,
      }),
      output: mergeResult,
      handler: async (input, context, caller) =>
        mayEnqueueBackground(caller)
          ? queueMergeChange(
              context.bonsai,
              caller,
              input,
              await backgroundRuntime(context.bonsai, caller),
            )
          : mergeChange(
              context.bonsai,
              callerActor(caller),
              input,
              caller.idempotencyKey,
            ),
    }),
    "checks.request": defineAppMethod({
      description:
        "Request checks at this head; the emitted event ID is the real attempt identity for every report from that trigger.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({
        repo,
        number: z.number().int().positive(),
        head: gitSha1Schema,
        names: z.array(z.string().min(1).max(100)).optional(),
      }),
      output: checkRequestResult,
      handler: (input, context, caller) =>
        reviews.requestChecks(
          context.bonsai,
          callerActor(caller),
          input,
          caller.idempotencyKey,
        ),
    }),
    "checks.report": defineAppMethod({
      description:
        "Report a check for the triggering Change event ID. Use its actual eventId as attemptId; runUrl is optional and supplied only for a real run link. Old attempts and conflicting terminal reports settle without overwriting.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({
        repo,
        number: z.number().int().positive(),
        head: gitSha1Schema,
        name: z.string().min(1).max(100),
        status: z.enum(["queued", "running", "passed", "failed"]),
        attemptId: z.string().min(1).max(512),
        runUrl: z.url().optional(),
        summary: z.string().max(4000).optional(),
      }),
      output: checkReportResult,
      handler: (input, context, caller) =>
        reviews.reportCheck(
          context.bonsai,
          callerActor(caller),
          input,
          caller.idempotencyKey,
        ),
    }),
    "changes.close": defineAppMethod({
      description: "Close your proposal or a proposal you maintain.",
      effect: "write",
      requires: ["git.repository"],
      input: z.strictObject({ repo, number: z.number().int().positive() }),
      output: policyDecision,
      handler: (input, context, caller) =>
        changes.closeChange(
          context.bonsai,
          callerActor(caller),
          input.repo,
          input.number,
          caller.idempotencyKey,
        ),
    }),
    "activity.list": defineAppMethod({
      description:
        "Recent activity, newest first; pass after to receive only newer events.",
      effect: "read",
      requires: [],
      input: z.strictObject({
        repo: repo.nullable().default(null),
        limit: z.number().int().min(1).max(200).default(60),
        after: z.number().int().min(0).default(0),
      }),
      output: activityPage,
      handler: (input, context) => ({
        events: service.listActivity(context.bonsai, input),
      }),
    }),
    "actors.list": defineAppMethod({
      description: "Everyone Bonsai has seen act, with their colour slot.",
      effect: "read",
      requires: [],
      input: z.strictObject({}),
      output: agentPage,
      handler: (_input, context) => ({
        agents: context.bonsai.state.actors(),
      }),
    }),
  },
});

/** Deliver one pending page after a write; reads never acquire the event sink. */
function withOutbox(
  method: AppBackendMethod<BonsaiMethodContext>,
): AppBackendMethod<BonsaiMethodContext> {
  if (method.policy.effect !== "write") return method;
  return {
    ...method,
    policy: {
      ...method.policy,
      requires: [...method.policy.requires, "app.events.emit"],
    },
    call: async (input, context, caller) => {
      const result = await method.call(input, context, caller);
      await drainOutbox(context.bonsai);
      return result;
    },
  };
}

export const appBackend = defineAppBackend<BonsaiMethodContext>({
  gills: [openChangesGill, recentCommitsGill],
  sync: { method: "sync" },
  events: definition.events,
  methods: Object.fromEntries(
    Object.entries(definition.methods).map(([name, method]) => [
      name,
      withOutbox(method),
    ]),
  ),
});
