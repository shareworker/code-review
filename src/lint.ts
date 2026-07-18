import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  GetLintFindingsInput,
  GetLintFindingsResult,
  LintFinding,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;

interface ToolDef {
  name: string;
  /** Returns true if this tool is configured in the repo. */
  detect: (repoAbs: string) => boolean;
  /** Returns the executable path (or null if the binary isn't available). */
  resolveBinary: (repoAbs: string) => string | null;
  /** Build the argv (excluding the binary itself). */
  buildArgs: (repoAbs: string, files: string[] | undefined) => string[];
  /** Parse the tool's stdout into LintFinding[]. */
  parse: (stdout: string, stderr: string) => LintFinding[];
}

// ---------------------------------------------------------------------------
// ESLint
// ---------------------------------------------------------------------------

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

function detectEslint(repoAbs: string): boolean {
  return ESLINT_CONFIG_FILES.some((f) => existsSync(join(repoAbs, f)));
}

function resolveEslintBinary(repoAbs: string): string | null {
  const local = join(repoAbs, "node_modules", ".bin", "eslint");
  if (existsSync(local)) return local;
  // Fallback: assume global eslint is on PATH.
  return "eslint";
}

function buildEslintArgs(_repoAbs: string, files: string[] | undefined): string[] {
  const args = ["--format", "json"];
  if (files && files.length > 0) {
    args.push(...files);
  } else {
    args.push(".");
  }
  return args;
}

