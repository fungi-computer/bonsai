import type { StatusTone } from "@fungi.computer/caps/components/status";
import type { Change } from "./contract.js";

/** The same App-owned status labels and tones serve lists and Gills. */
export function changeStatusLabel(status: Change["status"]): string {
  const label = status.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export const changeStatusTone = {
  conflict: "warning",
  "checks-failed": "error",
  "checks-running": "info",
  "needs-approval": "warning",
  ready: "success",
  merging: "info",
  merged: "success",
  closed: "neutral",
} as const satisfies Record<Change["status"], StatusTone>;

export { relativeTime } from "@fungi.computer/gills/presentation";
