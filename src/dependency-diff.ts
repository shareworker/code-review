import { getFileContent } from "./git.js";
import type {
  CheckDependencyDiffInput,
  CheckDependencyDiffResult,
  DependencyChange,
} from "./types.js";

/** Parse a package.json's dependencies + devDependencies into a Map. */
function parsePackageJson(content: string): Map<string, string> {
  const deps = new Map<string, string>();
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return deps;
  }
  const obj = data as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const section = obj[field];
    if (section && typeof section === "object") {
      for (const [name, version] of Object.entries(section as Record<string, string>)) {
        deps.set(name, version);
      }
    }
  }
  return deps;
}

/** Parse a requirements.txt into a Map of name -> version constraint. */
function parseRequirementsTxt(content: string): Map<string, string> {
  const deps = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const stripped = line.split(";")[0].trim();
    const match = stripped.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    const version = (match[2] ?? "").trim();
    deps.set(name, version);
  }
  return deps;
}

/** Parse a go.mod's require block into a Map of module -> version.
 *  Lines beginning with `//` (comments) are skipped. */
function parseGoMod(content: string): Map<string, string> {
  const deps = new Map<string, string>();
  let inRequireBlock = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("require (")) {
      inRequireBlock = true;
      continue;
    }
    if (line === ")" && inRequireBlock) {
      inRequireBlock = false;
      continue;
    }
    if (inRequireBlock) {
      // Strip trailing line comments (`// ...`) before parsing.
      const stripped = line.replace(/\s*\/\/.*$/, "").trim();
      if (!stripped) continue;
      const parts = stripped.split(/\s+/);
      if (parts.length >= 2) deps.set(parts[0], parts[1]);
    } else if (line.startsWith("require ")) {
      const stripped = line.slice(8).replace(/\s*\/\/.*$/, "").trim();
      const parts = stripped.split(/\s+/);
      if (parts.length >= 2) deps.set(parts[0], parts[1]);
    }
  }
  return deps;
}

function isUnpinned(version: string, format: "npm" | "pip" | "go"): boolean {
  const v = version.trim();
  if (format === "npm") {
    if (v === "" || v === "*" || v === "latest") return true;
    if (/^>=/.test(v) && !/[<~^]/.test(v)) return true;
    return false;
  }
  if (format === "pip") return v === "";
  if (format === "go") return v === "latest";
  return false;
}

function detectFormat(path: string): "npm" | "pip" | "go" | null {
  if (path.endsWith("package.json")) return "npm";
  if (path.endsWith("requirements.txt")) return "pip";
  if (path.endsWith("go.mod")) return "go";
  return null;
}

/** Resolve the "before" revision from a diff_ref.
 *  - "HEAD" (workspace mode) → "HEAD" (compare committed state vs worktree)
 *  - "from..to" (range mode) → "from"
 *  - "commit^..commit" (commit mode) → "commit^"
 */
function resolveBeforeRef(diffRef: string): string {
  if (diffRef === "HEAD") return "HEAD";
  const rangeMatch = diffRef.match(/^(.+?)\.\.(.+)$/);
  if (rangeMatch) return rangeMatch[1];
  return diffRef;
}

/** Resolve the "after" revision from a diff_ref.
 *  - "HEAD" (workspace mode) → not used (worktree is read directly)
 *  - "from..to" (range mode) → "to"
 *  - "commit^..commit" (commit mode) → "commit"
 */
function resolveAfterRef(diffRef: string): string {
  if (diffRef === "HEAD") return "HEAD";
  const rangeMatch = diffRef.match(/^(.+?)\.\.(.+)$/);
  if (rangeMatch) return rangeMatch[2];
  return diffRef;
}

function parseManifest(content: string, format: "npm" | "pip" | "go"): Map<string, string> {
  if (format === "npm") return parsePackageJson(content);
  if (format === "pip") return parseRequirementsTxt(content);
  return parseGoMod(content);
}

/**
 * Compare a dependency manifest file before and after a diff_ref,
 * returning added/removed/unpinned dependencies.
 *
 * Never throws — missing file or parse failure returns empty results + reason.
 */
export async function checkDependencyDiff(
  repo: string,
  input: CheckDependencyDiffInput
): Promise<CheckDependencyDiffResult> {
  const path = input.path.replace(/\\/g, "/");
  const diffRef = input.diffRef ?? "HEAD";
  const format = detectFormat(path);
  if (!format) {
    return {
      added: [],
      removed: [],
      unpinned: [],
      reason: `unsupported dependency manifest: ${path}`,
    };
  }

  const beforeRef = resolveBeforeRef(diffRef);
  const afterRef = resolveAfterRef(diffRef);

  let beforeContent: string | null = null;
  let afterContent: string | null = null;

  try {
    beforeContent = await getFileContent(repo, beforeRef, path);
  } catch {
    beforeContent = null;
  }
  // In workspace mode (diffRef === "HEAD"), the "after" state is the worktree
  // (which may have uncommitted changes). In range/commit mode, read from the ref.
  if (diffRef === "HEAD") {
    try {
      afterContent = await getFileContent(repo, "WORKTREE", path);
    } catch {
      afterContent = null;
    }
  } else {
    try {
      afterContent = await getFileContent(repo, afterRef, path);
    } catch {
      afterContent = null;
    }
  }

  if (!afterContent) {
    return {
      added: [],
      removed: [],
      unpinned: [],
      reason: `could not read ${path} at ${afterRef}`,
    };
  }

  const beforeDeps = beforeContent ? parseManifest(beforeContent, format) : new Map<string, string>();
  const afterDeps = parseManifest(afterContent, format);

  const added: DependencyChange[] = [];
  const removed: string[] = [];
  const unpinned: string[] = [];

  for (const [name, version] of afterDeps) {
    if (!beforeDeps.has(name)) {
      added.push({ name, versionConstraint: version });
      if (isUnpinned(version, format)) {
        unpinned.push(name);
      }
    }
  }
  for (const name of beforeDeps.keys()) {
    if (!afterDeps.has(name)) {
      removed.push(name);
    }
  }

  return { added, removed, unpinned };
}
