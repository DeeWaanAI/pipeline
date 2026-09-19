import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { User } from "@db/schema";
import { verifyLocalToken } from "./routers/localAuth";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { eq } from "drizzle-orm";
import { createRequestId } from "./lib/logger";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  user?: User | null;
  giteeToken?: string | null;
  requestId: string;
  /** Direct socket address of the connection (when available). Used for
   *  rate-limit IP resolution when TRUSTED_PROXY=false — see lib/clientIp. */
  remoteIp?: string;
};

export async function createContext(
  opts: FetchCreateContextFnOptions,
  remoteIp?: string,
): Promise<TrpcContext> {
  const ctx: TrpcContext = {
    req: opts.req,
    resHeaders: opts.resHeaders,
    giteeToken: opts.req.headers.get("x-gitee-token") || null,
    requestId: createRequestId(),
    remoteIp,
  };

  try {
    // Local auth (x-local-auth-token header)
    const localToken = opts.req.headers.get("x-local-auth-token");
    if (localToken) {
      const claim = await verifyLocalToken(localToken);
      if (claim) {
        const [user] = await getDb()
          .select()
          .from(users)
          .where(eq(users.id, claim.userId))
          .limit(1);
        if (user) {
          ctx.user = user;
          return ctx;
        }
      }
    }
  } catch {
    // Ignore auth errors — endpoints that need auth will reject via middleware
  }

  return ctx;
}
