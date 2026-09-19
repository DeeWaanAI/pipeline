import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { logger } from "../lib/logger";

const ALGORITHM = "aes-256-gcm";
const LEGACY_ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const DEFAULT_ITERATIONS = 480000;

function deriveKey(password: string, salt: Buffer, iterations = DEFAULT_ITERATIONS): Buffer {
  return pbkdf2Sync(password, salt, iterations, KEY_LENGTH, "sha256");
}

export function encrypt(text: string, password: string): { encrypted: string; salt: string; iterations: number } {
  const salt = randomBytes(32);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt, DEFAULT_ITERATIONS);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  // salt:iv:authTag:encrypted (4-part GCM format)
  const result = `${salt.toString("hex")}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  return {
    encrypted: result,
    salt: salt.toString("hex"),
    iterations: DEFAULT_ITERATIONS,
  };
}

export function decrypt(encryptedData: string, password: string, _salt?: string, _iterations?: number): string {
  const parts = encryptedData.split(":");
  const iterations = _iterations ?? DEFAULT_ITERATIONS;

  // Detect format: 4 parts = GCM (new), 3 parts = CBC (legacy)
  if (parts.length === 4) {
    // GCM format: salt:iv:authTag:encrypted
    const [saltHex, ivHex, authTagHex, encrypted] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const key = deriveKey(password, salt, iterations);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  if (parts.length === 3) {
    // Legacy CBC format: salt:iv:encrypted
    const [saltHex, ivHex, encrypted] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const key = deriveKey(password, salt, iterations);

    const decipher = createDecipheriv(LEGACY_ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  throw new Error("Invalid encrypted data format");
}

export function getMasterKey(): string {
  const key = process.env.AI_SWARM_MASTER_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AI_SWARM_MASTER_KEY environment variable is required in production");
    }
    logger.warn("AI_SWARM_MASTER_KEY not set, using dev-only fallback. Set this env var!");
    return "dev-only-insecure-master-key";
  }
  return key;
}
