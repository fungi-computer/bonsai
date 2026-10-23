import * as S from "effect/Schema";
import { parseSha256Digest } from "@fungi.computer/puffball";
import {
  appGitPushFactSchema,
  type AppGitPushFact,
} from "@fungi.computer/agar/git";
import { contentDigest, workflowDefinitionSchema } from "@fungi.computer/braid";
import type { GraphStartRequest } from "@fungi.computer/braid/runtime";
import {
  repositoryWorkflowSourceSchema,
  runReply,
  statusReply,
  runsReplySchema,
} from "@fungi.computer/workflows-wire";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import type { AppBuildWorkflowInput } from "../shared/contract.js";
import template from "@fungi.computer/trellis/templates/bonsai-build-on-merge" with { type: "json" };

export type RepositoryWorkflowSource =
  typeof repositoryWorkflowSourceSchema.Type;
export type BuildWorkflowRunReply = ReturnType<typeof runReply.parse>;

export type BuildWorkflowBindings = Readonly<{
  APPS?: Readonly<{
    repository(input: {
      repo: string;
    }): Promise<RepositoryWorkflowSource | null>;
  }>;
  WORKFLOWS?: Readonly<{
    runs(input: {
      workflowId?: string;
    }): Promise<ReturnType<typeof runsReplySchema.parse>>;
    runGraph(input: GraphStartRequest): Promise<BuildWorkflowRunReply>;
    graphStatus(input: {
      runId: string;
    }): Promise<ReturnType<typeof statusReply.parse>>;
  }>;
}>;

/** One request path for accepted main pushes and an explicit owner action.
 * The host owns lifecycle identity; manual request IDs are ordinary call replay
 * keys. Neither entrypoint constructs a call frame or installs as this App. */
async function requestBuildWorkflow(
  env: BuildWorkflowBindings,
  input: AppBuildWorkflowInput,
) {
  if (env.APPS === undefined)
    throw new AppMethodRefusal(
      "unavailable",
      "App source lookup is unavailable",
    );
  const source = S.decodeUnknownSync(S.NullOr(repositoryWorkflowSourceSchema))(
    await env.APPS.repository({ repo: input.repo }),
  );
  if (source === null) return null;
  if (env.WORKFLOWS === undefined)
    throw new AppMethodRefusal("unavailable", "Workflow access is not granted");
  const stock = S.decodeUnknownSync(workflowDefinitionSchema)(
    template.definition,
  );
  const definition = {
    ...stock,
    apps: { bonsai: { appId: source.callerAppId } },
  };
  const response = runReply.parse(
    await env.WORKFLOWS.runGraph({
      requestId: input.requestId,
      definition,
      bindings: { bonsai: source.installationId },
      input: {
        appId: source.appId,
        sourceRevision: input.sourceRevision,
        installationId: input.installationId,
      },
      published: {
        workflowId: template.id,
        commit: source.callerSourceRevision.slice(4),
        digest: parseSha256Digest(await contentDigest(definition)),
      },
    }),
  );
  if (
    !("kind" in response) ||
    (response.kind !== "started" && response.kind !== "replay")
  )
    throw new AppMethodRefusal(
      "kind" in response && response.kind === "invalid"
        ? "invalid"
        : "unavailable",
      "Build Workflow refused: " + JSON.stringify(response).slice(0, 2000),
    );
  return response;
}

/** The host journal supplies the accepted main head, never an App merge event. */
export async function startBuildWorkflow(
  env: BuildWorkflowBindings,
  raw: AppGitPushFact,
): Promise<void> {
  const fact = appGitPushFactSchema.parse(raw);
  const update = fact.updates.find(
    (row) =>
      row.ref === "refs/heads/main" &&
      row.after !== "0".repeat(40) &&
      row.before !== row.after,
  );
  if (update === undefined) return;
  await requestBuildWorkflow(env, {
    repo: fact.repository,
    sourceRevision: "git:" + update.after,
    installationId: fact.repository,
    requestId: fact.eventId,
  });
}

/** Owner calls use the same retained definition, verification and node authority. */
export async function startManualBuildWorkflow(
  env: BuildWorkflowBindings,
  input: AppBuildWorkflowInput,
) {
  const started = await requestBuildWorkflow(env, input);
  if (started === null)
    throw new AppMethodRefusal(
      "not_found",
      "This repository is not registered as an App",
    );
  return started;
}

/** Discover host-owned runs after a push, without materializing a trigger ledger. */
export async function readBuildWorkflowRuns(env: BuildWorkflowBindings) {
  if (env.WORKFLOWS === undefined)
    throw new AppMethodRefusal("unavailable", "Workflow access is not granted");
  return runsReplySchema.parse(
    await env.WORKFLOWS.runs({ workflowId: template.id }),
  );
}
