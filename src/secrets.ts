import { getDiff, getDiffForFileOrSynthesize } from "./git.js";
import { parseFileDiffs } from "./diff-parser.js";
import type {
  ScanSecretsInput,
  ScanSecretsResult,
  SecretFinding,
} from "./types.js";

// ---------------------------------------------------------------------------
// Built-in secret patterns
// ---------------------------------------------------------------------------

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws_secret_key", regex: /\baws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  { name: "private_key_pem", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { name: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "generic_api_key", regex: /\b(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}["']?/gi },
  { name: "generic_token", regex: /\b(?:access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{20,}["']?/gi },
  { name: "generic_password", regex: /\bpassword\s*[:=]\s*["']?[^\s"']{8,}["']?/gi },
];

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  const len = s.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const HIGH_ENTROPY_MIN_LENGTH = 30;
const HIGH_ENTROPY_THRESHOLD = 4.5;

/**
 * Extract candidate string literals from a line of code for entropy checking.
 * Matches quoted strings and base64-like blobs.
 */
function extractStringLiterals(line: string): string[] {
  const results: string[] = [];
  // Double-quoted strings
  const dq = line.match(/"([^"\\]|\\.){30,}"/g);
  if (dq) results.push(...dq.map((s) => s.slice(1, -1)));
  // Single-quoted strings
  const sq = line.match(/'([^'\\]|\\.){30,}'/g);
  if (sq) results.push(...sq.map((s) => s.slice(1, -1)));
  // Backtick template strings
  const bq = line.match(/`([^`\\]|\\.){30,}`/g);
  if (bq) results.push(...bq.map((s) => s.slice(1, -1)));
  return results;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

function maskSecret(text: string): string {
  if (text.length <= 8) return "*".repeat(text.length);
  return text.slice(0, 4) + "*".repeat(Math.min(text.length - 8, 20)) + text.slice(-4);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Scan diff added lines for accidentally committed secrets.
 *
 * - Only scans lines that are ADDED in the diff (not unchanged historical content).
 * - Uses built-in regex patterns for known secret formats + Shannon entropy
 *   detection for high-entropy string literals.
 * - Never throws — non-git repo, invalid ref, and no-diff all return empty results.
 */
export async function scanSecrets(
  repo: string,
  input: ScanSecretsInput
): Promise<ScanSecretsResult> {
  const diffRef = input.diffRef ?? "HEAD";

  // Get the full diff for the given ref.
  let fullDiff: string;
  try {
    fullDiff = await getDiff(repo, diffRef);
  } catch {
    return { findings: [], reason: "could not read diff for given ref" };
  }

  // Also include untracked files in workspace mode.
  if (diffRef === "HEAD") {
    try {
      const { getUntrackedFiles, synthesizeUntrackedDiff } = await import("./git.js");
      const untracked = await getUntrackedFiles(repo);
      for (const f of untracked) {
        try {
          fullDiff += "\n" + await synthesizeUntrackedDiff(repo, f);
        } catch {
          // skip this untracked file
        }
      }
    } catch {
      // ignore
    }
  }

  if (!fullDiff.trim()) {
    return { findings: [] };
  }

  const fileDiffs = parseFileDiffs(fullDiff);
  const findings: SecretFinding[] = [];

  for (const fd of fileDiffs) {
    const filePath = fd.newPath.replace(/\\/g, "/");
    // Walk through hunks and scan only added lines.
    for (const hunk of fd.hunks) {
      let newLine = hunk.newStart;
      for (const hl of hunk.lines) {
        if (hl.type === "added") {
          scanLine(filePath, newLine, hl.content, findings);
        }
        if (hl.type === "added" || hl.type === "context") {
          newLine++;
        }
      }
    }
  }

  return { findings };
}

function scanLine(
  path: string,
  line: number,
  content: string,
  findings: SecretFinding[]
): void {
  // 1. Check known patterns.
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(content)) !== null) {
      findings.push({
        path,
        line,
        patternName: pattern.name,
        matchedText: maskSecret(match[0]),
      });
      // Avoid infinite loop on zero-length matches.
      if (match.index === pattern.regex.lastIndex) pattern.regex.lastIndex++;
    }
  }

  // 2. Check high-entropy string literals.
  const literals = extractStringLiterals(content);
  for (const lit of literals) {
    if (lit.length >= HIGH_ENTROPY_MIN_LENGTH && shannonEntropy(lit) >= HIGH_ENTROPY_THRESHOLD) {
      // Avoid duplicating if already caught by a known pattern.
      const alreadyFound = findings.some(
        (f) => f.path === path && f.line === line && f.matchedText === maskSecret(lit)
      );
      if (!alreadyFound) {
        findings.push({
          path,
          line,
          patternName: "high_entropy_string",
          matchedText: maskSecret(lit),
        });
      }
    }
  }
}
