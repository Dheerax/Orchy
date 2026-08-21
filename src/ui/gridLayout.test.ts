/** Run with:  node out/ui/gridLayout.test.js */
import {
  columnForIndex,
  MAX_VISIBLE,
  pageCount,
  pageSlice,
  planGrid,
  toEditorLayout,
} from './gridLayout';

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks++;
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(
      `  FAIL ${label}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`
    );
  }
}

console.log('\ngrid plan');

check('none', planGrid(0), []);
check('one fills the pane', planGrid(1), [1]);
check('two sit side by side', planGrid(2), [2]);
check('three take a 2x2 with one cell spare', planGrid(3), [2, 2]);
check('four square up', planGrid(4), [2, 2]);
check('five', planGrid(5), [3, 3]);
check('six', planGrid(6), [3, 3]);
check('seven', planGrid(7), [3, 3, 3]);
check('eight', planGrid(8), [3, 3, 3]);
check('nine', planGrid(9), [3, 3, 3]);
check('ten', planGrid(10), [4, 4, 4]);
check('eleven', planGrid(11), [4, 4, 4]);
check('twelve fills three rows of four', planGrid(12), [4, 4, 4]);

console.log('\nevery row is the same width');

for (let n = 1; n <= 12; n++) {
  const plan = planGrid(n);
  checks++;
  if (new Set(plan).size !== 1) {
    failures++;
    console.log(`  FAIL n=${n} produced unequal rows ${JSON.stringify(plan)}`);
  }
}
check('rows stay uniform for every count (vscode#84425)', true, true);
check(
  'a grid always has room for the agents it holds',
  [1, 3, 5, 7, 8, 10, 11].every((n) => planGrid(n).reduce((a, b) => a + b, 0) >= n),
  true
);

console.log('\nplans never exceed the ceiling');

for (let n = 0; n <= 40; n++) {
  const plan = planGrid(n);
  const total = plan.reduce((a, b) => a + b, 0);
  const undersized = n <= MAX_VISIBLE && n > total;
  if (plan.length > 3 || plan.some((c) => c > 4) || total > MAX_VISIBLE || undersized) {
    failures++;
    checks++;
    console.log(`  FAIL n=${n} produced ${JSON.stringify(plan)}`);
  }
}
check('every plan from 0..40 stays within 3 rows of 4', true, true);
check('past the ceiling it clamps to twelve', planGrid(30), [4, 4, 4]);

console.log('\neditor layout argument');

const layout = toEditorLayout(planGrid(3));
check('rows stack vertically', layout.orientation, 1);
check('two rows', layout.groups.length, 2);
check('first row has two columns', layout.groups[0].groups?.length, 2);
check('so does the second', layout.groups[1].groups?.length, 2);
check(
  'row sizes sum to one',
  layout.groups.reduce((sum, g) => sum + (g.size ?? 0), 0),
  1
);
check(
  'columns within a row sum to one',
  layout.groups[0].groups?.reduce((sum, g) => sum + (g.size ?? 0), 0),
  1
);

console.log('\ncolumn assignment');

const plan12 = planGrid(12);
check('first pane is group one', columnForIndex(plan12, 0), 1);
check('fifth pane starts row two', columnForIndex(plan12, 4), 5);
check('last pane is column twelve', columnForIndex(plan12, 11), 12);
check('out of range clamps', columnForIndex(plan12, 99), 12);

console.log('\npagination');

const ids = Array.from({ length: 27 }, (_, i) => `s${i + 1}`);
check('27 sessions span three pages', pageCount(27), 3);
check('exactly twelve is one page', pageCount(12), 1);
check('thirteen spills to two', pageCount(13), 2);
check('empty still has one page', pageCount(0), 1);
check('page one holds the first twelve', pageSlice(ids, 0).length, 12);
check('page one starts at s1', pageSlice(ids, 0)[0], 's1');
check('page two starts at s13', pageSlice(ids, 1)[0], 's13');
check('page three holds the remainder', pageSlice(ids, 2).length, 3);
check('past the last page clamps', pageSlice(ids, 99)[0], 's25');

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
