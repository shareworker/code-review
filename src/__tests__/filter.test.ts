import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXCLUDE,
  isBinaryByExtension,
  matchAny,
  filterFiles,
  loadFilterConfig,
} from "../filter.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isBinaryByExtension", () => {
  it("detects binary extensions case-insensitively", () => {
    expect(isBinaryByExtension("foo.png")).toBe(true);
    expect(isBinaryByExtension("foo.PNG")).toBe(true);
    expect(isBinaryByExtension("foo.zip")).toBe(true);
    expect(isBinaryByExtension("foo.ts")).toBe(false);
    expect(isBinaryByExtension("foo.js")).toBe(false);
  });
});

describe("matchAny", () => {
  it("matches glob patterns case-insensitively", () => {
    expect(matchAny("src/foo.ts", ["**/*.ts"])).toBe(true);
    expect(matchAny("src/foo.TS", ["**/*.ts"])).toBe(true);
    expect(matchAny("src/foo.js", ["**/*.ts"])).toBe(false);
  });

  it("handles brace expansion", () => {
    expect(matchAny("src/foo.ts", ["**/*.{ts,js}"])).toBe(true);
    expect(matchAny("src/foo.js", ["**/*.{ts,js}"])).toBe(true);
    expect(matchAny("src/foo.go", ["**/*.{ts,js}"])).toBe(false);
  });
});

describe("DEFAULT_EXCLUDE", () => {
  it("includes common lock and min files", () => {
    expect(DEFAULT_EXCLUDE).toContain("**/*.lock");
    expect(DEFAULT_EXCLUDE).toContain("**/package-lock.json");
    expect(DEFAULT_EXCLUDE).toContain("**/*.min.js");
    expect(DEFAULT_EXCLUDE).toContain("**/*.map");
  });
});

describe("filterFiles", () => {
  const config = { include: [] as string[], exclude: DEFAULT_EXCLUDE };

  it("filters out default blacklisted files", () => {
    const files = ["src/foo.ts", "src/foo.lock", "package-lock.json", "src/foo.min.js"];
    const { kept, filtered } = filterFiles(files, config);
    expect(kept).toEqual(["src/foo.ts"]);
    expect(filtered).toBe(3);
  });

  it("filters out binary files by extension", () => {
    const files = ["src/foo.ts", "src/logo.png", "src/data.zip"];
    const { kept, filtered } = filterFiles(files, config);
    expect(kept).toEqual(["src/foo.ts"]);
    expect(filtered).toBe(2);
  });

  it("restricts to include patterns when present", () => {
    const files = ["src/foo.ts", "src/foo.js", "src/foo.go"];
    const { kept } = filterFiles(files, { include: ["**/*.ts"], exclude: [] });
    expect(kept).toEqual(["src/foo.ts"]);
  });

  it("keeps all non-excluded when no include patterns", () => {
    const files = ["src/foo.ts", "src/foo.js"];
    const { kept } = filterFiles(files, { include: [], exclude: ["**/*.lock"] });
    expect(kept).toEqual(["src/foo.ts", "src/foo.js"]);
  });

  it("normalizes backslashes to forward slashes", () => {
    const files = ["src\\foo.ts", "src\\foo.lock"];
    const { kept } = filterFiles(files, config);
    expect(kept).toEqual(["src/foo.ts"]);
  });
});

describe("loadFilterConfig", () => {
  let repoDir: string;

  it("returns built-in defaults when no rules.json exists", async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ocr-filter-"));
    try {
      const config = await loadFilterConfig(repoDir);
      expect(config.exclude).toContain("**/*.lock");
      expect(config.include).toEqual([]);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("merges user exclude with built-in defaults", async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ocr-filter2-"));
    try {
      await mkdir(join(repoDir, ".code-review"), { recursive: true });
      await writeFile(
        join(repoDir, ".code-review", "rules.json"),
        JSON.stringify({
          filters: {
            exclude: ["**/*.generated.ts"],
            include: ["**/*.ts"],
          },
        })
      );
      const config = await loadFilterConfig(repoDir);
      expect(config.exclude).toContain("**/*.lock");
      expect(config.exclude).toContain("**/*.generated.ts");
      expect(config.include).toEqual(["**/*.ts"]);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
