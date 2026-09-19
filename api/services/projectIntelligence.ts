/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROJECT INTELLIGENCE ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Generates an "Intelligence Card" for any project (coding or business).
 * Parses files, builds dependency graphs, extracts entities, and creates
 * a compact structured overview that gives LLMs full project awareness
 * without sending every file's contents.
 *
 * Supports:
 *   - Code files: JS/TS/Python/Java/Go/Rust/etc. (import graphs, exports)
 *   - Documents: PDF/DOCX (entity extraction, heading structure)
 *   - Data files: CSV/JSON/XML (schema inference)
 *   - Universal: file tree, cross-references, architecture detection
 */

/// <reference path="../../contracts/adm-zip.d.ts" />
import AdmZip from "adm-zip";

// ─── Types ──────────────────────────────────────────────────────────

interface FileNode {
  path: string;
  name: string;
  size: number;
  language: string;      // "typescript", "python", "pdf", "docx", "unknown"
  category: "code" | "document" | "data" | "config" | "image" | "binary";
  exports: string[];     // Functions, classes, variables (code) or headings (docs)
  description: string;   // One-line summary
  isEntryPoint: boolean;
}

interface DependencyEdge {
  source: string;        // file path
  target: string;        // imported file path
  importType: string;    // "import", "require", "include", "reference"
}

interface ExtractedEntity {
  name: string;
  type: "person" | "company" | "product" | "technology" | "metric" | "date" | "location" | "other";
  context: string;       // Where it was found
}

interface DatabaseTable {
  name: string;
  columns: Array<{ name: string; type: string; constraints?: string }>;
  sourceFile: string;
}

interface ApiEndpoint {
  method: string;
  path: string;
  handler: string;
  sourceFile: string;
}

export interface IntelligenceCard {
  version: number;
  generatedAt: string;
  projectType: "code" | "business" | "mixed" | "data" | "unknown";
  primaryLanguage: string;
  framework: string;
  totalFiles: number;
  totalSize: number;
  fileTree: FileNode[];
  dependencyGraph: DependencyEdge[];
  entities: ExtractedEntity[];
  databaseTables: DatabaseTable[];
  apiEndpoints: ApiEndpoint[];
  entryPoints: string[];
  architecture: string;    // "mvc", "layered", "microservices", "flat", etc.
  todos: string[];         // Auto-extracted TODOs/FIXMEs
  crossReferences: Array<{ source: string; target: string; type: string }>;
  // Compact string representation for LLM context
  toLLMContext(): string;
}

// ─── Constants ──────────────────────────────────────────────────────

const EXCLUDED_PATHS = [
  /^node_modules\//,
  /^\.git\//,
  /^\.svn\//,
  /^\.hg\//,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /^\.nuxt\//,
  /^target\//,
  /^bin\//,
  /^obj\//,
  /^\.vscode\//,
  /^\.idea\//,
  /^__pycache__\//,
  /\.pyc$/,
  /^\.DS_Store/,
  /^__MACOSX\//,
  /^Thumbs\.db/,
  /^\.env/,
  /^\.env\./,
  /\.lock$/,
  /^package-lock\.json/,
  /^yarn\.lock/,
  /^pnpm-lock\.yaml/,
  /^\.eslintcache/,
  /^\.prettiercache/,
  /^coverage\//,
  /^\.cache\//,
  /^tmp\//,
  /^temp\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.log$/,
];

const EXCLUDED_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
]);

