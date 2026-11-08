import { CopyField } from "@fungi.computer/caps/components/copy-field";
import type { RepoDetail } from "../shared/contract.js";
import { gitCommands } from "./git-commands.js";

/** GitHub-style Quick setup for an empty repository: every line works as copied. */
export function QuickSetup({ detail }: { detail: RepoDetail }) {
  const commands = gitCommands(detail.cloneUrl, detail.defaultBranch);
  return (
    <div className="space-y-6" aria-label="Quick setup">
      <p>This repository is empty. Push your code to start it.</p>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">1. Use your owner key</h3>
        <p className="text-sm">
          Run this in the folder where you started Oyster. On a deployed Oyster,
          use the owner key you saved at setup.
        </p>
        <CopyField value={commands.key} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">2. Start from this repository</h3>
        <CopyField value={commands.clone} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          Or push a project you already have
        </h3>
        <p className="text-sm">Run this inside that project.</p>
        <CopyField value={commands.push} />
      </section>
    </div>
  );
}