function parseEslint(stdout: string): LintFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const findings: LintFinding[] = [];
  for (const fileEntry of data) {
    const f = fileEntry as { filePath?: string; messages?: unknown[] };
    if (!f.messages || !Array.isArray(f.messages)) continue;
    const filePath = (f.filePath ?? "").replace(/\\/g, "/");
    for (const msg of f.messages) {
      const m = msg as {
        line?: number;
        severity?: number;
        message?: string;
        ruleId?: string;
      };
      findings.push({
        path: filePath,
        line: m.line ?? 0,
        severity: m.severity === 2 ? "error" : m.severity === 1 ? "warning" : "info",
        message: m.ruleId ? `${m.message ?? ""} (${m.ruleId})` : (m.message ?? ""),
        tool: "eslint",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// tsc
// ---------------------------------------------------------------------------

function detectTsc(repoAbs: string): boolean {
  return existsSync(join(repoAbs, "tsconfig.json"));
}

function resolveTscBinary(repoAbs: string): string | null {
  const local = join(repoAbs, "node_modules", ".bin", "tsc");
  if (existsSync(local)) return local;
  return "tsc";
}

function buildTscArgs(_repoAbs: string, _files: string[] | undefined): string[] {
  return ["--noEmit", "--pretty", "false"];
}

function parseTsc(stdout: string, stderr: string): LintFinding[] {
  // tsc --pretty false emits lines like:
  //   file.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
  const output = (stdout + "\n" + stderr).split("\n");
  const findings: LintFinding[] = [];
  const lineRe = /^(.+?)\((\d+),\d+\):\s+(error|warning|info)\s+TS\d+:\s+(.+)$/;
  for (const line of output) {
    const m = line.match(lineRe);
    if (!m) continue;
    findings.push({
      path: m[1].replace(/\\/g, "/"),
      line: parseInt(m[2], 10),
      severity: m[3] as "error" | "warning" | "info",
      message: m[4],
      tool: "tsc",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// ruff
// ---------------------------------------------------------------------------

function detectRuff(repoAbs: string): boolean {
  return (
    existsSync(join(repoAbs, "ruff.toml")) ||
    existsSync(join(repoAbs, ".ruff.toml")) ||
    existsSync(join(repoAbs, "pyproject.toml"))
  );
}

function resolveRuffBinary(_repoAbs: string): string | null {
  // ruff is typically installed globally or via pip; no reliable local bin check.
  return "ruff";
}

function buildRuffArgs(_repoAbs: string, files: string[] | undefined): string[] {
  const args = ["check", "--output-format", "json"];
  if (files && files.length > 0) {
    args.push(...files);
  } else {
    args.push(".");
  }
  return args;
}

function parseRuff(stdout: string): LintFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const findings: LintFinding[] = [];
  for (const entry of data) {
    const e = entry as {
      filename?: string;
      location?: { row?: number };
      url?: string;
      message?: string;
      code?: string;
    };
    findings.push({
      path: (e.filename ?? "").replace(/\\/g, "/"),
      line: e.location?.row ?? 0,
      severity: "warning",
      message: e.code ? `${e.message ?? ""} (${e.code})` : (e.message ?? ""),
      tool: "ruff",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// go vet
// ---------------------------------------------------------------------------

function detectGoVet(repoAbs: string): boolean {
  return existsSync(join(repoAbs, "go.mod"));
}

function resolveGoVetBinary(_repoAbs: string): string | null {
  return "go";
}

function buildGoVetArgs(_repoAbs: string, _files: string[] | undefined): string[] {
  return ["vet", "./..."];
}

function parseGoVet(stdout: string, stderr: string): LintFinding[] {
  // go vet output: <file>:<line>: <message>
  const output = (stdout + "\n" + stderr).split("\n");
  const findings: LintFinding[] = [];
  const lineRe = /^(.+?):(\d+):\s+(.+)$/;
  for (const line of output) {
    const m = line.match(lineRe);
    if (!m) continue;
    if (m[1].startsWith("#")) continue; // skip build status lines
    findings.push({
      path: m[1].replace(/\\/g, "/"),
      line: parseInt(m[2], 10),
      severity: "warning",
      message: m[3],
      tool: "go_vet",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// cargo clippy
// ---------------------------------------------------------------------------

function detectClippy(repoAbs: string): boolean {
  return existsSync(join(repoAbs, "Cargo.toml"));
}

function resolveClippyBinary(_repoAbs: string): string | null {
  return "cargo";
}

function buildClippyArgs(_repoAbs: string, _files: string[] | undefined): string[] {
  return ["clippy", "--message-format", "short"];
}

function parseClippy(stdout: string, stderr: string): LintFinding[] {
  // clippy short format: <file>:<line>:<col>: <severity>: <message>
  const output = (stdout + "\n" + stderr).split("\n");
  const findings: LintFinding[] = [];
  const lineRe = /^(.+?):(\d+):\d+:\s+(error|warning):\s+(.+)$/;
  for (const line of output) {
    const m = line.match(lineRe);
    if (!m) continue;
    findings.push({
      path: m[1].replace(/\\/g, "/"),
      line: parseInt(m[2], 10),
      severity: m[3] as "error" | "warning",
      message: m[4],
      tool: "clippy",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const TOOLS: ToolDef[] = [
  { name: "eslint", detect: detectEslint, resolveBinary: resolveEslintBinary, buildArgs: buildEslintArgs, parse: (s) => parseEslint(s) },
  { name: "tsc", detect: detectTsc, resolveBinary: resolveTscBinary, buildArgs: buildTscArgs, parse: parseTsc },
  { name: "ruff", detect: detectRuff, resolveBinary: resolveRuffBinary, buildArgs: buildRuffArgs, parse: (s) => parseRuff(s) },
  { name: "go_vet", detect: detectGoVet, resolveBinary: resolveGoVetBinary, buildArgs: buildGoVetArgs, parse: parseGoVet },
  { name: "clippy", detect: detectClippy, resolveBinary: resolveClippyBinary, buildArgs: buildClippyArgs, parse: parseClippy },
];

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Detect and run project-configured lint/typecheck tools.
 *
 * - Detects tools by config-file presence (eslint config, tsconfig.json, etc.).
 * - Calls the detected tool's binary (prefers node_modules/.bin for Node tools).
 * - Parses each tool's output into a unified LintFinding[].
 * - Never throws — missing config, missing binary, and timeouts all produce
 *   empty/partial results with reason or timedOut metadata.
 */
export async function getLintFindings(
  repo: string,
  input: GetLintFindingsInput
): Promise<GetLintFindingsResult> {
  const repoAbs = resolve(repo);
  const files = input.files;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  const applicable = TOOLS.filter((t) => t.detect(repoAbs));
  if (applicable.length === 0) {
    return {
      findings: [],
      toolsRun: [],
      reason: "no known lint/typecheck configuration detected",
    };
  }

  // Normalize the requested file list to repo-relative paths so we can filter
  // findings from tools that don't support per-file invocation (tsc, go vet,
  // clippy) while leaving already-file-scoped tools (eslint, ruff) unaffected.
  const repoPrefix = repoAbs.replace(/\\/g, "/") + "/";
  const normalizedFiles = new Set(
    (files ?? []).map((f) => {
      const nf = f.replace(/\\/g, "/");
      return nf.startsWith(repoPrefix) ? nf.slice(repoPrefix.length) : nf;
    })
  );

  const findings: LintFinding[] = [];
  const toolsRun: string[] = [];
  const timedOut: string[] = [];

  for (const tool of applicable) {
    const binary = tool.resolveBinary(repoAbs);
    if (!binary) {
      continue;
    }
    const args = tool.buildArgs(repoAbs, files);
    try {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        cwd: repoAbs,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10, // 10 MB
      });
      toolsRun.push(tool.name);
      const parsed = tool.parse(stdout, stderr);
      findings.push(...filterFindings(parsed, normalizedFiles, repoPrefix));
    } catch (err: unknown) {
      const e = err as { killed?: boolean; signal?: string; stdout?: string; stderr?: string; code?: number };
      // Many linters exit non-zero when they find issues — that's not a real error.
      // If stdout is present, parse it anyway.
      if (e.stdout || e.stderr) {
        toolsRun.push(tool.name);
        const parsed = tool.parse(e.stdout ?? "", e.stderr ?? "");
        findings.push(...filterFindings(parsed, normalizedFiles, repoPrefix));
      }
      if (e.killed || e.signal === "SIGTERM") {
        timedOut.push(tool.name);
      }
      // Otherwise (binary not found, spawn error with no stdout): skip silently.
    }
  }

  if (toolsRun.length === 0 && timedOut.length === 0) {
    return {
      findings: [],
      toolsRun: [],
      reason: "detected configurations but no tool binaries were available",
    };
  }

  return {
    findings,
    toolsRun,
    ...(timedOut.length > 0 ? { timedOut } : {}),
  };
}

/** Filter lint findings to the requested files. Pass-through when no files. */
function filterFindings(
  findings: LintFinding[],
  normalizedFiles: Set<string>,
  repoPrefix: string
): LintFinding[] {
  if (normalizedFiles.size === 0) return findings;
  return findings.filter((f) => {
    const nf = f.path.replace(/\\/g, "/");
    const relPath = nf.startsWith(repoPrefix) ? nf.slice(repoPrefix.length) : nf;
    return normalizedFiles.has(relPath);
  });
}
