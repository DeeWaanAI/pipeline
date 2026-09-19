import { describe, it, expect } from "vitest";
import {
  parseDatabaseUrl,
  escapeDefaultsValue,
  selectExpiredBackups,
  BACKUP_KEY_PREFIX,
} from "./backup";

describe("parseDatabaseUrl", () => {
  it("parses a standard mysql URL", () => {
    expect(parseDatabaseUrl("mysql://root:secret@db.internal:3306/railway")).toEqual({
      user: "root",
      password: "secret",
      host: "db.internal",
      port: 3306,
      database: "railway",
    });
  });

  it("percent-decodes credentials with special characters", () => {
    const creds = parseDatabaseUrl("mysql://root:p%23ss%2Fword%40x@host:3307/mydb");
    expect(creds.password).toBe("p#ss/word@x");
    expect(creds.port).toBe(3307);
  });

  it("defaults to port 3306 and strips query strings", () => {
    const creds = parseDatabaseUrl("mysql://u:p@host/mydb?ssl=false");
    expect(creds.port).toBe(3306);
    expect(creds.database).toBe("mydb");
  });

  it("rejects non-mysql URLs and missing parts", () => {
    expect(() => parseDatabaseUrl("postgres://u:p@h/db")).toThrow(/mysql:\/\/ scheme/);
    expect(() => parseDatabaseUrl("not-a-url")).toThrow(/not a valid URL/);
    expect(() => parseDatabaseUrl("mysql://:p@h/db")).toThrow(/user and database/);
    expect(() => parseDatabaseUrl("mysql://u:p@h/")).toThrow(/user and database/);
  });
});

describe("escapeDefaultsValue", () => {
  it("quotes and escapes option-file special characters", () => {
    expect(escapeDefaultsValue("plain")).toBe('"plain"');
    expect(escapeDefaultsValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe("selectExpiredBackups", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date("2026-07-19T03:00:00Z");

  it("selects only objects older than the retention window", () => {
    const objects = [
      { key: `${BACKUP_KEY_PREFIX}old.sql.gz`, lastModified: new Date(now.getTime() - 8 * day) },
      { key: `${BACKUP_KEY_PREFIX}fresh.sql.gz`, lastModified: new Date(now.getTime() - 2 * day) },
      { key: `${BACKUP_KEY_PREFIX}no-date.sql.gz` },
    ];
    expect(selectExpiredBackups(objects, now)).toEqual([`${BACKUP_KEY_PREFIX}old.sql.gz`]);
  });

  it("returns nothing when all backups are fresh", () => {
    const objects = [
      { key: `${BACKUP_KEY_PREFIX}a.sql.gz`, lastModified: new Date(now.getTime() - day) },
    ];
    expect(selectExpiredBackups(objects, now)).toEqual([]);
  });
});
