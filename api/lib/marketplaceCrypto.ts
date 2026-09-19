import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getMasterKey(): Buffer {
  const envKey = process.env.MARKETPLACE_MASTER_KEY;
  if (!envKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MARKETPLACE_MASTER_KEY environment variable is required in production");
    }
    logger.warn("MARKETPLACE_MASTER_KEY not set, using dev-only fallback. Set this env var!");
    return createHash("sha256").update("dev-only-insecure-marketplace-key").digest();
  }
  return createHash("sha256").update(envKey).digest();
}

function deriveKey(listingId: number): Buffer {
  const masterKey = getMasterKey();
  const listingSalt = createHash("sha256").update(String(listingId)).digest().slice(0, 16);
  const combined = Buffer.concat([masterKey, listingSalt]);
  return createHash("sha256").update(combined).digest();
}

interface EncryptedData {
  encrypted: string;
  iv: string;
}

function encryptPrompt(plainText: string, listingId: number): EncryptedData {
  const key = deriveKey(listingId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  // iv:authTag:encrypted
  const combined = `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  return {
    encrypted: combined,
    iv: iv.toString("hex"),
  };
}

export function decryptPrompt(encryptedData: string, listingId: number): string {
  const key = deriveKey(listingId);
  const parts = encryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted prompt format: expected iv:authTag:encrypted");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

// Encrypt all prompts in a pipeline template for marketplace listing
export function encryptPipelineSteps(
  steps: Array<{ systemPrompt: string; [key: string]: unknown }>,
  listingId: number,
): Array<{ agentIndex: number; encryptedPrompt: string; iv: string }> {
  return steps.map((step, index) => {
    const { encrypted, iv } = encryptPrompt(step.systemPrompt, listingId);
    return {
      agentIndex: index,
      encryptedPrompt: encrypted,
      iv,
    };
  });
}
