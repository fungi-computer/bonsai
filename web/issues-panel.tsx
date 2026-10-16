import { BonsaiBoard } from "./board.js";
import { CardTitle } from "@fungi.computer/caps/components/card";
/**
 * Issues as files: Markdown tickets under issues/ in the repository, checked
 * by the shared issue validator, with the unblocked frontier first.
 */
import { Badge } from "@fungi.computer/caps/components/badge";
import {
  DataList,
  DataListHeading,
  DataRow,
} from "@fungi.computer/caps/components/data-list";
import {
  Status,
  type StatusTone,
} from "@fungi.computer/caps/components/status";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import {
  inspectIssueTree,
  type IssueIndexRecord,
  type IssueStatus,
} from "@fungi.computer/issues";
import { useMemo } from "react";
import { useIssueFiles } from "./api.js";
import { Failure, Loading } from "./parts.js";
import { href, Link } from "./router.js";
import { Markdown } from "./views.js";

const statusTone = {
  "needs-triage": "neutral",
  "needs-info": "warning",
  "ready-for-agent": "info",
  "ready-for-human": "info",
  "in-progress": "primary",
  resolved: "success",
  wontfix: "neutral",
} satisfies Record<IssueStatus, StatusTone>;

const statusLabel = {
  "needs-triage": "triage",
  "needs-info": "needs info",
  "ready-for-agent": "ready · agent",
  "ready-for-human": "ready · person",
  "in-progress": "in progress",
  resolved: "resolved",
  wontfix: "won't fix",
} satisfies Record<IssueStatus, string>;

function IssueRow({
  repo,
  refName,
  issue,
  records,
}: {
  repo: string;
  refName: string;
  issue: IssueIndexRecord;
  records: readonly IssueIndexRecord[];
}) {
  return (
    <DataRow className="grid-cols-[minmax(0,1fr)_auto]">
      <div className="bonsai-commit-text">
        <Link
          to={href({
            page: "repo",
            repo,
            tab: "issues",
            ref: refName,
            path: "",
            file: issue.path,
          })}
        >
          {issue.title}
        </Link>
        <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
          <code>{issue.id}</code>
          {issue.assignee === null ? "" : ` · ${issue.assignee}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Status
          size="compact"
          tone={issue.blocked ? "warning" : statusTone[issue.status]}
          glyph={
            issue.status === "in-progress" && !issue.blocked ? "arc" : "dot"
          }
          label={
            issue.blocked ? (
              <>
                blocked by{" "}
                {issue.blocked_by.map((id, index) => {
                  const dependency = records.find((record) => record.id === id);
                  return (
                    <span key={id}>
                      {index > 0 ? ", " : ""}
                      {dependency ? (
                        <Link
                          to={href({
                            page: "repo",
                            repo,
                            tab: "issues",
                            ref: refName,
                            path: "",
                            file: dependency.path,
                          })}
                        >
                          {id}
                        </Link>
                      ) : (
                        id
                      )}
                    </span>
                  );
                })}
              </>
            ) : (
              statusLabel[issue.status]
            )
          }
        />
        <Badge
          size="sm"
          variant="quiet"
          tone={
            issue.priority === "p0" || issue.priority === "p1"
              ? "warning"
              : "neutral"
          }
        >
          {issue.priority}
        </Badge>
      </div>
    </DataRow>
  );
}

export function IssuesPanel({
  repo,
  refName,
  open,
}: {
  repo: string;
  refName: string;
  open: string | null;
}) {
  const files = useIssueFiles(repo, refName);
  const report = useMemo(
    () => (files.data ? inspectIssueTree(files.data.files) : null),
    [files.data],
  );
  if (files.isPending) return <Loading label="Loading issues" />;
  if (files.isError)
    return (
      <Failure
        error={files.error}
        retry={() => {
          void files.refetch();
        }}
      />
    );
  if (report === null || Object.keys(files.data.files).length === 0)
    return (
      <EmptyState
        variant="panel"
        headingLevel={3}
        title="No issues yet"
        description="Issues live in the repository as Markdown under issues/<effort>/<NN>-<slug>.md, so agents read and update them with git."
      />
    );
  const opened = open === null ? undefined : files.data.files[open];
  if (open !== null && opened !== undefined)
    return (
      <div className="bonsai-issue">
        <nav className="bonsai-crumbs" aria-label="Issue">
          <Link
            to={href({
              page: "repo",
              repo,
              tab: "issues",
              ref: refName,
              path: "",
              file: null,
            })}
          >
            Issues
          </Link>
          <span>/ {open}</span>
        </nav>
        <div className="caps-card caps-card-surface bonsai-file">
          <Markdown text={opened} />
        </div>
      </div>
    );
  const done = (issue: IssueIndexRecord) =>
    issue.status === "resolved" || issue.status === "wontfix";
  const groups = [
    {
      title: "Unblocked",
      records: report.records.filter((issue) => !done(issue) && !issue.blocked),
    },
    {
      title: "Blocked",
      records: report.records.filter((issue) => !done(issue) && issue.blocked),
    },
    { title: "Done", records: report.records.filter(done) },
  ];
  return (
    <BonsaiBoard
      rowHeight={0}
      placements={[
        { id: "issues", col: 0, row: 0, w: 3, h: 1 },
        { id: "issue-help", col: 3, row: 0, w: 1, h: 1 },
      ]}
      phoneOrder={["issues", "issue-help"]}
      tiles={[
        {
          id: "issues",
          title: "Issues",
          autoHeight: true,
          body: (
            <div className="space-y-4">
              {report.status === "fail" ? (
                <section
                  className="caps-card caps-card-surface p-4 bonsai-issue-problems"
                  aria-labelledby="issue-problems"
                >
                  <header className="bonsai-section-head">
                    <CardTitle level={2} id="issue-problems">
                      Issue files need fixing
                    </CardTitle>
                    <Badge size="sm" tone="error" variant="quiet">
                      {report.diagnostics.length}
                    </Badge>
                  </header>
                  <ul>
                    {report.diagnostics
                      .slice(0, 12)
                      .map((diagnostic, index) => (
                        <li key={`${diagnostic.path}:${String(index)}`}>
                          <code>{diagnostic.path}</code>{" "}
                          <span className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
                            {diagnostic.detail}
                          </span>
                        </li>
                      ))}
                  </ul>
                </section>
              ) : null}
              {report.records.length === 0 ? (
                <DataList className="bonsai-change-list" density="compact">
                  {Object.keys(files.data.files).map((path) => (
                    <DataRow key={path}>
                      <Link
                        to={href({
                          page: "repo",
                          repo,
                          tab: "issues",
                          ref: refName,
                          path: "",
                          file: path,
                        })}
                      >
                        {path}
                      </Link>
                    </DataRow>
                  ))}
                </DataList>
              ) : null}
              {groups
                .filter((group) => group.records.length > 0)
                .map((group) => (
                  <section key={group.title}>
                    <DataListHeading level={3}>{group.title}</DataListHeading>
                    <DataList>
                      {group.records.map((issue) => (
                        <IssueRow
                          key={issue.id}
                          repo={repo}
                          refName={refName}
                          issue={issue}
                          records={report.records}
                        />
                      ))}
                    </DataList>
                  </section>
                ))}
            </div>
          ),
        },
        {
          id: "issue-help",
          title: "How issues work",
          autoHeight: true,
          body: (
            <p>
              Issues are Markdown files under <code>issues/</code>. Agents and
              people edit them with git. Dependencies link each issue to the
              work that must finish first.
            </p>
          ),
        },
      ]}
    />
  );
}
