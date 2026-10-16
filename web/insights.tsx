import { useState } from "react";
import { createPortal } from "react-dom";
import { BonsaiBoard, type BoardTile } from "./board.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { arrangeBento } from "@fungi.computer/maosaico";
import { Button } from "@fungi.computer/caps/components/button";
import { Select } from "@fungi.computer/caps/components/select";
import {
  defaultLayout,
  insightLayout,
  savedLayout,
  tileId,
  tileTitles,
  type InsightLayout,
  type TileId,
} from "../shared/insights.js";
import { callMethod } from "./transport.js";
import { Failure, Loading } from "./parts.js";

function Grid({
  repo,
  initial,
  definitions,
  controlsTarget,
}: {
  repo: string;
  initial: InsightLayout["placements"];
  definitions: BoardTile[];
  controlsTarget: HTMLElement | null;
}) {
  const client = useQueryClient();
  const [tiles, setTiles] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<Error | null>(null);
  const [add, setAdd] = useState<TileId>("contributors");
  const missing = tileId.options.filter(
    (id) =>
      !tiles.some((tile) => tile.id === id) &&
      definitions.some((tile) => tile.id === id),
  );
  const selectedAdd = missing.includes(add) ? add : missing[0];
  async function save() {
    setSaving(true);
    setError(null);
    try {
      await callMethod(
        "insights.layout.save",
        { repo, tiles: { view: "overview", placements: tiles } },
        savedLayout,
      );
      client.setQueryData(["insight-layout", repo], {
        tiles: { view: "overview", placements: tiles },
      });
      setSaved(tiles);
      setEditing(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause : new Error("Could not save layout"),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="bonsai-insights" aria-label="Repository overview">
      {controlsTarget
        ? createPortal(
            <div className="flex flex-wrap items-center gap-2 bonsai-insight-actions">
              {editing ? (
                <>
                  {selectedAdd ? (
                    <>
                      <Select
                        aria-label="Visualization to add"
                        value={selectedAdd}
                        onChange={(event) => {
                          setAdd(tileId.parse(event.target.value));
                        }}
                      >
                        {missing.map((id) => (
                          <option key={id} value={id}>
                            {tileTitles[id]}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => {
                          setTiles(
                            insightLayout.shape.placements.parse(
                              arrangeBento(
                                [
                                  ...tiles,
                                  {
                                    id: selectedAdd,
                                    col: 0,
                                    row: 48,
                                    w: 2,
                                    h: 1,
                                  },
                                ],
                                4,
                              ),
                            ),
                          );
                        }}
                      >
                        Add
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setTiles(defaultLayout.placements);
                    }}
                  >
                    Reset
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setTiles(saved);
                      setEditing(false);
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    loading={saving}
                    onClick={() => void save()}
                  >
                    Save layout
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  Arrange tiles
                </Button>
              )}
            </div>,
            controlsTarget,
          )
        : null}
      {editing ? (
        <p
          className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted"
          role="status"
        >
          Drag Move or Resize. With a handle focused, use arrow keys; Escape
          cancels a drag. Save keeps this layout for your account.
        </p>
      ) : null}
      {error ? <Failure error={error} /> : null}
      {tiles.length === 0 ? (
        <p className="text-sm text-[var(--stipe-fg-muted)] bonsai-muted">
          No tiles. Arrange tiles to add a visualization.
        </p>
      ) : null}
      <BonsaiBoard
        placements={tiles}
        tiles={definitions}
        phoneOrder={
          editing
            ? []
            : [
                "network",
                "live",
                "changes",
                "actors",
                "next",
                "readme",
                "contributors",
                "ages",
                "churn",
                "calendar",
              ]
        }
        editable={editing && !saving}
        onChange={(next) => {
          setTiles(
            insightLayout.shape.placements.parse(
              next.map((tile) => ({
                ...tile,
                col: Math.min(3, tile.col),
                row: Math.min(48, tile.row),
                w: Math.min(4, tile.w),
                h: Math.min(4, tile.h),
              })),
            ),
          );
        }}
        onRemove={(id) => {
          setTiles(tiles.filter((tile) => tile.id !== id));
        }}
      />
    </section>
  );
}

export function OverviewBoard({
  repo,
  definitions,
  controlsTarget,
}: {
  repo: string;
  definitions: BoardTile[];
  controlsTarget: HTMLElement | null;
}) {
  const layout = useQuery({
    queryKey: ["insight-layout", repo],
    queryFn: () => callMethod("insights.layout.get", { repo }, savedLayout),
    staleTime: Infinity,
  });
  if (layout.isPending) return <Loading label="Loading your layout" />;
  if (layout.isError)
    return (
      <Failure
        error={layout.error}
        retry={() => {
          void layout.refetch();
        }}
      />
    );
  return (
    <Grid
      key={repo}
      repo={repo}
      initial={(layout.data.tiles ?? defaultLayout).placements}
      definitions={definitions}
      controlsTarget={controlsTarget}
    />
  );
}
