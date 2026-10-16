import * as z from "zod";

export const tileId = z.enum([
  "contributors",
  "actors",
  "ages",
  "churn",
  "calendar",
  "network",
  "live",
  "changes",
  "next",
  "readme",
]);
export type TileId = z.infer<typeof tileId>;
export const tileTitles = {
  contributors: "Contributors",
  actors: "Agents & people",
  ages: "Code age",
  churn: "File churn",
  calendar: "Contribution calendar",
  network: "Network",
  live: "Live",
  changes: "Changes",
  next: "Next up",
  readme: "README",
} satisfies Record<TileId, string>;
const placement = z.strictObject({
  id: tileId,
  col: z.int().min(0).max(3),
  row: z.int().min(0).max(48),
  w: z.int().min(1).max(4),
  h: z.int().min(1).max(4),
});
export const insightLayout = z.strictObject({
  view: z.literal("overview"),
  placements: z
    .array(placement)
    .max(10)
    .refine(
      (tiles) => new Set(tiles.map((tile) => tile.id)).size === tiles.length,
      "Each tile appears once",
    ),
});
export type InsightLayout = z.infer<typeof insightLayout>;
export const defaultLayout: InsightLayout = {
  view: "overview",
  placements: [
    { id: "network", col: 0, row: 0, w: 3, h: 2 },
    { id: "live", col: 3, row: 0, w: 1, h: 2 },
    { id: "changes", col: 0, row: 2, w: 2, h: 1 },
    { id: "actors", col: 2, row: 2, w: 1, h: 1 },
    { id: "next", col: 3, row: 2, w: 1, h: 1 },
    { id: "contributors", col: 0, row: 3, w: 2, h: 1 },
    { id: "readme", col: 2, row: 3, w: 2, h: 1 },
    { id: "calendar", col: 0, row: 4, w: 4, h: 1 },
  ],
};
export const savedLayout = z.strictObject({ tiles: insightLayout.nullable() });

export const ageBandLabels = [
  "Under a week",
  "1–4 weeks",
  "1–3 months",
  "Over 3 months",
  "Before sample / unknown",
] as const;

export const codeInsights = z.strictObject({
  head: z.string().nullable(),
  commits: z.int().nonnegative(),
  /** First-parent history and a bounded sample of current text files. */
  files: z.array(
    z.strictObject({
      path: z.string(),
      lines: z.int().nonnegative(),
      changes: z.int().nonnegative(),
    }),
  ),
  /** Oldest-first first-parent snapshots, then today; current sampled paths only. */
  ageHistory: z.array(
    z.strictObject({
      at: z.number(),
      lines: z.array(z.int().nonnegative()).length(ageBandLabels.length),
    }),
  ),
  omittedFiles: z.int().nonnegative(),
  partial: z.boolean(),
});
export type CodeInsights = z.infer<typeof codeInsights>;
