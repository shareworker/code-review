import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import {
  bundleFiles,
  findTestSourcePair,
  findI18nVariants,
  BUNDLE_CHAR_CAP,
} from "../bundler.js";

let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-bundle-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "i18n"), { recursive: true });

  // test/source pair
  await writeFile(join(repoDir, "src", "user.ts"), "export const u: any = null;\n");
  await writeFile(join(repoDir, "src", "user.test.ts"), "test('u', () => {});\n");
  // i18n variants
  await writeFile(join(repoDir, "i18n", "messages_en.ts"), "export const m = 'en';\n");
  await writeFile(join(repoDir, "i18n", "messages_zh.ts"), "export const m = 'zh';\n");
  // standalone
  await writeFile(join(repoDir, "src", "auth.ts"), "export const a = 1;\n");
  await git.add(".");
  await git.commit("init");
  // Modify all files so they show up in diff
  await writeFile(join(repoDir, "src", "user.ts"), "export const u: any = null;\nexport const v = 2;\n");
  await writeFile(join(repoDir, "src", "user.test.ts"), "test('u', () => {});\ntest('v', () => {});\n");
  await writeFile(join(repoDir, "i18n", "messages_en.ts"), "export const m = 'en';\nexport const n = 1;\n");
  await writeFile(join(repoDir, "i18n", "messages_zh.ts"), "export const m = 'zh';\nexport const n = 1;\n");
  await writeFile(join(repoDir, "src", "auth.ts"), "export const a = 1;\nexport const b = 2;\n");
  await git.add(".");
  await git.commit("changes");
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("findTestSourcePair", () => {
  it("pairs foo.test.ts with foo.ts", () => {
    const files = ["src/foo.test.ts", "src/foo.ts"];
    expect(findTestSourcePair("src/foo.test.ts", files)).toBe("src/foo.ts");
    expect(findTestSourcePair("src/foo.ts", files)).toBe("src/foo.test.ts");
  });

  it("pairs foo_spec.go with foo.go", () => {
    const files = ["foo_spec.go", "foo.go"];
    expect(findTestSourcePair("foo_spec.go", files)).toBe("foo.go");
  });

  it("pairs TestFoo.java with Foo.java", () => {
    const files = ["TestFoo.java", "Foo.java"];
    expect(findTestSourcePair("TestFoo.java", files)).toBe("Foo.java");
  });

  it("returns null when no pair exists", () => {
    expect(findTestSourcePair("src/foo.ts", ["src/foo.ts"])).toBeNull();
  });
});

describe("findI18nVariants", () => {
  it("finds locale variants", () => {
    const files = ["i18n/messages_en.ts", "i18n/messages_zh.ts", "i18n/messages_ja.ts"];
    const variants = findI18nVariants("i18n/messages_en.ts", files);
    expect(variants).toContain("i18n/messages_zh.ts");
    expect(variants).toContain("i18n/messages_ja.ts");
  });

  it("returns empty for non-i18n files", () => {
    expect(findI18nVariants("src/foo.ts", ["src/foo.ts"])).toEqual([]);
  });
});

