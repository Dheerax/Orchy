import * as fs from 'fs';
import * as path from 'path';
import { PlannedAgent } from './types';

export interface PipelineTemplate {
  name: string;
  description: string;
  /** When this shape is the right one, in terms the orchestrator can judge. */
  useWhen: string;
  agents: { role: string; task: string; dependsOn: number[]; owns: string }[];
  builtIn: boolean;
}

/**
 * Starting shapes for a pipeline.
 *
 * A template is not a script — it is a decomposition. Tasks are written as
 * instructions to fill in, because the useful part is which agents exist and how
 * they depend on each other, not the wording. The orchestrator adapts them to
 * the actual request and the user still approves the result.
 */
const BUILT_IN: PipelineTemplate[] = [
  {
    name: 'solo',
    description: 'One agent, isolated and verified.',
    useWhen:
      'A change that lives in one area — a bug fix, a small feature, a refactor of one module. ' +
      'Splitting this costs more than it saves.',
    agents: [{ role: 'build', task: '<the whole change>', dependsOn: [], owns: '<the files>' }],
    builtIn: true,
  },
  {
    name: 'feature',
    description: 'Schema first, then API and UI in parallel, then tests.',
    useWhen:
      'A feature that crosses layers and has a shared data shape at its centre. The common ' +
      'case for most product work.',
    agents: [
      { role: 'schema', task: '<the data model and types>', dependsOn: [], owns: 'src/models' },
      { role: 'api', task: '<the endpoints or services>', dependsOn: [0], owns: 'src/routes' },
      { role: 'ui', task: '<the screens and components>', dependsOn: [0], owns: 'src/pages' },
      { role: 'tests', task: '<tests across the feature>', dependsOn: [1, 2], owns: 'tests' },
    ],
    builtIn: true,
  },
  {
    name: 'parallel',
    description: 'Independent agents, no dependencies.',
    useWhen:
      'Several unrelated changes that share no files — separate bug fixes, separate modules. ' +
      'The widest shape, and the only one with no ordering cost.',
    agents: [
      { role: 'a', task: '<first change>', dependsOn: [], owns: '<its files>' },
      { role: 'b', task: '<second change>', dependsOn: [], owns: '<its files>' },
    ],
    builtIn: true,
  },
  {
    name: 'explore-then-build',
    description: 'Research first, then implementation informed by it.',
    useWhen:
      'The approach is not settled yet. The first agent reads and reports without changing ' +
      'anything, so the decision is made once rather than three times in parallel.',
    agents: [
      {
        role: 'research',
        task: '<investigate and write findings to a file, changing nothing else>',
        dependsOn: [],
        owns: 'docs',
      },
      { role: 'build', task: '<implement what the research settled>', dependsOn: [0], owns: 'src' },
    ],
    builtIn: true,
  },
  {
    name: 'migration',
    description: 'Prepare, migrate in parallel slices, then remove the old path.',
    useWhen:
      'A change across many files with a compatibility window — renaming an interface, moving ' +
      'a dependency. The slices are parallel; the cleanup must be last.',
    agents: [
      { role: 'prepare', task: '<add the new path alongside the old>', dependsOn: [], owns: 'src' },
      { role: 'migrate-a', task: '<move the first group of callers>', dependsOn: [0], owns: '<group a>' },
      { role: 'migrate-b', task: '<move the second group of callers>', dependsOn: [0], owns: '<group b>' },
      { role: 'cleanup', task: '<remove the old path>', dependsOn: [1, 2], owns: 'src' },
    ],
    builtIn: true,
  },
];

export class TemplateLibrary {
  constructor(private readonly orchyDir: string) {}

  /** Built-in shapes plus anything the user has written into .orchy/templates. */
  all(): PipelineTemplate[] {
    return [...BUILT_IN, ...this.custom()];
  }

  get(name: string): PipelineTemplate | undefined {
    return this.all().find((t) => t.name === name);
  }

  private custom(): PipelineTemplate[] {
    const dir = path.join(this.orchyDir, 'templates');
    if (!fs.existsSync(dir)) {
      return [];
    }
    const found: PipelineTemplate[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
        if (parsed && typeof parsed.name === 'string' && Array.isArray(parsed.agents)) {
          found.push({ ...parsed, builtIn: false });
        }
      } catch {
        // A malformed template should not hide the ones that are fine.
      }
    }
    return found;
  }

  /** Turn a template into plan agents, ready for the orchestrator to fill in. */
  static toPlannedAgents(template: PipelineTemplate): PlannedAgent[] {
    return template.agents.map((a) => ({
      role: a.role,
      task: a.task,
      deliverables: [],
      dependsOn: a.dependsOn,
      provides: [],
      needs: [],
    }));
  }

  /** Write the built-ins to disk as editable examples. */
  seed(): string {
    const dir = path.join(this.orchyDir, 'templates');
    fs.mkdirSync(dir, { recursive: true });
    for (const template of BUILT_IN) {
      const file = path.join(dir, `${template.name}.example.json`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify({ ...template, builtIn: undefined }, null, 2), 'utf8');
      }
    }
    return dir;
  }
}
