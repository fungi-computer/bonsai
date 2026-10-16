/** Shared pieces composed from Caps: agent marks, the activity feed, sparklines. */
import { Button } from "@fungi.computer/caps/components/button";
import { Monogram } from "@fungi.computer/caps/components/monogram";
import { Loader } from "@fungi.computer/caps/components/loader";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { useListMotion } from "@fungi.computer/caps/lib/reorder-motion";
import { curveMonotoneX } from "@visx/curve";
import { scaleLinear } from "@visx/scale";
import { AreaClosed, LinePath } from "@visx/shape";
import { useRef, type ReactNode } from "react";
import type { Activity, Agent } from "../shared/contract.js";
import { ApiError } from "./api.js";
import { agentColor, relativeTime, shortActor, shortHash } from "./format.js";
import { href, Link } from "./router.js";

export type AgentColors = ReadonlyMap<
  string,
  { color: string; kind: Agent["kind"] }
>;

export function agentColors(agents: readonly Agent[] | undefined): AgentColors {
  return new Map(
    (agents ?? []).map((agent) => [
      agent.name,
      { color: agent.color, kind: agent.kind },
    ]),
  );
}

/**
 * The actor's readable label. Bonsai never records a human member's display
 * name (their id is their identity, see `callerActor`), so a known human
 * actor reads as a short label instead of the raw host-issued id. Agents,
 * and any actor this view hasn't resolved yet, keep their recorded name.
 */
export function actorLabel(name: string, colors: AgentColors): string {
  return colors.get(name)?.kind === "human" ? shortActor(name) : name;
}

export function AgentMark({
  name,
  colors,
  size = "default",
}: {
  name: string;
  colors: AgentColors;
  size?: "default" | "lg";
}) {
  return (
    <Monogram
      name={actorLabel(name, colors)}
      seed={name}
      size={size}
      data-agent-slot={colors.get(name)?.color}
    />
  );
}

export function AgentName({
  name,
  colors,
}: {
  name: string;
  colors: AgentColors;
}) {
  return (
    <span className="font-semibold bonsai-agent-name">
      <svg
        className="inline-block mr-1"
        width="8"
        height="8"
        viewBox="0 0 8 8"
        aria-hidden="true"
      >
        <circle
          cx="4"
          cy="4"
          r="4"
          fill={agentColor(colors.get(name)?.color)}
        />
      </svg>
      {actorLabel(name, colors)}
    </span>
  );
}

function ownerOf(repo: string): string | null {
  const split = repo.indexOf("--");
  return split === -1 ? null : repo.slice(split + 2);
}

function familyOf(repo: string): string {
  return repo.split("--")[0] ?? repo;
}

