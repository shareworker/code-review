import { describe, it, expect } from "vitest";
import {
  parseFileDiffs,
  parseHunks,
  normalizeLine,
  splitAndNormalize,
  extractSideLines,
  matchConsecutive,
  getAddedLineNumbers,
} from "../diff-parser.js";

const SAMPLE_DIFF = `diff --git a/foo.ts b/foo.ts
index 123..456 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;
`;

const RENAME_DIFF = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 123..456 100644
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-old line
+new line
`;

const NEW_FILE_DIFF = `diff --git a/new.ts b/new.ts
new file mode 100644
index 000..456
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+const x = 1;
+const y = 2;
`;

const BINARY_DIFF = `diff --git a/binary.png b/binary.png
index 123..456 100644
Binary files a/binary.png and b/binary.png differ
`;

const DELETED_DIFF = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 123..000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;
`;

describe("normalizeLine", () => {
  it("trims whitespace and trailing \\r but preserves +/- as code", () => {
    expect(normalizeLine("  const a = 1; \r")).toBe("const a = 1;");
    expect(normalizeLine("const x = -1;")).toBe("const x = -1;");
    expect(normalizeLine("+const a = 1;")).toBe("+const a = 1;");
  });
});

describe("splitAndNormalize", () => {
  it("splits and filters blank lines", () => {
    const result = splitAndNormalize("const a = 1;\n\nconst b = 2;");
    expect(result).toEqual(["const a = 1;", "const b = 2;"]);
  });
});

describe("parseFileDiffs", () => {
  it("parses a simple modified file", () => {
    const diffs = parseFileDiffs(SAMPLE_DIFF);
    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    expect(d.oldPath).toBe("foo.ts");
    expect(d.newPath).toBe("foo.ts");
    expect(d.isBinary).toBe(false);
    expect(d.isNew).toBe(false);
    expect(d.isDeleted).toBe(false);
    expect(d.insertions).toBe(1);
    expect(d.deletions).toBe(0);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].lines).toHaveLength(4);
    expect(d.hunks[0].lines[0].type).toBe("context");
    expect(d.hunks[0].lines[1].type).toBe("added");
  });

  it("parses a renamed file", () => {
    const diffs = parseFileDiffs(RENAME_DIFF);
    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    expect(d.isRenamed).toBe(true);
    expect(d.oldPath).toBe("old.ts");
    expect(d.newPath).toBe("new.ts");
    expect(d.insertions).toBe(1);
    expect(d.deletions).toBe(1);
  });

  it("parses a new file", () => {
    const diffs = parseFileDiffs(NEW_FILE_DIFF);
    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    expect(d.isNew).toBe(true);
    expect(d.newPath).toBe("new.ts");
    expect(d.oldPath).toBe("");
    expect(d.insertions).toBe(2);
    expect(d.deletions).toBe(0);
  });

  it("parses a binary file with no hunks", () => {
    const diffs = parseFileDiffs(BINARY_DIFF);
    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    expect(d.isBinary).toBe(true);
    expect(d.hunks).toHaveLength(0);
  });

  it("parses a deleted file", () => {
    const diffs = parseFileDiffs(DELETED_DIFF);
    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    expect(d.isDeleted).toBe(true);
    expect(d.newPath).toBe("");
    expect(d.oldPath).toBe("gone.ts");
    expect(d.deletions).toBe(2);
  });

  it("parses multiple files in one diff", () => {
    const multi = SAMPLE_DIFF + "\n" + NEW_FILE_DIFF;
    const diffs = parseFileDiffs(multi);
    expect(diffs).toHaveLength(2);
    expect(diffs[0].newPath).toBe("foo.ts");
    expect(diffs[1].newPath).toBe("new.ts");
  });

  it("returns empty array for empty input", () => {
    expect(parseFileDiffs("")).toEqual([]);
    expect(parseFileDiffs("   ")).toEqual([]);
  });
});

describe("parseHunks", () => {
  it("parses hunk headers and classifies lines", () => {
    const hunks = parseHunks(SAMPLE_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].oldCount).toBe(3);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newCount).toBe(4);
  });

  it("handles hunk header without count (defaults to 1)", () => {
    const diff = `@@ -5 +5,2 @@
 keep
+added
`;
    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldCount).toBe(1);
  });
});

describe("extractSideLines", () => {
  it("extracts new-side lines with new-file line numbers", () => {
    const hunks = parseHunks(SAMPLE_DIFF);
    const newSide = extractSideLines(hunks[0], true);
    expect(newSide).toHaveLength(4);
    expect(newSide[0]).toEqual({ lineNum: 1, content: "const a = 1;" });
    expect(newSide[1]).toEqual({ lineNum: 2, content: "const b = 2;" });
    expect(newSide[2]).toEqual({ lineNum: 3, content: "const c = 3;" });
  });

  it("extracts old-side lines with old-file line numbers", () => {
    const hunks = parseHunks(SAMPLE_DIFF);
    const oldSide = extractSideLines(hunks[0], false);
    expect(oldSide).toHaveLength(3);
    expect(oldSide[0]).toEqual({ lineNum: 1, content: "const a = 1;" });
    expect(oldSide[1]).toEqual({ lineNum: 2, content: "const c = 3;" });
  });
});

describe("matchConsecutive", () => {
  it("finds a consecutive run", () => {
    const side = [
      { lineNum: 1, content: "a" },
      { lineNum: 2, content: "b" },
      { lineNum: 3, content: "c" },
    ];
    const result = matchConsecutive(side, ["b", "c"]);
    expect(result).toEqual({ start: 2, end: 3 });
  });

  it("returns null when no match", () => {
    const side = [{ lineNum: 1, content: "a" }];
    expect(matchConsecutive(side, ["b"])).toBeNull();
  });

  it("returns null for empty target", () => {
    const side = [{ lineNum: 1, content: "a" }];
    expect(matchConsecutive(side, [])).toBeNull();
  });
});

describe("getAddedLineNumbers", () => {
  it("returns the set of added line numbers", () => {
    const hunks = parseHunks(SAMPLE_DIFF);
    const added = getAddedLineNumbers(hunks);
    expect(added.has(2)).toBe(true);
    expect(added.size).toBe(1);
  });
});
