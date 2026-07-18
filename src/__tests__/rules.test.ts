import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchRules, BUILT_IN_DEFAULT_RULE, BUILT_IN_LANGUAGE_RULES } from "../rules.js";

let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-rules-"));
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("matchRules", () => {
  it("returns built-in generic default when no rules.json exists and path matches no language rule", async () => {
    // .txt is not covered by any built-in language rule → falls through to generic default.
    const result = await matchRules(repoDir, "src/foo.txt");
    expect(result.usedDefault).toBe(true);
    expect(result.matchedRules).toEqual([]);
    expect(result.promptSection).toBe(BUILT_IN_DEFAULT_RULE);
  });

  it("matches a user rule by glob pattern (takes precedence over built-in language rule)", async () => {
    await mkdir(join(repoDir, ".code-review"), { recursive: true });
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [
          { path: "**/*.ts", rule: "Check for any types and proper null handling" },
          { path: "**/*.xml", rule: "Check SQL for injection risks" },
        ],
      })
    );
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(false);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].pattern).toBe("**/*.ts");
    expect(result.promptSection).toContain("Check for any types");
  });

  it("uses first match wins when multiple patterns match", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [
          { path: "**/*.ts", rule: "First rule" },
          { path: "**/foo.ts", rule: "Second rule" },
        ],
      })
    );
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.matchedRules[0].rule).toBe("First rule");
  });

  it("falls back to built-in language rule when no user rule matches", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [{ path: "**/*.go", rule: "Go rule" }],
      })
    );
    // .ts matches the built-in TS/JS rule, not the user's .go rule.
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(true);
    expect(result.promptSection).toContain("TypeScript / JavaScript");
  });

  it("falls back to generic default when no user rule and no language rule matches", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [{ path: "**/*.go", rule: "Go rule" }],
      })
    );
    // .txt matches neither user rules nor built-in language rules.
    const result = await matchRules(repoDir, "src/foo.txt");
    expect(result.usedDefault).toBe(true);
    expect(result.promptSection).toBe(BUILT_IN_DEFAULT_RULE);
  });

  it("falls back to built-in language rule when rules.json is unparseable", async () => {
    await writeFile(join(repoDir, ".code-review", "rules.json"), "{ invalid json }");
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(true);
    expect(result.promptSection).toContain("TypeScript / JavaScript");
  });

  it("normalizes backslashes in path", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [{ path: "**/*.ts", rule: "TS rule" }],
      })
    );
    const result = await matchRules(repoDir, "src\\foo.ts");
    expect(result.path).toBe("src/foo.ts");
    expect(result.usedDefault).toBe(false);
  });

  it("matches case-insensitively", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [{ path: "**/*.TS", rule: "Upper rule" }],
      })
    );
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(false);
  });
});

