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
});
