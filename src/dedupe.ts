import type {
  CommentForDedupe,
  DedupeCommentsInput,
  DedupeCommentsResult,
  DedupeDroppedItem,
} from "./types.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

/** Normalize comment content for comparison: lowercase, strip punctuation, split into words. */
function normalizeContent(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0)
  );
}

/** Normalize existing_code for comparison. */
function normalizeCode(code: string | undefined): string {
  return (code ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Compute Jaccard similarity between two word sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Deterministically deduplicate review comments by text similarity.
 *
 * - Normalizes each comment's content (lowercase, strip punctuation, tokenize).
 * - Computes pairwise Jaccard similarity of word sets.
 * - Comments with similarity >= threshold AND existing_code that is identical
 *   or highly overlapping are considered duplicates.
 * - Among duplicates, keeps the one with the alphabetically-first path.
 * - Does NOT call any LLM or semantic similarity model.
 */
export function dedupeComments(
  input: DedupeCommentsInput
): DedupeCommentsResult {
  const threshold = input.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const comments = input.comments;

  if (comments.length === 0) {
    return { kept: [], dropped: [] };
  }

  // Pre-compute normalized forms.
  const normalized = comments.map((c) => ({
    comment: c,
    words: normalizeContent(c.content),
    code: normalizeCode(c.existingCode),
  }));

  // Two-pass grouping:
  //   Pass 1 — union-find style: assign each comment to a duplicate group.
  //   Pass 2 — for each group, pick the alphabetically-first path as the
  //            representative (kept); all others are dropped with
  //            duplicateOf pointing at that representative.
  // This guarantees the spec invariant: every dropped comment's duplicateOf
  // references a comment that is in `kept[]` (no chains through dropped ones).
  const groupOf = new Array<number>(normalized.length).fill(-1);
  let nextGroup = 0;

  for (let i = 0; i < normalized.length; i++) {
    if (groupOf[i] !== -1) continue; // already assigned
    const group = nextGroup++;
    groupOf[i] = group;
    for (let j = i + 1; j < normalized.length; j++) {
      if (groupOf[j] !== -1) continue;
      const sim = jaccardSimilarity(normalized[i].words, normalized[j].words);
      if (sim < threshold) continue;
      const codeA = normalized[i].code;
      const codeB = normalized[j].code;
      const codeMatch =
        codeA === codeB ||
        (codeA.length > 0 && codeB.length > 0 &&
          (codeA.includes(codeB) || codeB.includes(codeA)));
      if (codeMatch) {
        groupOf[j] = group;
      }
    }
  }

  // Collect members of each group.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < normalized.length; i++) {
    const g = groupOf[i];
    const arr = groups.get(g) ?? [];
    arr.push(i);
    groups.set(g, arr);
  }

  const kept: CommentForDedupe[] = [];
  const dropped: DedupeDroppedItem[] = [];

  for (const members of groups.values()) {
    // Pick the alphabetically-first path as the representative.
    let repIdx = members[0];
    for (const idx of members) {
      if (normalized[idx].comment.path < normalized[repIdx].comment.path) {
        repIdx = idx;
      }
    }
    kept.push(normalized[repIdx].comment);
    for (const idx of members) {
      if (idx === repIdx) continue;
      dropped.push({
        comment: normalized[idx].comment,
        duplicateOf: normalized[repIdx].comment,
      });
    }
  }

  return { kept, dropped };
}
