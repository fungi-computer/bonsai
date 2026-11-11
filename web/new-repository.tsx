import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert } from "@fungi.computer/caps/components/alert";
import { Button } from "@fungi.computer/caps/components/button";
import { Checkbox } from "@fungi.computer/caps/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fungi.computer/caps/components/dialog";
import { Field } from "@fungi.computer/caps/components/field";
import { Input } from "@fungi.computer/caps/components/input";
import { SetupNotice } from "@fungi.computer/caps/blocks/setup-notice";
import { repoNameProblem } from "../shared/repo-name.js";
import { createRepository } from "./api.js";
import { href, useRouter } from "./router.js";
import { isPermissionDenied, requestGitAccess } from "./transport.js";

/** Name a repository, optionally commit a README, and open it. */
export function NewRepositoryDialog({
  open,
  onOpenChange,
  initialName = "",
  initialError = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A suggested name to start from, chosen from the empty state. */
  initialName?: string;
  /** Why a one-click start failed, shown when the form opens instead. */
  initialError?: string | null;
}) {
  const client = useQueryClient();
  const { go } = useRouter();
  const [name, setName] = useState(initialName);
  const [readme, setReadme] = useState(true);
  const [touched, setTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [needsAccess, setNeedsAccess] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<string | null>(initialError);
  const problem = repoNameProblem(name);
  const shownProblem = touched ? problem : null;

  async function create(): Promise<"created" | "refused" | "failed"> {
    setTouched(true);
    if (problem !== null) return "refused";
    setCreating(true);
    setFailure(null);
    try {
      const created = await createRepository({ name, readme });
      await client.invalidateQueries({ queryKey: ["repos"] });
      onOpenChange(false);
      setName("");
      setNeedsAccess(false);
      go(
        href({
          page: "repo",
          repo: created.name,
          tab: "overview",
          ref: null,
          file: null,
          path: "",
        }),
      );
      return "created";
    } catch (error) {
      if (error instanceof Error && isPermissionDenied(error))
        setNeedsAccess(true);
      else
        setFailure(
          error instanceof Error ? error.message : "Couldn't create it.",
        );
      return "failed";
    } finally {
      setCreating(false);
    }
  }

  async function approve(): Promise<void> {
    setWaiting(true);
    try {
      const outcome = await requestGitAccess();
      if (outcome === "granted") {
        setNeedsAccess(false);
        await create();
      } else if (outcome === "declined") {
        setFailure("Bonsai needs Git access to create a repository.");
      } else if (outcome === "unavailable") {
        setFailure("Open this Oyster's App settings and allow Git for Bonsai.");
      }
    } finally {
      setWaiting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="mb-4">
          <DialogTitle>New repository</DialogTitle>
          <DialogDescription>
            Pick a short name. Lowercase letters, digits and dashes work.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field label="Name" error={shownProblem} required>
            <Input
              autoFocus
              value={name}
              placeholder="koi-pond"
              onChange={(event) => {
                setName(event.target.value);
              }}
              onBlur={() => {
                setTouched(true);
              }}
            />
          </Field>
          <Field label="Start with a README" orientation="inline">
            <Checkbox
              checked={readme}
              onChange={(event) => {
                setReadme(event.target.checked);
              }}
            />
          </Field>
          {needsAccess ? (
            <SetupNotice
              variant="inline"
              need="Bonsai needs Git access to save your repositories"
              cause="Approve once and Bonsai can save your repositories."
              fix={{
                label: "Approve",
                onSelect: () => void approve(),
                pending: waiting,
              }}
              waitingFor="your answer"
            />
          ) : null}
          {failure !== null ? (
            <Alert tone="error" description={failure} />
          ) : null}
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="ghost"
              disabled={creating}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating || needsAccess}>
              {creating ? "Creating…" : "Create repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
