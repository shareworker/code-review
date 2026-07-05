import { minimatch } from "minimatch";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FilterConfig, RulesConfig } from "./types.js";

/** Built-in default blacklist of glob patterns. */
export const DEFAULT_EXCLUDE: string[] = [
  "**/*.lock",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  // Binary file extensions
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.bmp",
  "**/*.ico",
  "**/*.svg",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.tgz",
  "**/*.bz2",
  "**/*.7z",
  "**/*.rar",
  "**/*.pdf",
  "**/*.doc",
  "**/*.docx",
  "**/*.xls",
  "**/*.xlsx",
  "**/*.ppt",
  "**/*.pptx",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
  "**/*.class",
  "**/*.jar",
  "**/*.war",
  "**/*.wasm",
  "**/*.mp3",
  "**/*.mp4",
  "**/*.avi",
  "**/*.mov",
  "**/*.webp",
  "**/*.ttf",
  "**/*.otf",
  "**/*.woff",
  "**/*.woff2",
  "**/*.eot",
];

/** Binary file extensions for fallback detection (without glob wrapper). */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".war", ".wasm",
  ".mp3", ".mp4", ".avi", ".mov", ".webp",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
]);

/**
 * Check if a path has a binary file extension.
 */
export function isBinaryByExtension(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Match a path against a list of glob patterns (case-insensitive).
 * Brace expansion like "*.{ts,js}" is handled by minimatch.
 */
export function matchAny(path: string, patterns: string[]): boolean {
  const lowerPath = path.toLowerCase();
  for (const pattern of patterns) {
    if (minimatch(lowerPath, pattern.toLowerCase())) return true;
  }
  return false;
}

/**
 * Load a rules.json file from a directory, returning null if missing or unparseable.
 */
async function loadRulesFile(dir: string): Promise<RulesConfig | null> {
  const filePath = join(dir, ".code-review", "rules.json");
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as RulesConfig;
  } catch {
    return null;
  }
}

/**
 * Load and merge filter config from repo, home, and built-in defaults.
 * Priority: repo > home > built-in defaults.
 * User exclude patterns are appended to (not replacing) the built-in defaults;
 * user include patterns (when present) restrict to only matching files.
 */
export async function loadFilterConfig(repo: string): Promise<FilterConfig> {
  const repoConfig = await loadRulesFile(repo);
  const homeConfig = await loadRulesFile(homedir());

  const repoFilters = repoConfig?.filters;
  const homeFilters = homeConfig?.filters;

  // Merge excludes: built-in defaults + home + repo (all apply, repo wins on conflict by being last).
  const exclude = [
    ...DEFAULT_EXCLUDE,
    ...(homeFilters?.exclude ?? []),
    ...(repoFilters?.exclude ?? []),
  ];

  // Merge includes: repo include wins if present, else home, else empty (no restriction).
  const include =
    repoFilters?.include ??
    homeFilters?.include ??
    [];

  return { include, exclude: dedup(exclude) };
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * Filter a list of file paths.
 * - Files matching any exclude pattern are removed.
 * - If include patterns are present, only files matching an include pattern are kept.
 * - Binary files (by extension) are removed.
 * @returns kept files and count of filtered-out files.
 */
export function filterFiles(
  files: string[],
  config: FilterConfig
): { kept: string[]; filtered: number } {
  const kept: string[] = [];
  let filtered = 0;
  for (const file of files) {
    // Normalize to forward slashes.
    const path = file.replace(/\\/g, "/");
    if (isBinaryByExtension(path)) {
      filtered++;
      continue;
    }
    if (matchAny(path, config.exclude)) {
      filtered++;
      continue;
    }
    if (config.include.length > 0 && !matchAny(path, config.include)) {
      filtered++;
      continue;
    }
    kept.push(path);
  }
  return { kept, filtered };
}
