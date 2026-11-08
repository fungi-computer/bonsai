/** The names Bonsai can hold: lowercase, digits, dots and dashes; no `--`. */
export const repoNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

/** Why a name cannot be used, in words a person can act on; null when it is fine. */
export function repoNameProblem(name: string): string | null {
  if (name === "") return "Give the repository a name.";
  if (name.includes("--"))
    return "Use single dashes; two in a row are reserved.";
  if (!repoNamePattern.test(name))
    return "Use lowercase letters, digits, dots and dashes, starting with a letter or digit.";
  return null;
}
