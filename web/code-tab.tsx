import { useEffect, useState } from "react";
import { Button } from "@fungi.computer/caps/components/button";
import { CopyField } from "@fungi.computer/caps/components/copy-field";
import { Disclosure } from "@fungi.computer/caps/components/disclosure";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { fileSyncResult } from "@fungi.computer/agar/roles/files";
import { editInFilesEditor, callMethod } from "./transport.js";
import type { RepoDetail } from "../shared/contract.js";
import { useFiles, useFile, useFilesEditor } from "./api.js";
import { BonsaiBoard } from "./board.js";
import { firstLine, formatBytes, relativeTime, shortHash } from "./format.js";
import { Loading, Failure } from "./parts.js";
import { href, Link, useRouter, type Route } from "./router.js";
import { FileView, Markdown, RepoTree } from "./views.js";

export function CodeTab({
  route,
  detail,
}: {
  route: Extract<Route, { page: "repo" }>;
  detail: RepoDetail;
}) {
  const { go } = useRouter();
  const [wide, setWide] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const editor = useFilesEditor();
  const editLabel =
    editor.data === undefined || editor.data === null
      ? null
      : editor.data.displayName === null
        ? "Edit"
        : `Edit in ${editor.data.displayName}`;
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
  const ref = route.ref ?? detail.defaultBranch;
  const files = useFiles(route.repo, ref, !detail.empty);
  const readme =
    files.data?.paths.find((path) => /^readme(\.md)?$/iu.test(path)) ?? null;
  const shown = route.file ?? readme;
  const file = useFile(route.repo, ref, shown);
  const shownText = file.data?.pending?.text ?? file.data?.text ?? null;
  if (detail.empty)
    return (
      <EmptyState
        variant="panel"
        title="Empty repository"
        description={`Push a first commit: git push ${detail.cloneUrl} main`}
      />
    );
  const tree = files.isPending ? (
    <Loading label="Loading files" />
  ) : files.isError ? (
    <Failure
      error={files.error}
      retry={() => {
        void files.refetch();
      }}
    />
  ) : (
    <div
      className="flex"
      style={{
        height: Math.min(480, Math.max(90, files.data.paths.length * 30 + 60)),
      }}
    >
      <RepoTree
        key={`${route.repo}:${files.data.commit.hash}`}
        paths={files.data.paths}
        active={shown}
        onOpen={(path) => {
          setTreeOpen(false);
          setRaw(false);
          go(href({ ...route, path: "", file: path }));
        }}
      />
    </div>
  );
  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
      <div className="min-w-0 lg:sticky lg:top-3">
        {wide ? (
          <BonsaiBoard
            columns={1}
            rowHeight={0}
            placements={[{ id: "files", col: 0, row: 0, w: 1, h: 1 }]}
            tiles={[
              { id: "files", title: "Files", autoHeight: true, body: tree },
            ]}
          />
        ) : (
          <Disclosure
            open={treeOpen}
            onOpenChange={setTreeOpen}
            summary={`Files · ${shown ?? ref}`}
          >
            {tree}
          </Disclosure>
        )}
      </div>
      <BonsaiBoard
        columns={1}
        rowHeight={0}
        placements={[{ id: "file", col: 0, row: 0, w: 1, h: 1 }]}
        tiles={[
          {
            id: "file",
            title: "File",
            autoHeight: true,
            body: (
              <div className="space-y-3">
                {shown ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CopyField value={shown} label="Copy path" />
                    <div className="flex flex-wrap items-center gap-2">
                      {file.data?.binary === false &&
                      file.data.text !== null &&
                      editLabel !== null ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setActionError(null);
                            void editInFilesEditor(
                              route.repo,
                              ref,
                              shown,
                            ).catch((error: unknown) => {
                              setActionError(
                                error instanceof Error
                                  ? error.message
                                  : "The editor could not open",
                              );
                            });
                          }}
                        >
                          {editLabel}
                        </Button>
                      ) : null}
                      {file.data?.text !== null &&
                      file.data?.text !== undefined ? (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-pressed={raw}
                          onClick={() => {
                            setRaw(!raw);
                          }}
                        >
                          Raw
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {actionError === null ? null : (
                  <p role="alert">{actionError}</p>
                )}
                {file.data?.pending === undefined ? null : (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>
                      {file.data.pending.state === "conflict"
                        ? editLabel === null
                          ? "Sync conflict"
                          : `Sync conflict · ${editLabel} to compare`
                        : file.data.pending.state === "failed"
                          ? "Sync failed · Saved text retained"
                          : "Unsynced edit"}
                    </span>
                    {file.data.pending.state === "pending" ||
                    file.data.pending.state === "failed" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={syncing}
                        onClick={() => {
                          setSyncing(true);
                          setActionError(null);
                          void callMethod("files.sync", {}, fileSyncResult)
                            .then(async () => {
                              await files.refetch();
                              await file.refetch();
                            })
                            .catch((error: unknown) => {
                              setActionError(
                                error instanceof Error
                                  ? error.message
                                  : "Sync could not finish",
                              );
                            })
                            .finally(() => {
                              setSyncing(false);
                            });
                        }}
                      >
                        {syncing ? "Syncing…" : "Sync"}
                      </Button>
                    ) : null}
                  </div>
                )}
                {file.data ? (
                  <p className="text-xs text-[var(--stipe-fg-muted)]">
                    {formatBytes(file.data.size)}
                    {shownText === null
                      ? ""
                      : ` · ${String(shownText.trimEnd().split("\n").length)} lines`}
                  </p>
                ) : null}
                {files.data ? (
                  <p className="text-sm text-[var(--stipe-fg-muted)]">
                    Latest commit · {files.data.commit.author.name} ·{" "}
                    <Link
                      to={href({
                        page: "commit",
                        repo: route.repo,
                        hash: files.data.commit.hash,
                      })}
                    >
                      {shortHash(files.data.commit.hash)}
                    </Link>{" "}
                    · {firstLine(files.data.commit.message)} ·{" "}
                    {relativeTime(files.data.commit.committedAt * 1000)}
                  </p>
                ) : null}
                {shown === null ? (
                  <p>Pick a file to read it.</p>
                ) : file.isPending ? (
                  <Loading label="Loading file" />
                ) : file.isError ? (
                  <Failure
                    error={file.error}
                    retry={() => {
                      void file.refetch();
                    }}
                  />
                ) : shownText === null ? (
                  <p>
                    {file.data.binary ? "Binary file" : "Too large to show"}
                  </p>
                ) : raw ? (
                  <pre className="overflow-x-auto whitespace-pre text-sm">
                    {shownText}
                  </pre>
                ) : /\.(md|mdx|markdown)$/iu.test(shown) ? (
                  <Markdown text={shownText} />
                ) : (
                  <FileView path={shown} text={shownText} />
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
