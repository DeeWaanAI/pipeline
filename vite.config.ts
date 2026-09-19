import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/|feedback-screenshots\/).*$/] }),
    inspectAttr(), react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split heavy vendors into stable, long-term-cacheable chunks.
        // Only packages that actually exist in package.json are matched.
        // NOTE: @radix-ui/* is intentionally NOT consolidated — it is mostly
        // used by lazy routes, and Rollup already auto-splits the shared
        // pieces; one radix chunk would be pulled into first load via
        // ui/button (react-slot) and inflate it by ~120 kB.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router/") ||
            id.includes("/scheduler/")
          ) {
            return "react";
          }
          if (
            id.includes("/@trpc/") ||
            id.includes("/@tanstack/") ||
            id.includes("/superjson/")
          ) {
            return "trpc";
          }
          if (
            id.includes("/i18next/") ||
            id.includes("/react-i18next/") ||
            id.includes("/i18next-browser-languagedetector/")
          ) {
            return "i18n";
          }
          if (id.includes("/lucide-react/")) return "icons";
        },
      },
    },
  },
});
