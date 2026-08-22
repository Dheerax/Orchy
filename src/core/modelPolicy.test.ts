/** Run with:  node out/core/modelPolicy.test.js */
import { ModelPolicy, ModelInfo, looksLikeModelFailure } from './modelPolicy';

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
const ok = (label: string, cond: boolean, detail = ''): void => {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? '\n         ' + detail : ''}`);
  }
};

function model(id: string, inputCost: number, over: Partial<ModelInfo> = {}): ModelInfo {
  return { id, name: id, inputCost, outputCost: inputCost * 3, context: 200_000, tools: true, ...over };
}

const catalogue = [
  model('opencode/free-fast', 0),
  model('opencode/free-big', 0, { context: 1_000_000 }),
  model('google/mid', 2),
  model('google/mid-plus', 3),
  model('google/frontier', 15),
  model('google/frontier-max', 30),
];

console.log('\nwhat can actually run an agent');

const tiny = new ModelPolicy([...catalogue, model('google/toy', 0, { context: 8_000 })]);
ok('a context too small for a file and a conversation is excluded', !tiny.has('google/toy'));

const noTools = new ModelPolicy([...catalogue, model('google/chat-only', 1, { tools: false })]);
ok('a model that cannot call tools is excluded', !noTools.has('google/chat-only'));

const policy = new ModelPolicy(catalogue);
ok('and the rest are available', policy.has('google/frontier'));
check('the catalogue is what is left', policy.models.length, 6);

console.log('\ntiers, by price rather than by name');

check('free is cheap', policy.tierOf('opencode/free-fast'), 'cheap');
check('the expensive end is strong', policy.tierOf('google/frontier-max'), 'strong');
check('the middle is standard', policy.tierOf('google/mid'), 'standard');
ok(
  'an unknown model is assumed ordinary rather than dropped',
  policy.tierOf('someone/new-model') === 'standard'
);

console.log('\nchoosing a model for an agent');

check(
  'what was asked for comes first',
  policy.candidates('google/frontier')[0],
  'google/frontier'
);
ok(
  'and the next choice is the same kind of model',
  policy.tierOf(policy.candidates('google/frontier')[1]) === 'strong',
  policy.candidates('google/frontier').slice(0, 3).join(', ')
);

// The point of tier-aware fallback: a mechanical task whose free model was
// withdrawn must not silently start costing frontier money.
const cheapFirst = policy.candidates('opencode/withdrawn', 'cheap');
check('a withdrawn cheap model falls back to a cheap one', policy.tierOf(cheapFirst[0]), 'cheap');
ok(
  'and the strong models are last in that list',
  policy.tierOf(cheapFirst[cheapFirst.length - 2]) === 'strong',
  cheapFirst.join(', ')
);

ok(
  'every available model is offered eventually',
  policy.candidates('google/mid').length >= catalogue.length,
  `${policy.candidates('google/mid').length} candidates`
);
ok(
  'the unavailable request is still tried last, in case we are wrong',
  policy.candidates('someone/unlisted').slice(-1)[0] === 'someone/unlisted'
);
ok('no model is offered twice', new Set(policy.candidates('google/mid')).size === policy.candidates('google/mid').length);

console.log('\nwith no catalogue at all');

const blind = new ModelPolicy([]);
check(
  'the request is passed through untouched',
  blind.candidates('anything/at-all'),
  ['anything/at-all']
);
check('and nothing is invented when none was asked for', blind.candidates(undefined), []);

console.log('\nsaying why');

ok(
  'an unconfigured provider is named as the problem',
  (policy.explain('anthropic/claude') || '').includes('No provider'),
  policy.explain('anthropic/claude')
);
ok(
  'a wrong model on a real provider says so differently',
  (policy.explain('google/imaginary') || '').includes('not among'),
  policy.explain('google/imaginary')
);
ok('and a fine request explains nothing', policy.explain('google/mid') === undefined);

console.log('\nis this failure about the model');

ok('unknown model', looksLikeModelFailure('Error: model not found: google/gone'));
ok('withdrawn model', looksLikeModelFailure('The model is no longer available'));
ok('quota', looksLikeModelFailure('model quota exceeded for this key'));
ok('but not a worktree problem', !looksLikeModelFailure('fatal: not a git repository'));
ok('and not a dead server', !looksLikeModelFailure('connect ECONNREFUSED 127.0.0.1:4096'));

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
