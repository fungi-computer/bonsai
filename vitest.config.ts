import { defineConfig } from "vitest/config";

/**
 * These files drive real `git` subprocesses (init, http-backend pushes, clones,
 * plumbing reads) through Agar's real-Git test kit. Each Git spawn costs a few
 * milliseconds idle and tens under CI load, so a test that is about 1 s on an
 * idle box crosses the 5 s default when the gate runs at several times
 * oversubscription. They get their own project and timeout; the fast unit
 * tests keep Vitest's default.
 */
const realGit = [
  "test/background-runtime.test.ts",
  "test/changes.test.ts",
  "test/file-edits.test.ts",
  "test/files-read-copy-calls.test.ts",
  "test/graph-commit-read-copy-calls.test.ts",
  "test/merge-background.test.ts",
  "test/merge-conflict.test.ts",
  "test/merge-repro.test.ts",
  "test/read-copy-composer.test.ts",
  "test/read-copy-lifetimes.test.ts",
  "test/repository-deletion.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: realGit,
          environment: "node",
        },
      },
      {
        test: {
          name: "real-git",
          include: realGit,
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
