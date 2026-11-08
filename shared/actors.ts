/** How Bonsai names a person it knows only by the host-issued member id. */

/** Whether a name is a host-issued member id rather than something readable. */
export function isMemberId(name: string): boolean {
  return /(?:^|_)member_[a-z0-9]+$/iu.test(name);
}

const pondWords = [
  "alder",
  "bramble",
  "cattail",
  "clover",
  "dragonfly",
  "fern",
  "heron",
  "iris",
  "juniper",
  "kingfisher",
  "lilypad",
  "marsh",
  "newt",
  "otter",
  "pebble",
  "reed",
  "sedge",
  "tadpole",
  "willow",
  "yarrow",
  "moss",
  "minnow",
  "lotus",
  "ripple",
  "frog",
  "maple",
  "birch",
  "cedar",
  "dew",
  "ember",
  "fable",
  "glade",
];

function hashOf(text: string): number {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value;
}

/**
 * The name a fork carries after `--`. A member id is never part of a repository
 * name: it becomes a short pond word picked from a hash of the id, so the same
 * member always gets the same word. `attempt` picks the next word when two
 * members land on the same one. A readable name is used as it is.
 */
export function forkOwnerSlug(name: string, attempt = 0): string {
  if (!isMemberId(name)) return name;
  const start = hashOf(name);
  const word = pondWords[(start + attempt) % pondWords.length] ?? "member";
  return attempt >= pondWords.length
    ? `${word}-${String(Math.floor(attempt / pondWords.length) + 1)}`
    : word;
}
