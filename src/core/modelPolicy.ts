/**
 * Which model an agent should actually run on.
 *
 * A pipeline says what it wants — something cheap for the mechanical work,
 * something strong where correctness is decided — but what is *available*
 * changes underneath it. Providers come and go with a config edit, free tiers
 * are withdrawn, new models appear weekly, and a plan written last month names
 * models that no longer exist. A session that dies because its model was
 * retired is the worst kind of failure: nothing was wrong with the work.
 *
 * So a request is treated as a preference rather than an instruction. It is
 * resolved against the live catalogue, and if it cannot be honoured the next
 * best model of the same character is used instead.
 */

export interface ModelInfo {
  /** `provider/model`, the form everything else in Orchy uses. */
  id: string;
  name: string;
  /** Cost per million input tokens. Zero for free tiers. */
  inputCost: number;
  outputCost: number;
  /** Context window in tokens. A small one rules a model out of real work. */
  context: number;
  /** Whether the model can call tools. An agent that cannot is useless here. */
  tools: boolean;
}

/**
 * What the work needs, rather than what it is called.
 *
 * Naming a tier instead of a model is what lets a plan outlive the model it was
 * written against.
 */
export type Tier = 'cheap' | 'standard' | 'strong';

/** Below this, a model cannot hold a source file and a conversation at once. */
const MIN_CONTEXT = 32_000;

export class ModelPolicy {
  private catalogue: ModelInfo[] = [];

  constructor(models: ModelInfo[] = []) {
    this.replace(models);
  }

  /** Models that can actually run an agent, cheapest first. */
  replace(models: ModelInfo[]): void {
    this.catalogue = models
      .filter((m) => m.tools && m.context >= MIN_CONTEXT)
      .sort((a, b) => a.inputCost - b.inputCost || a.id.localeCompare(b.id));
  }

  get models(): ModelInfo[] {
    return [...this.catalogue];
  }

  get known(): boolean {
    return this.catalogue.length > 0;
  }

  has(id: string): boolean {
    return this.catalogue.some((m) => m.id === id);
  }

  /**
   * The tier a model belongs to, by price.
   *
   * Free and near-free models are the cheap tier by definition; the rest split
   * at the median, which moves with the catalogue rather than with a table of
   * model names that would be stale within a month.
   */
  tierOf(id: string): Tier {
    const model = this.catalogue.find((m) => m.id === id);
    if (!model) {
      return 'standard';
    }
    if (model.inputCost === 0) {
      return 'cheap';
    }
    const paid = this.catalogue.filter((m) => m.inputCost > 0);
    if (paid.length < 2) {
      // Nothing to compare against; calling a lone paid model "strong" would be
      // a guess dressed up as a judgement.
      return paid.length === 0 ? 'cheap' : 'standard';
    }
    // The dearer half is strong. Taking the strict upper median instead of the
    // lower one matters: with an even number of paid models the lower median is
    // itself a member of the dearer half, and comparing strictly against it put
    // the second-most-expensive model in the standard tier.
    const threshold = paid[Math.ceil(paid.length / 2)].inputCost;
    return model.inputCost >= threshold ? 'strong' : 'standard';
  }

  /** The best available models for a tier, in the order they should be tried. */
  forTier(tier: Tier): ModelInfo[] {
    const matching = this.catalogue.filter((m) => this.tierOf(m.id) === tier);
    if (tier === 'strong') {
      // Strongest first: for the work that actually needs it, price is the point.
      return [...matching].sort((a, b) => b.inputCost - a.inputCost);
    }
    if (tier === 'cheap') {
      // Cheapest first, but a bigger context breaks the tie — same price, more room.
      return [...matching].sort((a, b) => a.inputCost - b.inputCost || b.context - a.context);
    }
    return matching;
  }

  /**
   * Everything worth trying for one agent, best first.
   *
   * The requested model leads when it exists. What follows is the rest of its
   * tier, then the neighbouring tiers — so a fallback is still the same kind of
   * model, and a cheap mechanical task does not silently start costing real
   * money because its usual model was withdrawn.
   */
  candidates(requested: string | undefined, tier: Tier = 'standard'): string[] {
    if (!this.known) {
      // Nothing to resolve against — trust the caller rather than override them.
      return requested ? [requested] : [];
    }

    const wanted = requested && this.has(requested) ? requested : undefined;
    const effectiveTier = wanted ? this.tierOf(wanted) : tier;
    const order: Tier[] =
      effectiveTier === 'cheap'
        ? ['cheap', 'standard', 'strong']
        : effectiveTier === 'strong'
          ? ['strong', 'standard', 'cheap']
          : ['standard', 'strong', 'cheap'];

    const ranked = order.flatMap((t) => this.forTier(t).map((m) => m.id));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...(wanted ? [wanted] : []), ...ranked]) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }

    // An unavailable request still goes on the end: the catalogue can be
    // incomplete, and being wrong about that should cost a retry, not the run.
    if (requested && !seen.has(requested)) {
      out.push(requested);
    }
    return out;
  }

  /**
   * Why a model was not used, in terms the user can act on.
   * Returns undefined when the request was fine.
   */
  explain(requested: string | undefined): string | undefined {
    if (!requested || !this.known || this.has(requested)) {
      return undefined;
    }
    const provider = requested.split('/')[0];
    const sameProvider = this.catalogue.filter((m) => m.id.startsWith(provider + '/'));
    return sameProvider.length === 0
      ? `No provider '${provider}' is configured, so '${requested}' cannot run.`
      : `'${requested}' is not among the ${sameProvider.length} available ${provider} models.`;
  }
}

/**
 * Whether a failure looks like the model being wrong rather than the work.
 *
 * Backends report this in prose and every one of them words it differently, so
 * this is deliberately generous: retrying on a model we could have run anyway
 * costs one attempt, while not retrying costs the whole session.
 */
export function looksLikeModelFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('model') &&
    ['not found', 'unknown', 'unavailable', 'unsupported', 'invalid', 'no such', 'deprecated',
      'does not exist', 'available', 'access', 'quota', 'rate limit', 'retired',
      'decommission'].some((phrase) =>
      text.includes(phrase)
    )
  );
}
