import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { verifyLocalToken } from "./routers/localAuth";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";

// Supported MIME types and extensions for file upload
// We accept broadly — if we can extract text or it's an image, we handle it.
// NOTE: SVG is deliberately excluded — it can carry embedded scripts.
const SUPPORTED_IMAGE_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
];

const SUPPORTED_TEXT_TYPES = [
  // Plain text
  "text/plain", "text/markdown", "text/csv", "text/xml", "text/html",
  "text/css", "text/javascript", "text/x-python", "text/x-java", "text/x-c",
  "text/x-c++", "text/x-go", "text/x-rust", "text/x-ruby", "text/x-php",
  "text/x-swift", "text/x-kotlin", "text/x-scala", "text/x-r", "text/x-sh",
  "text/x-lua", "text/x-perl", "text/x-sql", "text/yaml", "text/x-yaml",
  "text/x-toml", "text/x-ini", "text/x-conf", "text/x-graphql",
  // Application types treated as text
  "application/json", "application/javascript", "application/typescript",
  "application/xml", "application/x-javascript", "application/yaml",
  "application/x-yaml", "application/toml", "application/graphql",
];

const SUPPORTED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
];

// Extensions that indicate a text/code file even with ambiguous MIME type
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf", ".sql", ".graphql", ".prisma",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".pyw", ".java", ".go", ".rs", ".c", ".cpp", ".cc", ".cxx",
  ".h", ".hpp", ".hxx", ".rb", ".erb", ".php", ".phtml",
  ".swift", ".kt", ".kts", ".scala", ".sc", ".r", ".rmd",
  ".m", ".mm", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1",
  ".lua", ".pl", ".pm", ".t", ".v", ".sv", ".vhd", ".vhdl",
  ".dart", ".elm", ".hs", ".lhs", ".ml", ".mli", ".fs", ".fsx",
  ".clj", ".cljs", ".edn", ".erl", ".hrl", ".ex", ".exs",
  ".cmake", ".make", ".dockerfile", ".tf", ".tfvars", ".hcl",
  ".gitignore", ".gitattributes", ".env", ".lock", ".log",
  ".diff", ".patch",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);
const DOCX_EXTENSIONS = new Set([".docx"]);

// Maximum sizes
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB — most vision APIs accept up to ~20MB
const MAX_TEXT_SIZE = 10 * 1024 * 1024; // 10MB for text/code files
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB for PDFs/DOCX
const MAX_TOTAL_TEXT_LENGTH = 30000; // Max characters to extract for LLM context

// ─── Auth helper for raw HTTP routes ──────────────────────────────
async function getAuthUser(req: Request) {
  // 1. Try local auth token
  const localToken = req.headers.get("x-local-auth-token");
  if (localToken) {
    const claim = await verifyLocalToken(localToken);
    if (claim) {
      const [user] = await getDb()
        .select()
        .from(users)
        .where(eq(users.id, claim.userId))
        .limit(1);
      if (user) return user;
    }
  }

  return null;
}

// ─── Get file extension from name ─────────────────────────────────
function getExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot >= 0 ? name.slice(lastDot).toLowerCase() : "";
}

