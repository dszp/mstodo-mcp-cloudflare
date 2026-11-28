import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The app build. The Worker's CSP forbids inline script and style, so the
// modulepreload polyfill (an inline script) is off and the built index.html is
// checked for inline code by workers/web/build.test.ts.
//
// The dev server (`npm run web:dev`) answers /bff/* and /auth/* from a fake
// BFF (src/app/dev/fake-bff.ts). It is imported only when serving, so a build
// never loads it.
export default defineConfig(async ({ command }) => {
  const plugins: PluginOption[] = [react()];
  if (command === "serve") plugins.push((await import("./src/app/dev/fake-bff.ts")).fakeBff());
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins,
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    build: { outDir: "dist", emptyOutDir: true, modulePreload: { polyfill: false } },
  };
});
