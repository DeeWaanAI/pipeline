// `me` is the one auth procedure the SPA calls on every load, and it used to run
// a bare `select()` — so the browser was handed the row straight from the
// `users` table, bcrypt hash included. A hash the client can read can be cracked
// offline, and a token is exactly the thing an XSS or a shared browser profile
// leaves lying around. These tests pin what the endpoint may return; the shape
// login/signup already return by hand is the contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selected: unknown[] = [];
let row: Record<string, unknown> | null = null;

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: (columns?: unknown) => {
      selected.push(columns);
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                row
                  // The real driver sends back only the columns it was asked
                  // for; without this the fake would hand back the whole row
                  // and the projection would never be exercised.
                  ? [columns
                      ? Object.fromEntries(
                          Object.keys(columns as Record<string, unknown>).map((k) => [k, (row as Record<string, unknown>)[k]]),
                        )
                      : row]
                  : [],
              ),
          }),
        }),
      };
    },
  }),
}));

const { readSessionUser, signLocalToken, PUBLIC_USER_COLUMNS } = await import("./localAuth");

beforeEach(() => {
  selected.length = 0;
  row = null;
});

describe("what the session endpoint may return", () => {
  it("is exactly the four fields the client reads", async () => {
    row = {
      id: 7, username: "owner", name: "Owner", role: "user",
      passwordHash: "$2b$10$sixtyfourcharsofbcrypt",
      email: "owner@example.test", tier: "solo", preferences: { theme: "dark" },
      unionId: "u-1", defaultProviderId: 3, lastSignInAt: new Date(),
    };
    const token = await signLocalToken(7, "owner");
    const user = await readSessionUser(token);

    expect(user).toEqual({ id: 7, username: "owner", name: "Owner", role: "user" });
    expect(Object.keys(user ?? {})).not.toContain("passwordHash");
    expect(selected).toHaveLength(1);
  });

  it("asks the database for a column list that has no secret in it", async () => {
    const token = await signLocalToken(7, "owner");
    await readSessionUser(token);

    const columns = selected[0] as Record<string, { name?: string }>;
    expect(Object.keys(columns).sort()).toEqual(["id", "name", "role", "username"]);
    for (const [, column] of Object.entries(columns)) {
      expect(column.name).not.toMatch(/password|hash|secret|token/i);
    }
    expect(PUBLIC_USER_COLUMNS).not.toHaveProperty("passwordHash");
  });

  it("returns null for a token it cannot verify, without querying", async () => {
    row = { id: 7, username: "owner", name: "Owner", role: "user" };
    expect(await readSessionUser(null)).toBeNull();
    expect(await readSessionUser("not-a-jwt")).toBeNull();
    expect(selected).toHaveLength(0);
  });
});
