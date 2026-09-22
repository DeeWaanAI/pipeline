import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { customAgents } from "@db/schema";
import { eq, and } from "drizzle-orm";

// Pre-built agent templates, available to every account
const DEFAULT_TEMPLATES = [
  {
    name: "Builder",
    slug: "builder",
    role: "builder",
    systemPrompt: "You are a Builder agent. Create an initial, comprehensive response to the user's request. Focus on completeness and accuracy. Produce a well-structured draft that covers all aspects of the request.",
    description: "Creates the initial response/draft",
  },
  {
    name: "Critic",
    slug: "critic",
    role: "critic",
    systemPrompt: "You are a Critic agent. Review the provided output and identify weaknesses, errors, or areas for improvement. Be specific about what needs to change and why. Format your response with clear sections for different types of issues. End with an Overall Assessment: PASS, NEEDS_WORK, or MAJOR_REVISIONS.",
    description: "Identifies weaknesses and errors",
  },
  {
    name: "Refiner",
    slug: "refiner",
    role: "refiner",
    systemPrompt: "You are a Refiner agent. Improve the provided output based on the feedback. Address each point of criticism systematically. Produce a significantly improved version that maintains the original intent while fixing all identified issues.",
    description: "Improves output based on feedback",
  },
  {
    name: "Polisher",
    slug: "polisher",
    role: "polisher",
    systemPrompt: "You are a Polisher agent. Take the refined output and make it presentation-ready. Improve clarity, flow, formatting, and tone. Ensure the final output is professional, concise, and polished. This is the final quality check.",
    description: "Final quality check and polish",
  },
  {
    name: "Reviewer",
    slug: "reviewer",
    role: "reviewer",
    systemPrompt: "You are a Reviewer agent. Evaluate the provided output from a specific perspective. Check for accuracy, completeness, and alignment with requirements. Provide detailed, constructive feedback organized by category.",
    description: "Evaluates from specific perspective",
  },
  {
    name: "Translator",
    slug: "translator",
    role: "translator",
    systemPrompt: "You are a Translator agent. Translate the provided content accurately while preserving meaning, tone, and context. Ensure cultural appropriateness and maintain formatting. Provide the translation with notes on any ambiguities.",
    description: "Translates content to another language",
  },
  {
    name: "Summarizer",
    slug: "summarizer",
    role: "summarizer",
    systemPrompt: "You are a Summarizer agent. Compress the provided content into a concise summary while preserving all key points and important details. Maintain the original tone and intent. The summary should be at most 30% of the original length.",
    description: "Compresses long outputs",
  },
  {
    name: "Custom Agent",
    slug: "custom",
    role: "custom",
    systemPrompt: "You are a specialized agent. Follow your specific instructions to process the input and produce high-quality output.",
    description: "User-defined custom agent",
  },
];

export const customAgentRouter = createRouter({
  // List user's custom agents + templates
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const userAgents = await db
      .select()
      .from(customAgents)
      .where(eq(customAgents.userId, ctx.user.id));

    return {
      userAgents,
      templates: DEFAULT_TEMPLATES,
    };
  }),

  // Create a new custom agent (from template or scratch)
  create: authedQuery
    .input(z.object({
      name: z.string().min(1).max(100),
      slug: z.string().min(1).max(100),
      role: z.string().min(1).max(50),
      systemPrompt: z.string().min(1),
      description: z.string().optional(),
      defaultProviderId: z.number().optional(),
      defaultModel: z.string().optional(),
      temperature: z.string().optional(),
      maxTokens: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Check for duplicate slug
      const existing = await db
        .select()
        .from(customAgents)
        .where(and(eq(customAgents.userId, ctx.user.id), eq(customAgents.slug, input.slug)))
        .limit(1);
      if (existing[0]) throw new Error("An agent with this slug already exists");

      await db.insert(customAgents).values({
        userId: ctx.user.id,
        name: input.name,
        slug: input.slug,
        role: input.role,
        systemPrompt: input.systemPrompt,
        description: input.description ?? null,
        defaultProviderId: input.defaultProviderId ?? null,
        defaultModel: input.defaultModel ?? null,
        temperature: input.temperature ?? "0.7",
        maxTokens: input.maxTokens ?? 4096,
      });

      const [created] = await db
        .select()
        .from(customAgents)
        .where(and(eq(customAgents.userId, ctx.user.id), eq(customAgents.slug, input.slug)))
        .limit(1);

      return created;
    }),

  // Update an existing agent
  update: authedQuery
    .input(z.object({
      id: z.number(),
      name: z.string().optional(),
      systemPrompt: z.string().optional(),
      description: z.string().optional(),
      defaultProviderId: z.number().nullable().optional(),
      defaultModel: z.string().optional(),
      temperature: z.string().optional(),
      maxTokens: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const db = getDb();

      await db.update(customAgents)
        .set(data)
        .where(and(eq(customAgents.id, id), eq(customAgents.userId, ctx.user.id)));

      const [updated] = await db
        .select()
        .from(customAgents)
        .where(eq(customAgents.id, id))
        .limit(1);

      return updated;
    }),

  // Delete an agent
  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await getDb()
        .delete(customAgents)
        .where(and(eq(customAgents.id, input.id), eq(customAgents.userId, ctx.user.id)));
      return { success: true };
    }),
});
