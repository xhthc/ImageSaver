import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Test-only bundle for test_ui_render.js: one IIFE with the real components and a development React (act() is available).
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  build: {
    outDir: path.resolve(import.meta.dirname, ".test-dist"),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: { entry: path.resolve(import.meta.dirname, "test/render-entry.tsx"), formats: ["iife"], name: "__UITest", fileName: () => "render-bundle.js" },
  },
})
