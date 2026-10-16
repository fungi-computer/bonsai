import { HomePage } from "./home-page.js";
import { ChangePage } from "./change-page.js";
import { mountApp, useWindowStatus } from "@fungi.computer/agar/react";
import type { AppRoot } from "@fungi.computer/agar";
import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import "@fungi.computer/caps/fonts.css";
import "./bonsai.css";
import { productName } from "../shared/contract.js";
import { useLive } from "./api.js";
import { CommitPage, RepoPage } from "./pages.js";
import { connect } from "./transport.js";
import { RouterProvider, useRouter } from "./router.js";

function Shell({ app }: { app: AppRoot | null }) {
  const { route } = useRouter();
  const live = useLive();
  // Bonsai's one status bar is the window footer: the Live/Connecting
  // readout goes there, the same way Shed and Inkcap report their state.
  useWindowStatus(app, [
    {
      kind: "text",
      id: "live",
      text: live.error ?? (live.connected ? "Live" : "Connecting"),
      tone:
        live.error !== null ? "error" : live.connected ? "success" : "neutral",
    },
  ]);
  return (
    <div className="caps-app-canvas bonsai-shell">
      <main className="bonsai-page">
        {route.page === "home" ? (
          <HomePage live={live} />
        ) : route.page === "repo" ? (
          <RepoPage key={route.repo} route={route} live={live} />
        ) : route.page === "change" ? (
          <ChangePage
            key={`${route.repo}:${String(route.number)}`}
            repo={route.repo}
            number={route.number}
          />
        ) : (
          <CommitPage repo={route.repo} hash={route.hash} />
        )}
      </main>
    </div>
  );
}

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const root = document.getElementById("bonsai-root");
if (!root) throw new Error("Bonsai's root element is missing");
mountApp(
  root,
  { name: productName, queryClient: client },
  ({ app, status }) => {
    if (status === "connecting") return null;
    connect(app);
    return (
      <StrictMode>
        <RouterProvider>
          <Shell app={app} />
        </RouterProvider>
      </StrictMode>
    );
  },
);
