/**
 * Line-level diff between two versions of a file, used to render colored
 * add/modify/remove highlights in the editor when the agent changes a file,
 * and to let the user Accept or Reject the change.
 */

export type DiffOpType = "equal" | "add" | "remove" | "modify";

export interface DiffLine {
  type: DiffOpType;
  /** 1-indexed line number in the NEW document (add/modify/equal, and the
   *  anchor line for a "remove" — the new-doc line the removed text used to
   *  sit in front of). */
  newLine?: number;
  /** 1-indexed line number in the OLD document (remove/modify/equal). */
  oldLine?: number;
  /** Line text to display (new text for add/modify, old text for remove). */
  content: string;
  /** For "modify", the old line's text (so callers can show both sides). */
  oldContent?: string;
}

// Guard against pathological O(N*M) blowup on huge files — fall back to a
// cheap positional diff (same index = same line) instead of hanging the UI.
const MAX_LCS_CELLS = 4_000_000;

/**
 * Computes a line-level diff between `oldText` and `newText`, classifying
 * each changed line as an "add" (new line with no old counterpart), a
 * "remove" (old line dropped), or a "modify" (an add/remove pair of equal
 * size within the same change block, i.e. a line that was edited in place).
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return positionalDiff(oldLines, newLines);
  }

  const ops = lcsDiff(oldLines, newLines);
  return pairModifications(ops);
}

/** Classic dynamic-programming LCS diff, backtracked into equal/add/remove ops. */
function lcsDiff(
  oldLines: string[],
  newLines: string[],
): Array<{ type: "equal" | "add" | "remove"; oldLine?: number; newLine?: number; content: string }> {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = length of LCS of oldLines[i..] and newLines[j..]
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Array<{ type: "equal" | "add" | "remove"; oldLine?: number; newLine?: number; content: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "equal", oldLine: i + 1, newLine: j + 1, content: newLines[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", oldLine: i + 1, content: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "add", newLine: j + 1, content: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", oldLine: i + 1, content: oldLines[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", newLine: j + 1, content: newLines[j] });
    j++;
  }
  return ops;
}

/**
 * Post-processes raw add/remove ops into "modify" pairs: within a single
 * contiguous change block, a removed line and an added line at the same
 * relative position are treated as one edited line rather than a delete
 * plus an unrelated insert.
 */
function pairModifications(
  ops: Array<{ type: "equal" | "add" | "remove"; oldLine?: number; newLine?: number; content: string }>,
): DiffLine[] {
  const result: DiffLine[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === "equal") {
      result.push({ type: "equal", oldLine: op.oldLine, newLine: op.newLine, content: op.content });
      i++;
      continue;
    }

    // Collect the contiguous run of removes followed by adds (standard LCS
    // backtrack order emits removes before adds within a change block).
    const removes: typeof ops = [];
    while (i < ops.length && ops[i].type === "remove") removes.push(ops[i++]);
    const adds: typeof ops = [];
    while (i < ops.length && ops[i].type === "add") adds.push(ops[i++]);

    const pairCount = Math.min(removes.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      result.push({
        type: "modify",
        oldLine: removes[k].oldLine,
        newLine: adds[k].newLine,
        content: adds[k].content,
        oldContent: removes[k].content,
      });
    }
    for (let k = pairCount; k < removes.length; k++) {
      // Anchor a pure removal at the new-doc line it now sits in front of —
      // either the next add's line, or one past the last emitted new line.
      const anchor = adds[pairCount]?.newLine ?? (result.length > 0 ? (result[result.length - 1].newLine ?? 0) + 1 : 1);
      result.push({ type: "remove", oldLine: removes[k].oldLine, newLine: anchor, content: removes[k].content });
    }
    for (let k = pairCount; k < adds.length; k++) {
      result.push({ type: "add", newLine: adds[k].newLine, content: adds[k].content });
    }
  }
  return result;
}

/** Cheap fallback for very large files: compare by index only. */
function positionalDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let idx = 0; idx < max; idx++) {
    const oldLine = oldLines[idx];
    const newLine = newLines[idx];
    if (oldLine === undefined) {
      result.push({ type: "add", newLine: idx + 1, content: newLine });
    } else if (newLine === undefined) {
      result.push({ type: "remove", oldLine: idx + 1, newLine: idx + 1, content: oldLine });
    } else if (oldLine === newLine) {
      result.push({ type: "equal", oldLine: idx + 1, newLine: idx + 1, content: newLine });
    } else {
      result.push({ type: "modify", oldLine: idx + 1, newLine: idx + 1, content: newLine, oldContent: oldLine });
    }
  }
  return result;
}

/** 1-indexed new-doc line numbers for every add/modify — used to flash/scroll. */
export function changedNewLines(diff: DiffLine[]): number[] {
  const lines: number[] = [];
  for (const d of diff) {
    if ((d.type === "add" || d.type === "modify") && d.newLine !== undefined) lines.push(d.newLine);
  }
  return lines;
}

export interface DiffStats {
  added: number;
  modified: number;
  removed: number;
}

export function diffStats(diff: DiffLine[]): DiffStats {
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.type === "add") added++;
    else if (d.type === "modify") modified++;
    else if (d.type === "remove") removed++;
  }
  return { added, modified, removed };
}
