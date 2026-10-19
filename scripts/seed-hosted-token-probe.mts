// Probe: is the local .env APP_SECRET the hosted one? (mint a hosted JWT)
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const token = await new SignJWT({ userId: 1, username: "owner", type: "local" })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
  .sign(new TextEncoder().encode(env.APP_SECRET));
const res = await fetch("https://app.deewaanai.com/api/trpc/localAuth.me", {
  headers: { "x-local-auth-token": token },
});
const body = await res.json() as any;
console.log(res.status, JSON.stringify(body?.result?.data?.json ?? body?.error ?? body).slice(0, 150));
