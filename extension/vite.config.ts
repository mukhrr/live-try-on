import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        mirror: "mirror.html",
        background: "src/background.ts",
        content: "src/content.ts",
      },
      output: {
        // The manifest references these by fixed name.
        entryFileNames: (chunk) => (chunk.name === "mirror" ? "assets/[name]-[hash].js" : "[name].js"),
      },
    },
  },
});
