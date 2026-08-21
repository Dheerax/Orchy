import * as fs from 'fs';
import * as path from 'path';
import { AgentContract } from './types';

export interface ContractResult {
  symbol: string;
  file: string;
  satisfied: boolean;
  detail: string;
}

/**
 * Checks that an agent produced the interface it promised.
 *
 * Deliverables answer "did a file appear". This answers "is the thing other
 * agents are waiting for actually in it" — which is the failure that matters
 * when work is split, because a downstream agent will otherwise build against a
 * symbol that was renamed, nested, or never exported.
 *
 * Deliberately textual rather than a parser: it must work for any language, and
 * a false pass here is cheaper than refusing to support a stack.
 */
export class ContractChecker {
  check(agreement: AgentContract, cwd: string): ContractResult[] {
    return agreement.provides.map((promise) => {
      const target = path.resolve(cwd, promise.file);
      if (!fs.existsSync(target)) {
        return {
          ...promise,
          satisfied: false,
          detail: `file not found: ${promise.file}`,
        };
      }
      let contents: string;
      try {
        contents = fs.readFileSync(target, 'utf8');
      } catch (err) {
        return {
          ...promise,
          satisfied: false,
          detail: `could not read ${promise.file}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Word boundaries, so `user` does not match `userName` and call it done.
      const escaped = promise.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const present = new RegExp(`\\b${escaped}\\b`).test(contents);
      if (!present) {
        return {
          ...promise,
          satisfied: false,
          detail: `'${promise.symbol}' does not appear in ${promise.file}`,
        };
      }

      // Present but not exported is the subtler failure: the file looks right
      // and every consumer still breaks.
      const exported = new RegExp(
        `(export|module\\.exports|public|def|func|class|pub)\\b[^\\n]*\\b${escaped}\\b|` +
          `\\b${escaped}\\b[^\\n]*(:|=)[^\\n]*\\bexport\\b`
      ).test(contents);

      return {
        ...promise,
        satisfied: true,
        detail: exported ? 'exported' : `present, but no export of '${promise.symbol}' detected`,
      };
    });
  }
}
