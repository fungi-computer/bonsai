import { fileContent, fileSaveResult } from "@fungi.computer/agar/roles/files";
import { callMethod, editInFilesEditor, filesEditor } from "./transport.js";

export const firstIssuePath = "issues/general/01-first-issue.md";

/** Create the first issue through the editor's save door, then open it there. */
export async function writeFirstIssue(repo: string, branch: string) {
  if ((await filesEditor()) === null)
    throw new Error("Choose a file editor in your App settings first.");
  const file = await callMethod(
    "files.read",
    { repo, ref: branch, path: firstIssuePath },
    fileContent,
  );
  // A repeated click or an earlier editor draft must never replace someone's text.
  if (file.blob === null && file.pending === undefined) {
    const result = await callMethod(
      "files.save",
      {
        repo,
        branch,
        path: firstIssuePath,
        baseBlob: null,
        baseCommit: file.commit,
        revision: file.version,
        text: `---
id: general-01
title: "First issue"
type: task
status: needs-triage
priority: p2
created: ${new Date().toISOString().slice(0, 10)}
assignee: null
areas: [general]
blocked_by: []
---

# First issue

## Outcome

Describe what you want to change.

## Context

Add any details that will help someone understand the issue.

## Acceptance criteria

- [ ] Describe what success looks like.

## Verification

- [ ] Describe how to check the result.
`,
      },
      fileSaveResult,
    );
    if (result.kind !== "saved" && result.kind !== "synced")
      throw new Error("The issue could not be created. Try again.");
  }
  await editInFilesEditor(repo, branch, firstIssuePath);
}
