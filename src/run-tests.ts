import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  RunAffectedTestsInput,
  RunAffectedTestsResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Execute the project's declared `test` script from package.json.
 *
 * - Only reads `package.json` scripts.test — does NOT accept arbitrary commands.
 * - On non-Windows platforms, uses execFile directly on `npm` (no shell).
 * - On Windows, npm is a .cmd batch file that must be invoked through cmd.exe
 *   (`cmd.exe /c npm run test`). Only the fixed command "npm run test" is run —
 *   no user-supplied arguments — so command injection is not possible.
 * - Returns exit_code, stdout, stderr, timed_out as-is; never retries or swallows failures.
 * - Non-Node projects (no package.json) return empty + reason.
 */
export async function runAffectedTests(
  repo: string,
  input: RunAffectedTestsInput
): Promise<RunAffectedTestsResult> {
  const repoAbs = resolve(repo);
  const pkgJsonPath = join(repoAbs, "package.json");

  if (!existsSync(pkgJsonPath)) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      reason: "no package.json found in repo root",
    };
  }

  let pkgContent: string;
  try {
    pkgContent = await readFile(pkgJsonPath, "utf8");
  } catch {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      reason: "could not read package.json",
    };
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgContent);
  } catch {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      reason: "package.json is not valid JSON",
    };
  }

  const scripts = (pkg as Record<string, unknown>)?.scripts as
    | Record<string, string>
    | undefined;
  const testScript = scripts?.test;
  if (!testScript) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      reason: "no scripts.test defined in package.json",
    };
  }

  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;

  // On Windows, npm is a .cmd batch file that must be invoked through cmd.exe.
  // Only the fixed command "npm run test" is run — no user-supplied arguments —
  // so command injection is not possible.
  const isWindows = process.platform === "win32";
  const binary = isWindows ? "cmd.exe" : "npm";
  const args = isWindows ? ["/c", "npm", "run", "test"] : ["run", "test"];
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd: repoAbs,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 10, // 10 MB
      env: { ...process.env, CI: "true" }, // CI=true makes most test runners non-interactive
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stdout,
      stderr,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const timedOut = e.killed === true || e.signal === "SIGTERM";
    // Distinguish ENOENT (binary not found) from normal non-zero exit.
    if (e.code === "ENOENT" && !e.stdout && !e.stderr) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        reason: `could not execute npm (not found on PATH)`,
      };
    }
    return {
      exitCode: typeof e.code === "number" ? e.code : null,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      timedOut,
    };
  }
}