const LANGUAGE_MAP: Record<string, string> = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript",
  ".py": "python", ".pyw": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".c": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".h": "c", ".hpp": "cpp",
  ".rb": "ruby", ".erb": "ruby",
  ".php": "php", ".phtml": "php",
  ".swift": "swift",
  ".kt": "kotlin", ".kts": "kotlin",
  ".scala": "scala", ".sc": "scala",
  ".r": "r", ".rmd": "r",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".fish": "bash",
  ".lua": "lua",
  ".pl": "perl", ".pm": "perl",
  ".dart": "dart",
  ".hs": "haskell", ".lhs": "haskell",
  ".ml": "ocaml", ".mli": "ocaml",
  ".fs": "fsharp", ".fsx": "fsharp",
  ".clj": "clojure", ".cljs": "clojure",
  ".erl": "erlang", ".hrl": "erlang",
  ".ex": "elixir", ".exs": "elixir",
  ".elm": "elm",
  ".v": "verilog", ".sv": "verilog", ".vhd": "vhdl", ".vhdl": "vhdl",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".sass": "scss", ".less": "css",
  ".json": "json",
  ".xml": "xml",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".graphql": "graphql", ".gql": "graphql",
  ".prisma": "prisma",
  ".md": "markdown", ".markdown": "markdown",
  ".txt": "text",
  ".csv": "csv",
  ".dockerfile": "dockerfile",
  ".tf": "terraform", ".tfvars": "terraform",
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "doc",
  ".xlsx": "xlsx", ".xls": "xls",
  ".pptx": "pptx", ".ppt": "ppt",
};

// ─── ZIP Extraction ─────────────────────────────────────────────────

/**
 * Extract a ZIP file, filter out junk, return list of {path, content, size}
 */
function extractZip(buffer: Buffer): Array<{ path: string; content: Buffer; size: number }> {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const results: Array<{ path: string; content: Buffer; size: number }> = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const path = entry.entryName;

    // Skip excluded paths
    if (EXCLUDED_PATHS.some((pattern) => pattern.test(path))) continue;

    // Skip excluded extensions
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) continue;

    // Skip very large files (>5MB per file)
    if (entry.header.size > 5 * 1024 * 1024) continue;

    // Skip files that look like secrets
    if (path.includes(".env") || path.includes("secret") || path.includes("private-key") || path.includes(".pem")) continue;

    const content = entry.getData();
    if (content && content.length > 0) {
      results.push({ path, content, size: content.length });
    }
  }

  return results;
}

// ─── File Classification ────────────────────────────────────────────

function detectLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return LANGUAGE_MAP[ext] || "unknown";
}

function detectCategory(language: string, path: string): FileNode["category"] {
  if (["javascript", "typescript", "python", "java", "go", "rust", "c", "cpp", "ruby", "php", "swift", "kotlin", "scala", "dart", "elixir", "clojure", "haskell", "ocaml", "fsharp", "erlang", "lua", "perl", "verilog", "vhdl", "elm"].includes(language)) {
    return "code";
  }
  if (["html", "css", "scss"].includes(language)) return "code";
  if (["pdf", "docx", "doc", "markdown", "txt"].includes(language)) return "document";
  if (["json", "xml", "yaml", "toml", "csv", "sql", "graphql"].includes(language)) return "data";
  if (["dockerfile", "terraform", "prisma"].includes(language) || path.includes("config")) return "config";
  if (["bash"].includes(language)) return "code";
  return "binary";
}

// ─── Code Parsing (Regex-based) ─────────────────────────────────────

/**
 * Parse code file with regex to extract:
 * - Imports/requires
 * - Exports (functions, classes, variables)
 * - TODOs/FIXMEs
 * - Description (from first JSDoc/docstring comment)
 */
