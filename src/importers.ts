import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, dirname, resolve, normalize, sep } from "node:path";
import type {
  GetImportersInput,
  GetImportersResult,
} from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Regex patterns for extracting static import/require/export-from statements.
// These intentionally only capture string-literal module specifiers (not
// dynamic import(variable) or conditional require) — see design.md known limitations.
const IMPORT_PATTERNS: RegExp[] = [
  // import ... from "..."
  /import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
  // export ... from "..."
  /export\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
  // require("...")
  /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  // import("...") — static string argument only (dynamic variable import is not captured)
  /import\s*\(\s*["']([^"']+)["']\s*\)/g,
];

interface ImportEdge {
  /** Absolute path of the file making the import. */
  importer: string;
  /** Raw module specifier as written in code. */
  specifier: string;
}

/** Recursively collect all supported source files under a directory. */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    // Skip node_modules, .git, dist, build, and other common ignore dirs.
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build" || entry === ".next" || entry === ".cache") {
      continue;
    }
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      results.push(...await collectSourceFiles(full));
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

/** Extract all static import/require specifiers from file content. */
function extractSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      specifiers.push(match[1]);
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
  return specifiers;
}

/**
 * Resolve a relative module specifier to ALL possible absolute file paths
 * (with different extensions and index file variants).
 * Returns an array of candidate paths to try.
 */
function resolveModulePaths(importerAbs: string, specifier: string): string[] {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return []; // bare package import — skip
  }
  const base = specifier.startsWith("/")
    ? specifier
    : join(dirname(importerAbs), specifier);
  const normalizedBase = normalize(base).replace(/\\/g, "/");

  const candidates: string[] = [];
  // The specifier as-is (may already have an extension).
  candidates.push(normalizedBase);
  // With each supported extension (if the specifier doesn't already have one).
  if (!extname(normalizedBase)) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.push(normalizedBase + ext);
    }
    // Index files.
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.push(normalizedBase + "/index" + ext);
    }
  }
  return candidates;
}

/**
 * Build a reverse dependency index: for each file, which files import it.
 * Returns a Map from imported absolute path → array of importer absolute paths.
 */
async function buildReverseIndex(repoAbs: string): Promise<Map<string, string[]>> {
  const files = await collectSourceFiles(repoAbs);
  const reverseIndex = new Map<string, string[]>();

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const specifiers = extractSpecifiers(content);
    for (const spec of specifiers) {
      const candidates = resolveModulePaths(file, spec);
      const importerPath = file.replace(/\\/g, "/");
      for (const resolved of candidates) {
        const importers = reverseIndex.get(resolved) ?? [];
        if (!importers.includes(importerPath)) {
          importers.push(importerPath);
        }
        reverseIndex.set(resolved, importers);
      }
    }
  }

  return reverseIndex;
}

/**
 * Find all files that import a given file (module-level reverse dependency).
 *
 * Uses regex-based static import/require/export-from parsing — does NOT handle
 * dynamic import(variable), conditional require, or tsconfig paths aliases.
 * Only processes .ts/.tsx/.js/.jsx/.mjs/.cjs files.
 *
 * Never throws — missing files and no importers return empty results.
 */
export async function getImporters(
  repo: string,
  input: GetImportersInput
): Promise<GetImportersResult> {
  const repoAbs = resolve(repo);
  // Resolve the target path to an absolute path for matching against the index.
  const targetAbs = resolve(repoAbs, input.path).replace(/\\/g, "/");
  const targetBase = targetAbs.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");

  const reverseIndex = await buildReverseIndex(repoAbs);

  // Try exact match and all extension variants.
  const candidates = [
    targetAbs,
    targetBase,
    targetBase + ".ts",
    targetBase + ".tsx",
    targetBase + ".js",
    targetBase + ".jsx",
    targetBase + ".mjs",
    targetBase + ".cjs",
  ];

  const importers = new Set<string>();
  for (const candidate of candidates) {
    const found = reverseIndex.get(candidate);
    if (found) {
      for (const imp of found) importers.add(imp);
    }
  }

  return {
    path: input.path.replace(/\\/g, "/"),
    importers: [...importers].sort(),
  };
}
