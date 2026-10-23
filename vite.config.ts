import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fungiFaviconHref } from "@fungi.computer/sigils/favicon";

export default defineConfig({
  envDir: false,
  base: "./",
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "fungi-favicon",
      transformIndexHtml: () => [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/svg+xml",
            href: fungiFaviconHref,
          },
          injectTo: "head",
        },
      ],
    },
  ],
  build: {
    target: "es2022",
    outDir: fileURLToPath(new URL("./.botanical/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:8797", "/git": "http://127.0.0.1:8797" },
  },
});
