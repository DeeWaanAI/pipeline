// ═══════════════════════════════════════════════════════════════════
//  SCHEDULED DB BACKUP SERVICE (Batch A)
// ═══════════════════════════════════════════════════════════════════
// Streams a full SQL dump of the database (schema + data + views + triggers),
// gzips it on the fly, and uploads it to the configured S3-compatible bucket
// under backups/ via a multipart upload. Everything is streamed, so memory stays
// bounded even though the dump is hundreds of MB; nothing touches local disk and
// no credential is ever placed on a command line.
//
// Why in-process via mysql2 rather than the mysqldump binary: Railway MySQL is
// MySQL 8 using caching_sha2_password, which the Alpine mariadb-client cannot
// complete (error 1045). mysql2 — the driver the app already uses — handles it,
// so the dump reuses the proven connection path and the image needs no MySQL
// client. The data dump runs inside START TRANSACTION WITH CONSISTENT SNAPSHOT
// (InnoDB), the equivalent of mysqldump --single-transaction: a consistent
// point-in-time copy that never blocks production writes.
//
// Triggered by POST /api/admin/backup (api/backup-route.ts), called daily by
// the GitHub Actions backup cron.
//
// Retention mirrors scripts/backup-db.sh: objects under backups/ older than
// 7 days are deleted after each successful upload.

import { createGzip } from "zlib";
import { PassThrough, Readable } from "stream";
import { pipeline } from "stream/promises";
import { createConnection } from "mysql2/promise";
import { escape, escapeId } from "mysql2";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

export const BACKUP_KEY_PREFIX = "backups/";
export const BACKUP_RETENTION_DAYS = 7;

export interface DbCredentials {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

export interface BackupResult {
  key: string;
  bytes: number;
  pruned: string[];
}

/** Parse mysql://user:pass@host:port/dbname (password may be percent-encoded). */
export function parseDatabaseUrl(url: string): DbCredentials {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error(`DATABASE_URL must use the mysql:// scheme, got ${parsed.protocol}`);
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!parsed.username || !database) {
    throw new Error("DATABASE_URL must include a user and database name");
  }
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 3306,
    database,
  };
}

/** Escape a value for a MySQL defaults file (option-file syntax). */
export function escapeDefaultsValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Keys whose LastModified is older than the retention window. */
export function selectExpiredBackups(
  objects: { key: string; lastModified?: Date }[],
  now: Date,
  retentionDays = BACKUP_RETENTION_DAYS,
): string[] {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return objects
    .filter((o) => o.lastModified && o.lastModified.getTime() < cutoff)
    .map((o) => o.key);
}

export function isBackupConfigured(): boolean {
  return !!(
    env.backupToken &&
    env.s3Bucket &&
    env.s3AccessKeyId &&
    env.s3SecretAccessKey &&
    env.databaseUrl
  );
}

async function s3Client() {
  // Lazy import so the ~10 MB SDK only loads when backups actually run.
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: env.s3Region || "auto",
    endpoint: env.s3Endpoint || undefined, // empty = AWS default
    forcePathStyle: !!env.s3Endpoint, // required by R2/MinIO
    credentials: {
      accessKeyId: env.s3AccessKeyId,
      secretAccessKey: env.s3SecretAccessKey,
    },
  });
}

function timestampKey(date = new Date()): string {
  const ts = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  return `${BACKUP_KEY_PREFIX}swarm-${ts}.sql.gz`;
}

/** Rows per multi-row INSERT (balances dump size against max_allowed_packet). */
const INSERT_BATCH = 50;

/** Stream a full SQL dump (schema + data + views + triggers) as incremental text
 *  chunks so memory stays bounded for large databases. Uses the app's own mysql2
 *  driver, which — unlike the Alpine mariadb-client — completes MySQL 8
 *  caching_sha2_password auth over Railway's private network. Data is read inside
 *  a consistent InnoDB snapshot (START TRANSACTION WITH CONSISTENT SNAPSHOT), the
 *  equivalent of mysqldump --single-transaction, so writes are never blocked. */
