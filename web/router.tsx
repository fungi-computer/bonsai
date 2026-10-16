/**
 * App navigation stays in memory. Numbered Changes also accept a hash link
 * when the frame opens, or when its hash changes.
 */
import * as z from "zod";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

export type Route =
  | { page: "home" }
  | {
      page: "repo";
      repo: string;
      tab: "code" | "commits" | "changes" | "issues" | "overview" | "settings";
      ref: string | null;
      path: string;
      file: string | null;
      commit?: string;
    }
  | { page: "commit"; repo: string; hash: string }
  | { page: "change"; repo: string; number: number };

function parseRoute(path: string): Route {
  const location = new URL(path, "https://bonsai.local");
  if (location.hash.startsWith("#change/")) {
    const [kind, repo, rawNumber] = location.hash.slice(1).split("/");
    const number = z.coerce.number().int().positive().safeParse(rawNumber);
    if (kind === "change" && repo && number.success)
      return {
        page: "change",
        repo: decodeURIComponent(repo),
        number: number.data,
      };
    return { page: "home" };
  }
  const parts = location.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const [repo, section, hash] = parts;
  if (repo === undefined) return { page: "home" };
  if (section === "commit" && hash !== undefined)
    return { page: "commit", repo, hash };
  const tab = location.searchParams.get("tab");
  const route: Extract<Route, { page: "repo" }> = {
    page: "repo",
    repo,
    tab:
      tab === "commits" ||
      tab === "changes" ||
      tab === "issues" ||
      tab === "settings" ||
      tab === "overview"
        ? tab
        : tab === "insights"
          ? "overview"
          : tab === "code"
            ? "code"
            : "overview",
    ref: location.searchParams.get("ref"),
    path: location.searchParams.get("path") ?? "",
    file: location.searchParams.get("file"),
  };
  const commit = location.searchParams.get("commit");
  if (commit !== null) route.commit = commit;
  return route;
}

export function href(route: Route): string {
  if (route.page === "home") return "/";
  if (route.page === "commit")
    return `/${encodeURIComponent(route.repo)}/commit/${route.hash}`;
  if (route.page === "change")
    return `#change/${encodeURIComponent(route.repo)}/${String(route.number)}`;
  const params = new URLSearchParams();
  if (route.tab !== "overview") params.set("tab", route.tab);
  if (route.ref !== null) params.set("ref", route.ref);
  if (route.path !== "") params.set("path", route.path);
  if (route.file !== null) params.set("file", route.file);
  if (route.commit !== undefined) params.set("commit", route.commit);
  const query = params.toString();
  return `/${encodeURIComponent(route.repo)}${query ? `?${query}` : ""}`;
}

export type RouterValue = Readonly<{ route: Route; go: (to: string) => void }>;

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() =>
    location.hash.startsWith("#change/") ? location.hash : "/",
  );
  useEffect(() => {
    const changed = () => {
      setPath(location.hash.startsWith("#change/") ? location.hash : "/");
    };
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  const go = (to: string) => {
    setPath(to);
    scrollTo({ top: 0 });
  };
  return (
    <RouterContext.Provider value={{ route: parseRoute(path), go }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (value === null) throw new Error("Bonsai routes need a RouterProvider");
  return value;
}

export function Link({
  to,
  onClick,
  ...props
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { go } = useRouter();
  return (
    <a
      {...props}
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        go(to);
      }}
    />
  );
}
