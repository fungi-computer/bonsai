/** Small presentation helpers shared by Bonsai's views. */

const AGENT_COLOR = /^c[0-7]$/u;

/** An agent's palette slot as a CSS colour; unknown agents read as neutral ink. */
export function agentColor(slot: string | undefined): string {
  return slot !== undefined && AGENT_COLOR.test(slot)
    ? `var(--bonsai-agent-${slot})`
    : "var(--stipe-fg-muted)";
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * A readable stand-in for a human actor whose host-issued member id is the
 * only identity Bonsai has recorded; never show that raw id.
 */
export function shortActor(id: string): string {
  return `Member ${id.slice(-6)}`;
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const relative = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
  style: "narrow",
});

export function relativeTime(at: number, now = Date.now()): string {
  const delta = at - now;
  for (const [unit, size] of units)
    if (Math.abs(delta) >= size)
      return relative.format(Math.round(delta / size), unit);
  return "just now";
}

export function firstLine(message: string): string {
  return message.split("\n")[0] ?? "";
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