describe("BUILT_IN_LANGUAGE_RULES", () => {
  // Clean up any rules.json left by the matchRules tests so language rules are tested in isolation.
  beforeAll(async () => {
    await rm(join(repoDir, ".code-review"), { recursive: true, force: true });
  });

  it("includes a TS/JS rule covering ts/tsx/js/jsx/mjs/cjs", async () => {
    const tsResult = await matchRules(repoDir, "src/foo.ts");
    expect(tsResult.promptSection).toContain("TypeScript / JavaScript");

    const tsxResult = await matchRules(repoDir, "src/foo.tsx");
    expect(tsxResult.promptSection).toContain("TypeScript / JavaScript");

    const jsResult = await matchRules(repoDir, "src/foo.js");
    expect(jsResult.promptSection).toContain("TypeScript / JavaScript");

    const mjsResult = await matchRules(repoDir, "src/foo.mjs");
    expect(mjsResult.promptSection).toContain("TypeScript / JavaScript");
  });

  it("includes a package.json-specific rule", async () => {
    const result = await matchRules(repoDir, "package.json");
    expect(result.promptSection).toContain("package.json");
    expect(result.promptSection).toContain("Dependency hygiene");
  });

  it("includes a JSON-specific rule for non-package.json JSON files", async () => {
    const result = await matchRules(repoDir, "tsconfig.json");
    expect(result.promptSection).toContain("JSON");
    expect(result.promptSection).toContain("trailing commas");
  });

  it("includes a YAML rule for .yaml and .yml", async () => {
    const yamlResult = await matchRules(repoDir, "config.yaml");
    expect(yamlResult.promptSection).toContain("YAML");
    expect(yamlResult.promptSection).toContain("Indentation");

    const ymlResult = await matchRules(repoDir, "config.yml");
    expect(ymlResult.promptSection).toContain("YAML");
  });

  it("includes a GitHub Actions workflow rule for .github/workflows/**", async () => {
    const result = await matchRules(repoDir, ".github/workflows/ci.yml");
    expect(result.promptSection).toContain("GitHub Actions Workflow");
    expect(result.promptSection).toContain("pull_request_target");
  });

  it("distinguishes file types by extension (no cross-contamination)", async () => {
    // A .ts file should NOT get the YAML rule.
    const tsResult = await matchRules(repoDir, "src/foo.ts");
    expect(tsResult.promptSection).not.toContain("Indentation");
    // A .yaml file should NOT get the TS rule.
    const yamlResult = await matchRules(repoDir, "config.yaml");
    expect(yamlResult.promptSection).not.toContain("TypeScript / JavaScript");
  });

  it("first match wins in the built-in language rules table", async () => {
    // package.json matches both "**/package.json" and "**/*.json" — the
    // package.json-specific rule should win because it appears first.
    const result = await matchRules(repoDir, "package.json");
    expect(result.promptSection).toContain("package.json");
    expect(result.promptSection).toContain("Dependency hygiene");
    // It should NOT contain the generic JSON rule's "trailing commas" line.
    expect(result.promptSection).not.toContain("trailing commas");
  });

  it("includes a Python rule for .py files", async () => {
    const result = await matchRules(repoDir, "src/app.py");
    expect(result.promptSection).toContain("Python");
    expect(result.promptSection).toContain("Exception handling");
    expect(result.promptSection).toContain("eval()");
  });

  it("includes a Go rule for .go files", async () => {
    const result = await matchRules(repoDir, "src/server.go");
    expect(result.promptSection).toContain("Go");
    expect(result.promptSection).toContain("Error handling");
    expect(result.promptSection).toContain("Goroutine leaks");
  });

  it("includes a Java rule for .java files", async () => {
    const result = await matchRules(repoDir, "src/Main.java");
    expect(result.promptSection).toContain("Java");
    expect(result.promptSection).toContain("try-with-resources");
    expect(result.promptSection).toContain("Concurrency");
  });

  it("includes a C/C++ rule for c/h/cpp/cc/cxx/hpp files", async () => {
    const cResult = await matchRules(repoDir, "src/foo.c");
    expect(cResult.promptSection).toContain("C / C++");
    expect(cResult.promptSection).toContain("Memory safety");
    expect(cResult.promptSection).toContain("Buffer safety");

    const hResult = await matchRules(repoDir, "src/foo.h");
    expect(hResult.promptSection).toContain("C / C++");

    const cppResult = await matchRules(repoDir, "src/foo.cpp");
    expect(cppResult.promptSection).toContain("C / C++");
    expect(cppResult.promptSection).toContain("Rule of Zero/Three/Five");

    const hppResult = await matchRules(repoDir, "src/foo.hpp");
    expect(hppResult.promptSection).toContain("C / C++");
  });

  it("includes a Rust rule for .rs files", async () => {
    const result = await matchRules(repoDir, "src/lib.rs");
    expect(result.promptSection).toContain("Rust");
    expect(result.promptSection).toContain("unwrap()");
    expect(result.promptSection).toContain("SAFETY");
  });

  it("includes a QML/Qt rule for .qml files", async () => {
    const result = await matchRules(repoDir, "src/ui/Main.qml");
    expect(result.promptSection).toContain("QML / Qt");
    expect(result.promptSection).toContain("Property bindings");
    expect(result.promptSection).toContain("Object ownership");
  });

  it("includes an XML rule for .xml files (SQL mapper)", async () => {
    const result = await matchRules(repoDir, "src/mapper.xml");
    expect(result.promptSection).toContain("XML");
    expect(result.promptSection).toContain("SQL injection");
    expect(result.promptSection).toContain("MyBatis");
  });

  it("includes a Dockerfile rule for Dockerfile and variants", async () => {
    const result = await matchRules(repoDir, "Dockerfile");
    expect(result.promptSection).toContain("Dockerfile");
    expect(result.promptSection).toContain("Base image pinning");
    expect(result.promptSection).toContain("Non-root user");

    const variantResult = await matchRules(repoDir, "Dockerfile.prod");
    expect(variantResult.promptSection).toContain("Dockerfile");
  });

  it("second batch rules do not cross-contaminate with first batch", async () => {
    // A .py file should NOT get the TS rule.
    const pyResult = await matchRules(repoDir, "src/app.py");
    expect(pyResult.promptSection).not.toContain("TypeScript / JavaScript");
    // A .go file should NOT get the Python rule.
    const goResult = await matchRules(repoDir, "src/server.go");
    expect(goResult.promptSection).not.toContain("Python");
    expect(goResult.promptSection).not.toContain("eval()");
  });

  it("C/C++, Rust, and QML rules do not cross-contaminate with each other or other rules", async () => {
    // A .rs file should NOT get the C/C++ rule.
    const rustResult = await matchRules(repoDir, "src/lib.rs");
    expect(rustResult.promptSection).not.toContain("C / C++");
    // A .cpp file should NOT get the Rust rule.
    const cppResult = await matchRules(repoDir, "src/main.cpp");
    expect(cppResult.promptSection).not.toContain("Rust");
    // A .qml file should NOT get the C/C++ or Rust rule.
    const qmlResult = await matchRules(repoDir, "src/Main.qml");
    expect(qmlResult.promptSection).not.toContain("C / C++");
    expect(qmlResult.promptSection).not.toContain("Rust");
    // A .c file should NOT get the Java rule.
    const cResult = await matchRules(repoDir, "src/main.c");
    expect(cResult.promptSection).not.toContain("try-with-resources");
  });
});

describe("BUILT_IN_DEFAULT_RULE", () => {
  it("covers the five review dimensions", () => {
    expect(BUILT_IN_DEFAULT_RULE).toContain("Correctness");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Security");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Performance");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Maintainability");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Test Coverage");
  });
});
