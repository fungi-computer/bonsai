/** Mutable read copies share one durable repository-ref readiness gate. */
import { readCopyFrame } from "./git.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import type { Bonsai } from "./service.js";
import type { RepoDetail } from "../shared/contract.js";

/** Local only: callers may not rebuild a mutable view from pending or missing refs. */
export function readRepositoryRefs(
  bonsai: Bonsai,
  repo: string,
): Omit<RepoDetail, "repo"> {
  if (bonsai.state.repo(repo) === null)
    throw new AppMethodRefusal("not_found", `No repository ${repo}`);
  const copy = bonsai.state.repositoryCopies.read(repo);
  if (bonsai.state.repositoryRefStatus(repo).pending || copy.kind !== "ready")
    throw new AppMethodRefusal(
      "unavailable",
      "Repository refs are rebuilding.",
    );
  return copy.value;
}

/** Foreground metadata publication uses the same revision as its provider read. */
export async function refreshRepositoryCopy(
  bonsai: Bonsai,
  name: string,
  signal: AbortSignal,
): Promise<RepoDetail> {
  const summary = bonsai.state.repo(name);
  if (summary === null)
    throw new AppMethodRefusal("not_found", `No repository ${name}`);
  const status = bonsai.state.repositoryRefStatus(name);
  const saved = bonsai.state.repositoryCopies.read(name);
  if (!status.pending && saved.kind === "ready")
    return { repo: summary, ...saved.value };
  const info = await bonsai.store.info(name);
  if (info === null)
    throw new AppMethodRefusal("not_found", "Repository storage is missing");
  const refs = await bonsai.store.refs(name);
  const value = {
    defaultBranch: info.defaultBranch,
    refs: refs.filter((ref) => ref.name !== "HEAD"),
    cloneUrl: await bonsai.store.cloneUrl(name),
    empty: refs.length === 0,
  };
  signal.throwIfAborted();
  if (
    !bonsai.state.publishRepositoryRefs(
      name,
      status.revision,
      refs.find((ref) => ref.name === `refs/heads/${info.defaultBranch}`)
        ?.hash ?? null,
      value,
    )
  )
    throw new AppMethodRefusal(
      "unavailable",
      "Repository refs changed during rebuild.",
    );
  return { repo: summary, ...value };
}

export async function getRepoDetail(
  bonsai: Bonsai,
  name: string,
): Promise<RepoDetail> {
  return readCopyFrame(bonsai.store, (store, signal) =>
    refreshRepositoryCopy({ ...bonsai, store }, name, signal),
  );
}