// ─── Determine file category ──────────────────────────────────────
function categorizeFile(name: string, mimeType: string): "image" | "text" | "document" | "unknown" {
  const ext = getExtension(name);

  if (SUPPORTED_IMAGE_TYPES.includes(mimeType) || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (SUPPORTED_TEXT_TYPES.includes(mimeType) || mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return "text";
  if (SUPPORTED_DOCUMENT_TYPES.includes(mimeType) || PDF_EXTENSIONS.has(ext)) return "document";
  if (DOCX_EXTENSIONS.has(ext)) return "document";

  return "unknown";
}

// ─── Process image → dataUrl ──────────────────────────────────────
async function processImage(file: File): Promise<{ dataUrl: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_IMAGE_SIZE / 1024 / 1024}MB`);
  }

  const base64 = buffer.toString("base64");
  const mimeType = file.type || "application/octet-stream";
  return { dataUrl: `data:${mimeType};base64,${base64}` };
}

// ─── Process text file → text content ─────────────────────────────
async function processTextFile(file: File): Promise<{ textContent: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.length > MAX_TEXT_SIZE) {
    throw new Error(`Text file too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_TEXT_SIZE / 1024 / 1024}MB`);
  }

  // Try UTF-8 first, fall back to latin1
  let text: string;
  try {
    text = buffer.toString("utf-8");
    // Validate it's valid UTF-8 by checking for replacement characters
    if (text.includes("\uFFFD") && buffer.includes(0)) {
      text = buffer.toString("latin1");
    }
  } catch {
    text = buffer.toString("latin1");
  }

  // Truncate if too long for LLM context
  if (text.length > MAX_TOTAL_TEXT_LENGTH) {
    text = text.substring(0, MAX_TOTAL_TEXT_LENGTH) +
      `\n\n[... File truncated: ${file.name} has ${text.length} characters total. Only first ${MAX_TOTAL_TEXT_LENGTH} shown.]`;
  }

  return { textContent: text };
}

// ─── Process PDF → extract text ───────────────────────────────────
async function processPdf(file: File): Promise<{ textContent: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.length > MAX_DOCUMENT_SIZE) {
    throw new Error(`PDF too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB`);
  }

  try {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    let text = result.text || "";

    if (text.length > MAX_TOTAL_TEXT_LENGTH) {
      text = text.substring(0, MAX_TOTAL_TEXT_LENGTH) +
        `\n\n[... PDF truncated: ${file.name} has ${text.length} characters total. Only first ${MAX_TOTAL_TEXT_LENGTH} shown.]`;
    }

    return { textContent: text || `[Empty or image-based PDF: ${file.name}]` };
  } catch (err) {
    logger.error("[Upload] PDF parse failed", { error: (err as Error).message });
    throw new Error(`Failed to extract text from PDF "${file.name}". It may be a scanned/image-based PDF.`);
  }
}

// ─── Process DOCX → extract text ──────────────────────────────────
async function processDocx(file: File): Promise<{ textContent: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.length > MAX_DOCUMENT_SIZE) {
    throw new Error(`DOCX too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB`);
  }

  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    let text = result.value || "";

    if (text.length > MAX_TOTAL_TEXT_LENGTH) {
      text = text.substring(0, MAX_TOTAL_TEXT_LENGTH) +
        `\n\n[... DOCX truncated: ${file.name} has ${text.length} characters total. Only first ${MAX_TOTAL_TEXT_LENGTH} shown.]`;
    }

    return { textContent: text || `[Empty DOCX: ${file.name}]` };
  } catch (err) {
    logger.error("[Upload] DOCX parse failed", { error: (err as Error).message });
    throw new Error(`Failed to extract text from DOCX "${file.name}".`);
  }
}

// ─── Main upload route ────────────────────────────────────────────
export function registerUploadRoute(app: Hono<{ Bindings: HttpBindings }>) {
  app.post("/api/upload-file", async (c) => {
    // ─── Auth ───
    const user = await getAuthUser(c.req.raw);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ─── Parse multipart ───
    let file: File | undefined;
    try {
      const body = await c.req.parseBody({ all: false });
      const uploaded = body.file;
      if (!uploaded) {
        return c.json({ error: "No file provided" }, 400);
      }
      // In Hono Node.js adapter, uploaded files come as File objects
      file = uploaded as File;
    } catch (err) {
      logger.error("[Upload] Parse failed", { error: (err as Error).message });
      return c.json({ error: `Failed to parse upload: ${(err as Error).message}` }, 400);
    }

    if (!file || file.size === 0) {
      return c.json({ error: "Empty file" }, 400);
    }

    const name = file.name || "unnamed";
    const mimeType = file.type || "application/octet-stream";
    const size = file.size;

    // SVG is explicitly rejected — it can carry embedded scripts
    if (mimeType === "image/svg+xml" || getExtension(name) === ".svg") {
      logger.warn("[Upload] Rejected SVG upload", { userId: user.id, name, mimeType });
      return c.json({ error: "SVG files are not supported" }, 400);
    }

    logger.info("[Upload] File upload", { userId: user.id, name, mimeType, sizeBytes: size });

    // ─── Categorize and process ───
    const category = categorizeFile(name, mimeType);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      switch (category) {
        case "image": {
          const { dataUrl } = await processImage(file);
          return c.json({
            id, name, type: mimeType, size,
            dataUrl,
            category: "image",
          });
        }

        case "text": {
          const { textContent } = await processTextFile(file);
          return c.json({
            id, name, type: mimeType, size,
            textContent,
            category: "text",
          });
        }

        case "document": {
          const ext = getExtension(name);
          if (ext === ".pdf" || mimeType === "application/pdf") {
            const { textContent } = await processPdf(file);
            return c.json({
              id, name, type: mimeType, size,
              textContent,
              category: "document",
            });
          }
          if (ext === ".docx") {
            const { textContent } = await processDocx(file);
            return c.json({
              id, name, type: mimeType, size,
              textContent,
              category: "document",
            });
          }
          // Unknown document type — return metadata
          return c.json({
            id, name, type: mimeType, size,
            category: "document",
            textContent: `[Document: ${name} (${mimeType}) — text extraction not supported for this format]`,
          });
        }

        case "unknown": {
          // Try to read as text as a fallback
          try {
            const { textContent } = await processTextFile(file);
            return c.json({
              id, name, type: mimeType, size,
              textContent,
              category: "text",
            });
          } catch {
            // Can't read as text either
            return c.json({
              id, name, type: mimeType, size,
              category: "unknown",
              textContent: `[File: ${name} (${mimeType}, ${(size / 1024).toFixed(1)}KB) — unsupported format]`,
            });
          }
        }
      }
    } catch (err) {
      logger.error("[Upload] Processing failed", { name, error: (err as Error).message });
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