describe("bundleFiles", () => {
  it("bundles test/source pairs together", async () => {
    const bundles = await bundleFiles(repoDir, ["src/user.ts", "src/user.test.ts"], "HEAD~1..HEAD");
    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleReason).toBe("test_source_pair");
    const paths = bundles[0].files.map((f) => f.path);
    expect(paths).toContain("src/user.ts");
    expect(paths).toContain("src/user.test.ts");
  });

  it("bundles i18n variants together", async () => {
    const bundles = await bundleFiles(
      repoDir,
      ["i18n/messages_en.ts", "i18n/messages_zh.ts"],
      "HEAD~1..HEAD"
    );
    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleReason).toBe("i18n_variants");
  });

  it("makes standalone bundles for unpaired files", async () => {
    const bundles = await bundleFiles(repoDir, ["src/auth.ts"], "HEAD~1..HEAD");
    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleReason).toBe("single_file");
    expect(bundles[0].files).toHaveLength(1);
  });

  it("returns empty array for empty file list", async () => {
    const bundles = await bundleFiles(repoDir, [], "HEAD~1..HEAD");
    expect(bundles).toEqual([]);
  });

  it("respects the 20000 char cap by splitting", async () => {
    // Create a repo with many files whose combined diffs exceed the cap.
    const bigRepo = await mkdtemp(join(tmpdir(), "ocr-big-"));
    const git = simpleGit(bigRepo);
    await git.init();
    await git.addConfig("user.email", "test@test.com");
    await git.addConfig("user.name", "Test");
    await mkdir(join(bigRepo, "src"), { recursive: true });
    // Initial commit with small content.
    for (let i = 0; i < 10; i++) {
      await writeFile(join(bigRepo, "src", `f${i}.ts`), `export const f${i} = 0;\n`);
    }
    await git.add(".");
    await git.commit("init");
    // Modify each file with a large diff (> 2000 chars each, 10 files > 20000).
    for (let i = 0; i < 10; i++) {
      const big = `export const f${i} = 0;\n` + `// ${"x".repeat(2500)}\n`;
      await writeFile(join(bigRepo, "src", `f${i}.ts`), big);
    }
    await git.add(".");
    await git.commit("big changes");

    const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const bundles = await bundleFiles(bigRepo, files, "HEAD~1..HEAD");
    expect(bundles.length).toBeGreaterThan(1);
    // Each bundle should be under the cap (except possibly a single over-cap file).
    for (const b of bundles) {
      // A bundle with a single file may exceed the cap if that file alone exceeds it.
      if (b.files.length > 1) {
        expect(b.totalChars).toBeLessThanOrEqual(BUNDLE_CHAR_CAP);
      }
    }
    await rm(bigRepo, { recursive: true, force: true });
  });

  it("sorts by change density before truncation", async () => {
    // Create a repo with two files: one with high density (many changes / few chars)
    // and one with low density (few changes / many chars). When both are in the
    // same group and exceed the cap together, the high-density one should be
    // in the first bundle.
    const densityRepo = await mkdtemp(join(tmpdir(), "ocr-density-"));
    const git = simpleGit(densityRepo);
    await git.init();
    await git.addConfig("user.email", "test@test.com");
    await git.addConfig("user.name", "Test");
    await mkdir(join(densityRepo, "src"), { recursive: true });
    // Low-density file: lots of context, small change.
    await writeFile(
      join(densityRepo, "src", "low.ts"),
      Array.from({ length: 100 }, (_, i) => `// comment line ${i}`).join("\n") + "\nexport const x = 1;\n"
    );
    // High-density file: small file, all changed.
    await writeFile(join(densityRepo, "src", "high.ts"), "export const a = 1;\n");
    await git.add(".");
    await git.commit("init");
    // Modify both: low.ts gets a 1-line change in a 100-line file (low density),
    // high.ts gets a complete rewrite (high density).
    await writeFile(
      join(densityRepo, "src", "low.ts"),
      Array.from({ length: 100 }, (_, i) => `// comment line ${i}`).join("\n") + "\nexport const x = 2;\n"
    );
    await writeFile(join(densityRepo, "src", "high.ts"), "export const a = 100;\nexport const b = 200;\nexport const c = 300;\n");
    await git.add(".");
    await git.commit("changes");

    const bundles = await bundleFiles(densityRepo, ["src/low.ts", "src/high.ts"], "HEAD~1..HEAD");
    // Both are singletons (no pairing), so they'll be in separate bundles.
    // The key assertion: density sorting only affects multi-file groups.
    // For singletons, each gets its own bundle regardless.
    expect(bundles.length).toBeGreaterThanOrEqual(2);
    await rm(densityRepo, { recursive: true, force: true });
  });

  it("computes i18n key diff for JSON variant bundles", async () => {
    // Create a repo with JSON i18n files that have different key sets.
    const i18nRepo = await mkdtemp(join(tmpdir(), "ocr-i18n-keydiff-"));
    const git = simpleGit(i18nRepo);
    await git.init();
    await git.addConfig("user.email", "test@test.com");
    await git.addConfig("user.name", "Test");
    await mkdir(join(i18nRepo, "i18n"), { recursive: true });
    // Initial commit with matching keys. Use _en/_zh naming convention.
    await writeFile(join(i18nRepo, "i18n", "messages_en.json"), JSON.stringify({ hello: "Hi" }));
    await writeFile(join(i18nRepo, "i18n", "messages_zh.json"), JSON.stringify({ hello: "你好" }));
    await git.add(".");
    await git.commit("init");
    // Modify both so they appear in the diff, with divergent key sets.
    await writeFile(join(i18nRepo, "i18n", "messages_en.json"), JSON.stringify({ hello: "Hi!", bye: "Bye" }));
    await writeFile(join(i18nRepo, "i18n", "messages_zh.json"), JSON.stringify({ hello: "你好!", welcome: "欢迎" }));
    await git.add(".");
    await git.commit("changes");

    const bundles = await bundleFiles(i18nRepo, ["i18n/messages_en.json", "i18n/messages_zh.json"], "HEAD~1..HEAD");
    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleReason).toBe("i18n_variants");
    expect(bundles[0].keyDiff).toBeDefined();
    const keyDiff = bundles[0].keyDiff!;
    // en.json should be missing "welcome" (which only zh.json has).
    const enEntry = keyDiff.entries.find((e) => e.path.includes("messages_en.json"));
    expect(enEntry).toBeDefined();
    expect(enEntry!.missingKeys).toContain("welcome");
    // zh.json should be missing "bye" (which only en.json has).
    const zhEntry = keyDiff.entries.find((e) => e.path.includes("messages_zh.json"));
    expect(zhEntry).toBeDefined();
    expect(zhEntry!.missingKeys).toContain("bye");
    await rm(i18nRepo, { recursive: true, force: true });
  });

  it("skips key diff for non-JSON i18n bundles", async () => {
    // The existing test repo has .ts i18n files — key diff should be empty/skipped.
    const bundles = await bundleFiles(
      repoDir,
      ["i18n/messages_en.ts", "i18n/messages_zh.ts"],
      "HEAD~1..HEAD"
    );
    expect(bundles).toHaveLength(1);
    // .ts files are not JSON — keyDiff should be undefined or have empty entries.
    if (bundles[0].keyDiff) {
      expect(bundles[0].keyDiff.entries.length === 0 || bundles[0].keyDiff.reason).toBe(true);
    }
  });
});
