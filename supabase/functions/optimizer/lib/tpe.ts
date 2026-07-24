/**
 * Tree-structured Parzen Estimator (TPE) Implementation
 * 
 * A Bayesian hyperparameter optimization algorithm that models P(x|y) 
 * instead of P(y|x), splitting observations into "good" (l) and "bad" (g)
 * groups and sampling from l(x)/g(x) to find promising configurations.
 * 
 * Reference: Bergstra et al., "Algorithms for Hyper-Parameter Optimization" (2011)
 */

// ─── Types ───

export interface ParameterSpec {
  name: string;
  type: "continuous" | "integer" | "categorical";
  low?: number;
  high?: number;
  choices?: (string | number | boolean)[];
  logScale?: boolean; // sample in log space (useful for learning rates, etc.)
}

export interface Trial {
  id: number;
  params: Record<string, number | string | boolean>;
  score: number;
  timestamp: number;
}

export interface TPEConfig {
  gamma: number;         // quantile split (default 0.25 = top 25% are "good")
  nStartupTrials: number; // random trials before TPE kicks in (default 10)
  nEICandidates: number;  // candidates to evaluate EI for (default 24)
  priorWeight: number;    // weight of uniform prior (default 1.0)
  seed?: number;          // reproducible randomness
}

const DEFAULT_TPE_CONFIG: TPEConfig = {
  gamma: 0.25,
  nStartupTrials: 10,
  nEICandidates: 24,
  priorWeight: 1.0,
};

// ─── Seeded PRNG (xoshiro128**) ───

class SeededRNG {
  private state: Uint32Array;

  constructor(seed: number) {
    this.state = new Uint32Array(4);
    // SplitMix32 to initialize state
    let s = seed >>> 0;
    for (let i = 0; i < 4; i++) {
      s += 0x9e3779b9;
      let z = s;
      z = (z ^ (z >>> 16)) * 0x85ebca6b;
      z = (z ^ (z >>> 13)) * 0xc2b2ae35;
      z = z ^ (z >>> 16);
      this.state[i] = z >>> 0;
    }
  }

