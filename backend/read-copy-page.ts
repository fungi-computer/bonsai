/** App-owned cursors select a page of a saved copy, without provider work. */
import * as z from "zod";
import type { JsonValue } from "../shared/contract.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";

const cursor = z.strictObject({
  version: z.literal(1),
  scope: z.string(),
  snapshot: z.string().nullable(),
  offset: z.number().int().nonnegative(),
});

export function readCopyPageOffset(
  after: string | undefined,
  scope: string,
  snapshot: string | null,
): number {
  if (after === undefined) return 0;
  let decoded: z.output<typeof cursor>;
  try {
    const bytes = Uint8Array.from(atob(after), (char) => char.charCodeAt(0));
    decoded = cursor.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new AppMethodRefusal("invalid", "Invalid saved-copy cursor.");
  }
  if (decoded.scope !== scope)
    throw new AppMethodRefusal("invalid", "Cursor belongs to another view.");
  if (decoded.snapshot !== snapshot)
    throw new AppMethodRefusal(
      "conflict",
      "The saved page changed; restart from the first page.",
    );
  return decoded.offset;
}

export function sliceReadCopyPage<T>(
  values: readonly T[],
  limit: number,
  offset: number,
  scope: string,
  snapshot: string | null,
) {
  if (offset > values.length)
    throw new AppMethodRefusal("invalid", "Cursor is outside the saved page.");
  const items = values.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const next =
    nextOffset < values.length
      ? btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(
              JSON.stringify(
                cursor.parse({
                  version: 1,
                  scope,
                  snapshot,
                  offset: nextOffset,
                }),
              ),
            ),
          ),
        )
      : null;
  return { items, next };
}

export async function copyListSnapshot(value: JsonValue): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
