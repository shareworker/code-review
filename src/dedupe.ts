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

  // Build a similarity graph and group comments into connected components.
  // This implements true transitive grouping: if A matches B and B matches C,
  // all three are placed in the same group even when A and C are not directly
  // similar. The previous greedy assignment under-deduplicated such chains.
  const similar = (a: number, b: number): boolean => {
    const sim = jaccardSimilarity(normalized[a].words, normalized[b].words);
    if (sim < threshold) return false;
    const codeA = normalized[a].code;
    const codeB = normalized[b].code;
    return (
      codeA === codeB ||
      (codeA.length > 0 && codeB.length > 0 &&
        (codeA.includes(codeB) || codeB.includes(codeA)))
    );
  };

  const n = normalized.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (similar(i, j)) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // Collect connected components via DFS.
  const groupOf = new Array<number>(n).fill(-1);
  let nextGroup = 0;
  const groups = new Map<number, number[]>();

  for (let i = 0; i < n; i++) {
    if (groupOf[i] !== -1) continue;
    const groupMembers: number[] = [];
    const stack = [i];
    groupOf[i] = nextGroup;
    while (stack.length > 0) {
      const u = stack.pop()!;
      groupMembers.push(u);
      for (const v of adj[u]) {
        if (groupOf[v] === -1) {
          groupOf[v] = nextGroup;
          stack.push(v);
        }
      }
    }
    groups.set(nextGroup, groupMembers);
    nextGroup++;
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
