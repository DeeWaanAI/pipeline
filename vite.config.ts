import devServer from "@hono/vite-dev-server"
import { getRequestListener } from "@hono/node-server"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// The streamable-HTTP MCP transport hands the raw node request/response to the
// MCP SDK, so it needs Hono's `c.env.incoming`/`c.env.outgoing`. @hono/node-server
// passes those bindings as the SECOND argument of its fetch callback;
// @hono/vite-dev-server declares `async (request) => …`, discards it, and calls
// `app.fetch(request, {})` — which is why `/mcp` 500'd under `npm run dev` and
// only worked behind a built, separately-served process. This middleware re-attaches
// the bindings for `/mcp` alone, so development needs no build step and no second
// server. Registered before devServer() so it wins the route.
const MCP_ROUTE = /^\/mcp(\/|\?|$)/

function mcpNodeBindings(): Plugin {
  return {
    name: "mcp-node-bindings",
    configureServer(server) {
      const listener = getRequestListener(async (request, bindings) => {
        // Same specifier as devServer({entry}) so vite's SSR module graph returns
        // the one already-loaded app instance — a second copy would start a
        // second in-process pipeline worker.
        const { default: app } = await server.ssrLoadModule("api/boot.ts")
        return (app as { fetch: (r: Request, env: unknown) => Promise<Response> }).fetch(request, bindings)
      }, { overrideGlobalObjects: false })
      server.middlewares.use((req, res, next) => {
        if (!MCP_ROUTE.test(req.url ?? "")) return next()
        void listener(req as IncomingMessage, res as ServerResponse)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    mcpNodeBindings(),
    // Paths NOT listed here never reach the Hono app in dev: vite serves them
    // as the SPA instead. That silently made the MCP server untestable locally,
    // because /mcp, the OAuth endpoints and the RFC 8414 / 9728 discovery
    // documents all 404'd into index.html while the API looked fine. The OAuth
    // paths are listed by prefix, deliberately UNANCHORED: the consent page posts
    // to /oauth/authorize/confirm, so an end-of-string anchor leaves that request
    // with the SPA (404) and the user sees "Authorization failed" after clicking
    // Allow. /oauth/consent itself must NOT match — it is a REACT route
    // (src/pages/OAuthConsent.tsx).
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/|feedback-screenshots\/|mcp(\?|$)|mcp\/|oauth\/(authorize|token|register)|\.well-known\/).*$/] }),
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
