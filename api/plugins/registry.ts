/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PLUGIN REGISTRY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Central registry for all plugins. Each plugin is a self-contained unit with:
 * - ID and metadata
 * - tRPC router (optional)
 * - Feature flag key (for gating)
 *
 * To add a new plugin:
 *   1. Create folder under api/plugins/{pluginId}/
 *   2. Export a PluginManifest from index.ts
 *   3. Register it in the PLUGINS array below
 */

import type { AnyRouter } from "@trpc/server";

export interface PluginManifest {
  id: string;              // unique identifier (kebab-case)
  name: string;            // human-readable name
  description: string;     // what it does
  version: string;         // semver
  featureFlag: string;     // key in feature_flags table
  dependencies?: string[]; // other plugin IDs required
  router?: AnyRouter;      // tRPC routes (optional)
}

// ═════════════════════════════════════════════════════════════════════════════
// REGISTER PLUGINS HERE
// ═════════════════════════════════════════════════════════════════════════════

import { circuitBreakerPlugin } from "./circuit-breaker";

export const PLUGINS: PluginManifest[] = [
  circuitBreakerPlugin,
  // Add new plugins here...
];

// ═════════════════════════════════════════════════════════════════════════════
// Plugin helpers
// ═════════════════════════════════════════════════════════════════════════════

/** Get all plugin routers keyed by plugin ID */
export function getPluginRouters(): Record<string, AnyRouter> {
  const routers: Record<string, AnyRouter> = {};
  for (const plugin of PLUGINS) {
    if (plugin.router) {
      routers[plugin.id] = plugin.router;
    }
  }
  return routers;
}

/** Check if all dependencies are satisfied */
export function validateDependencies(): string[] {
  const pluginIds = new Set(PLUGINS.map((p) => p.id));
  const errors: string[] = [];

  for (const plugin of PLUGINS) {
    for (const dep of plugin.dependencies || []) {
      if (!pluginIds.has(dep)) {
        errors.push(`Plugin "${plugin.id}" requires missing dependency "${dep}"`);
      }
    }
  }

  return errors;
}
