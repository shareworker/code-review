import { describe, it, expect } from "vitest";
import { dedupeComments } from "../dedupe.js";
import type { CommentForDedupe } from "../types.js";

describe("dedupeComments", () => {
  it("identifies highly similar duplicate comments", () => {
    const comments: CommentForDedupe[] = [
      { path: "src/a.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
      { path: "src/b.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
    ];
    const result = dedupeComments({ comments });
    expect(result.kept.length).toBe(1);
    expect(result.dropped.length).toBe(1);
    // Should keep the one with alphabetically-first path.
    expect(result.kept[0].path).toBe("src/a.ts");
    expect(result.dropped[0].duplicateOf.path).toBe("src/a.ts");
  });

  it("does not dedupe comments with similar content but different existing_code", () => {
    const comments: CommentForDedupe[] = [
      { path: "src/a.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
      { path: "src/b.ts", content: "Avoid using any type here", existingCode: "const y: any = 2;" },
    ];
    const result = dedupeComments({ comments });
    // existing_code is different (not overlapping) → both kept.
    expect(result.kept.length).toBe(2);
    expect(result.dropped.length).toBe(0);
  });

  it("does not dedupe comments with low similarity", () => {
    const comments: CommentForDedupe[] = [
      { path: "src/a.ts", content: "Fix the SQL injection vulnerability", existingCode: "query = 'SELECT * FROM users'" },
      { path: "src/b.ts", content: "Add null check for user input", existingCode: "const data = input.value;" },
    ];
    const result = dedupeComments({ comments });
    expect(result.kept.length).toBe(2);
    expect(result.dropped.length).toBe(0);
  });

  it("returns empty for empty input", () => {
    const result = dedupeComments({ comments: [] });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("respects custom similarity threshold", () => {
    const comments: CommentForDedupe[] = [
      { path: "src/a.ts", content: "Avoid using any type in this function parameter", existingCode: "function foo(x) {}" },
      { path: "src/b.ts", content: "Avoid using any type in this function return", existingCode: "function foo(x) {}" },
    ];
    // With default threshold 0.6, these are similar enough (most words overlap).
    const defaultResult = dedupeComments({ comments });
    expect(defaultResult.dropped.length).toBe(1);

    // With a very high threshold, they should NOT be deduped.
    const strictResult = dedupeComments({ comments, similarityThreshold: 0.99 });
    expect(strictResult.dropped.length).toBe(0);
    expect(strictResult.kept.length).toBe(2);
  });

  it("handles comments without existing_code", () => {
    const comments: CommentForDedupe[] = [
      { path: "src/a.ts", content: "This function is too complex" },
      { path: "src/b.ts", content: "This function is too complex" },
    ];
    const result = dedupeComments({ comments });
    // Both have no existing_code (empty/undefined) → code matches vacuously.
    expect(result.kept.length).toBe(1);
    expect(result.dropped.length).toBe(1);
  });

  it("deduplicates across multiple similar comments keeping only one", () => {
    const comments: CommentForDedupe[] = [
      { path: "src/a.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
      { path: "src/b.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
      { path: "src/c.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
    ];
    const result = dedupeComments({ comments });
    expect(result.kept.length).toBe(1);
    expect(result.dropped.length).toBe(2);
    expect(result.kept[0].path).toBe("src/a.ts");
  });

  it("duplicateOf always points to a kept comment regardless of input order", () => {
    // Reverse-alphabetical input order — exercises the swap path that previously
    // produced duplicateOf chains through dropped comments.
    const comments: CommentForDedupe[] = [
      { path: "src/c.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
      { path: "src/b.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
      { path: "src/a.ts", content: "Avoid using any type here", existingCode: "const x: any = 1;" },
    ];
    const result = dedupeComments({ comments });
    expect(result.kept.length).toBe(1);
    expect(result.kept[0].path).toBe("src/a.ts");
    // Every dropped comment's duplicateOf must reference a kept comment.
    const keptPaths = new Set(result.kept.map((c) => c.path));
    for (const d of result.dropped) {
      expect(keptPaths.has(d.duplicateOf.path)).toBe(true);
    }
  });
});
