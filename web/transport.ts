/**
 * How the UI reaches Bonsai's App methods: agar's `app.methods` capability
 * through the host's admitted method route. Only the host attributes a call.
 */
import { appsOpen, type AppRoleChoice } from "@fungi.computer/agar/apps";
import { AppError, type AppRoot } from "@fungi.computer/agar";
import { appMethods } from "@fungi.computer/agar/backend";
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

export type Connection = Readonly<{
  capabilities: AppRoot["capabilities"];
  /** The host's permission request, when this host can ask on Bonsai's behalf. */
  ui?: Pick<AppRoot["ui"], "requestAppPermissions"> | undefined;
}>;

let connection: Connection | null = null;

/** Remember the host connection mountApp handed over (null outside a host). */
export function connect(app: Connection | null): void {
  connection = app;
}

/** What the person answered when Bonsai asked the host for Git access. */
export type GitAccessOutcome =
  "granted" | "declined" | "customize" | "unavailable";

/** Ask the host's consent sheet for the rights Bonsai's writes need. */
export async function requestGitAccess(): Promise<GitAccessOutcome> {
  const ui = connection?.ui;
  if (ui === undefined) return "unavailable";
  return ui.requestAppPermissions({
    git: ["git.repository"],
    events: ["app.events.emit"],
  });
}

/** A write the host refused because Bonsai has not been given that permission. */
export function isPermissionDenied(error: Error): boolean {
  return error instanceof ApiError && error.status === 403;
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
  // The host applies each method's effect and supplies caller identity.
  const capabilities = connection.capabilities;
  let result;
  try {
    result = await capabilities
      .require(appMethods)
      .call(method, JSON.stringify(input));
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
