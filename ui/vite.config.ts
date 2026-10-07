import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// UI-only build of the two extension pages. The output goes to ../popup and is committed, so the unpacked extension
// loads without Node or a build step. background.js, the content scripts and offscreen.js are not part of this build.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: path.resolve(import.meta.dirname, "../popup"),
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    target: "chrome120",
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        quick: path.resolve(import.meta.dirname, "quick.html"),
        popup: path.resolve(import.meta.dirname, "popup.html"),
      },
    },
  },
})
