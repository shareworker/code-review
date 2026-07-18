import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import { scanSecrets } from "../secrets.js";

let repoDir: string;
let git: ReturnType<typeof simpleGit>;

async function makeRepo(): Promise<void> {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-secrets-"));
  git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
}

describe("scanSecrets", () => {
  beforeEach(makeRepo);

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("detects AWS access key in an added line", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "config.ts"), 'const key = "placeholder";\n');
    await git.add(".");
    await git.commit("initial");
    await writeFile(
      join(repoDir, "src", "config.ts"),
      'const key = "placeholder";\nconst secret = "AKIAIOSFODNN7EXAMPLE";\n'
    );
    const result = await scanSecrets(repoDir, { diffRef: "HEAD" });
    expect(result.findings.some((f) => f.patternName === "aws_access_key")).toBe(true);
    expect(result.findings.some((f) => f.path.includes("config.ts"))).toBe(true);
  });

  it("detects private key PEM header", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "key.pem"), "placeholder\n");
    await git.add(".");
    await git.commit("initial");
    await writeFile(
      join(repoDir, "src", "key.pem"),
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAI...\n-----END RSA PRIVATE KEY-----\n"
    );
    const result = await scanSecrets(repoDir, { diffRef: "HEAD" });
    expect(result.findings.some((f) => f.patternName === "private_key_pem")).toBe(true);
  });

  it("does not report secrets in unchanged historical lines", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "old.ts"), 'const old = "AKIAIOSFODNN7EXAMPLE";\n');
    await git.add(".");
    await git.commit("has secret");
    // Make an unrelated change that does NOT touch the secret line.
    await writeFile(join(repoDir, "src", "old.ts"), 'const old = "AKIAIOSFODNN7EXAMPLE";\nconst x = 1;\n');
    const result = await scanSecrets(repoDir, { diffRef: "HEAD" });
    // The secret line is context (unchanged), not added — should not be reported.
    expect(result.findings.every((f) => !f.matchedText.includes("IOSFODNN7EXAMPLE"))).toBe(true);
  });

  it("returns empty when diff has no secrets", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "clean.ts"), 'const x = 1;\n');
    await git.add(".");
    await git.commit("initial");
    await writeFile(join(repoDir, "src", "clean.ts"), 'const x = 2;\n');
    const result = await scanSecrets(repoDir, { diffRef: "HEAD" });
    expect(result.findings).toEqual([]);
  });

  it("masks matched text in output", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "config.ts"), "placeholder\n");
    await git.add(".");
    await git.commit("initial");
    await writeFile(join(repoDir, "src", "config.ts"), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    const result = await scanSecrets(repoDir, { diffRef: "HEAD" });
    const awsFinding = result.findings.find((f) => f.patternName === "aws_access_key");
    expect(awsFinding).toBeDefined();
    expect(awsFinding!.matchedText).not.toContain("IOSFODNN7EXAMPLE");
  });
});