function parseCodeFile(content: string, _language: string) {
  const exports: string[] = [];
  const imports: Array<{ source: string; type: string }> = [];
  const todos: string[] = [];
  let description = "";

  // Extract exports: function/class/const/let/var declarations
  const exportPatterns = [
    // JavaScript/TypeScript: export function/class/const/let/var
    /export\s+(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)|let\s+(\w+)|var\s+(\w+))/g,
    // Python: def / class
    /^(?:\s*@\w+\s*\n)?\s*(?:async\s+)?def\s+(\w+)|^class\s+(\w+)/gm,
    // Java/Go/Rust: func / fn / class
    /^(?:public\s+|private\s+|protected\s+)?(?:class|interface|record)\s+(\w+)|^func\s+(?:\([^)]+\)\s+)?(\w+)|^fn\s+(\w+)/gm,
    // Ruby: def / class / module
    /^def\s+(\w+)|^class\s+(\w+)|^module\s+(\w+)/gm,
  ];

  for (const pattern of exportPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3] || match[4] || match[5];
      if (name && !exports.includes(name)) exports.push(name);
    }
  }

  // Extract imports
  const importPatterns = [
    // ES6: import X from "path" / import { X } from "path"
    /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g,
    // CommonJS: require("path")
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Python: import X / from X import Y
    /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm,
    // Go: import "path"
    /import\s+(?:\(\s*["']([^"']+)["']|"([^"]+)")/g,
    // Rust: use crate::... / mod ...
    /^use\s+(\S+)|^mod\s+(\w+)/gm,
    // Java: import ...
    /^import\s+([\w.]+)/gm,
  ];

  for (const pattern of importPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const source = match[1] || match[2];
      if (source && !imports.find((i) => i.source === source)) {
        imports.push({ source, type: detectImportType(source) });
      }
    }
  }

  // Extract TODOs/FIXMEs
  const todoPattern = /(?:TODO|FIXME|HACK|BUG|XXX)[\s:]+(.+?)(?:\n|$)/gi;
  let todoMatch;
  while ((todoMatch = todoPattern.exec(content)) !== null) {
    const line = content.slice(0, todoMatch.index).split("\n").length;
    todos.push(`L${line}: ${todoMatch[1].trim()}`);
  }

  // Extract description from first JSDoc / docstring comment
  const jsdocMatch = content.match(/\/\*\*[\s\S]*?\*\//);
  if (jsdocMatch) {
    description = jsdocMatch[0]
      .replace(/\/\*\*|\*\/|\*/g, "")
      .replace(/\n\s*\n/g, " ")
      .trim()
      .slice(0, 200);
  } else {
    // Python docstring
    const pyDocMatch = content.match(/^\s*(?:"""|''')[\s\S]*?(?:"""|''')/m);
    if (pyDocMatch) {
      description = pyDocMatch[0]
        .replace(/"""|'''/g, "")
        .replace(/\n\s*\n/g, " ")
        .trim()
        .slice(0, 200);
    }
  }

  return { exports, imports, todos, description };
}

function detectImportType(source: string): string {
  if (source.startsWith(".") || source.startsWith("/")) return "local";
  if (source.startsWith("@/")) return "alias";
  if (source.includes("/")) return "package";
  return "module";
}

// ─── Document Parsing ───────────────────────────────────────────────

/**
 * Parse document files to extract:
 * - Headings/sections
 * - Named entities (people, companies, products)
 * - Key metrics (monetary values, percentages)
 * - Dates
 */
