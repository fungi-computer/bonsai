import type { Activity } from "../shared/contract.js";
import { AgentMark, AgentName, type AgentColors } from "./parts.js";
import { relativeTime } from "./format.js";

const activityWindowMs = 15 * 60_000;

function refLabel(ref: string): string {
  return ref.replace(/^refs\/heads\//u, "").replace(/^refs\/tags\//u, "");
}

/** Agents who pushed in this repository family in the last 15 minutes. */
export function workingNow(events: readonly Activity[]) {
  const since = Date.now() - activityWindowMs;
  const byAgent = new Map<
    string,
    { repo: string; ref: string; at: number; paths: Set<string> }
  >();
  for (const event of events) {
    if (event.type !== "push" || event.at < since) continue;
    const current = byAgent.get(event.actor);
    const ref = refLabel(event.data.updates[0]?.ref ?? "");
    if (!current)
      byAgent.set(event.actor, {
        repo: event.repo,
        ref,
        at: event.at,
        paths: new Set(event.data.paths),
      });
    else for (const path of event.data.paths) current.paths.add(path);
  }
  return [...byAgent.entries()].map(([agent, value]) => ({ agent, ...value }));
}

/** Expire recorded activity even when the cached event page stays unchanged. */
export function useWorkingNow(events: readonly Activity[]) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const current = workingNow(events);
  const expiresAt = current.length
    ? Math.min(...current.map((item) => item.at)) + activityWindowMs + 1
    : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timeout = setTimeout(refresh, Math.max(0, expiresAt - Date.now()));
    return () => {
      clearTimeout(timeout);
    };
  }, [expiresAt]);
  return current;
}

function areaOf(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : path;
}

export function WorkingNow({
  events,
  colors,
}: {
  events: readonly Activity[];
  colors: AgentColors;
}) {
  const working = useWorkingNow(events);
  if (working.length === 0) return null;
  return (
    <ul className="bonsai-working">
      {working.map((item) => {
        const areas = [...new Set([...item.paths].map(areaOf))].slice(0, 4);
        return (
          <li key={item.agent} data-agent-slot={colors.get(item.agent)?.color}>
            <AgentMark name={item.agent} colors={colors} />
            <div>
              <p>
                <AgentName name={item.agent} colors={colors} />{" "}
                <span className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
                  on
                </span>{" "}
                <span className="font-mono text-sm bonsai-ref">
                  {item.repo.includes("--") ? `${item.agent}/` : ""}
                  {item.ref}
                </span>
              </p>
              <p className="text-xs bonsai-working-areas">
                {areas.map((area) => (
                  <code key={area}>{area}</code>
                ))}
              </p>
            </div>
            <time className="text-xs text-[var(--stipe-fg-muted)] bonsai-feed-time">
              {relativeTime(item.at)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
import { useEffect, useReducer } from "react";
