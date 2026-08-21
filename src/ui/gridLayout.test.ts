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
check('three go two over one', planGrid(3), [2, 1]);
check('four square up', planGrid(4), [2, 2]);
check('five', planGrid(5), [3, 2]);
check('six', planGrid(6), [3, 3]);
check('seven balances', planGrid(7), [3, 2, 2]);
check('eight', planGrid(8), [3, 3, 2]);
check('nine', planGrid(9), [3, 3, 3]);
check('ten', planGrid(10), [4, 3, 3]);
check('eleven', planGrid(11), [4, 4, 3]);
check('twelve fills three rows of four', planGrid(12), [4, 4, 4]);

console.log('\nplans never exceed the ceiling');

for (let n = 0; n <= 40; n++) {
  const plan = planGrid(n);
  const total = plan.reduce((a, b) => a + b, 0);
  if (plan.length > 3 || plan.some((c) => c > 4) || total > MAX_VISIBLE) {
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
check('second row has one', layout.groups[1].groups?.length, 1);
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
check('first pane is column one', columnForIndex(plan12, 0), 1);
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