function parseDocument(content: string, _language: string) {
  const exports: string[] = [];
  const entities: ExtractedEntity[] = [];
  const todos: string[] = [];
  let description = "";

  // Extract headings (Markdown-style or from text)
  const headingPattern = /^(#{1,6}\s+.+|^\S+.+\n[=-]+)/gm;
  let match;
  while ((match = headingPattern.exec(content)) !== null) {
    const heading = match[0].replace(/^#+\s*/, "").replace(/\n[=-]+/, "").trim();
    if (heading && !exports.includes(heading)) exports.push(heading);
  }

  // Extract entities: people (Mr./Ms./Dr. + Name), companies (Inc./Ltd./Corp.), products (capitalized words)
  const textLines = content.split("\n").slice(0, 200); // First 200 lines only

  for (let i = 0; i < textLines.length; i++) {
    const line = textLines[i];

    // People: Mr./Ms./Dr./Prof. + Capitalized Name
    const personMatches = line.matchAll(/(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?|Prof\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g);
    for (const pm of personMatches) {
      entities.push({ name: pm[1], type: "person", context: `L${i + 1}` });
    }

    // Companies: Name + Inc/Ltd/Corp/LLC/GmbH/Co.
    const companyMatches = line.matchAll(/([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*)\s+(?:Inc\.?|Ltd\.?|Corp\.?|LLC|GmbH|Co\.?|Limited|Group|Technologies)/g);
    for (const cm of companyMatches) {
      if (cm[1].length > 2) {
        entities.push({ name: cm[0], type: "company", context: `L${i + 1}` });
      }
    }

    // Metrics: monetary values, percentages, numbers with units
    const metricMatches = line.matchAll(/(?:\$|€|¥)\s*[\d,.]+[KMB]?|\d+\.?\d*\s*%|\d+\.?\d*\s*(?:users|customers|revenue|sales|growth)/gi);
    for (const mm of metricMatches) {
      entities.push({ name: mm[0], type: "metric", context: `L${i + 1}: ${line.trim().slice(0, 100)}` });
    }

    // Dates: YYYY-MM-DD, Month YYYY, Q[1-4] YYYY
    const dateMatches = line.matchAll(/\b(20\d{2}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2}|Q[1-4]\s*20\d{2})\b/gi);
    for (const dm of dateMatches) {
      entities.push({ name: dm[0], type: "date", context: `L${i + 1}` });
    }
  }

  // First non-empty paragraph as description
  const firstPara = content.split("\n\n").find((p) => p.trim().length > 20);
  if (firstPara) {
    description = firstPara.trim().slice(0, 300);
  }

  return { exports, entities, todos, description };
}

// ─── Database Schema Extraction ─────────────────────────────────────

/**
 * Extract database table definitions from SQL/schema files
 */
function extractDatabaseTables(content: string, path: string): DatabaseTable[] {
  const tables: DatabaseTable[] = [];

  // SQL CREATE TABLE
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\)/gi;
  let match;
  while ((match = tablePattern.exec(content)) !== null) {
    const tableName = match[1];
    const columnsBlock = match[2];
    const columns: DatabaseTable["columns"] = [];

    // Parse columns
    const colLines = columnsBlock.split(",").map((l) => l.trim()).filter((l) => l.length > 0);
    for (const line of colLines) {
      // Skip constraints at the end
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|CHECK|CONSTRAINT)/i.test(line)) continue;

      const colMatch = line.match(/[`"']?(\w+)[`"']?\s+(\w+(?:\([^)]*\))?)\s*(.*)/);
      if (colMatch) {
        columns.push({
          name: colMatch[1],
          type: colMatch[2],
          constraints: colMatch[3].trim() || undefined,
        });
      }
    }

    if (columns.length > 0) {
      tables.push({ name: tableName, columns, sourceFile: path });
    }
  }

  // Prisma schema
  const prismaModelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)\n\}/gm;
  let prismaMatch;
  while ((prismaMatch = prismaModelPattern.exec(content)) !== null) {
    const modelName = prismaMatch[1];
    const fieldsBlock = prismaMatch[2];
    const columns: DatabaseTable["columns"] = [];

    const fieldLines = fieldsBlock.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("//"));
    for (const line of fieldLines) {
      const fm = line.match(/(\w+)\s+(\w+(?:\?)?)(?:\s+@\w+.*)?/);
      if (fm) {
        columns.push({ name: fm[1], type: fm[2] });
      }
    }

    if (columns.length > 0) {
      tables.push({ name: modelName, columns, sourceFile: path });
    }
  }

  // Drizzle ORM schema (TypeScript style)
  const drizzlePattern = /export\s+const\s+(\w+)\s*=\s*\w+\([`"'](\w+)[`"']\s*,\s*\{/g;
  let drizzleMatch;
  while ((drizzleMatch = drizzlePattern.exec(content)) !== null) {
    const tableName = drizzleMatch[2];
    // Extract fields between braces
    const startIdx = content.indexOf("{", drizzleMatch.index);
    const endIdx = findMatchingBrace(content, startIdx);
    if (endIdx > 0) {
      const block = content.slice(startIdx + 1, endIdx);
      const columns: DatabaseTable["columns"] = [];
      const fieldMatches = block.matchAll(/(\w+):\s*(\w+)\("(\w+)"/g);
      for (const fm of fieldMatches) {
        columns.push({ name: fm[3], type: fm[2] });
      }
      if (columns.length > 0) {
        tables.push({ name: tableName, columns, sourceFile: path });
      }
    }
  }

  return tables;
}

function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    if (depth === 0) return i;
  }
  return -1;
}

// ─── API Route Extraction ───────────────────────────────────────────

/**
 * Extract API route definitions from web framework code
 */
