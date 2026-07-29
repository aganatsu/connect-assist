export interface GamePlanGenerationFailure {
  symbol: string;
  attempt: number;
  error: string;
}

export interface GamePlanGenerationResult<T> {
  plans: T[];
  failures: GamePlanGenerationFailure[];
  missingSymbols: string[];
  complete: boolean;
}

export interface GamePlanGenerationOptions<T> {
  symbols: string[];
  generate: (symbol: string, attempt: number) => Promise<T | null>;
  batchSize?: number;
  batchDelayMs?: number;
  retryDelayMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Generates one plan per enabled symbol, then retries only missing symbols
 * sequentially. The caller decides whether an incomplete result may be used;
 * production activation should require `complete === true`.
 */
export async function generateGamePlansWithRetry<T>(
  options: GamePlanGenerationOptions<T>,
): Promise<GamePlanGenerationResult<T>> {
  const batchSize = Math.max(1, options.batchSize ?? 3);
  const batchDelayMs = Math.max(0, options.batchDelayMs ?? 1_200);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_500);
  const plans = new Map<string, T>();
  const failures: GamePlanGenerationFailure[] = [];

  const attempt = async (symbol: string, attemptNumber: number) => {
    try {
      const plan = await options.generate(symbol, attemptNumber);
      if (plan) {
        plans.set(symbol, plan);
        return;
      }
      failures.push({
        symbol,
        attempt: attemptNumber,
        error: "Generation returned no plan",
      });
    } catch (error) {
      failures.push({
        symbol,
        attempt: attemptNumber,
        error: errorMessage(error),
      });
    }
  };

  for (let index = 0; index < options.symbols.length; index += batchSize) {
    const batch = options.symbols.slice(index, index + batchSize);
    await Promise.all(batch.map((symbol) => attempt(symbol, 1)));
    if (index + batchSize < options.symbols.length && batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }

  const firstPassMissing = options.symbols.filter((symbol) =>
    !plans.has(symbol)
  );
  for (const symbol of firstPassMissing) {
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    await attempt(symbol, 2);
  }

  const missingSymbols = options.symbols.filter((symbol) => !plans.has(symbol));
  return {
    plans: options.symbols.flatMap((symbol) => {
      const plan = plans.get(symbol);
      return plan ? [plan] : [];
    }),
    failures,
    missingSymbols,
    complete: missingSymbols.length === 0,
  };
}
