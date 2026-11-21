import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname),
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      input: resolve(__dirname, "index.html"),
      onwarn(warning, defaultHandler) {
        // zod ships /** @__PURE__ */-style comments Rollup can't place; the comments are safely dropped.
        if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("/node_modules/zod/")) {
          return;
        }
        defaultHandler(warning);
      },
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "assets/index.css" : "assets/[name][extname]",
      },
    },
  },
});
