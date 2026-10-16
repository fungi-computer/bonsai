import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@fungi.computer/caps/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@fungi.computer/caps/components/card";
import { Input } from "@fungi.computer/caps/components/input";
import { repositoryDeletion } from "../shared/repository-deletion.js";
import { callMethod } from "./transport.js";
import { href, Link, useRouter } from "./router.js";
import { AppBuildPanel } from "./app-build-panel.js";

/** Keep cleanup retry usable after the public repository entry is withdrawn. */
export function RepoSettings({ repo }: { repo: string }) {
  const { go } = useRouter();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const deletion = useMutation({
    mutationFn: () => callMethod("repos.delete", { repo }, repositoryDeletion),
    onSuccess: async () => {
      client.removeQueries({ queryKey: ["repo", repo] });
      await client.invalidateQueries({ queryKey: ["repos"] });
      go("/");
    },
  });
  const failure = deletion.error?.message;
  const retryMessage =
    failure === "Provider temporarily unavailable; retry deletion" ||
    failure === "Bonsai could not finish that request"
      ? "Deletion didn't finish because storage was unavailable. Confirm again to finish removing it."
      : failure;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <nav
        aria-label="Repository"
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        <Link to="/">Bonsai</Link>
        <span aria-hidden="true">/</span>
        <Link
          className="break-all"
          to={href({
            page: "repo",
            repo,
            tab: "overview",
            ref: null,
            path: "",
            file: null,
          })}
        >
          {repo}
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Settings</span>
      </nav>
      <h1 className="caps-card-title">Repository settings</h1>
      <Card className="w-full max-w-2xl" variant="outline">
        <CardHeader>
          <CardTitle level={2}>Delete repository</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p>
            This removes <strong className="break-all">{repo}</strong> and its
            Git content. This cannot be undone.
          </p>
          <p className="text-sm text-[var(--stipe-fg-muted)]">
            Only the owner can delete a repository. Delete its forks first.
          </p>
          {confirming ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (confirmation === repo && !deletion.isPending)
                  deletion.mutate();
              }}
            >
              <label
                className="flex flex-col gap-2"
                htmlFor="repository-deletion-name"
              >
                <span>Repository name</span>
                <span className="text-sm text-[var(--stipe-fg-muted)]">
                  Type the name above to confirm.
                </span>
                <Input
                  id="repository-deletion-name"
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                  }}
                  autoComplete="off"
                  disabled={deletion.isPending}
                  autoFocus
                />
              </label>
              {deletion.isError ? (
                <div role="alert" className="text-sm text-error">
                  <p>{retryMessage}</p>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="destructive"
                  type="submit"
                  disabled={confirmation !== repo || deletion.isPending}
                >
                  {deletion.isPending ? "Deleting…" : "Confirm deletion"}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={deletion.isPending}
                  onClick={() => {
                    setConfirming(false);
                    setConfirmation("");
                    deletion.reset();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Delete repository
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <AppBuildPanel />
    </div>
  );
}
