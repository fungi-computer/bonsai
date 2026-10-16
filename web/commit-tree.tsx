/** Newest-first history: topology in a narrow rail, readable commit links beside it. */
import { useEffect, useMemo, useRef } from "react";
import type { Graph, GraphNode } from "../shared/contract.js";
import { layoutGraph } from "./network-graph.js";
import { agentColor, relativeTime, shortHash } from "./format.js";
import { href, Link } from "./router.js";
import type { AgentColors } from "./parts.js";

export function verticalHistory(graph: Graph) {
  const layout = layoutGraph(graph, 1);
  const step = Math.min(20, 112 / Math.max(1, layout.lanes.length));
  const order = [...layout.order].reverse().map((item, row) => ({
    ...item,
    x: 12 + item.row * step,
    y: row * 62 + 20,
  }));
  return {
    order,
    byHash: new Map(order.map((item) => [item.node.hash, item])),
    home: layout.home,
    width: 24 + Math.max(0, layout.lanes.length - 1) * step,
  };
}

export function CommitTree({
  graph,
  colors,
  selected,
  onSelect,
}: {
  graph: Graph;
  colors: AgentColors;
  selected?: string | undefined;
  onSelect?: (node: GraphNode) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected)
      element.current
        ?.querySelector('[aria-current="true"]')
        ?.scrollIntoView({ block: "center" });
  }, [selected]);
  const tree = useMemo(() => verticalHistory(graph), [graph]);
  if (tree.order.length === 0)
    return (
      <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
        No commits yet.
      </p>
    );
  return (
    <div
      ref={element}
      className="bonsai-history"
      aria-label="Commit history, newest first"
    >
      <div className="bonsai-history-body" style={{ paddingLeft: tree.width }}>
        <svg
          className="bonsai-history-rail"
          width={tree.width}
          height={tree.order.length * 62}
          aria-hidden="true"
        >
          {tree.order.flatMap((child) =>
            child.node.parents.map((hash) => {
              const parent = tree.byHash.get(hash);
              return parent ? (
                <path
                  key={`${child.node.hash}:${hash}`}
                  d={`M ${String(child.x)} ${String(child.y)} C ${String(child.x)} ${String(child.y + 30)}, ${String(parent.x)} ${String(parent.y - 30)}, ${String(parent.x)} ${String(parent.y)}`}
                  fill="none"
                  stroke={agentColor(colors.get(child.node.agent ?? "")?.color)}
                  strokeWidth={2}
                />
              ) : (
                <path
                  key={`${child.node.hash}:${hash}`}
                  d={`M ${String(child.x)} ${String(child.y)} v 30`}
                  stroke="var(--stipe-fg-muted)"
                  strokeDasharray="3 3"
                >
                  <title>Parent outside this history sample</title>
                </path>
              );
            }),
          )}
          {tree.order.map((item) => (
            <circle
              key={item.node.hash}
              cx={item.x}
              cy={item.y}
              r={item.node.parents.length > 1 ? 5 : 4}
              fill={
                item.node.parents.length > 1
                  ? "var(--color-base-100)"
                  : agentColor(colors.get(item.node.agent ?? "")?.color)
              }
              stroke={agentColor(colors.get(item.node.agent ?? "")?.color)}
              strokeWidth={2}
            />
          ))}
        </svg>
        <ol className="bonsai-history-commits">
          {tree.order.map(({ node }) => {
            const lane = tree.home.get(node.hash);
            return (
              <li
                key={node.hash}
                className={
                  selected === node.hash
                    ? "bg-[var(--stipe-surface-selected)]"
                    : undefined
                }
              >
                <Link
                  onClick={(event) => {
                    if (
                      onSelect &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      event.button === 0
                    ) {
                      event.preventDefault();
                      onSelect(node);
                    }
                  }}
                  aria-current={selected === node.hash ? "true" : undefined}
                  to={href({
                    page: "commit",
                    repo: lane?.repo ?? graph.lanes[0]?.repo ?? "",
                    hash: node.hash,
                  })}
                >
                  <span className="min-w-0 truncate">{node.message}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--stipe-fg-muted)] bonsai-history-branch">
                    {lane?.owner ? `${lane.owner}/` : ""}
                    {lane?.ref}
                  </span>
                </Link>
                <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
                  <code>{shortHash(node.hash)}</code> ·{" "}
                  {node.agent ?? node.author} ·{" "}
                  {relativeTime(node.committedAt * 1000)}
                </p>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
