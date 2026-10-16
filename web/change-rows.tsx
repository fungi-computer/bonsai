import {
  DataList,
  DataListHeading,
  DataRow,
} from "@fungi.computer/caps/components/data-list";
import { Status } from "@fungi.computer/caps/components/status";
import type { Change } from "../shared/contract.js";
import { relativeTime } from "./format.js";
import { AgentName, type AgentColors } from "./parts.js";
import { href, Link } from "./router.js";

export function changeStatusLabel(status: Change["status"]): string {
  const label = status.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const order = {
  conflict: 0,
  "checks-failed": 1,
  "checks-running": 2,
  "needs-approval": 3,
  ready: 4,
  merging: 5,
  merged: 6,
  closed: 7,
};
export const changeStatusTone = {
  conflict: "warning",
  "checks-failed": "error",
  "checks-running": "info",
  "needs-approval": "warning",
  ready: "success",
  merging: "info",
  merged: "success",
  closed: "neutral",
} as const;
function ChangeRows({
  changes,
  colors,
  limit,
}: {
  changes: readonly Change[];
  colors: AgentColors;
  limit?: number;
}) {
  return (
    <DataList className="bonsai-change-list">
      {[...changes]
        .sort((a, b) => order[a.status] - order[b.status])
        .slice(0, limit)
        .map((change) => {
          return (
            <DataRow key={`${change.repo}:${String(change.number)}`}>
              <div className="min-w-0 flex-1">
                <Link
                  to={href({
                    page: "change",
                    repo: change.repo,
                    number: change.number,
                  })}
                >
                  {`#${String(change.number)} · ${change.title}`}
                </Link>
                <p className="text-xs text-[var(--stipe-fg-muted)]">
                  <AgentName name={change.openedBy} colors={colors} /> ·{" "}
                  {change.ahead} ahead · {change.behind} behind
                  {` · ${relativeTime(change.updatedAt)}`}
                </p>
              </div>
              <Status
                size="compact"
                tone={changeStatusTone[change.status]}
                label={changeStatusLabel(change.status)}
              />
            </DataRow>
          );
        })}
    </DataList>
  );
}

/** The attention group uses the server's derived status, not client policy. */
export function needsAttention(change: Change): boolean {
  return (
    change.status === "conflict" ||
    change.status === "checks-failed" ||
    change.status === "needs-approval"
  );
}

export function ChangeGroups({
  changes,
  colors,
  limit,
}: {
  changes: readonly Change[];
  colors: AgentColors;
  limit?: number;
}) {
  const shown = [...changes]
    .sort((a, b) => order[a.status] - order[b.status])
    .slice(0, limit);
  const groups = [
    { title: "Needs you", items: shown.filter(needsAttention) },
    {
      title: "Ready",
      items: shown.filter((change) => change.status === "ready"),
    },
    {
      title: "In progress",
      items: shown.filter(
        (change) =>
          change.status === "checks-running" || change.status === "merging",
      ),
    },
    {
      title: "Done",
      items: shown.filter(
        (change) => change.state === "merged" || change.state === "closed",
      ),
    },
  ];
  return (
    <>
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section key={group.title}>
            <DataListHeading level={3}>{group.title}</DataListHeading>
            <ChangeRows changes={group.items} colors={colors} />
          </section>
        ))}
    </>
  );
}
