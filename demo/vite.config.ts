import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = `${normalizePath(root).replace(/\/$/, "")}/`;

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  envDir: false,
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: fileURLToPath(new URL("../dist-demo", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  plugins: [
    react(),
    {
      name: "grounds-demo-source-boundary",
      transformIndexHtml(_html, context) {
        if (context.server) return [];
        return [{
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          },
          injectTo: "head-prepend",
        }];
      },
      moduleParsed({ id }) {
        const path = normalizePath(id);
        if (path.startsWith("\0") || path.includes("/node_modules/")) return;
        if (!path.startsWith(sourceRoot)) {
          this.error(`Demo builds may not import application or operational files: ${id}`);
        }
      },
    },
  ],
});
