import { useEffect, useRef, useState } from "react";
import { Button } from "@fungi.computer/caps/components/button";
import { CopyField } from "@fungi.computer/caps/components/copy-field";
import { CountBadge } from "@fungi.computer/caps/components/count-badge";
import { Status } from "@fungi.computer/caps/components/status";
import { NavigationRail } from "@fungi.computer/caps/components/navigation-rail";
import {
  Popover,
  PopoverAnchor,
} from "@fungi.computer/caps/components/popover";
import { Select } from "@fungi.computer/caps/components/select";
import { inspectIssueTree } from "@fungi.computer/issues";
import type { RepoDetail } from "../shared/contract.js";
import { useIssueFiles } from "./api.js";
import { href, Link, useRouter, type Route } from "./router.js";

const sections = [
  ["overview", "Overview", "o"],
  ["code", "Code", "c"],
  ["commits", "History", "h"],
  ["changes", "Changes", "x"],
  ["issues", "Issues", "i"],
  ["settings", "Settings", "s"],
] as const;

function IssueCount({ repo, refName }: { repo: string; refName: string }) {
  const files = useIssueFiles(repo, refName);
  if (!files.data) return null;
  const count = inspectIssueTree(files.data.files).frontier.length;
  return count > 0 ? <CountBadge count={count} /> : null;
}

export function RepoNavigation({
  detail,
  route,
  working,
  changes,
  needsAttention,
  controlsTarget,
}: {
  detail: RepoDetail;
  route: Extract<Route, { page: "repo" }>;
  working: number;
  changes: number;
  needsAttention: boolean;
  controlsTarget: (element: HTMLDivElement | null) => void;
}) {
  const { go } = useRouter();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [copyRequest, setCopyRequest] = useState(0);
  const desktopClone = useRef<HTMLDivElement>(null);
  const phoneClone = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const cloneButton = useRef<HTMLButtonElement>(null);
  const refName = route.ref ?? detail.defaultBranch;
  const navigate = (tab: Extract<Route, { page: "repo" }>["tab"]) => {
    go(href({ ...route, tab, file: null, path: "" }));
  };
  useEffect(() => {
    let chordAt = 0;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input,textarea,select,[role=textbox]"))
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "escape" && cloneOpen) {
        setCloneOpen(false);
        cloneButton.current?.focus();
        return;
      }
      const section = sections.find((item) => item[2] === key);
      if (chordAt && Date.now() - chordAt < 1200 && section) {
        event.preventDefault();
        chordAt = 0;
        navigate(section[0]);
      } else if (key === "g") chordAt = Date.now();
      else {
        chordAt = 0;
        if (key === "c") {
          event.preventDefault();
          if (matchMedia("(max-width: 767px)").matches) setCloneOpen(true);
          setCopyRequest((value) => value + 1);
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
    };
  });
  useEffect(() => {
    if (copyRequest === 0) return;
    const field = matchMedia("(max-width: 767px)").matches
      ? phoneClone.current
      : desktopClone.current;
    field?.querySelector("button")?.click();
  }, [copyRequest]);
  useEffect(() => {
    if (!cloneOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target)
      )
        setCloneOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [cloneOpen]);
  return (
    <>
      <header
        className="flex min-w-0 flex-wrap items-center gap-3"
        aria-label="Repository header"
      >
        <div className="flex min-w-0 flex-1 basis-full flex-wrap items-baseline gap-x-2 gap-y-1 md:basis-0">
          <Link to="/" className="text-sm text-[var(--stipe-fg-muted)]">
            Bonsai /
          </Link>
          <h1 className="caps-card-title">{detail.repo.name}</h1>
          {detail.repo.description ? (
            <p className="text-sm text-[var(--stipe-fg-muted)]">
              {detail.repo.description}
            </p>
          ) : null}
          {detail.repo.parent ? (
            <span className="text-sm text-[var(--stipe-fg-muted)]">
              fork of{" "}
              <Link
                to={href({
                  ...route,
                  repo: detail.repo.parent,
                  tab: "overview",
                })}
              >
                {detail.repo.parent}
              </Link>
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {working > 0 ? (
            <Status
              aria-label="Recent repository pushes"
              title="Pushed in the last 15 minutes"
              size="compact"
              appearance="chip"
              tone="neutral"
              label={`${String(working)} pushed recently`}
            />
          ) : null}
          <div className="w-32 shrink-0">
            <Select
              aria-label="Branch"
              className="w-32"
              value={refName}
              onChange={(event) => {
                go(
                  href({
                    ...route,
                    ref: event.target.value,
                    path: "",
                    file: null,
                  }),
                );
              }}
            >
              {detail.refs
                .filter((item) => item.name.startsWith("refs/heads/"))
                .map((item) => (
                  <option key={item.name} value={item.name.slice(11)}>
                    {item.name.slice(11)}
                  </option>
                ))}
            </Select>
          </div>
          <div className="hidden max-w-sm md:block" ref={desktopClone}>
            <CopyField value={detail.cloneUrl} label="Clone" />
          </div>
          <PopoverAnchor className="md:hidden" ref={anchor}>
            <Button
              ref={cloneButton}
              variant="outline"
              size="sm"
              aria-expanded={cloneOpen}
              aria-controls="repo-clone"
              onClick={() => {
                setCloneOpen(!cloneOpen);
              }}
            >
              Clone
            </Button>
            <Popover
              open={cloneOpen}
              side="bottom"
              id="repo-clone"
              className="w-72 max-w-[calc(100vw-2rem)]"
              role="region"
              aria-label="Clone repository"
            >
              <div ref={phoneClone}>
                <CopyField value={detail.cloneUrl} />
              </div>
            </Popover>
          </PopoverAnchor>
        </div>
      </header>
      <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <NavigationRail
          className="min-w-0 sm:flex-1"
          aria-label="Repository sections"
        >
          {sections.map(([tab, label, key]) => (
            <Link
              key={tab}
              className="inline-flex items-center gap-2"
              to={href({ ...route, tab, path: "", file: null })}
              aria-current={route.tab === tab ? "page" : undefined}
              title={`G ${key.toUpperCase()}`}
            >
              {label}
              {tab === "changes" && changes > 0 ? (
                <CountBadge
                  count={changes}
                  tone={needsAttention ? "warning" : "neutral"}
                />
              ) : null}
              {tab === "issues" ? (
                <IssueCount repo={route.repo} refName={refName} />
              ) : null}
            </Link>
          ))}
        </NavigationRail>
        <div
          className="self-end sm:self-auto"
          ref={controlsTarget}
          hidden={route.tab !== "overview"}
        />
      </div>
    </>
  );
}
