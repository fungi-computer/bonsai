/**
 * Bonsai's events: the public, versioned envelope Bonsai emits through its host
 * (the Oyster EVENTS binding) and the signatures that prove a delivery came
 * from Bonsai. Runtime-neutral (Web Crypto only), so any consumer can import it
 * to verify and parse a delivery.
 *
 * The body follows the Standard Webhooks payload shape (type, timestamp and
 * data). A standalone host delivers it as an HTTP POST signed with Standard
 * Webhooks headers (webhook-id, webhook-timestamp, webhook-signature) and,
 * for receivers built for other git hosts, X-Hub-Signature-256 (sha256=HEX of
 * the body), X-GitHub-Delivery and X-GitHub-Event. Bonsai-Signature
 * (t=SECONDS,v1=HEX of "SECONDS.BODY") is checked by `verifyHook` below.
 * A subscriber answers 2xx to accept; anything else is retried with backoff.
 */
import * as z from "zod";
import { activity, changeIdentity, type Activity } from "./contract.js";

export const hookSpec = "bonsai.event/v1";

/** Every Change delivery carries its stored proposal identity. */
const changeTypes = [
  "change.opened",
  "change.updated",
  "change.approved",
  "change.checks_requested",
  "change.checked",
  "change.merged",
  "change.conflicted",
  "change.closed",
] as const;
const gitTypes = ["git.push", "git.fork", "repo.created"] as const;
const eventData = z.strictObject({
  spec: z.literal(hookSpec),
  eventId: z.string(),
  repository: z.strictObject({
    name: z.string(),
    canonical: z.string(),
    cloneUrl: z.url(),
  }),
  actor: z.string(),
  activity,
});
const gitEnvelope = z.strictObject({
  type: z.enum(gitTypes),
  timestamp: z.iso.datetime(),
  data: eventData,
});
const changeEnvelope = z.strictObject({
  type: z.enum(changeTypes),
  timestamp: z.iso.datetime(),
  data: eventData.extend({ change: changeIdentity }),
});
export const hookEvent = z.discriminatedUnion("type", [
  gitEnvelope,
  changeEnvelope,
]);
export type HookEvent = z.infer<typeof hookEvent>;
export type HookEventType = HookEvent["type"];
/** The precise declared event schema comes from the same envelope owner. */
export function hookEventFor(type: HookEventType) {
  return type.startsWith("change.")
    ? changeEnvelope.extend({ type: z.literal(type) })
    : gitEnvelope.extend({ type: z.literal(type) });
}

const eventTypes = {
  push: "git.push",
  fork: "git.fork",
  merge: "change.merged",
  "merge.conflict": "change.conflicted",
  "repo.created": "repo.created",
  "change.opened": "change.opened",
  "change.updated": "change.updated",
  "change.approved": "change.approved",
  "change.checks_requested": "change.checks_requested",
  "change.checked": "change.checked",
  "change.closed": "change.closed",
} as const satisfies Record<Activity["type"], HookEventType>;
/** Build stable envelopes from committed activity; Change links identify the source repo. */
export function activityEnvelope(
  stored: Activity,
  repository: HookEvent["data"]["repository"],
): HookEvent {
  const identity = "change" in stored.data ? stored.data.change : null;
  const payload = {
    type: eventTypes[stored.type],
    timestamp: new Date(stored.at).toISOString(),
    data: {
      spec: hookSpec,
      eventId: `evt_${String(stored.id)}`,
      repository,
      actor: stored.actor,
      activity: stored,
    },
  };
  if (identity === null) return hookEvent.parse(payload);
  return hookEvent.parse({
    ...payload,
    data: { ...payload.data, change: identity },
  });
}

const MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith("whsec_")) return encoder.encode(secret);
  try {
    return Uint8Array.from(atob(secret.slice(6)), (char) => char.charCodeAt(0));
  } catch {
    return encoder.encode(secret);
  }
}

/**
 * The Standard Webhooks signature header value (`v1,<base64>`): HMAC-SHA256
 * of "id.timestamp.body", keyed by the decoded `whsec_` secret.
 */
export async function signStandardWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${id}.${String(timestamp)}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

/** The Bonsai-Signature header value for a body sent at `timestamp` (seconds). */
export async function signHook(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  return `t=${String(timestamp)},v1=${await hmac(secret, `${String(timestamp)}.${body}`)}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

const signatureParts = /^t=(\d+),v1=([0-9a-f]{64})$/u;

export type HookVerification =
  | Readonly<{ ok: true; event: HookEvent }>
  | Readonly<{ ok: false; reason: "signature" | "stale" | "shape" }>;

/** Verify a delivery's signature and freshness, then parse its body. */
export async function verifyHook(
  secret: string,
  body: string,
  header: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<HookVerification> {
  const match = signatureParts.exec(header ?? "");
  if (!match) return { ok: false, reason: "signature" };
  const [, stamp = "", digest = ""] = match;
  const timestamp = Number.parseInt(stamp, 10);
  if (Math.abs(now - timestamp) > MAX_SKEW_SECONDS)
    return { ok: false, reason: "stale" };
  const expected = await hmac(secret, `${stamp}.${body}`);
  if (!constantTimeEqual(expected, digest))
    return { ok: false, reason: "signature" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: "shape" };
  }
  const parsed = hookEvent.safeParse(json);
  return parsed.success
    ? { ok: true, event: parsed.data }
    : { ok: false, reason: "shape" };
}
