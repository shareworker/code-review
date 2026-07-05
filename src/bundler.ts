import { getDiffForFileOrSynthesize } from "./git.js";
import { parseFileDiffs } from "./diff-parser.js";
import type { BundleFile, BundleReason, FileBundle } from "./types.js";

/** Character cap per bundle (counting diff text only). */
export const BUNDLE_CHAR_CAP = 20000;

/**
 * Identify the test counterpart of a source file, or vice versa.
 * Returns the paired path or null.
 *
 * Conventions:
 *   foo.test.ts     <-> foo.ts
 *   foo.spec.ts     <-> foo.ts
 *   foo_test.go     <-> foo.go
 *   foo_spec.go     <-> foo.go
 *   TestFoo.java    <-> Foo.java
 *   FooTest.java    <-> Foo.java
 */
export function findTestSourcePair(path: string, allFiles: string[]): string | null {
  const base = stripExt(path);
  const ext = getExt(path);

  // Test file -> source file.
  const testMatch = base.match(/^(.+)\.(test|spec)$/i) || base.match(/^(.+)[._](test|spec)$/i);
  if (testMatch) {
    const sourceBase = testMatch[1];
    const sourcePath = `${sourceBase}.${ext}`;
    if (allFiles.includes(sourcePath)) return sourcePath;
  }
  // Java: TestFoo.java <-> Foo.java, FooTest.java <-> Foo.java
  const javaTestMatch = base.match(/^Test(.+)$/);
  if (javaTestMatch && ext === "java") {
    const sourcePath = `${javaTestMatch[1]}.java`;
    if (allFiles.includes(sourcePath)) return sourcePath;
  }
  const javaTestSuffixMatch = base.match(/^(.+)Test$/);
  if (javaTestSuffixMatch && ext === "java") {
    const sourcePath = `${javaTestSuffixMatch[1]}.java`;
    if (allFiles.includes(sourcePath)) return sourcePath;
  }

  // Source file -> test file.
  for (const candidate of allFiles) {
    if (candidate === path) continue;
    const cBase = stripExt(candidate);
    const cExt = getExt(candidate);
    if (cExt !== ext) continue;
    const cTestMatch = cBase.match(/^(.+)\.(test|spec)$/i) || cBase.match(/^(.+)[._](test|spec)$/i);
    if (cTestMatch && cTestMatch[1] === base) return candidate;
    if (ext === "java") {
      if (cBase === `Test${base}` || cBase === `${base}Test`) return candidate;
    }
  }
  return null;
}

/**
 * Identify i18n variant files: same base name with different locale suffixes.
 * Locale suffixes: _en, _zh, _ja, _ko, _fr, _de, _es, _pt, _ru, _ar, etc.
 * The suffix sits before the file extension, e.g. messages_en.ts.
 */
const LOCALE_SUFFIX_RE = /[_-](en|zh|ja|ko|fr|de|es|pt|ru|ar|it|nl|pl|tr|vi|th|id|hi|bn|mx|tw|cn|hk|us|uk|br)(?:[_-][A-Z]{2})?(?=\.|$)/i;

export function findI18nVariants(path: string, allFiles: string[]): string[] {
  const base = path.replace(LOCALE_SUFFIX_RE, "");
  if (base === path) return []; // no locale suffix, not an i18n file
  const ext = getExt(path);
  const result: string[] = [];
  for (const candidate of allFiles) {
    if (candidate === path) continue;
    const cBase = candidate.replace(LOCALE_SUFFIX_RE, "");
    if (cBase === base && getExt(candidate) === ext) {
      result.push(candidate);
    }
  }
  return result;
}

function stripExt(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot <= slash) return path;
  return path.slice(0, dot);
}

function getExt(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot <= slash) return "";
  return path.slice(dot + 1);
}

/**
 * Read a single file's diff and build a BundleFile.
 * Returns null if the diff can't be read.
 */
async function buildBundleFile(
  repo: string,
  path: string,
  diffRef: string
): Promise<BundleFile | null> {
  try {
    const diff = await getDiffForFileOrSynthesize(repo, diffRef, path);
    const parsed = parseFileDiffs(diff)[0];
    return {
      path,
      diff,
      additions: parsed?.insertions ?? 0,
      deletions: parsed?.deletions ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Bundle files by test/source pairing and i18n variants, with a 20000 char cap.
 *
 * Algorithm:
 * 1. Build pairing groups (test/source pairs, i18n variant groups, singletons).
 * 2. For each group, read diffs and pack into bundles respecting the char cap.
 * 3. A single file whose diff alone exceeds the cap gets its own over-cap bundle.
 */
export async function bundleFiles(
  repo: string,
  files: string[],
  diffRef: string
): Promise<FileBundle[]> {
  if (files.length === 0) return [];

  const groups = buildPairingGroups(files);
  const bundles: FileBundle[] = [];
  let bundleIndex = 0;

  for (const group of groups) {
    const bundleFiles: BundleFile[] = [];
    for (const path of group.files) {
      const bf = await buildBundleFile(repo, path, diffRef);
      if (bf) bundleFiles.push(bf);
    }
    if (bundleFiles.length === 0) continue;

    // Pack into bundles respecting the char cap.
    let current: BundleFile[] = [];
    let currentChars = 0;
    for (const bf of bundleFiles) {
      const bfChars = bf.diff.length;
      if (current.length > 0 && currentChars + bfChars > BUNDLE_CHAR_CAP) {
        bundles.push(makeBundle(bundleIndex++, current, group.reason));
        current = [];
        currentChars = 0;
      }
      current.push(bf);
      currentChars += bfChars;
    }
    if (current.length > 0) {
      bundles.push(makeBundle(bundleIndex++, current, group.reason));
    }
  }

  return bundles;
}

interface PairingGroup {
  files: string[];
  reason: BundleReason;
}

/**
 * Build pairing groups from the file list.
 * Each file appears in exactly one group.
 */
function buildPairingGroups(files: string[]): PairingGroup[] {
  const remaining = new Set(files);
  const groups: PairingGroup[] = [];

  // Pass 1: test/source pairs.
  for (const file of files) {
    if (!remaining.has(file)) continue;
    const pair = findTestSourcePair(file, files);
    if (pair && remaining.has(pair)) {
      remaining.delete(file);
      remaining.delete(pair);
      groups.push({ files: [file, pair], reason: "test_source_pair" });
    }
  }

  // Pass 2: i18n variants.
  for (const file of files) {
    if (!remaining.has(file)) continue;
    const variants = findI18nVariants(file, files).filter((v) => remaining.has(v));
    if (variants.length > 0) {
      remaining.delete(file);
      for (const v of variants) remaining.delete(v);
      groups.push({ files: [file, ...variants], reason: "i18n_variants" });
    }
  }

  // Pass 3: singletons.
  for (const file of files) {
    if (!remaining.has(file)) continue;
    remaining.delete(file);
    groups.push({ files: [file], reason: "single_file" });
  }

  return groups;
}

function makeBundle(id: number, files: BundleFile[], reason: BundleReason): FileBundle {
  return {
    id: `bundle-${id}`,
    files,
    totalChars: files.reduce((sum, f) => sum + f.diff.length, 0),
    bundleReason: reason,
  };
}