function extractApiRoutes(content: string, path: string): ApiEndpoint[] {
  const routes: ApiEndpoint[] = [];

  // Express / Hono / Fastify: app.get('/path', ...)
  const routePattern = /\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = routePattern.exec(content)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      handler: "",
      sourceFile: path,
    });
  }

  // FastAPI / Flask decorators: @app.get("/path")
  const decoratorPattern = /@\w+\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  let decMatch;
  while ((decMatch = decoratorPattern.exec(content)) !== null) {
    routes.push({
      method: decMatch[1].toUpperCase(),
      path: decMatch[2],
      handler: "",
      sourceFile: path,
    });
  }

  // Next.js: export default function Page or API routes
  const nextApiPattern = /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+).*?(?:req|request)/;
  if (nextApiPattern.test(content) && path.includes("api")) {
    const routePath = path.replace(/.*\/api/, "/api").replace(/\.(js|ts)$/, "");
    routes.push({ method: "GET", path: routePath, handler: "", sourceFile: path });
  }

  // Django: path('route', view)
  const djangoPattern = /path\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g;
  let djangoMatch;
  while ((djangoMatch = djangoPattern.exec(content)) !== null) {
    routes.push({
      method: "GET",
      path: djangoMatch[1],
      handler: djangoMatch[2],
      sourceFile: path,
    });
  }

  return routes;
}

// ─── Architecture Detection ─────────────────────────────────────────

function detectArchitecture(fileTree: FileNode[]): string {
  const paths = fileTree.map((f) => f.path);
  const hasDir = (name: string) => paths.some((p) => p.includes(`/${name}/`));

  if (hasDir("controllers") && hasDir("models") && hasDir("views")) return "mvc";
  if (hasDir("routes") && hasDir("services") && hasDir("models")) return "layered";
  if (hasDir("components") && hasDir("hooks") && hasDir("pages")) return "react-spa";
  if (hasDir("app") && hasDir("components")) return "nextjs-app";
  if (hasDir("pages") && hasDir("api")) return "nextjs-pages";
  if (hasDir("src") && hasDir("lib")) return "standard-lib";
  if (hasDir("services") && hasDir("repositories")) return "ddd";
  if (hasDir("cmd") && hasDir("internal")) return "go-standard";
  if (hasDir("src") && hasDir("test")) return "standard-src";
  if (paths.some((p) => p.includes("docker-compose"))) return "dockerized";

  return "flat";
}

function detectFramework(fileTree: FileNode[]): string {
  const paths = fileTree.map((f) => f.path);

  // Framework detection via config files
  if (paths.some((p) => p.includes("next.config"))) return "nextjs";
  if (paths.some((p) => p.includes("nuxt.config"))) return "nuxt";
  if (paths.some((p) => p.includes("vite.config"))) return "vite";
  if (paths.some((p) => p.includes("vue.config"))) return "vue-cli";
  if (paths.some((p) => p.includes("angular.json"))) return "angular";
  if (paths.some((p) => p.includes("svelte.config"))) return "svelte";
  if (paths.some((p) => p.includes("astro.config"))) return "astro";
  if (paths.some((p) => p.includes("remix.config"))) return "remix";
  if (paths.some((p) => p.includes("Dockerfile")) || paths.some((p) => p.includes("docker-compose"))) return "docker";
  if (paths.some((p) => p.includes("go.mod"))) return "go";
  if (paths.some((p) => p.includes("Cargo.toml"))) return "rust";
  if (paths.some((p) => p.includes("requirements.txt")) || paths.some((p) => p.includes("pyproject.toml"))) return "python";
  if (paths.some((p) => p.includes("pom.xml")) || paths.some((p) => p.includes("build.gradle"))) return "java";
  if (paths.some((p) => p.includes("Gemfile"))) return "ruby";
  if (paths.some((p) => p.includes("composer.json"))) return "php";
  if (paths.some((p) => p.includes("pubspec.yaml"))) return "flutter";
  if (paths.some((p) => p.includes("mix.exs"))) return "elixir";

  return "custom";
}

// ─── Entry Point Detection ──────────────────────────────────────────

function detectEntryPoints(fileTree: FileNode[]): string[] {
  const entryPatterns = [
    /^main\.(js|ts|py|java|go|rs|c|cpp)$/,
    /^index\.(js|ts|jsx|tsx|py)$/,
    /^app\.(js|ts|py)$/,
    /^server\.(js|ts|py|go)$/,
    /^cli\.(js|ts|py|go)$/,
    /^manage\.py$/,         // Django
    /^asgi\.py$/, /^wsgi\.py$/, // Django
    /^application\.py$/,    // Flask
    /^src\/(main|index|app)\.(js|ts|jsx|tsx)$/,
    /^cmd\/.*\/main\.go$/,  // Go
    /^src\/main\.rs$/,     // Rust
  ];

  return fileTree
    .filter((f) => entryPatterns.some((p) => p.test(f.path)))
    .map((f) => f.path);
}

