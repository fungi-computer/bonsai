import { Button } from "@fungi.computer/caps/components/button";
/**
 * The network: every branch of the canonical repository and every agent fork
 * as a lane, commits as beads coloured by the agent that pushed them, forks
 * peeling off and merges folding back. Time runs left to right; the graph fills
 * its width, zooms, pans, and new commits arrive with a pop.
 */
import { IconButton } from "@fungi.computer/caps/components/icon-button";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { Graph, GraphLane, GraphNode } from "../shared/contract.js";
import { agentColor, relativeTime, shortHash } from "./format.js";
import type { AgentColors } from "./parts.js";

const ROW = 52;
const PAD_X = 32;
const PAD_TOP = 34;
const AXIS = 34;
const LABEL_ROOM = 260;
const NARROW = 560;
const NARROW_LABEL_ROOM = 24;
const NARROW_MIN_FIT_STEP = 14;
const MIN_STEP = 18;
const MAX_FIT_STEP = 96;
const MIN_FIT_STEP = 34;
const LABEL_CHARS = 38;
const NARROW_LABEL_CHARS = 20;

export type Placed = Readonly<{
  node: GraphNode;
  x: number;
  y: number;
  row: number;
  column: number;
}>;

export type Lane = GraphLane & { readonly row: number };

/** Order commits so every parent precedes its children, oldest first. */
function topoOrder(nodes: readonly GraphNode[]): GraphNode[] {
  const byHash = new Map(nodes.map((node) => [node.hash, node]));
  const seen = new Set<string>();
  const ordered: GraphNode[] = [];
  const ascending = [...nodes].sort((a, b) => a.committedAt - b.committedAt);
  for (const start of ascending) {
    const stack: { node: GraphNode; next: number }[] = [
      { node: start, next: 0 },
    ];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      if (seen.has(top.node.hash) && top.next === 0) {
        stack.pop();
        continue;
      }
      const parentHash = top.node.parents[top.next];
      if (parentHash !== undefined) {
        top.next += 1;
        const parent = byHash.get(parentHash);
        if (parent && !seen.has(parent.hash))
          stack.push({ node: parent, next: 0 });
        continue;
      }
      stack.pop();
      if (!seen.has(top.node.hash)) {
        seen.add(top.node.hash);
        ordered.push(top.node);
      }
    }
  }
  return ordered;
}

/**
 * A commit lives on the lane of the repository it was first pushed to, so a
 * fork's work stays on the fork's lane after it is merged; otherwise on the
 * first lane that contains it.
 */
function homeLane(
  node: GraphNode,
  lanes: ReadonlyMap<string, Lane>,
): Lane | undefined {
  const own =
    node.origin === null
      ? undefined
      : node.lanes.find((id) => lanes.get(id)?.repo === node.origin);
  return lanes.get(own ?? node.lanes[0] ?? "");
}

export type GraphLayout = Readonly<{
  placed: ReadonlyMap<string, Placed>;
  order: readonly Placed[];
  lanes: readonly Lane[];
  home: ReadonlyMap<string, Lane>;
  step: number;
  width: number;
  height: number;
}>;

function laneY(row: number): number {
  return PAD_TOP + row * ROW;
}

export function layoutGraph(
  graph: Graph,
  step: number,
  labelRoom = LABEL_ROOM,
): GraphLayout {
  const lanes = graph.lanes.map((lane, row): Lane => ({ ...lane, row }));
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const placed = new Map<string, Placed>();
  const home = new Map<string, Lane>();
  const order: Placed[] = [];
  topoOrder(graph.nodes).forEach((node, column) => {
    const lane = homeLane(node, byId);
    const row = lane?.row ?? 0;
    if (lane) home.set(node.hash, lane);
    const item: Placed = {
      node,
      row,
      column,
      x: PAD_X + column * step,
      y: laneY(row),
    };
    placed.set(node.hash, item);
    order.push(item);
  });
  return {
    placed,
    order,
    lanes,
    home,
    step,
    width: PAD_X * 2 + Math.max(0, order.length - 1) * step + labelRoom,
    height: laneY(Math.max(0, lanes.length - 1)) + AXIS + 18,
  };
}

/** An SVG path from commands and coordinates. */
function path(...parts: readonly (string | number)[]): string {
  return parts.join(" ");
}

