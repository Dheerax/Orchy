/**
 * Grid geometry for the agent pane.
 *
 * Pure functions, no VS Code imports — the arithmetic is fiddly enough to be
 * worth testing directly rather than by squinting at an editor.
 */

/** Hard ceiling on panes shown at once. Beyond this, sessions paginate. */
export const MAX_VISIBLE = 12;
const MAX_COLUMNS = 4;
const MAX_ROWS = 3;

/**
 * Grid shape for `n` visible sessions: every row the same width.
 *
 * Uniformity is not cosmetic. VS Code mishandles setEditorLayout when rows have
 * unequal lengths (microsoft/vscode#84425), and the failure mode is brutal — the
 * call throws after the old panes are already gone, so the grid empties and
 * nothing says why. Three agents therefore occupy a 2x2 with one cell left
 * empty, rather than a 2-then-1 that risks taking the whole grid down.
 *
 *   1 → 1x1    4 → 2x2    7 → 3x3    10 → 3x4
 *   2 → 1x2    5 → 2x3    8 → 3x3    11 → 3x4
 *   3 → 2x2    6 → 2x3    9 → 3x3    12 → 3x4
 */
export function planGrid(n: number): number[] {
  const count = Math.max(0, Math.min(n, MAX_VISIBLE));
  if (count === 0) {
    return [];
  }
  const columns = Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(count)));
  const rows = Math.min(MAX_ROWS, Math.ceil(count / columns));
  return Array.from({ length: rows }, () => columns);
}

export interface EditorGroupLayout {
  orientation: 0 | 1;
  groups: { size?: number; groups?: { size?: number }[] }[];
}

/**
 * Translate a row plan into the argument `vscode.setEditorLayout` expects.
 *
 * Orientation 1 is vertical, so the top level stacks rows; nested groups are
 * laid out orthogonal to their parent, giving each row its columns. Sizes must
 * sum to 1 within each level or VS Code ignores them.
 */
export function toEditorLayout(plan: number[]): EditorGroupLayout {
  const rowSize = plan.length > 0 ? 1 / plan.length : 1;
  return {
    orientation: 1,
    groups: plan.map((columns) => ({
      size: rowSize,
      groups: Array.from({ length: columns }, () => ({ size: 1 / columns })),
    })),
  };
}

/**
 * 1-based editor group for the nth pane, reading rows left to right.
 * VS Code numbers groups in the order the layout declares them.
 * Trailing cells of a partly filled grid simply stay empty.
 */
export function columnForIndex(plan: number[], index: number): number {
  const total = plan.reduce((sum, columns) => sum + columns, 0);
  return Math.min(Math.max(index, 0), Math.max(total - 1, 0)) + 1;
}

/** How many pages `total` sessions occupy. Always at least one. */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / MAX_VISIBLE));
}

/** The slice of session ids shown on `page` (0-based). */
export function pageSlice<T>(items: T[], page: number): T[] {
  const pages = pageCount(items.length);
  const clamped = Math.min(Math.max(page, 0), pages - 1);
  return items.slice(clamped * MAX_VISIBLE, clamped * MAX_VISIBLE + MAX_VISIBLE);
}
