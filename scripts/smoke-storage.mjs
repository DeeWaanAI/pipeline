#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE SMOKE — verifies the S3-backed screenshot upload path end to end.
// ═══════════════════════════════════════════════════════════════════════════════
//
// Prereqs:
//   1. An S3-compatible endpoint. Local MinIO:
//        docker run -d --name minio-smoke -p 9000:9000 \
//          -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
//          minio/minio server /data
//   2. App booted with the S3 env pointing at it:
//        S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 S3_BUCKET=uploads \
//        S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=minioadmin \
//        DATABASE_URL=... APP_ID=... APP_SECRET=... AI_SWARM_MASTER_KEY=... \
//        MARKETPLACE_MASTER_KEY=... NODE_ENV=production PORT=3120 node dist/boot.js
//
// Run:  node scripts/smoke-storage.mjs [baseUrl] [--keep]
// Env:  DATABASE_URL, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID,
//       S3_SECRET_ACCESS_KEY (same values the app was booted with)
//
// Asserts: signup → upload a real PNG → object lands in S3 (NOT on local
// disk) → authenticated GET returns byte-identical content → bogus signed URL
// rejected → fixtures cleaned (unless --keep).
// ═══════════════════════════════════════════════════════════════════════════════

import { S3Client, CreateBucketCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import mysql from "mysql2/promise";
import { readFileSync } from "fs";

const baseUrl = (process.argv[2] || "http://localhost:3120").replace(/\/$/, "");
const keep = process.argv.includes("--keep");
const required = ["DATABASE_URL", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`FAIL: ${name} must be set (same values the app was booted with)`);
    process.exit(1);
  }
}

// A real 1x1 PNG (67 bytes) — verified byte-for-byte on the way back.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const username = `storagesmoke${Date.now()}`;
let userId = null;
let objectKey = null;

try {
  // 0. Ensure bucket exists
  try {
    await s3.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
  } catch (err) {
    if (err.name !== "BucketAlreadyOwnedByYou" && err.name !== "BucketAlreadyExists") throw err;
  }

  // 1. Signup a throwaway user
  const signup = await fetch(`${baseUrl}/api/trpc/localAuth.signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: { username, password: "str0ng-pass-99" } }),
  }).then((r) => r.json());
  const token = signup?.result?.data?.json?.token;
  check("signup temp user", !!token);
  if (!token) throw new Error("no token — aborting");

  // 2. Upload the PNG through the app's endpoint
  const upload = await fetch(`${baseUrl}/api/upload-screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-local-auth-token": token },
    body: JSON.stringify({ image: `data:image/png;base64,${PNG_B64}` }),
  }).then((r) => r.json());
  const url = upload?.url;
  check("upload accepted", !!url, url);
  if (!url) throw new Error("no url — aborting");
  const filename = url.split("/").pop();
  objectKey = `feedback-screenshots/${filename}`;

  // 3. Object must exist in S3…
  let headOk = false;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }));
    headOk = head.ContentLength === PNG_BYTES.length;
  } catch { /* missing */ }
  check("object present in S3 with correct size", headOk, objectKey);

  // 4. …and must NOT be on local disk
  let onDisk = true;
  try {
    readFileSync(`./feedback-screenshots/${filename}`);
  } catch {
    onDisk = false;
  }
  check("object NOT written to local disk", !onDisk);

  // 5. Authenticated GET returns byte-identical content
  const get = await fetch(`${baseUrl}${url}`, { headers: { "x-local-auth-token": token } });
  const got = Buffer.from(await get.arrayBuffer());
  check("GET via auth header returns identical bytes", get.status === 200 && got.equals(PNG_BYTES),
    `${get.status}, ${got.length}B`);

  // 6. Bogus signed URL is rejected
  const bogus = await fetch(`${baseUrl}${url}?exp=99999999999999&sig=${"0".repeat(64)}`);
  check("bogus signed URL rejected (401)", bogus.status === 401);
} catch (err) {
  console.error("SMOKE ERROR:", err.message);
  process.exitCode = 1;
} finally {
  if (!keep) {
    try {
      if (objectKey) await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }));
      if (process.env.DATABASE_URL) {
        const conn = await mysql.createConnection(process.env.DATABASE_URL);
        await conn.execute("DELETE FROM users WHERE username = ?", [username]);
        await conn.end();
      }
      console.log("fixtures cleaned");
    } catch (err) {
      console.warn("cleanup warning:", err.message);
    }
  }
}

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? `\nSTORAGE SMOKE: ALL ${checks.length} CHECKS PASSED` : `\nSTORAGE SMOKE: ${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