function describe(event: Activity, colors: AgentColors): ReactNode {
  const who = <AgentName name={event.actor} colors={colors} />;
  switch (event.type) {
    case "push": {
      const count = event.data.commits.length;
      if (count === 0)
        return (
          <>
            {who} brought{" "}
            <span className="font-mono text-sm bonsai-ref">{event.repo}</span>{" "}
            up to date
          </>
        );
      const ref =
        event.data.updates[0]?.ref.replace(/^refs\/heads\//u, "") ?? "";
      const where =
        ownerOf(event.repo) === null
          ? event.repo
          : `${ownerOf(event.repo) ?? ""}/${ref}`;
      return (
        <>
          {who} pushed {count === 1 ? "a commit" : `${String(count)} commits`}{" "}
          to{" "}
          <span className="font-mono text-sm bonsai-ref">
            {ownerOf(event.repo) === null ? `${event.repo}/${ref}` : where}
          </span>
        </>
      );
    }
    case "fork":
      return (
        <>
          {who} forked{" "}
          <span className="font-mono text-sm bonsai-ref">{event.repo}</span>
        </>
      );
    case "merge":
      return (
        <>
          {who} merged{" "}
          <span className="font-mono text-sm bonsai-ref">
            {ownerOf(event.data.change.sourceRepo) ??
              event.data.change.sourceRepo}
            /{event.data.change.sourceRef}
          </span>{" "}
          into{" "}
          <span className="font-mono text-sm bonsai-ref">{event.data.ref}</span>
        </>
      );
    case "merge.conflict":
      return (
        <>
          {who} tried to merge{" "}
          <span className="font-mono text-sm bonsai-ref">
            {ownerOf(event.data.change.sourceRepo) ??
              event.data.change.sourceRepo}
            /{event.data.change.sourceRef}
          </span>
          : conflicts in{" "}
          {event.data.paths.length === 1
            ? event.data.paths[0]
            : `${String(event.data.paths.length)} files`}
        </>
      );
    case "change.opened":
    case "change.updated":
    case "change.approved":
    case "change.checks_requested":
    case "change.checked":
    case "change.closed":
      return (
        <>
          {who} {event.type.slice(7).replaceAll("_", " ")}{" "}
          <Link
            to={href({
              page: "change",
              repo: event.data.change.repo,
              number: event.data.change.number,
            })}
          >
            Change #{event.data.change.number}
          </Link>
          {event.data.name
            ? ` · ${event.data.name}: ${event.data.status ?? ""}`
            : ""}
        </>
      );
    case "repo.created":
      return (
        <>
          {who} created{" "}
          <span className="font-mono text-sm bonsai-ref">{event.repo}</span>
        </>
      );
  }
}

export function ActivityFeed({
  events,
  colors,
  fresh,
  showRepo = false,
}: {
  events: readonly Activity[];
  colors: AgentColors;
  fresh: ReadonlySet<number>;
  showRepo?: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  useListMotion(
    list,
    events.map((event) => String(event.id)),
  );
  if (events.length === 0) return null;
  return (
    <ol className="bonsai-feed" ref={list}>
      {events.map((event) => (
        <li
          key={event.id}
          data-reorder-key={String(event.id)}
          className={
            fresh.has(event.id)
              ? "bonsai-feed-item bonsai-feed-fresh"
              : "bonsai-feed-item"
          }
        >
          <div className="min-w-0">
            <p
              className="truncate"
              title={
                event.type === "push"
                  ? event.data.commits[0]?.message
                  : undefined
              }
            >
              {event.type === "push" && event.data.commits.length > 0 ? (
                <>
                  <AgentName name={event.actor} colors={colors} /> ·{" "}
                  {event.data.commits[0]?.message}
                  {event.data.commits.length > 1
                    ? ` (+${String(event.data.commits.length - 1)} commits)`
                    : ""}
                </>
              ) : (
                describe(event, colors)
              )}
            </p>
            <p
              className="truncate text-xs text-[var(--stipe-fg-muted)]"
              title={
                event.type === "push" ? event.data.paths.join(", ") : undefined
              }
            >
              {event.type === "push" && event.data.commits[0] ? (
                <>
                  <Link
                    to={href({
                      page: "commit",
                      repo: event.repo,
                      hash: event.data.commits[0].hash,
                    })}
                  >
                    {shortHash(event.data.commits[0].hash)}
                  </Link>
                  {event.data.paths.length > 0
                    ? ` · ${event.data.paths[0] ?? ""}${event.data.paths.length > 1 ? ` +${String(event.data.paths.length - 1)}` : ""}`
                    : ""}
                  {" · "}
                </>
              ) : null}
              {showRepo ? (
                <>
                  <Link
                    to={href({
                      page: "repo",
                      repo: familyOf(event.repo),
                      tab: "overview",
                      ref: null,
                      path: "",
                      file: null,
                    })}
                  >
                    {familyOf(event.repo)}
                  </Link>
                  {" · "}
                </>
              ) : null}
              <time dateTime={new Date(event.at).toISOString()}>
                {relativeTime(event.at)}
              </time>
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Pushes per hour over the last day, as a soft area. A single active bucket
 * (or none) has no trend to show, only a stray mark, so it renders nothing.
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) {
  const active = values.filter((value) => value > 0).length;
  if (active < 2) return null;
  const max = Math.max(1, ...values);
  const x = scaleLinear({
    domain: [0, Math.max(1, values.length - 1)],
    range: [1, width - 1],
  });
  const y = scaleLinear({ domain: [0, max], range: [height - 2, 3] });
  const points = values.map((value, index) => ({ index, value }));
  return (
    <svg
      className="bonsai-spark"
      width={width}
      height={height}
      role="img"
      aria-label={`${String(values.reduce((a, b) => a + b, 0))} pushes in the last day`}
    >
      <AreaClosed
        data={points}
        x={(point) => x(point.index)}
        y={(point) => y(point.value)}
        yScale={y}
        curve={curveMonotoneX}
        className="bonsai-spark-area"
      />
      <LinePath
        data={points}
        x={(point) => x(point.index)}
        y={(point) => y(point.value)}
        curve={curveMonotoneX}
        className="bonsai-spark-line"
      />
    </svg>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="bonsai-loading">
      <Loader label={label} size="sm" />
    </div>
  );
}

export function Failure({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <EmptyState
      variant="quiet"
      headingLevel={3}
      title={
        error instanceof ApiError && error.status === 404
          ? "Not found"
          : retry
            ? "Taking longer than usual"
            : "Couldn't load this"
      }
      description={
        error instanceof Error ? error.message : "Try again in a moment."
      }
      actions={
        retry ? (
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}
