import {
  ScreenCells,
  ScreenCell,
} from "@fungi.computer/caps/components/surface";
import { useLayoutEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AreaStack } from "@visx/shape";
import { curveMonotoneX } from "@visx/curve";
import { scaleLinear } from "@visx/scale";
import { hierarchy, Treemap } from "@visx/hierarchy";
import type { Agent, Graph } from "../shared/contract.js";
import {
  codeInsights,
  ageBandLabels,
  type CodeInsights,
} from "../shared/insights.js";
import {
  actorSplit,
  contributionDays,
  contributionWeeks,
} from "./insight-data.js";
import { agentColor } from "./format.js";
import { callMethod } from "./transport.js";
import { Failure, Loading } from "./parts.js";

const kindLabel = { agent: "Agent", human: "Person", unknown: "Unattributed" };
const kinds = ["agent", "human", "unknown"] as const;

/** Match the viewBox to the display width so fixed-height charts never letterbox. */
function useChartWidth() {
  const [element, setElement] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(440);
  useLayoutEffect(() => {
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return { ref: setElement, width };
}

function Contributors({ graph, actors }: { graph: Graph; actors: Agent[] }) {
  const { ref, width } = useChartWidth();
  const data = useMemo(() => contributionWeeks(graph, actors), [graph, actors]);
  const keys = data.contributors.map((item) => item.id);
  const max = Math.max(
    1,
    ...data.weeks.map((week) =>
      [...week.counts.values()].reduce((a, b) => a + b, 0),
    ),
  );
  const firstWeek = Math.max(
    0,
    data.weeks.findIndex((week) => week.counts.size > 0),
  );
  const weeks = data.weeks.slice(firstWeek);
  // A single occupied week is still a full time interval, not a zero-width path.
  const plotted =
    weeks.length === 1 && weeks[0]
      ? [...weeks, { ...weeks[0], index: 12 }]
      : weeks;
  const x = scaleLinear({
    domain: [firstWeek, Math.max(11, firstWeek + 1)],
    range: [0, width],
  });
  const y = scaleLinear({ domain: [-max / 2, max / 2], range: [116, 8] });
  if (keys.length === 0)
    return (
      <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
        No sampled commits in the past 12 weeks.
      </p>
    );
  return (
    <>
      <p className="text-xs text-[var(--stipe-fg-muted)] bonsai-chart-note">
        Loaded history (up to 12 weeks) · weekly commits by first pushing actor
      </p>
      <svg
        ref={ref}
        className="bonsai-contributor-chart"
        viewBox={`0 0 ${String(width)} 140`}
        role="img"
        aria-label="Contributor streamgraph, weekly sampled commits"
      >
        <AreaStack
          data={plotted}
          keys={keys}
          offset="silhouette"
          curve={curveMonotoneX}
          x={(point) => x(point.data.index)}
          y0={(point) => y(point[0])}
          y1={(point) => y(point[1])}
          value={(week, key) => week.counts.get(key) ?? 0}
        >
          {({ stacks, path }) =>
            stacks.map((series) => {
              const contributor = data.contributors.find(
                (item) => item.id === series.key,
              );
              return (
                <path
                  key={series.key}
                  d={path(series) ?? ""}
                  fill={agentColor(contributor?.color)}
                  stroke="var(--color-base-100)"
                  strokeWidth={1}
                  fillOpacity={contributor?.kind === "human" ? 0.65 : 0.95}
                >
                  <title>
                    {contributor?.name}: {contributor?.total} commits ·{" "}
                    {kindLabel[contributor?.kind ?? "unknown"]}
                  </title>
                </path>
              );
            })
          }
        </AreaStack>
        <line
          data-time-axis
          x1={0}
          x2={width}
          y1={120}
          y2={120}
          stroke="var(--stipe-linework)"
        />
        <text x={0} y={137}>
          {firstWeek === 11
            ? "This week"
            : `${String(11 - firstWeek)} weeks ago`}
        </text>
        <text x={width} y={137} textAnchor="end">
          This week
        </text>
      </svg>
      <ul className="text-xs bonsai-chart-legend">
        {data.contributors.map((item) => (
          <li key={item.id}>
            <i style={{ background: agentColor(item.color) }} />
            <span>
              {item.name} <small>{kindLabel[item.kind]}</small>
            </span>
            <strong>{item.total}</strong>
          </li>
        ))}
      </ul>
    </>
  );
}

function ActorSplit({ graph, actors }: { graph: Graph; actors: Agent[] }) {
  const split = actorSplit(graph, actors);
  const total =
    split.commits.agent + split.commits.human + split.commits.unknown;
  const contributors = contributionWeeks(graph, actors).contributors;
  const recorded = contributors.reduce((sum, actor) => sum + actor.total, 0);
  let offset = 0;
  return (
    <>
      <p className="text-2xl font-semibold">
        {total ? Math.round((100 * split.commits.agent) / total) : 0}%{" "}
        <span className="text-sm font-normal">by Agents</span>
      </p>
      <svg
        viewBox="0 0 440 16"
        className="bonsai-actor-bar"
        role="img"
        aria-label="Recent sampled commits by actor"
      >
        {contributors.map((actor) => {
          const width = recorded ? (440 * actor.total) / recorded : 0;
          const x = offset;
          offset += width;
          return (
            <rect
              key={actor.id}
              x={x}
              width={width}
              height={16}
              fill={agentColor(actor.color)}
            >
              <title>
                {actor.name}: {actor.total} sampled commits
              </title>
            </rect>
          );
        })}
      </svg>
      <ScreenCells>
        {kinds.map((kind) => (
          <ScreenCell
            key={kind}
            legend={
              kind === "agent"
                ? "Agents"
                : kind === "human"
                  ? "People"
                  : "Unknown"
            }
          >
            {split.commits[kind]}
          </ScreenCell>
        ))}
      </ScreenCells>
      <p className="text-xs text-[var(--stipe-fg-muted)]">
        {total} loaded commits ·{" "}
        {split.merges.agent + split.merges.human + split.merges.unknown} merges.
        Review counts are not included.
      </p>
    </>
  );
}

function Calendar({ graph }: { graph: Graph }) {
  const { ref, width } = useChartWidth();
  const days = contributionDays(graph);
  const max = Math.max(1, ...days.map((day) => day.count));
  const startDay = days[0]?.day ?? 0;
  const offset = new Date(startDay * 86400000).getUTCDay();
  const step = (width - 18) / Math.ceil((days.length + offset) / 7);
  return (
    <>
      <p className="text-xs text-[var(--stipe-fg-muted)] bonsai-chart-note">
        Past 26 weeks · sampled commits · UTC
      </p>
      <svg
        ref={ref}
        className="bonsai-calendar-chart"
        viewBox={`0 0 ${String(width)} 130`}
        role="img"
        aria-label={`${String(days.reduce((sum, day) => sum + day.count, 0))} sampled commits in the past 26 weeks`}
      >
        {["S", "M", "T", "W", "T", "F", "S"].map((label, row) => (
          <text key={row} x={0} y={32 + row * 15}>
            {label}
          </text>
        ))}
        {days.map((day, index) => {
          const date = new Date(day.day * 86400000);
          const x = 18 + Math.floor((index + offset) / 7) * step;
          const y = 22 + ((index + offset) % 7) * 15;
          return (
            <g key={day.day}>
              {date.getUTCDate() <= 7 && date.getUTCDay() === 0 ? (
                <text x={x} y={12}>
                  {date.toLocaleDateString("en", {
                    month: "short",
                    timeZone: "UTC",
                  })}
                </text>
              ) : null}
              <rect
                x={x}
                y={y}
                width={Math.max(1, step - 3)}
                height={12}
                rx={2}
                fill={
                  day.count ? "var(--bonsai-agent-c3)" : "var(--color-base-300)"
                }
                fillOpacity={day.count ? 0.25 + (day.count / max) * 0.75 : 0.5}
              >
                <title>
                  {date.toISOString().slice(0, 10)}: {day.count} commits
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-[var(--stipe-fg-muted)] bonsai-chart-note">
        Lighter to darker = fewer to more commits. Empty cells mean no commits
        in the loaded history sample.
      </p>
    </>
  );
}

function CodeAge({ data }: { data: CodeInsights }) {
  const { ref, width } = useChartWidth();
  const latest = data.ageHistory.at(-1);
  const total = latest?.lines.reduce((sum, count) => sum + count, 0) ?? 0;
  const max = Math.max(
    1,
    ...data.ageHistory.map((snapshot) =>
      snapshot.lines.reduce((sum, count) => sum + count, 0),
    ),
  );
  const x = scaleLinear({
    domain: [0, Math.max(1, data.ageHistory.length - 1)],
    range: [0, width],
  });
  const y = scaleLinear({ domain: [0, max], range: [88, 6] });
  const date = (at: number) =>
    new Date(at * 1000).toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const first = data.ageHistory[0];
  const keys = ageBandLabels.map((_, index) => index);
  return (
    <>
      <p className="text-xs text-[var(--stipe-fg-muted)] bonsai-chart-note">
        {total.toLocaleString()} current lines · sampled paths across
        first-parent snapshots
      </p>
      <svg
        ref={ref}
        className="bonsai-age-chart"
        viewBox={`0 0 ${String(width)} 110`}
        role="img"
        aria-label="Line ages over history, stacked by age band"
      >
        <AreaStack
          data={data.ageHistory}
          keys={keys}
          curve={curveMonotoneX}
          x={(_point, index) => x(index)}
          y0={(point) => y(point[0])}
          y1={(point) => y(point[1])}
          value={(snapshot, key) => snapshot.lines[key] ?? 0}
        >
          {({ stacks, path }) =>
            stacks.map((series) => (
              <path
                key={series.key}
                d={path(series) ?? ""}
                fill={
                  series.key === 4
                    ? "var(--stipe-fg-muted)"
                    : agentColor(`c${String(series.key + 1)}`)
                }
              >
                <title>
                  {ageBandLabels[series.key]}: {latest?.lines[series.key] ?? 0}{" "}
                  current lines
                </title>
              </path>
            ))
          }
        </AreaStack>
        <line
          data-time-axis
          x1={0}
          x2={width}
          y1={90}
          y2={90}
          stroke="var(--stipe-linework)"
        />
        <text x={0} y={106}>
          {first ? date(first.at) : ""}
        </text>
        <text x={width} y={106} textAnchor="end">
          {latest ? date(latest.at) : ""}
        </text>
      </svg>
      <ul className="text-xs bonsai-chart-legend">
        {ageBandLabels.map((label, index) => (
          <li key={label}>
            <i
              style={{
                background:
                  index === 4
                    ? "var(--stipe-fg-muted)"
                    : agentColor(`c${String(index + 1)}`),
              }}
            />
            <span>{label}</span>
            <strong>{(latest?.lines[index] ?? 0).toLocaleString()}</strong>
          </li>
        ))}
      </ul>
    </>
  );
}

type FileLeaf = {
  path: string;
  lines: number;
  changes: number;
  children?: FileLeaf[];
};
function FileChurn({ data }: { data: CodeInsights }) {
  const root = hierarchy<FileLeaf>({
    path: "root",
    lines: 0,
    changes: 0,
    children: data.files.filter((file) => file.lines > 0),
  })
    .sum((file) => file.lines)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const max = Math.max(1, ...data.files.map((file) => file.changes));
  if (!root.children?.length)
    return (
      <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
        No readable, non-empty text files in this sample.
      </p>
    );
  return (
    <>
      <p className="text-xs text-[var(--stipe-fg-muted)] bonsai-chart-note">
        Area = current lines · darker = more changed revisions
      </p>
      <svg viewBox="0 0 440 175" role="img" aria-label="File churn treemap">
        <Treemap root={root} size={[440, 175]} paddingInner={2}>
          {(tree) =>
            tree.leaves().map((leaf) => (
              <g key={leaf.data.path}>
                <rect
                  x={leaf.x0}
                  y={leaf.y0}
                  width={leaf.x1 - leaf.x0}
                  height={leaf.y1 - leaf.y0}
                  rx={2}
                  fill="var(--bonsai-agent-c1)"
                  fillOpacity={0.2 + (leaf.data.changes / max) * 0.8}
                >
                  <title>
                    {leaf.data.path}: {leaf.data.lines} lines,{" "}
                    {leaf.data.changes} changed revisions
                  </title>
                </rect>
                {leaf.x1 - leaf.x0 > 70 && leaf.y1 - leaf.y0 > 28 ? (
                  <text x={leaf.x0 + 6} y={leaf.y0 + 17}>
                    {leaf.data.path
                      .split("/")
                      .at(-1)
                      ?.slice(
                        0,
                        Math.max(4, Math.floor((leaf.x1 - leaf.x0 - 12) / 7)),
                      )}
                  </text>
                ) : null}
              </g>
            ))
          }
        </Treemap>
      </svg>
      <details>
        <summary>File counts</summary>
        <ul className="bonsai-file-counts">
          {data.files.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code>
              <span>
                {file.lines} lines · {file.changes} changes
              </span>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function CodeTile({
  id,
  repo,
  refName,
}: {
  id: "ages" | "churn";
  repo: string;
  refName: string;
}) {
  const query = useQuery({
    queryKey: ["code-insights", repo, refName],
    queryFn: () =>
      callMethod("insights.code", { repo, ref: refName }, codeInsights),
    staleTime: 60000,
  });
  if (query.isPending) return <Loading label="Reading line history" />;
  if (query.isError)
    return (
      <Failure
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  if (query.data.head === null)
    return (
      <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
        Push a first commit to see code insights.
      </p>
    );
  return (
    <>
      {id === "ages" ? (
        <CodeAge data={query.data} />
      ) : (
        <FileChurn data={query.data} />
      )}
      <p className="text-xs text-[var(--stipe-fg-muted)] bonsai-chart-note">
        {query.data.files.length} text files · {query.data.commits} first-parent
        commits
        {query.data.partial
          ? ` · bounded sample, ${String(query.data.omittedFiles)} files omitted; older lines may be unknown`
          : ""}
      </p>
    </>
  );
}

export function InsightTile({
  id,
  repo,
  refName,
  graph,
  actors,
}: {
  id: "contributors" | "actors" | "calendar" | "ages" | "churn";
  repo: string;
  refName: string;
  graph: Graph;
  actors: Agent[];
}) {
  switch (id) {
    case "contributors":
      return <Contributors graph={graph} actors={actors} />;
    case "actors":
      return <ActorSplit graph={graph} actors={actors} />;
    case "calendar":
      return <Calendar graph={graph} />;
    case "ages":
    case "churn":
      return <CodeTile id={id} repo={repo} refName={refName} />;
  }
}
