import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Locale-scoped content (SPEC §5.5): entries are addressed as
// "<locale>/<slug>" — e.g. "en/selling", later "es/selling".
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number(),
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
  }),
});

export const collections = { docs, blog };
