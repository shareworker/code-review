import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getImporters } from "../importers.js";

let repoDir: string;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-importers-"));
  return dir;
}

describe("getImporters", () => {
  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("finds static import references", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), "export const foo = 1;\n");
    await writeFile(join(repoDir, "src", "b.ts"), 'import { foo } from "./a";\n');
    const result = await getImporters(repoDir, { path: "src/a.ts" });
    expect(result.importers.some((p) => p.includes("b.ts"))).toBe(true);
  });

  it("finds require references", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.js"), "module.exports = { foo: 1 };\n");
    await writeFile(join(repoDir, "src", "b.js"), 'const a = require("./a");\n');
    const result = await getImporters(repoDir, { path: "src/a.js" });
    expect(result.importers.some((p) => p.includes("b.js"))).toBe(true);
  });

  it("finds export-from references", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), "export const foo = 1;\n");
    await writeFile(join(repoDir, "src", "b.ts"), 'export { foo } from "./a";\n');
    const result = await getImporters(repoDir, { path: "src/a.ts" });
    expect(result.importers.some((p) => p.includes("b.ts"))).toBe(true);
  });

  it("returns empty when no one imports the file", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "lonely.ts"), "export const x = 1;\n");
    const result = await getImporters(repoDir, { path: "src/lonely.ts" });
    expect(result.importers).toEqual([]);
  });

  it("does not identify bare package imports as importers", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), 'import React from "react";\n');
    // "react" is a bare package import — should not resolve to any file.
    const result = await getImporters(repoDir, { path: "src/react.ts" });
    expect(result.importers).toEqual([]);
  });

  it("skips node_modules and dist directories", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await mkdir(join(repoDir, "node_modules", "fake"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), "export const foo = 1;\n");
    // A file in node_modules that imports a.ts — should be skipped.
    await writeFile(
      join(repoDir, "node_modules", "fake", "index.ts"),
      'import { foo } from "../../src/a";\n'
    );
    const result = await getImporters(repoDir, { path: "src/a.ts" });
    expect(result.importers.every((p) => !p.includes("node_modules"))).toBe(true);
  });
});
