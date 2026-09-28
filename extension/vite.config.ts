import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// package.json is the only place the version lives; `pnpm release` bumps it.
function manifest(): Plugin {
  return {
    name: "toshoyna-manifest",
    generateBundle() {
      const { version } = JSON.parse(readFileSync("package.json", "utf8"));
      const source = JSON.parse(readFileSync("manifest.json", "utf8"));
      this.emitFile({ type: "asset", fileName: "manifest.json", source: JSON.stringify({ ...source, version }, null, 2) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), manifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        mirror: "mirror.html",
        float: "float.html",
        offscreen: "offscreen.html",
        permission: "permission.html",
        background: "src/background.ts",
        content: "src/content.ts",
      },
      output: {
        // The manifest references these by fixed name.
        entryFileNames: (chunk) => (chunk.name === "background" || chunk.name === "content" ? "[name].js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
