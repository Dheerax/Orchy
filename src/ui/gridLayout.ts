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
 * How many panes go in each row, for `n` visible sessions.
 *
 * Aims for roughly square panes rather than one long strip: three agents read
 * far better as two-over-one than as three slivers side by side. Earlier rows
 * take the remainder, so a partial row sits at the bottom.
 *
 *   1 → [1]        4 → [2,2]      7 → [3,2,2]    10 → [4,3,3]
 *   2 → [2]        5 → [3,2]      8 → [3,3,2]    11 → [4,4,3]
 *   3 → [2,1]      6 → [3,3]      9 → [3,3,3]    12 → [4,4,4]
 */
export function planGrid(n: number): number[] {
  const count = Math.max(0, Math.min(n, MAX_VISIBLE));
  if (count === 0) {
    return [];
  }
  const columns = Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(count)));
  const rows = Math.min(MAX_ROWS, Math.ceil(count / columns));

  const plan: number[] = [];
  let remaining = count;
  for (let row = 0; row < rows; row++) {
    const rowsLeft = rows - row;
    const size = Math.ceil(remaining / rowsLeft);
    plan.push(size);
    remaining -= size;
  }
  return plan;
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
 * 1-based editor column for the nth pane, reading rows left to right.
 * VS Code numbers groups in the order the layout declares them.
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