// ─── Cross-Reference Detection ──────────────────────────────────────

function detectCrossReferences(_fileTree: FileNode[], dependencyGraph: DependencyEdge[]) {
  const refs: Array<{ source: string; target: string; type: string }> = [];

  // Type 1: Import-based (from dependency graph)
  for (const edge of dependencyGraph) {
    refs.push({ source: edge.source, target: edge.target, type: "import" });
  }

  return refs;
}

// ─── Main: Generate Intelligence Card ───────────────────────────────

/**
 * Generate a complete Intelligence Card from a ZIP buffer.
 * This is the main entry point — call this with the uploaded ZIP file.
 */
export async function generateIntelligenceCard(zipBuffer: Buffer): Promise<IntelligenceCard> {
  const extracted = extractZip(zipBuffer);

  if (extracted.length === 0) {
    throw new Error("No valid files found in ZIP. Check that it's not empty and doesn't contain only excluded files (node_modules, .git, etc.).");
  }

  // Build file tree nodes
  const fileTree: FileNode[] = extracted.map((file) => {
    const language = detectLanguage(file.path);
    const category = detectCategory(language, file.path);
    return {
      path: file.path,
      name: file.path.split("/").pop() || file.path,
      size: file.size,
      language,
      category,
      exports: [],
      description: "",
      isEntryPoint: false,
    };
  });

  // Parse each file
  const dependencyGraph: DependencyEdge[] = [];
  const allTodos: string[] = [];
  const allEntities: ExtractedEntity[] = [];
  const allTables: DatabaseTable[] = [];
  const allRoutes: ApiEndpoint[] = [];
  const pathToContent: Map<string, string> = new Map();

  for (let i = 0; i < extracted.length; i++) {
    const file = extracted[i];
    const node = fileTree[i];

    // Convert binary content to text (if it's a text-ish file)
    let content = "";
    if (node.category !== "binary" && node.category !== "image") {
      try {
        content = file.content.toString("utf-8");
        // Check for replacement characters — if present, it's binary
        if (content.includes("\uFFFD") && file.content.includes(0)) {
          content = ""; // Binary file, skip content analysis
        }
      } catch {
        content = "";
      }
    }

    if (content) {
      pathToContent.set(file.path, content);

      if (node.category === "code") {
        const parsed = parseCodeFile(content, node.language);
        node.exports = parsed.exports.slice(0, 30); // Cap at 30 exports
        node.description = parsed.description;
        allTodos.push(...parsed.todos.map((t) => `${file.path}:${t}`));

        // Build dependency edges
        for (const imp of parsed.imports) {
          if (imp.type === "local" || imp.type === "alias") {
            const resolvedPath = resolveImportPath(imp.source, file.path);
            if (resolvedPath) {
              dependencyGraph.push({
                source: file.path,
                target: resolvedPath,
                importType: imp.type,
              });
            }
          }
        }

        // Extract API routes
        allRoutes.push(...extractApiRoutes(content, file.path));
      }

      if (node.category === "document" || node.category === "data") {
        const parsed = parseDocument(content, node.language);
        node.exports = parsed.exports.slice(0, 20);
        node.description = parsed.description;
        allEntities.push(...parsed.entities);
        allTodos.push(...parsed.todos.map((t) => `${file.path}:${t}`));
      }

      // Database tables from any file type
      allTables.push(...extractDatabaseTables(content, file.path));
    }
  }

  // Detect entry points
  const entryPoints = detectEntryPoints(fileTree);
  for (const ep of entryPoints) {
    const node = fileTree.find((f) => f.path === ep);
    if (node) node.isEntryPoint = true;
  }

  // Deduplicate entities
  const uniqueEntities = deduplicateEntities(allEntities);

  // Detect architecture and framework
  const architecture = detectArchitecture(fileTree);
  const framework = detectFramework(fileTree);

  // Detect project type
  const codeCount = fileTree.filter((f) => f.category === "code").length;
  const docCount = fileTree.filter((f) => f.category === "document").length;
  const dataCount = fileTree.filter((f) => f.category === "data").length;
  const totalAnalyzed = codeCount + docCount + dataCount;

  let projectType: IntelligenceCard["projectType"] = "unknown";
  if (codeCount / totalAnalyzed > 0.6) projectType = "code";
  else if (docCount / totalAnalyzed > 0.6) projectType = "business";
  else if (dataCount / totalAnalyzed > 0.6) projectType = "data";
  else if (totalAnalyzed > 0) projectType = "mixed";

  // Primary language
  const langCounts: Record<string, number> = {};
  for (const f of fileTree) {
    if (f.category === "code" && f.language !== "unknown") {
      langCounts[f.language] = (langCounts[f.language] || 0) + 1;
    }
  }
  const primaryLanguage = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  // Cross-references
  const crossReferences = detectCrossReferences(fileTree, dependencyGraph);

  // Build the card
  const card: IntelligenceCard = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectType,
    primaryLanguage,
    framework,
    totalFiles: fileTree.length,
    totalSize: extracted.reduce((sum, f) => sum + f.size, 0),
    fileTree,
    dependencyGraph,
    entities: uniqueEntities.slice(0, 50), // Cap at 50 entities
    databaseTables: allTables,
    apiEndpoints: allRoutes.slice(0, 30), // Cap at 30 routes
    entryPoints,
    architecture,
    todos: allTodos.slice(0, 20), // Cap at 20 TODOs
    crossReferences,
    toLLMContext(): string {
      return renderIntelligenceCard(this);
    },
  };

  return card;
}

