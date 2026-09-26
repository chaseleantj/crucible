import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// `npm run dev:ui` serves this folder with hot reload and forwards data
// requests to a `crucible ui` already running on CRUCIBLE_UI_PORT. That server
// answers only requests addressed to itself, so the forwarded ones name it as
// their host and origin.
const api = `http://127.0.0.1:${process.env.CRUCIBLE_UI_PORT ?? "8300"}`;
const forward = { target: api, changeOrigin: true, headers: { origin: api } };

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [svelte()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
  server: { proxy: { "/api": forward, "/files": forward } },
});