  /** Returns a float in [0, 1) */
  random(): number {
    const s = this.state;
    const result = Math.imul(s[1] * 5, 7) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return (result >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive */
  randInt(min: number, max: number): number {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  /** Returns a float in [min, max) */
  uniform(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  /** Sample from normal distribution (Box-Muller) */
  normal(mean: number, std: number): number {
    const u1 = this.random();
    const u2 = this.random();
    const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
    return mean + z * std;
  }
}

// ─── Kernel Density Estimation ───

interface KDE {
  samples: number[];
  bandwidth: number;
  low: number;
  high: number;
  logScale: boolean;
}

function buildKDE(values: number[], low: number, high: number, logScale: boolean): KDE {
  const n = values.length;
  // Scott's rule for bandwidth
  const std = standardDeviation(values);
  const bandwidth = std * Math.pow(n, -0.2) || (high - low) * 0.1;
  return { samples: values, bandwidth, low, high, logScale };
}

function kdeLogPdf(kde: KDE, x: number): number {
  const { samples, bandwidth, low, high } = kde;
  if (x < low || x > high) return -Infinity;

  let logSum = -Infinity;
  for (const s of samples) {
    const z = (x - s) / bandwidth;
    const logKernel = -0.5 * z * z - 0.5 * Math.log(2 * Math.PI) - Math.log(bandwidth);
    logSum = logSumExp(logSum, logKernel);
  }
  return logSum - Math.log(samples.length);
}

function sampleFromKDE(kde: KDE, rng: SeededRNG): number {
  const { samples, bandwidth, low, high } = kde;
  // Pick a random sample and add Gaussian noise
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = samples[Math.floor(rng.random() * samples.length)];
    const candidate = base + rng.normal(0, bandwidth);
    if (candidate >= low && candidate <= high) {
      return candidate;
    }
  }
  // Fallback: uniform
  return rng.uniform(low, high);
}

// ─── Utilities ───

function logSumExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const max = Math.max(a, b);
  return max + Math.log(Math.exp(a - max) + Math.exp(b - max));
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (pos - lower) * (sorted[upper] - sorted[lower]);
}

// ─── Main TPE Class ───

export class TPEOptimizer {
  private config: TPEConfig;
  private paramSpecs: ParameterSpec[];
  private trials: Trial[] = [];
  private rng: SeededRNG;
  private nextId = 0;

  constructor(paramSpecs: ParameterSpec[], config: Partial<TPEConfig> = {}) {
    this.config = { ...DEFAULT_TPE_CONFIG, ...config };
    this.paramSpecs = paramSpecs;
    this.rng = new SeededRNG(this.config.seed ?? Date.now());
  }

  /** Record a completed trial */
  tell(params: Record<string, number | string | boolean>, score: number): Trial {
    const trial: Trial = {
      id: this.nextId++,
      params,
      score,
      timestamp: Date.now(),
    };
    this.trials.push(trial);
    return trial;
  }

  /** Suggest next parameters to try */
  ask(): Record<string, number | string | boolean> {
    // During startup phase, sample uniformly
    if (this.trials.length < this.config.nStartupTrials) {
      return this.sampleUniform();
    }

    // Split trials into good (l) and bad (g) based on gamma quantile
    const { good, bad } = this.splitTrials();

    // For each parameter, build KDEs for good and bad, then sample
    const params: Record<string, number | string | boolean> = {};

    for (const spec of this.paramSpecs) {
      if (spec.type === "categorical") {
        params[spec.name] = this.sampleCategoricalTPE(spec, good, bad);
      } else {
        params[spec.name] = this.sampleNumericalTPE(spec, good, bad);
      }
    }

    return params;
  }

  /** Get the best trial so far */
  getBest(): Trial | null {
    if (this.trials.length === 0) return null;
    return this.trials.reduce((best, t) => t.score > best.score ? t : best);
  }

  /** Get all trials */
  getTrials(): Trial[] {
    return [...this.trials];
  }

  /** Get trial count */
  getTrialCount(): number {
    return this.trials.length;
  }

  /** Load previous trials (for warm-starting) */
  loadTrials(trials: Trial[]): void {
    this.trials = [...trials];
    this.nextId = Math.max(0, ...trials.map(t => t.id)) + 1;
  }

  // ─── Private Methods ───

  private sampleUniform(): Record<string, number | string | boolean> {
    const params: Record<string, number | string | boolean> = {};
    for (const spec of this.paramSpecs) {
      if (spec.type === "categorical") {
        const choices = spec.choices!;
        params[spec.name] = choices[Math.floor(this.rng.random() * choices.length)];
      } else if (spec.type === "integer") {
        params[spec.name] = this.rng.randInt(spec.low!, spec.high!);
      } else {
        // continuous
        if (spec.logScale) {
          const logLow = Math.log(spec.low!);
          const logHigh = Math.log(spec.high!);
          params[spec.name] = Math.exp(this.rng.uniform(logLow, logHigh));
        } else {
          params[spec.name] = this.rng.uniform(spec.low!, spec.high!);
        }
      }
    }
    return params;
  }

  private splitTrials(): { good: Trial[]; bad: Trial[] } {
    const sorted = [...this.trials].sort((a, b) => b.score - a.score); // highest score first
    const nGood = Math.max(1, Math.floor(this.config.gamma * sorted.length));
    return {
      good: sorted.slice(0, nGood),
      bad: sorted.slice(nGood),
    };
  }

  private sampleNumericalTPE(
    spec: ParameterSpec,
    good: Trial[],
    bad: Trial[],
  ): number {
    const low = spec.low!;
    const high = spec.high!;
    const isLog = spec.logScale ?? false;

    // Extract values (in log space if needed)
    const transform = (v: number) => isLog ? Math.log(v) : v;
    const untransform = (v: number) => isLog ? Math.exp(v) : v;

    const goodVals = good.map(t => transform(t.params[spec.name] as number));
    const badVals = bad.length > 0 ? bad.map(t => transform(t.params[spec.name] as number)) : [];

    const tLow = transform(low);
    const tHigh = transform(high);

    // Build KDEs
    const kdeGood = buildKDE(goodVals, tLow, tHigh, isLog);
    const kdeBad = badVals.length > 0 ? buildKDE(badVals, tLow, tHigh, isLog) : null;

    // Generate candidates and pick the one with best EI (l/g ratio)
    let bestCandidate = this.rng.uniform(tLow, tHigh);
    let bestEI = -Infinity;

    for (let i = 0; i < this.config.nEICandidates; i++) {
      const candidate = sampleFromKDE(kdeGood, this.rng);
      const logL = kdeLogPdf(kdeGood, candidate);
      const logG = kdeBad ? kdeLogPdf(kdeBad, candidate) : Math.log(1 / (tHigh - tLow));
      const ei = logL - logG; // maximize l(x) / g(x)

      if (ei > bestEI) {
        bestEI = ei;
        bestCandidate = candidate;
      }
    }

    let result = untransform(Math.max(tLow, Math.min(tHigh, bestCandidate)));

    // Round for integer params
    if (spec.type === "integer") {
      result = Math.round(result);
    }

    return result;
  }

  private sampleCategoricalTPE(
    spec: ParameterSpec,
    good: Trial[],
    bad: Trial[],
  ): string | number | boolean {
    const choices = spec.choices!;
    const nChoices = choices.length;

    // Count occurrences in good and bad
    const goodCounts = new Map<string, number>();
    const badCounts = new Map<string, number>();

    for (const choice of choices) {
      goodCounts.set(String(choice), this.config.priorWeight); // prior
      badCounts.set(String(choice), this.config.priorWeight);
    }

    for (const t of good) {
      const v = String(t.params[spec.name]);
      goodCounts.set(v, (goodCounts.get(v) || 0) + 1);
    }
    for (const t of bad) {
      const v = String(t.params[spec.name]);
      badCounts.set(v, (badCounts.get(v) || 0) + 1);
    }

    // Normalize to probabilities
    const goodTotal = Array.from(goodCounts.values()).reduce((a, b) => a + b, 0);
    const badTotal = Array.from(badCounts.values()).reduce((a, b) => a + b, 0);

    // Compute EI = l(x) / g(x) for each choice
    let bestChoice = choices[0];
    let bestEI = -Infinity;

    for (const choice of choices) {
      const pGood = (goodCounts.get(String(choice)) || 0) / goodTotal;
      const pBad = (badCounts.get(String(choice)) || 0) / badTotal;
      const ei = pBad > 0 ? pGood / pBad : pGood * 1000;

      if (ei > bestEI) {
        bestEI = ei;
        bestChoice = choice;
      }
    }

    return bestChoice;
  }
}