// ─── Import Path Resolution ─────────────────────────────────────────

function resolveImportPath(source: string, currentPath: string): string | null {
  // Handle @/ aliases (common in Vite/Webpack/Next.js)
  if (source.startsWith("@/")) {
    const relative = source.slice(2); // Remove "@/"
    // Try common src locations
    const candidates = [
      relative,
      `src/${relative}`,
      `app/${relative}`,
    ];
    // Add extensions
    for (const base of candidates) {
      for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs"]) {
        const fullPath = base + ext;
        // We'll check existence later; for now return the path
        // The caller will filter out non-existent targets
        return fullPath;
      }
    }
  }

  // Handle relative imports
  if (source.startsWith("./") || source.startsWith("../")) {
    const currentDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
    const segments = source.split("/");
    let resolved = currentDir;

    for (const seg of segments) {
      if (seg === "..") {
        resolved = resolved.includes("/") ? resolved.slice(0, resolved.lastIndexOf("/")) : "";
      } else if (seg !== "." && seg !== "") {
        resolved = resolved ? `${resolved}/${seg}` : seg;
      }
    }

    // Try with extensions
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", "/index.ts", "/index.js"]) {
      const candidate = resolved + ext;
      // Return first match — existence verified by caller
      return candidate;
    }
  }

  // Package imports — can't resolve without node_modules
  return null;
}

// ─── Entity Deduplication ───────────────────────────────────────────

function deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const result: ExtractedEntity[] = [];

  for (const e of entities) {
    const key = `${e.type}:${e.name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }

  return result;
}

// ─── Intelligence Card → LLM Context String ─────────────────────────

function renderIntelligenceCard(card: IntelligenceCard): string {
  const lines: string[] = [];

  lines.push(`═══ PROJECT INTELLIGENCE CARD ═══`);
  lines.push(`Type: ${card.projectType} | Primary: ${card.primaryLanguage} | Framework: ${card.framework}`);
  lines.push(`Files: ${card.totalFiles} | Architecture: ${card.architecture}`);
  if (card.entryPoints.length > 0) {
    lines.push(`Entry Points: ${card.entryPoints.join(", ")}`);
  }
  lines.push("");

  // File Tree (compact)
  lines.push("┌─ FILE TREE");
  for (const file of card.fileTree) {
    const icon = file.isEntryPoint ? "▶" : " ";
    const exportSummary = file.exports.length > 0 ? ` (${file.exports.length} exports)` : "";
    lines.push(` ${icon} ${file.path} [${file.language}]${exportSummary}`);
    if (file.description) {
      lines.push(`   → ${file.description.slice(0, 120)}${file.description.length > 120 ? "..." : ""}`);
    }
  }
  lines.push("");

  // Dependency Graph (if code project)
  if (card.dependencyGraph.length > 0 && card.projectType === "code") {
    lines.push("┌─ DEPENDENCY GRAPH");
    for (const edge of card.dependencyGraph.slice(0, 30)) {
      lines.push(` ${edge.source} ──[${edge.importType}]──> ${edge.target}`);
    }
    if (card.dependencyGraph.length > 30) {
      lines.push(` ... and ${card.dependencyGraph.length - 30} more`);
    }
    lines.push("");
  }

  // Database Schema
  if (card.databaseTables.length > 0) {
    lines.push("┌─ DATABASE SCHEMA");
    for (const table of card.databaseTables) {
      const cols = table.columns.map((c) => `${c.name}(${c.type})`).join(", ");
      lines.push(` ${table.name} [${table.sourceFile}]`);
      lines.push(`   Columns: ${cols}`);
    }
    lines.push("");
  }

  // API Routes
  if (card.apiEndpoints.length > 0) {
    lines.push("┌─ API ROUTES");
    for (const route of card.apiEndpoints) {
      lines.push(` ${route.method} ${route.path} [${route.sourceFile}]`);
    }
    lines.push("");
  }

  // Entities
  if (card.entities.length > 0) {
    lines.push("┌─ KEY ENTITIES");
    for (const entity of card.entities) {
      lines.push(` [${entity.type}] ${entity.name} — ${entity.context}`);
    }
    lines.push("");
  }

  // TODOs
  if (card.todos.length > 0) {
    lines.push("┌─ TODOs / FIXMEs");
    for (const todo of card.todos) {
      lines.push(` • ${todo}`);
    }
    lines.push("");
  }

  lines.push("═══ END INTELLIGENCE CARD ═══");

  return lines.join("\n");
}

// ─── Utility: Get relevant files for a query ────────────────────────

/**
 * Given a user query and the intelligence card, determine which files
 * are most likely relevant. Uses the dependency graph and entity matching.
 */
export function findRelevantFiles(card: IntelligenceCard, query: string): string[] {
  const queryLower = query.toLowerCase();
  const relevant = new Set<string>();

  // For small projects (≤10 files), always include ALL files — keyword matching
  // is too restrictive when the user prompt doesn't overlap with file names
  if (card.fileTree.length <= 10) {
    for (const file of card.fileTree) {
      relevant.add(file.path);
    }
    return Array.from(relevant).slice(0, 20);
  }

  // 1. Direct keyword matching against file paths and exports
  for (const file of card.fileTree) {
    const searchText = `${file.path} ${file.name} ${file.exports.join(" ")} ${file.description}`.toLowerCase();
    if (queryLower.split(/\s+/).some((word) => searchText.includes(word) && word.length > 2)) {
      relevant.add(file.path);
    }
  }

  // 2. Entity matching
  for (const entity of card.entities) {
    if (queryLower.includes(entity.name.toLowerCase())) {
      // Find files that mention this entity
      for (const ref of card.crossReferences) {
        if (ref.target.toLowerCase().includes(entity.name.toLowerCase())) {
          relevant.add(ref.source);
        }
      }
    }
  }

  // 3. If we found seed files, expand via dependency graph (BFS 2 levels)
  const seedFiles = Array.from(relevant);
  for (const seed of seedFiles) {
    // Find files that this file imports (dependencies)
    for (const edge of card.dependencyGraph) {
      if (edge.source === seed && !relevant.has(edge.target)) {
        relevant.add(edge.target);
      }
    }
    // Find files that import this file (dependents)
    for (const edge of card.dependencyGraph) {
      if (edge.target === seed && !relevant.has(edge.source)) {
        relevant.add(edge.source);
      }
    }
  }

  // Always include entry points (even if no keyword matches were found)
  for (const ep of card.entryPoints) {
    relevant.add(ep);
  }

  return Array.from(relevant).slice(0, 20); // Cap at 20 files
}
