import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The app build. The Worker's CSP forbids inline script and style, so the
// modulepreload polyfill (an inline script) is off and the built index.html is
// checked for inline code by workers/web/build.test.ts.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, modulePreload: { polyfill: false } },
});
