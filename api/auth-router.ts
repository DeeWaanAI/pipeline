import { createRouter, publicQuery } from "./middleware";

export const authRouter = createRouter({
  me: publicQuery.query((opts) => {
    return opts.ctx.user ?? null;
  }),
  logout: publicQuery.mutation(() => {
    // Local auth tokens are client-managed (stored in memory/cookie).
    // Token blacklist could be added here for production.
    return { success: true };
  }),
});
