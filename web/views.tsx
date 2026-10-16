/**
 * Bonsai's file, diff, tree and Markdown views. Code and diffs are Pierre
 * (themed like Inkcap: Catppuccin latte/mocha by the page theme), the tree is
 * Pierre trees through Stipe's projection, and Markdown is TanStack Markdown
 * inside Caps Prose.
 */
import { Markdown as CapsMarkdown } from "@fungi.computer/caps/components/markdown";
import { pierreTreesStyle } from "@fungi.computer/stipe/pierre/trees";
import { getTheme, subscribeTheme } from "@fungi.computer/stipe/theme";
import { File as PierreFile, MultiFileDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "../shared/contract.js";

const DARK_THEMES = new Set([
  "mocha",
  "dark",
  "readout-night",
  "field-guide-night",
  "embed-dark",
  "phosphor",
]);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readThemeType(): "light" | "dark" {
  const theme = getTheme();
  if (theme !== null) return DARK_THEMES.has(theme) ? "dark" : "light";
  return matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Light or dark, following the page's Stipe theme or the reader's setting. */
function useThemeType(): "light" | "dark" {
  const [type, setType] = useState(readThemeType);
  useEffect(() => {
    const query = matchMedia(DARK_QUERY);
    const update = () => {
      setType(readThemeType());
    };
    query.addEventListener("change", update);
    const unsubscribe = subscribeTheme(update);
    return () => {
      query.removeEventListener("change", update);
      unsubscribe();
    };
  }, []);
  return type;
}

const pierreTheme = {
  dark: "catppuccin-mocha",
  light: "catppuccin-latte",
} as const;

export function FileView({ path, text }: { path: string; text: string }) {
  const themeType = useThemeType();
  const file = useMemo(() => ({ name: path, contents: text }), [path, text]);
  return (
    <div className="bonsai-pierre">
      <PierreFile
        file={file}
        options={{
          disableFileHeader: true,
          overflow: "scroll",
          themeType,
          theme: pierreTheme,
        }}
      />
    </div>
  );
}

export function DiffView({ file }: { file: FileDiff }) {
  const themeType = useThemeType();
  const oldFile = useMemo(
    () => ({ name: file.path, contents: file.oldText ?? "" }),
    [file.path, file.oldText],
  );
  const newFile = useMemo(
    () => ({ name: file.path, contents: file.newText ?? "" }),
    [file.path, file.newText],
  );
  if (file.oldText === null || file.newText === null)
    return (
      <section
        className="caps-card caps-card-surface bonsai-diff-file"
        aria-label={file.path}
      >
        <header>
          <span className="bonsai-diff-path">{file.path}</span>
        </header>
        <p className="bonsai-diff-note">
          {file.binary ? "Binary file" : "Too large to show"}
        </p>
      </section>
    );
  return (
    <section
      className="caps-card caps-card-surface bonsai-diff-file bonsai-pierre"
      aria-label={file.path}
      id={`file-${file.path}`}
    >
      <MultiFileDiff
        oldFile={oldFile}
        newFile={newFile}
        options={{
          diffStyle: "unified",
          overflow: "scroll",
          themeType,
          theme: pierreTheme,
        }}
      />
    </section>
  );
}

export type TreeProps = Readonly<{
  paths: readonly string[];
  active: string | null;
  onOpen: (path: string) => void;
}>;

/** The repository tree. Remount it (key) when the path set changes. */
export function RepoTree({ paths, active, onOpen }: TreeProps) {
  const open = useRef(onOpen);
  open.current = onOpen;
  const { model } = useFileTree({
    paths,
    itemHeight: 30,
    initialExpansion: 1,
    onSelectionChange(selected) {
      const path = selected[0];
      if (path !== undefined && !path.endsWith("/")) open.current(path);
    },
  });
  useEffect(() => {
    if (active !== null) model.focusPath(active);
  }, [model, active]);
  return (
    <FileTree
      model={model}
      className="bonsai-tree"
      style={pierreTreesStyle({ itemHeight: 30 })}
    />
  );
}

/** Markdown from a repository, rendered by the shared Caps component. */
export function Markdown({ text }: { text: string }) {
  return <CapsMarkdown className="bonsai-markdown">{text}</CapsMarkdown>;
}
