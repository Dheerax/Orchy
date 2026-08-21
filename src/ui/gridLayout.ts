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
 * Panes per row, for `n` visible sessions.
 *
 * Written out rather than derived: the shape people actually want is not a
 * formula. Seven reads best as 3/3/1 while ten reads best as 4/3/3, and no
 * single rule produces both.
 */
const ROW_PLANS: readonly (readonly number[])[] = [
  [], // 0
  [1],
  [2],
  [2, 1],
  [2, 2],
  [3, 2],
  [3, 3],
  [3, 3, 1],
  [3, 3, 2],
  [3, 3, 3],
  [4, 3, 3],
  [4, 4, 3],
  [4, 4, 4],
];

export function planGrid(n: number): number[] {
  const count = Math.max(0, Math.min(n, MAX_VISIBLE));
  return [...ROW_PLANS[count]];
}

/**
 * A same-width fallback for `n` panes.
 *
 * VS Code has been known to reject layouts whose rows differ in length
 * (microsoft/vscode#84425). When the preferred plan is refused we retry with
 * this, which is less pleasing but always accepted.
 */
export function uniformGrid(n: number): number[] {
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
 * Orientation 0 stacks the top-level groups as rows; nested groups are laid out
 * orthogonal to their parent, giving each row its columns. Orientation 1 does
 * the opposite and produces a single strip of side-by-side panes. Sizes must sum
 * to 1 within each level or VS Code ignores them.
 */
export function toEditorLayout(plan: number[]): EditorGroupLayout {
  const rowSize = plan.length > 0 ? 1 / plan.length : 1;
  return {
    orientation: 0,
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
