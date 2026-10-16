/**
 * How the UI reaches Bonsai's App methods: agar's `app.methods` capability
 * when the host offers it, otherwise the admitted App backend. The host attributes every call
 * to the signed-in person.
 */
import { appsOpen, type AppRoleChoice } from "@fungi.computer/agar/apps";
import { AppError, type AppRoot } from "@fungi.computer/agar";
import { appBackend, appMethods } from "@fungi.computer/agar/backend";
import type * as z from "zod";
import { errorBody, jsonValue, type JsonValue } from "../shared/contract.js";
import {
  readCopyRebuilding,
  copyRebuildPage,
  filesNavigateIntent,
  filesRole,
} from "@fungi.computer/agar/roles/files";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let connection: Pick<AppRoot, "capabilities"> | null = null;

/** Remember the host connection mountApp handed over (null outside a host). */
export function connect(app: Pick<AppRoot, "capabilities"> | null): void {
  connection = app;
}

/** The Team's files-role App as the shell's role routing names it; null hides the entry. */
export async function filesEditor(): Promise<AppRoleChoice> {
  if (!connection?.capabilities.has(appsOpen)) return null;
  return connection.capabilities.require(appsOpen).role(filesRole);
}

/** Open the file in whichever App the Team chose for the files role. */
export async function editInFilesEditor(
  repository: string,
  branch: string,
  path: string,
): Promise<void> {
  if (connection === null)
    throw new ApiError(503, "Open Bonsai from an App host");
  await connection.capabilities.require(appsOpen).open({
    role: filesRole,
    intent: filesNavigateIntent({ repository, branch, path }),
  });
}

/** Call one App method and parse its result against the shared contract. */
export async function callMethod<S extends z.ZodType>(
  method: string,
  input: JsonValue,
  schema: S,
): Promise<z.infer<S>> {
  if (connection === null)
    throw new ApiError(503, "Open Bonsai from an App host such as Oyster");
  // Typed method calls let the host apply each method's effect (public
  // visitors may call read methods); hosts without them get the backend.
  const capabilities = connection.capabilities;
  let result;
  try {
    result = capabilities.has(appMethods)
      ? await capabilities
          .require(appMethods)
          .call(method, JSON.stringify(input))
      : await capabilities
          .require(appBackend)
          .request(JSON.stringify({ method, input }));
  } catch (error) {
    if (error instanceof AppError && error.code === "CAPABILITY_DENIED")
      throw new ApiError(403, "Sign in to this Oyster to do that");
    throw error;
  }
  if (readCopyRebuilding.safeParse(result).success) {
    let cursor: string | null = null;
    let page;
    do {
      page = await callMethod("rebuildCopies", { cursor }, copyRebuildPage);
      cursor = page.cursor;
    } while (!page.done);
    return callMethod(method, input, schema);
  }
  const failure = errorBody.safeParse(result);
  if (failure.success) throw new ApiError(400, failure.data.error);
  return schema.parse(jsonValue.parse(result));
}
