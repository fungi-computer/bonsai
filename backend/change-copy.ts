/** Saved Change facts and immutable detail objects, independent of lifecycle commands. */
import type { ChangeRecord } from "../shared/contract.js";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import { treeDiff } from "./diff.js";
import {
  changeCopyKey,
  changeObjectsSchema,
  changeCopySchema,
} from "./state.js";
import {
  compareChange,
  projectionStore,
  type ChangeHistory,
} from "./history.js";
import type { Bonsai } from "./service.js";
import { gitStore } from "./git.js";

async function buildChangeCopy(
  runtime: Bonsai,
  row: ChangeRecord,
  history?: ChangeHistory,
) {
  const bonsai = { ...runtime, store: projectionStore(runtime) };
  const compared =
    history ??
    (await compareChange(
      bonsai.store,
      row.repo,
      row.sourceRepo,
      row.head,
      row.target,
    ));
  if (compared === null)
    throw new AppMethodRefusal("not_found", "The proposed head is missing");
  const origins = bonsai.state.origins(compared.aheadHashes);
  const [base, head] = await Promise.all([
    compared.base === null
      ? null
      : bonsai.store.commit(row.sourceRepo, compared.base),
    bonsai.store.commit(row.sourceRepo, row.head),
  ]);
  if (head === null)
    throw new AppMethodRefusal("not_found", "The proposed head is missing");
  const objects = changeObjectsSchema.parse({
    commits: compared.ahead.map((commit) => ({
      commit,
      agent: origins.get(commit.hash)?.agent ?? null,
    })),
    diff: await treeDiff(
      bonsai.store,
      row.sourceRepo,
      base?.treeHash ?? null,
      head.treeHash,
    ),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(objects));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const detailHash = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  bonsai.state.copies.putBlob(detailHash, bytes);
  return changeCopySchema.parse({
    target: row.target,
    base: compared.base,
    ahead: compared.ahead,
    aheadHashes: compared.aheadHashes,
    behind: compared.behind,
    headAuthors: [
      ...new Set([...origins.values()].map((origin) => origin.agent)),
    ],
    detailHash,
  });
}

export async function loadChangeCopy(
  bonsai: Bonsai,
  row: ChangeRecord,
  signal: AbortSignal,
) {
  const result = await bonsai.state.changeCopies.load(changeCopyKey(row), {
    git: bonsai.store.binding,
    signal,
    rebuild: async (git) => ({
      head: row.head,
      value: await buildChangeCopy({ ...bonsai, store: gitStore(git) }, row),
    }),
  });
  if (result.kind !== "ready")
    throw new AppMethodRefusal("unavailable", "Change copy is rebuilding.");
  return result.value;
}

/** Prepare immutable objects and actor-independent facts in a write/push frame. */
export async function refreshChangeCopy(
  bonsai: Bonsai,
  row: ChangeRecord,
  history?: ChangeHistory,
): Promise<void> {
  const value = await buildChangeCopy(bonsai, row, history);
  bonsai.state.changeCopies.write(changeCopyKey(row), row.head, value);
}
