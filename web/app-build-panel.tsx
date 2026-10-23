import { replayKey } from "@fungi.computer/cairn";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as S from "effect/Schema";
import { z } from "zod";
import { workflowDefinitionSchema } from "@fungi.computer/braid";
import { runReply } from "@fungi.computer/workflows-wire";
import {
  RunTimeline,
  OutputError,
  runStatusSchema,
  runSteps,
  terminal,
  timelineItems,
} from "@fungi.computer/trellis/run-timeline";
import template from "@fungi.computer/trellis/templates/bonsai-build-on-merge" with { type: "json" };
import { Button } from "@fungi.computer/caps/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@fungi.computer/caps/components/card";
import { Input } from "@fungi.computer/caps/components/input";
import { pendingSchema } from "@fungi.computer/agar";
import { appBuildView, appRegistration } from "../shared/contract.js";
import { callMethod } from "./transport.js";

const buildStatus = z.union([pendingSchema, appBuildView]).nullable();
const definition = S.decodeUnknownSync(workflowDefinitionSchema)(
  template.definition,
);
const appDisplay = { app_bonsai: { displayName: "Bonsai", icon: "bonsai" } };

/** Both this owner action and accepted main pushes start the same Workflow.
 * Only its host-attested install step selects a Release; the panel never does. */
export function AppBuildPanel({ repo }: { repo: string }) {
  const queryClient = useQueryClient();
  const [appId, setAppId] = useState<string | null>(null);
  const [sourceRevision, setSourceRevision] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const statusKey = ["apps.buildStatus", repo];
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => callMethod("apps.buildStatus", { repo }, buildStatus),
    refetchInterval: 5000,
  });
  const settled =
    status.data == null || "kind" in status.data ? null : status.data;
  const selectedAppId = appId ?? settled?.appId ?? "";
  const selectedRevision = sourceRevision ?? settled?.sourceRevision ?? "";
  const selectedInstallationId = installationId ?? repo;
  const run = useQuery({
    queryKey: ["apps.buildWorkflowRun", runId],
    enabled: runId !== null,
    queryFn: () => {
      if (runId === null) throw new Error("No Workflow run selected");
      return callMethod("apps.buildWorkflowRun", { runId }, runStatusSchema);
    },
    refetchInterval: (query) =>
      query.state.data !== undefined &&
      (query.state.data.outcome !== "active" ||
        terminal(query.state.data.status))
        ? false
        : 2000,
  });
  const build = useMutation({
    mutationFn: async () => {
      const started = await callMethod(
        "apps.startBuildWorkflow",
        {
          repo,
          sourceRevision: selectedRevision,
          installationId: selectedInstallationId,
          requestId: replayKey(),
        },
        runReply,
      );
      if (
        !("kind" in started) ||
        (started.kind !== "started" && started.kind !== "replay")
      )
        throw new Error("Build Workflow refused: " + JSON.stringify(started));
      return started;
    },
    onSuccess: (started) => {
      setRunId(started.runId);
    },
  });
  const registration = useMutation({
    mutationFn: () => callMethod("apps.register", { repo }, appRegistration),
    onSuccess: (registered) => {
      setAppId(registered.appId);
      setSourceRevision(registered.sourceRevision);
      setInstallationId(repo);
      setRunId(null);
      queryClient.setQueryData(statusKey, null);
      build.reset();
    },
  });
  const busy = build.isPending || registration.isPending;
  return (
    <Card className="w-full max-w-2xl" variant="outline">
      <CardHeader>
        <CardTitle level={2}>Build &amp; install</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-[var(--stipe-fg-muted)]">
          Register the committed App recipe, then start the Workflow to build,
          verify and install your chosen revision. Its steps report what
          actually happened. Only the owner may do this.
        </p>
        <div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              registration.mutate();
            }}
          >
            {registration.isPending ? "Registering…" : "Make this an App"}
          </Button>
        </div>
        {registration.isError ? (
          <p role="alert">{registration.error.message}</p>
        ) : null}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              selectedAppId &&
              selectedRevision &&
              selectedInstallationId &&
              !busy
            )
              build.mutate();
          }}
        >
          <label className="flex flex-col gap-2" htmlFor="app-build-app-id">
            <span>App id</span>
            <Input
              id="app-build-app-id"
              value={selectedAppId}
              readOnly
              placeholder="app_myfork"
              disabled={busy}
            />
          </label>
          <label
            className="flex flex-col gap-2"
            htmlFor="app-build-source-revision"
          >
            <span>Source revision</span>
            <Input
              id="app-build-source-revision"
              value={selectedRevision}
              onChange={(event) => {
                setSourceRevision(event.target.value);
              }}
              placeholder={"git:" + "a".repeat(40)}
              disabled={busy}
            />
          </label>
          <label className="flex flex-col gap-2" htmlFor="app-install-id">
            <span>Install at</span>
            <Input
              id="app-install-id"
              value={selectedInstallationId}
              onChange={(event) => {
                setInstallationId(event.target.value);
              }}
              disabled={busy}
            />
          </label>
          {build.isError ? <p role="alert">{build.error.message}</p> : null}
          <div>
            <Button
              type="submit"
              disabled={
                !selectedAppId ||
                !selectedRevision ||
                !selectedInstallationId ||
                busy
              }
            >
              {build.isPending ? "Starting Workflow…" : "Build & install"}
            </Button>
          </div>
        </form>
        {runId !== null ? (
          <section aria-label="Build Workflow" className="flex flex-col gap-3">
            <p role="status">Workflow run {runId}</p>
            {run.isPending ? (
              <p role="status">Loading Workflow steps…</p>
            ) : null}
            {run.isError ? <p role="alert">{run.error.message}</p> : null}
            {run.data === undefined ? null : (
              <>
                <p role="status">
                  {run.data.title}: {run.data.status}
                </p>
                {run.data.error === null ? null : (
                  <OutputError error={run.data.error} />
                )}
                <RunTimeline
                  items={timelineItems(
                    runSteps(
                      run.data.events,
                      run.data.outcome,
                      run.data.reviews,
                    ),
                    definition,
                    appDisplay,
                  )}
                />
              </>
            )}
          </section>
        ) : (
          <section
            aria-label="Latest repository build"
            className="flex flex-col gap-2"
          >
            {status.data != null && "kind" in status.data ? (
              <p role="status">
                Build or automatic installation is still running.
              </p>
            ) : null}
            {settled === null ? null : (
              <p role="status">
                Job {settled.jobId}: {settled.status}
                {settled.status !== "succeeded" && settled.detail
                  ? " — " + settled.detail
                  : ""}
              </p>
            )}
            {status.isError ? <p role="alert">{status.error.message}</p> : null}
            {settled?.installation?.kind === "needs_consent" ? (
              <p role="status">
                Needs owner consent. Automatic installation left any previous
                Release unchanged.
              </p>
            ) : null}
            {settled?.installation?.kind === "installed" ? (
              <p role="status">
                Installed at {settled.installation.installationId}.
              </p>
            ) : null}
            {settled?.installation?.kind === "failed" ? (
              <p role="alert">Not installed: {settled.installation.detail}</p>
            ) : null}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
