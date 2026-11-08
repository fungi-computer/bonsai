/** Commands a person can paste into a shell to reach one Bonsai repository. */

export type GitCommands = {
  /** Sets the owner key the Git door checks; run once in the folder Oyster started from. */
  key: string;
  clone: string;
  push: string;
};

const authedGit =
  'git -c http.extraHeader="Authorization: Bearer $OYSTER_OWNER_KEY"';

/**
 * Copy-ready commands that carry the credential the Git door requires. The
 * clone URL is the one the host produced for this Oyster.
 */
export function gitCommands(cloneUrl: string, branch: string): GitCommands {
  return {
    key: "export OYSTER_OWNER_KEY=$(cat .oyster-owner)",
    clone: `${authedGit} clone ${cloneUrl}`,
    push: `${authedGit} push ${cloneUrl} HEAD:${branch}`,
  };
}
