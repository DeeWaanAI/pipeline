// Object storage for user uploads (feedback screenshots).
//
// Two backends behind one tiny API — mirroring the queue/Redis stance:
//   - S3-compatible (AWS S3, Cloudflare R2, MinIO) when S3_BUCKET +
//     S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY are all set. Objects are always
//     PRIVATE: the app proxies reads/writes, so the auth + signed-URL gate in
//     feedback-screenshot-route.ts applies regardless of backend. We never
//     redirect to public or presigned URLs (the signed-URL scheme would be
//     bypassed by a second, unauthenticated URL).
//   - Local disk otherwise (dev/beta default; ephemeral on cloud hosts).
//
// Keys are bare filenames ("<id>.png"); the S3 backend prefixes them with
// "feedback-screenshots/" inside the bucket so other upload types can share
// the bucket later.

import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, join } from "path";
import { env } from "./env";
import { logger } from "./logger";

export interface StoredObject {
  body: Buffer;
  contentType?: string;
}

export interface StorageBackend {
  readonly kind: "disk" | "s3";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Null when the object does not exist (route maps this to 404). */
  get(key: string): Promise<StoredObject | null>;
}

// ─── Local disk backend ─────────────────────────────────────────────
class DiskStorage implements StorageBackend {
  readonly kind = "disk" as const;
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private pathFor(key: string): string {
    return join(this.baseDir, basename(key)); // basename strips traversal
  }

  async put(key: string, body: Buffer): Promise<void> {
    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }
    await writeFile(this.pathFor(key), body);
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      return { body: await readFile(this.pathFor(key)) };
    } catch {
      return null;
    }
  }
}

// ─── S3-compatible backend ──────────────────────────────────────────
const S3_KEY_PREFIX = "feedback-screenshots/";

class S3Storage implements StorageBackend {
  readonly kind = "s3" as const;
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client> | null = null;

  private async client() {
    // Lazy import so the ~10 MB SDK is only loaded when S3 is configured.
    if (!this.clientPromise) {
      this.clientPromise = import("@aws-sdk/client-s3").then(
        ({ S3Client }) =>
          new S3Client({
            region: env.s3Region || "auto",
            endpoint: env.s3Endpoint || undefined, // empty = AWS default
            forcePathStyle: !!env.s3Endpoint, // required by R2/MinIO
            credentials: {
              accessKeyId: env.s3AccessKeyId,
              secretAccessKey: env.s3SecretAccessKey,
            },
          }),
      );
    }
    return this.clientPromise;
  }

  private fullKey(key: string): string {
    return `${S3_KEY_PREFIX}${basename(key)}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await this.client();
    await s3.send(
      new PutObjectCommand({
        Bucket: env.s3Bucket,
        Key: this.fullKey(key),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await this.client();
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: env.s3Bucket, Key: this.fullKey(key) }),
      );
      const bytes = await res.Body!.transformToByteArray();
      return { body: Buffer.from(bytes), contentType: res.ContentType };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "NoSuchKey" || name === "NotFound" || name === "NoSuchBucket") return null;
      throw err; // real S3 failures surface as 500 via the route's catch
    }
  }
}

// ─── Backend selection (lazy singleton) ─────────────────────────────
let backend: StorageBackend | null = null;

export function isS3Configured(): boolean {
  return !!(env.s3Bucket && env.s3AccessKeyId && env.s3SecretAccessKey);
}

export function getStorage(): StorageBackend {
  if (!backend) {
    backend = isS3Configured() ? new S3Storage() : new DiskStorage(env.screenshotDir);
    logger.info("Storage backend selected", { kind: backend.kind });
  }
  return backend;
}
