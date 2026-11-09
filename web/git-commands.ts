/** Commands a person can paste into a shell to reach one Bonsai repository. */

export type GitCommands = {
  /** Puts the owner key in this shell, for pushing from a project folder. */
  key: string;
  /** Works as pasted in the folder where Oyster was started. */
  clone: string;
  /** Works once `key` has been run in the same shell. */
  push: string;
};

/**
 * A credential helper hands the key to Git's own Basic-auth challenge, which the
 * Git door already answers. The key is read inside the helper, so it is never in
 * the command line, the shell history or the process list. `.oyster-owner` is
 * where `oyster try` saves it; an exported OYSTER_OWNER_KEY wins, for a
 * deployed Oyster.
 */
function helper(key: string): string {
  return `git -c credential.helper='!f() { echo username=oyster; echo "password=${key}"; }; f'`;
}

/** Copy-ready commands; the clone URL is the one the host produced for this Oyster. */
export function gitCommands(cloneUrl: string, branch: string): GitCommands {
  return {
    key: "export OYSTER_OWNER_KEY=$(cat .oyster-owner)",
    clone: `${helper("${OYSTER_OWNER_KEY:-$(cat .oyster-owner)}")} clone ${cloneUrl}`,
    push: `${helper("$OYSTER_OWNER_KEY")} push ${cloneUrl} HEAD:${branch}`,
  };
}
