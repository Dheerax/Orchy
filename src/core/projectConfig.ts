import * as fs from 'fs';
import * as path from 'path';

/**
 * What this project expects of every agent that works on it.
 *
 * Pipeline templates were the wrong idea. A pipeline is a shape the work has,
 * and the orchestrator can see the work — it does not need to be handed a
 * catalogue of shapes to pick from, any more than a programmer needs a list of
 * control-flow diagrams. Offering "solo" as a template is offering a pipeline
 * shape for not having a pipeline.
 *
 * What an orchestrator genuinely cannot infer is what *this repository*
 * expects: that it is CommonJS, that no new dependencies are welcome, that
 * `npm test` has to pass before anything counts as done, that the cheap tier
 * means one particular model here. Those are project facts, they belong in the
 * project, and they belong in version control where the rest of the team gets
 * them too.
 */
export interface ProjectConfig {
  /** Branch worktrees are cut from and merged into. Overrides the setting. */
  baseBranch?: string;
  /**
   * House rules, handed to every agent verbatim.
   *
   * These go in the prompt because that is the only place they can actually
   * change what an agent does. Keep them to things that are true of the
   * repository rather than of one task.
   */
  rules: string[];
  /**
   * A check every agent's work must pass, on top of its own deliverables.
   * Usually the test command.
   */
  verify?: string;
  /** Which model to prefer for each tier, when one is available. */
  models: { cheap?: string; standard?: string; strong?: string };
  /** Stop a session past this spend. Zero or absent means no cap. */
  budgetCap?: number;
  /** Commands agents may never run here, on top of the built-in refusals. */
  forbid: string[];
  /** Where this came from, for reporting. Absent when nothing was found. */
  path?: string;
  /** Problems found while reading it. Never fatal — a bad config is not a bad repo. */
  warnings: string[];
}

export const CONFIG_FILE = '.orchy.json';

/**
 * Remove `//` line comments so a hand-written config can be commented.
 *
 * JSON has no comments and people write them anyway; refusing the whole file
 * over one would be pedantry with a real cost. Quoted strings are respected so
 * a URL keeps its slashes.
 */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

const EMPTY: ProjectConfig = { rules: [], models: {}, forbid: [], warnings: [] };

/**
 * Read `.orchy.json` from the workspace root.
 *
 * Every failure is a warning rather than a throw. A malformed config should
 * cost the user the settings they got wrong, not the ability to run anything —
 * and it is read on a hot path, so it must never be the reason a spawn fails.
 */
export function loadProjectConfig(root: string): ProjectConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    return { ...EMPTY };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripComments(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    return {
      ...EMPTY,
      path: file,
      warnings: [
        `${CONFIG_FILE} is not valid JSON, so none of it is being used: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...EMPTY, path: file, warnings: [`${CONFIG_FILE} must be a JSON object.`] };
  }

  const input = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const strings = (key: string): string[] => {
    const value = input[key];
    if (value === undefined) {
      return [];
    }
    if (typeof value === 'string') {
      return [value];
    }
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value as string[];
    }
    warnings.push(`'${key}' should be a string or an array of strings; ignoring it.`);
    return [];
  };

  const text = (key: string): string | undefined => {
    const value = input[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    warnings.push(`'${key}' should be a non-empty string; ignoring it.`);
    return undefined;
  };

  const models: ProjectConfig['models'] = {};
  const rawModels = input.models;
  if (rawModels !== undefined) {
    if (typeof rawModels === 'object' && rawModels !== null && !Array.isArray(rawModels)) {
      for (const tier of ['cheap', 'standard', 'strong'] as const) {
        const value = (rawModels as Record<string, unknown>)[tier];
        if (value === undefined) {
          continue;
        }
        if (typeof value === 'string' && value.includes('/')) {
          models[tier] = value;
        } else {
          warnings.push(
            `models.${tier} should look like 'provider/model'; ignoring '${String(value)}'.`
          );
        }
      }
    } else {
      warnings.push(`'models' should be an object keyed by tier; ignoring it.`);
    }
  }

  let budgetCap: number | undefined;
  if (input.budgetCap !== undefined) {
    if (typeof input.budgetCap === 'number' && input.budgetCap >= 0) {
      budgetCap = input.budgetCap;
    } else {
      warnings.push(`'budgetCap' should be a number of dollars; ignoring it.`);
    }
  }

  const known = new Set([
    'baseBranch', 'rules', 'verify', 'models', 'budgetCap', 'forbid', '$schema',
  ]);
  for (const key of Object.keys(input)) {
    // Keys beginning with // are how people annotate JSON that has no comments.
    if (!known.has(key) && !key.startsWith('//')) {
      // Silence here would look exactly like a setting that does not work.
      warnings.push(`'${key}' is not a setting Orchy knows about; ignoring it.`);
    }
  }

  return {
    baseBranch: text('baseBranch'),
    rules: strings('rules'),
    verify: text('verify'),
    models,
    budgetCap,
    forbid: strings('forbid'),
    path: file,
    warnings,
  };
}

/**
 * The house rules as a block to append to an agent's brief.
 * Empty when there are none, so callers can concatenate unconditionally.
 */
export function rulesBlock(config: ProjectConfig): string {
  if (config.rules.length === 0) {
    return '';
  }
  return (
    `\n\nThis project's rules, which apply to everything you do here:\n` +
    config.rules.map((r) => `- ${r}`).join('\n')
  );
}

/** A starting file, written on request rather than assumed. */
export function exampleConfig(): string {
  return `{
  "// baseBranch": "Branch agents cut from and merge into.",
  "baseBranch": "main",

  "// rules": "Handed to every agent verbatim. Facts about this repository, not about one task.",
  "rules": [
    "Plain CommonJS. Do not introduce a build step.",
    "No new dependencies without saying why in the commit message.",
    "Every exported symbol needs a test."
  ],

  "// verify": "Run for every agent on top of its own deliverables.",
  "verify": "npm test",

  "// models": "Preferred model per tier. Orchy still substitutes if one is unavailable.",
  "models": {
    "cheap": "opencode/ling-3.0-flash-free",
    "strong": "google/antigravity-claude-sonnet-4-6"
  },

  "// budgetCap": "Dollars per session. Omit or zero for no cap.",
  "budgetCap": 0,

  "// forbid": "Commands agents may never run here, on top of the built-in refusals.",
  "forbid": []
}
`;
}
