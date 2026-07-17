import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("test script", () => {
  it("builds before running Vitest", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    const { test } = packageJson.scripts;

    expect(test.indexOf("build")).toBeGreaterThanOrEqual(0);
    expect(test.indexOf("build")).toBeLessThan(test.indexOf("vitest"));
  });
});