async function* dumpSql(creds: DbCredentials): AsyncGenerator<string> {
  const conn = await createConnection({
    host: creds.host,
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database: creds.database,
    // Return temporal/numeric/JSON columns as verbatim strings so values
    // round-trip exactly (no timezone drift, no BIGINT precision loss, no JSON
    // re-serialization) and escape() can quote them as plain literals.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    jsonStrings: true,
  });

  // jsonStrings already returns JSON columns as strings, but guard anyway: any
  // residual object/array is JSON-stringified first, because escape() would
  // otherwise render a plain object as a `k = v` SET clause rather than a value.
  const esc = (v: unknown): string =>
    v !== null && typeof v === "object" && !Buffer.isBuffer(v)
      ? escape(JSON.stringify(v))
      : escape(v);

  try {
    yield "-- DeeWaanAI database dump (streamed in-process via mysql2)\n";
    yield `-- Generated: ${new Date().toISOString()}\n`;
    yield `-- Database: ${creds.database}\n`;
    yield "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n\n";

    const [tables] = await conn.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      [creds.database],
    );
    const [views] = await conn.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [creds.database],
    );

    await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");

    // The promise wrapper exposes the underlying connection for row streaming.
    const core = (conn as unknown as {
      connection: { query(sql: string): { stream(): AsyncIterable<Record<string, unknown>> } };
    }).connection;

    for (const { TABLE_NAME: name } of tables as Array<{ TABLE_NAME: string }>) {
      const id = escapeId(name);
      const [ct] = await conn.query(`SHOW CREATE TABLE \`${name}\``);
      yield (ct as Array<Record<string, string>>)[0]["Create Table"] + ";\n";

      let cols: string | null = null;
      let batch: string[] = [];
      for await (const row of core.query(`SELECT * FROM \`${name}\``).stream()) {
        if (cols === null) cols = Object.keys(row).map((k) => escapeId(k)).join(", ");
        batch.push("(" + Object.values(row).map(esc).join(", ") + ")");
        if (batch.length >= INSERT_BATCH) {
          yield `INSERT INTO ${id} (${cols}) VALUES\n${batch.join(",\n")};\n`;
          batch = [];
        }
      }
      if (batch.length > 0 && cols !== null) {
        yield `INSERT INTO ${id} (${cols}) VALUES\n${batch.join(",\n")};\n`;
      }
      yield "\n";
    }

    await conn.query("COMMIT");

    // Views are created after the tables they reference.
    for (const { TABLE_NAME: name } of views as Array<{ TABLE_NAME: string }>) {
      const [cv] = await conn.query(`SHOW CREATE VIEW \`${name}\``);
      const def = (cv as Array<Record<string, string>>)[0]["Create View"];
      if (def) yield def + ";\n";
    }

    const [triggers] = await conn.query(
      "SELECT TRIGGER_NAME FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
      [creds.database],
    );
    for (const { TRIGGER_NAME: tn } of triggers as Array<{ TRIGGER_NAME: string }>) {
      const [tc] = await conn.query(`SHOW CREATE TRIGGER \`${tn}\``);
      const stmt = (tc as Array<Record<string, string>>)[0]["SQL Original Statement"];
      if (stmt) yield `DELIMITER ;;\n${stmt};;\nDELIMITER ;\n`;
    }

    yield "SET FOREIGN_KEY_CHECKS=1;\n";
  } finally {
    await conn.end();
  }
}

/** Dump the database, upload to S3, prune expired backups. Never throws on
 *  pruning failures — a successful dump must not be reported as failed. */
export async function runBackup(): Promise<BackupResult> {
  const creds = parseDatabaseUrl(env.databaseUrl);
  const key = timestampKey();

  logger.info("Backup: starting database dump", { host: creds.host, database: creds.database });

  const s3 = await s3Client();
  const { Upload } = await import("@aws-sdk/lib-storage");
  const { HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } =
    await import("@aws-sdk/client-s3");

  // Stream SQL -> gzip -> multipart S3 upload. Memory stays bounded (a few
  // partSize buffers in flight) no matter how large the dump grows.
  const gzOut = new PassThrough();
  const upload = new Upload({
    client: s3,
    params: { Bucket: env.s3Bucket, Key: key, Body: gzOut, ContentType: "application/gzip" },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
  });
  const uploaded = upload.done();
  uploaded.catch(() => {}); // avoid an unhandled rejection if the pipeline errors first
  await pipeline(Readable.from(dumpSql(creds)), createGzip(), gzOut);
  await uploaded;

  const head = await s3.send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key }));
  const bytes = head.ContentLength ?? 0;
  logger.info("Backup: uploaded", { key, bytes });

  // Retention: delete backups older than BACKUP_RETENTION_DAYS (best-effort).
  const pruned: string[] = [];
  try {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: env.s3Bucket, Prefix: BACKUP_KEY_PREFIX }),
    );
    const objects = (listed.Contents ?? [])
      .filter((o) => o.Key && o.Key.endsWith(".sql.gz"))
      .map((o) => ({ key: o.Key!, lastModified: o.LastModified }));
    const expired = selectExpiredBackups(objects, new Date());
    if (expired.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: env.s3Bucket,
          Delete: { Objects: expired.map((k) => ({ Key: k })) },
        }),
      );
      pruned.push(...expired);
      logger.info("Backup: pruned expired dumps", { count: expired.length });
    }
  } catch (err) {
    logger.warn("Backup: retention pruning failed (dump is safe in S3)", {
      error: (err as Error).message,
    });
  }

  return { key, bytes, pruned };
}
