import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Screen, ScreenHeader } from "@fungi.computer/caps/components/surface";
import { Button } from "@fungi.computer/caps/components/button";
import { Grip, Maximize2, X } from "lucide-react";
import { Link } from "./router.js";
import {
  arrangeBento,
  applyBentoOps,
  useMaosaicoBento,
  type BentoPlacement,
  type BentoColumns,
} from "@fungi.computer/maosaico";

export type BoardTile = {
  id: string;
  title: string;
  status?: ReactNode;
  body: ReactNode;
  to?: string;
  /** Long documents grow their rows instead of acquiring a nested scroller. */
  autoHeight?: boolean;
};

function BonsaiTile({
  title,
  status,
  children,
  footer,
  autoHeight = false,
  to,
}: {
  title: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  autoHeight?: boolean;
  to: string | undefined;
}) {
  const surface = (
    <Screen className={autoHeight ? "min-w-0" : "flex h-full min-w-0 flex-col"}>
      <ScreenHeader title={<h2>{title}</h2>} status={status} />
      <div
        className={
          autoHeight ? "min-w-0 p-3" : "min-h-0 flex-1 overflow-auto p-3"
        }
      >
        {children}
      </div>
      {footer ? (
        <footer className="flex justify-between gap-2 p-3">{footer}</footer>
      ) : null}
    </Screen>
  );
  return to ? (
    <Link to={to} className="block">
      {surface}
    </Link>
  ) : (
    surface
  );
}

/** App content and order around Maosaico's measured geometry and interaction. */
export function BonsaiBoard({
  placements,
  tiles,
  phoneOrder,
  rowHeight = 168,
  columns: fixedColumns,
  editable = false,
  onChange,
  onRemove,
}: {
  placements: readonly BentoPlacement[];
  tiles: readonly BoardTile[];
  phoneOrder?: readonly string[];
  /** Minimum row height; zero packs fixed, measured content. */
  rowHeight?: number;
  columns?: BentoColumns;
  editable?: boolean;
  onChange?: (placements: readonly BentoPlacement[]) => void;
  onRemove?: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const columns = fixedColumns ?? (width < 560 ? 1 : width < 920 ? 2 : 4);
  const shown = useMemo(() => {
    const active = placements.filter((placement) =>
      tiles.some((tile) => tile.id === placement.id),
    );
    if (columns === 1 && phoneOrder?.length) {
      let row = 0;
      return [...active]
        .sort((a, b) => phoneOrder.indexOf(a.id) - phoneOrder.indexOf(b.id))
        .map((tile) => {
          const h = tile.h;
          const next = { ...tile, col: 0, row, w: 1, h };
          row += h;
          return next;
        });
    }
    return active.some((tile) => tile.col + tile.w > columns)
      ? arrangeBento(active, columns)
      : active;
  }, [placements, tiles, columns, phoneOrder]);
  const rowHeights = useMemo(() => {
    const rows: number[] = [];
    for (const tile of shown) {
      if (!tiles.find((item) => item.id === tile.id)?.autoHeight) continue;
      const measured = heights.get(tile.id);
      if (measured === undefined) continue;
      const last = tile.row + tile.h - 1;
      const earlier = Array.from(
        { length: tile.h - 1 },
        (_, i) => (rows[tile.row + i] ?? rowHeight) + 12,
      ).reduce((sum, h) => sum + h, 0);
      while (rows.length <= last) rows.push(rowHeight);
      rows[last] = Math.max(rows[last] ?? rowHeight, measured - earlier);
    }
    return rows;
  }, [shown, tiles, heights, rowHeight]);
  const binding = useMaosaicoBento({
    placements: shown,
    columns,
    width,
    rowHeight,
    rowHeights,
    gap: 12,
    enabled: editable,
    onChange: (ops) => {
      onChange?.(applyBentoOps(shown, ops, columns));
    },
  });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      setHeights((current) => {
        const next = new Map(current);
        let changed = false;
        for (const entry of entries) {
          const id = entry.target.parentElement?.dataset.tile;
          if (!id) continue;
          const height = Math.ceil(entry.target.getBoundingClientRect().height);
          if (next.get(id) !== height) {
            next.set(id, height);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    for (const child of element.children) {
      if (
        child instanceof HTMLElement &&
        tiles.find((tile) => tile.id === child.dataset.tile)?.autoHeight &&
        child.firstElementChild
      )
        observer.observe(child.firstElementChild);
    }
    return () => {
      observer.disconnect();
    };
  }, [tiles, width]);
  const height = Math.max(
    0,
    ...[...binding.frames.values()].map((frame) => frame.y + frame.height),
  );
  return (
    <div ref={container} className="relative min-w-0" style={{ height }}>
      {shown.map((placement) => {
        const tile = tiles.find((item) => item.id === placement.id);
        const frame = binding.frames.get(placement.id);
        if (!tile || !frame) return null;
        return (
          <div
            key={tile.id}
            data-tile={tile.id}
            className="absolute min-w-0"
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
            }}
          >
            <BonsaiTile
              title={tile.title}
              to={editable ? undefined : tile.to}
              autoHeight={tile.autoHeight ?? false}
              status={
                editable ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Remove ${tile.title}`}
                    onClick={() => onRemove?.(tile.id)}
                  >
                    <X size={14} />
                  </Button>
                ) : (
                  tile.status
                )
              }
              footer={
                editable ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      className="touch-none"
                      aria-label={`Move ${tile.title}`}
                      {...binding.bind(tile.id, "move")}
                    >
                      <Grip size={12} />
                      Move
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      className="touch-none"
                      aria-label={`Resize ${tile.title}`}
                      {...binding.bind(tile.id, "resize")}
                    >
                      <Maximize2 size={12} />
                      Resize
                    </Button>
                  </>
                ) : null
              }
            >
              {tile.body}
            </BonsaiTile>
          </div>
        );
      })}
    </div>
  );
}
