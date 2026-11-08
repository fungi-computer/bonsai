import { createContext, useContext, type ReactNode } from "react";
import type { AppPermissions } from "@fungi.computer/agar";

/** Whether Bonsai may save repositories; `unknown` on hosts that do not say. */
export type GitAccess = "granted" | "missing" | "unknown";

/** Bonsai's writes need Git and event access together. */
export function gitAccessOf(
  permissions: AppPermissions | undefined,
): GitAccess {
  const git = permissions?.["git.repository"];
  const events = permissions?.["app.events.emit"];
  if (git === "missing" || events === "missing") return "missing";
  return git === "granted" && events === "granted" ? "granted" : "unknown";
}

const GitAccessContext = createContext<GitAccess>("unknown");

export function HostGitAccess({
  permissions,
  children,
}: {
  permissions: AppPermissions | undefined;
  children?: ReactNode;
}) {
  return (
    <GitAccessContext.Provider value={gitAccessOf(permissions)}>
      {children}
    </GitAccessContext.Provider>
  );
}

/** The host's published grant state for Git and events, from the live context. */
export function useHostGitAccess(): GitAccess {
  return useContext(GitAccessContext);
}
