import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@fungi.computer/caps/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@fungi.computer/caps/components/card";
import { Input } from "@fungi.computer/caps/components/input";
import { pendingSchema } from "@fungi.computer/agar";
import { appBuildView, jsonValue } from "../shared/contract.js";
import { callMethod } from "./transport.js";

// The panel sends the Release back to apps.install as JSON.
const buildView = appBuildView.extend({ release: jsonValue.nullable() });
// While the job runs, apps.buildStatus answers Agar Pending.
const buildStatus = z.union([pendingSchema, buildView]);

/** Start a build of a registered App's source, then install or switch its
 * Release once it finishes. Owner only; the host re-checks that on every call. */
export function AppBuildPanel() {
  const [appId, setAppId] = useState("");
  const [sourceRevision, setSourceRevision] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);

  const build = useMutation({
    mutationFn: () =>
      callMethod("apps.build", { appId, sourceRevision }, buildView),
    onSuccess: (job) => {
      setJobId(job.jobId);
    },
  });
  const status = useQuery({
    queryKey: ["apps.buildStatus", jobId],
    queryFn: () => {
      if (jobId === null) throw new Error("No build job to check yet");
      return callMethod("apps.buildStatus", { jobId }, buildStatus);
    },
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || "kind" in query.state.data
        ? 3_000
        : false,
  });
  const settled =
    status.data === undefined || "kind" in status.data ? null : status.data;
  const install = useMutation({
    mutationFn: () => {
      const release = settled?.release;
      if (release === null || release === undefined)
        throw new Error("This build has no Release yet");
      return callMethod(
        "apps.install",
        { installationId, release },
        z.unknown(),
      );
    },
  });

  const release = settled?.release ?? null;
  return (
    <Card className="w-full max-w-2xl" variant="outline">
      <CardHeader>
        <CardTitle level={2}>Build &amp; install</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-[var(--stipe-fg-muted)]">
          Build a registered App&rsquo;s source at one exact commit on this
          Oyster&rsquo;s Computer, then install the Release, or switch an
          already-live installation onto it. Only the owner may do this.
        </p>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (appId && sourceRevision && !build.isPending) build.mutate();
          }}
        >
          <label className="flex flex-col gap-2" htmlFor="app-build-app-id">
            <span>App id</span>
            <Input
              id="app-build-app-id"
              value={appId}
              onChange={(event) => {
                setAppId(event.target.value);
              }}
              placeholder="app_my-fork"
              disabled={build.isPending}
            />
          </label>
          <label
            className="flex flex-col gap-2"
            htmlFor="app-build-source-revision"
          >
            <span>Source revision</span>
            <Input
              id="app-build-source-revision"
              value={sourceRevision}
              onChange={(event) => {
                setSourceRevision(event.target.value);
              }}
              placeholder={`git:${"a".repeat(40)}`}
              disabled={build.isPending}
            />
          </label>
          {build.isError ? (
            <div role="alert" className="text-sm text-error">
              <p>{build.error.message}</p>
            </div>
          ) : null}
          <div>
            <Button
              type="submit"
              disabled={!appId || !sourceRevision || build.isPending}
            >
              {build.isPending ? "Starting build…" : "Build"}
            </Button>
          </div>
        </form>
        {jobId !== null ? (
          <p className="text-sm" role="status">
            Job {jobId}: {settled?.status ?? "running…"}
            {/* A succeeded build's detail is its phase timings, not a message. */}
            {settled?.status !== "succeeded" && settled?.detail
              ? ` — ${settled.detail}`
              : ""}
          </p>
        ) : null}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (installationId && release !== null && !install.isPending)
              install.mutate();
          }}
        >
          <label className="flex flex-col gap-2" htmlFor="app-install-id">
            <span>Install at</span>
            <Input
              id="app-install-id"
              value={installationId}
              onChange={(event) => {
                setInstallationId(event.target.value);
              }}
              placeholder="my-fork"
              disabled={install.isPending}
            />
          </label>
          {install.isError ? (
            <div role="alert" className="text-sm text-error">
              <p>{install.error.message}</p>
            </div>
          ) : null}
          <div>
            <Button
              type="submit"
              disabled={
                !installationId || release === null || install.isPending
              }
            >
              {install.isPending ? "Installing…" : "Install this Release"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