function edgePath(
  parent: Placed,
  child: Placed,
  merge: boolean,
  step: number,
): string {
  const { x: px, y: py } = parent;
  const { x: cx, y: cy } = child;
  if (py === cy) return path("M", px, py, "L", cx, cy);
  const bend = Math.min(Math.max(step, 30), cx - px);
  if (merge) {
    // Travel along the source lane, then fold into the target.
    const start = cx - bend;
    return path(
      "M",
      px,
      py,
      "L",
      start,
      py,
      "C",
      start + bend * 0.55,
      py,
      cx - bend * 0.45,
      cy,
      cx,
      cy,
    );
  }
  // Peel off right after the parent, then run along the new lane.
  const end = px + bend;
  return path(
    "M",
    px,
    py,
    "C",
    px + bend * 0.55,
    py,
    end - bend * 0.45,
    cy,
    end,
    cy,
    "L",
    cx,
    cy,
  );
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export type NetworkGraphProps = Readonly<{
  graph: Graph;
  colors: AgentColors;
  /** Commits that arrived while this page was open. */
  fresh: ReadonlySet<string>;
  onSelect: (node: GraphNode, lane: GraphLane) => void;
  onLaneSelect?: (lane: GraphLane) => void;
  laneDetails?: ReadonlyMap<string, string>;
  shortLabels?: boolean;
}>;

function useWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return undefined;
    setWidth(target.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return width;
}

export function NetworkGraph({
  graph,
  colors,
  fresh,
  onSelect,
  onLaneSelect,
  laneDetails,
  shortLabels = false,
}: NetworkGraphProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const width = useWidth(scroller);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [hover, setHover] = useState<Placed | null>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  const narrow = width > 0 && width < NARROW;
  const labelRoom = narrow ? NARROW_LABEL_ROOM : LABEL_ROOM;
  const labelChars = narrow ? NARROW_LABEL_CHARS : LABEL_CHARS;
  const columns = Math.max(1, graph.nodes.length - 1);
  const fitStep = Math.min(
    MAX_FIT_STEP,
    Math.max(
      narrow ? NARROW_MIN_FIT_STEP : MIN_FIT_STEP,
      (width - PAD_X * 2 - labelRoom) / columns,
    ),
  );
  const step = Math.max(MIN_STEP, fitStep * zoom);
  const layout = useMemo(
    () => layoutGraph(graph, step, labelRoom),
    [graph, step, labelRoom],
  );
  const heads = useMemo(() => {
    const byHead = new Map<string, Lane[]>();
    for (const lane of layout.lanes) {
      const list = byHead.get(lane.head) ?? [];
      list.push(lane);
      byHead.set(lane.head, list);
    }
    return byHead;
  }, [layout.lanes]);

  // Keep the newest work in view as history grows.
  const newest = graph.nodes[0]?.hash ?? "";
  const newestX = layout.order.at(-1)?.x ?? 0;
  useEffect(() => {
    const element = scroller.current;
    if (element)
      element.scrollTo({
        left: Math.max(0, newestX + labelRoom * 0.85 - element.clientWidth),
        behavior: "instant",
      });
  }, [newest, newestX, labelRoom, width]);

  const laneInk = (lane: GraphLane | undefined) => {
    const owner = lane?.owner ?? null;
    return owner === null
      ? "var(--stipe-fg-muted)"
      : agentColor(colors.get(owner)?.color);
  };
  const beadInk = (item: Placed) =>
    item.node.agent === null
      ? laneInk(layout.home.get(item.node.hash))
      : agentColor(colors.get(item.node.agent)?.color);

  type Edge = {
    key: string;
    d: string;
    ink: string;
    fresh: boolean;
    merge: boolean;
  };
  const edges: Edge[] = [];
  const forkPoints = new Set<string>();
  for (const child of layout.order) {
    child.node.parents.forEach((parentHash, index) => {
      const parent = layout.placed.get(parentHash);
      if (!parent) return;
      const merge = index > 0;
      if (!merge && parent.row !== child.row) forkPoints.add(parent.node.hash);
      edges.push({
        key: `${parentHash}-${child.node.hash}`,
        d: edgePath(parent, child, merge, layout.step),
        ink: laneInk(
          layout.home.get(merge ? parent.node.hash : child.node.hash),
        ),
        fresh: fresh.has(child.node.hash),
        merge,
      });
    });
  }
  // A fork with no commits of its own yet: a dashed stub off its base commit.
  const stubs: { key: string; d: string; ink: string }[] = [];
  for (const lane of layout.lanes) {
    const head = layout.placed.get(lane.head);
    if (!head || head.row === lane.row) continue;
    const y = laneY(lane.row);
    const reach = Math.max(layout.step, 30);
    stubs.push({
      key: lane.id,
      d: path(
        "M",
        head.x,
        head.y,
        "C",
        head.x + reach * 0.55,
        head.y,
        head.x + reach * 0.45,
        y,
        head.x + reach,
        y,
        "L",
        head.x + reach * 2,
        y,
      ),
      ink: laneInk(lane),
    });
  }

  // Select visible labels, including the final commit only when it fits.
  const ticks: { item: Placed; label: string }[] = [];
  const labels = new Set<string>();
  for (const item of layout.order) {
    const label = relativeTime(item.node.committedAt * 1000);
    const previous = ticks.at(-1);
    const margin = Math.max(32, label.length * 3.5);
    if (
      item.x - scrollLeft < margin ||
      item.x - scrollLeft > width - margin ||
      labels.has(label) ||
      (previous && item.x - previous.item.x < 110)
    )
      continue;
    ticks.push({ item, label });
    labels.add(label);
  }
  const axisY = layout.height - AXIS / 2 - 4;

  const select = (item: Placed) => {
    const lane = layout.home.get(item.node.hash);
    if (lane) onSelect(item.node, lane);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    drag.current = {
      x: event.clientX,
      left: event.currentTarget.scrollLeft,
      moved: false,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = event.clientX - state.x;
    if (Math.abs(delta) > 3) state.moved = true;
    event.currentTarget.scrollLeft = state.left - delta;
  };
  const endDrag = () => {
    drag.current = null;
  };

  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom((current) =>
          Math.min(
            4,
            Math.max(0.25, current * (event.deltaY < 0 ? 1.12 : 0.89)),
          ),
        );
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div className="bonsai-network">
      <div className="bonsai-network-tools" role="group" aria-label="Zoom">
        <IconButton
          aria-label="Zoom out"
          icon={<ZoomOut />}
          disabled={step <= MIN_STEP}
          onClick={() => {
            setZoom((current) => Math.max(0.25, current / 1.4));
          }}
        />
        <IconButton
          aria-label="Fit history"
          icon={<Maximize2 />}
          active={zoom === 1}
          onClick={() => {
            setZoom(1);
          }}
        />
        <IconButton
          aria-label="Zoom in"
          icon={<ZoomIn />}
          disabled={zoom >= 4}
          onClick={() => {
            setZoom((current) => Math.min(4, current * 1.4));
          }}
        />
      </div>
      <ol className="bonsai-network-gutter" style={{ height: layout.height }}>
        {layout.lanes.map((lane) => (
          <li
            key={lane.id}
            className="bonsai-network-lane"
            title={`${lane.repo}/${lane.ref}`}
          >
            <span
              className="bonsai-lane-swatch"
              style={{ background: laneInk(lane) }}
              aria-hidden="true"
            />
            {onLaneSelect ? (
              <Button
                variant="ghost"
                size="xs"
                className="h-auto min-w-max py-1"
                onClick={() => {
                  onLaneSelect(lane);
                }}
              >
                <span className="flex min-w-0 flex-col items-start">
                  <span className="max-w-full truncate">
                    {lane.owner ?? lane.repo} / {lane.ref}
                  </span>
                  <span className="text-xs text-[var(--stipe-fg-muted)]">
                    {laneDetails?.get(lane.repo)}
                  </span>
                </span>
              </Button>
            ) : (
              <>
                <span className="bonsai-lane-owner min-w-0 truncate">
                  {shortLabels
                    ? (lane.owner ?? lane.ref)
                    : (lane.owner ?? lane.repo)}
                </span>
                {!shortLabels ? (
                  <span className="bonsai-lane-ref">{lane.ref}</span>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ol>
      <div
        className="bonsai-network-scroll"
        ref={scroller}
        onScroll={(event) => {
          setScrollLeft(event.currentTarget.scrollLeft);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onClickCapture={(event) => {
          if (drag.current?.moved) event.stopPropagation();
        }}
      >
        <svg
          width={Math.max(layout.width, width)}
          height={layout.height}
          role="img"
          aria-label={`${String(graph.nodes.length)} commits across ${String(graph.lanes.length)} lanes`}
        >
          <g className="bonsai-network-tracks">
            {layout.lanes.map((lane) => (
              <line
                key={lane.id}
                x1={0}
                x2={Math.max(layout.width, width)}
                y1={laneY(lane.row)}
                y2={laneY(lane.row)}
              />
            ))}
          </g>
          <g className="bonsai-network-axis">
            {ticks.map(({ item, label }) => (
              <g key={item.node.hash}>
                <line x1={item.x} x2={item.x} y1={axisY - 14} y2={axisY - 9} />
                <text x={item.x} y={axisY + 4} textAnchor="middle">
                  {label}
                </text>
              </g>
            ))}
          </g>
          <g fill="none" strokeWidth={2.75} strokeLinecap="round">
            {stubs.map((stub) => (
              <path
                key={stub.key}
                d={stub.d}
                stroke={stub.ink}
                strokeDasharray="1 6"
              />
            ))}
            {edges.map((edge) => (
              <path
                key={edge.key}
                d={edge.d}
                stroke={edge.ink}
                pathLength={1}
                className={
                  edge.fresh ? "bonsai-edge bonsai-edge-fresh" : "bonsai-edge"
                }
                data-merge={edge.merge ? "" : undefined}
              />
            ))}
          </g>
          <g>
            {layout.order.map((item) => {
              const headLanes = heads.get(item.node.hash) ?? [];
              const isHead = headLanes.some((lane) => lane.row === item.row);
              const ink = beadInk(item);
              const merge = item.node.parents.length > 1;
              const isFresh = fresh.has(item.node.hash);
              const classes = ["bonsai-bead"];
              if (isFresh) classes.push("bonsai-bead-fresh");
              if (hover?.node.hash === item.node.hash)
                classes.push("bonsai-bead-active");
              return (
                <g
                  key={item.node.hash}
                  transform={path("translate(", item.x, item.y, ")")}
                  className={classes.join(" ")}
                  tabIndex={0}
                  role="button"
                  aria-label={`${item.node.message} by ${item.node.agent ?? item.node.author}`}
                  onPointerEnter={() => {
                    setHover(item);
                  }}
                  onPointerLeave={() => {
                    setHover(null);
                  }}
                  onFocus={() => {
                    setHover(item);
                  }}
                  onBlur={() => {
                    setHover(null);
                  }}
                  onClick={() => {
                    select(item);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      select(item);
                    }
                  }}
                >
                  {isHead ? (
                    <circle className="bonsai-bead-halo" r={13} fill={ink} />
                  ) : null}
                  {isFresh && isHead ? (
                    <circle
                      className="bonsai-recent-head"
                      r={10}
                      stroke={ink}
                      fill="none"
                    />
                  ) : null}
                  <circle r={16} fill="transparent" />
                  {forkPoints.has(item.node.hash) || merge ? (
                    <circle
                      className="bonsai-bead-ring"
                      r={isHead ? 12.5 : 10}
                      fill="none"
                      stroke={ink}
                      strokeWidth={1.5}
                    />
                  ) : null}
                  <circle
                    className="bonsai-bead-core"
                    r={isHead ? 8 : 6}
                    fill={merge ? "var(--color-base-100)" : ink}
                    stroke={ink}
                    strokeWidth={merge ? 3 : 0}
                  />
                  {isHead && !narrow ? (
                    <text className="bonsai-head-label" x={18} y={4}>
                      {clip(item.node.message, labelChars)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
        {hover ? (
          <div
            className="bg-neutral text-neutral-content rounded-box p-2 text-xs bonsai-network-tip"
            style={{ left: hover.x, top: hover.y + 22 }}
            role="tooltip"
          >
            <strong>{hover.node.message}</strong>
            <span>
              <i style={{ background: beadInk(hover) }} aria-hidden="true" />
              {hover.node.agent ?? hover.node.author} ·{" "}
              {shortHash(hover.node.hash)} ·{" "}
              {relativeTime(hover.node.committedAt * 1000)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
