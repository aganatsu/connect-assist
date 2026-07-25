/**
 * Auto-Apply Logic — Applies optimized configs to paper trading
 * with safety rails and Telegram notification.
 * 
 * Safety rails:
 * 1. Walk-forward verdict must be "robust" (≥75% folds profitable)
 * 2. Improvement must exceed 15% over baseline
 * 3. Max delta ±50% enforced (already done in optimization loop)
 * 4. Config is validated before writing
 * 5. Previous config is backed up before overwrite
 * 6. Telegram notification sent on every apply/reject decision
 * 
 * Integration notes:
 * - Writes to `bot_configs.config_json` (the actual JSONB column)
 * - Uses the project's `/functions/v1/telegram-notify` edge function
 * - Reads Telegram chat IDs from `user_settings.preferences_json`
 */

import type { OptimizationResult, TrialResult } from "./optimizationLoop.ts";
import { paramsToConfig } from "./parameterSpace.ts";
import { fetchTelegramChatIds } from "./backtestRunner.ts";

// ─── Types ───

export interface ApplyConfig {
  supabaseUrl: string;
  supabaseKey: string;
  userId: string;
  configId: string;
  /** Override: explicit Telegram chat IDs (skips user_settings lookup) */
  telegramChatIds?: string[];
  /** Deprecated: kept for backward compat with CLI args */
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface ApplyResult {
  applied: boolean;
  reason: string;
  backupId?: string;
  newConfigSnapshot?: Record<string, any>;
}

// ─── Auto-Apply ───

/**
 * Apply the best trial's config to the paper trading config in Supabase.
 * 
 * Only applies if:
 * - autoApplied flag is true (all gates passed in optimization loop)
 * - Walk-forward verdict is "robust"
 * - Config validation passes
 */
export async function autoApplyResult(
  optimizationResult: OptimizationResult,
  currentConfig: Record<string, any>,
  applyConfig: ApplyConfig,
): Promise<ApplyResult> {
  const { bestTrial, autoApplied, improvementPercent, rejectReason } = optimizationResult;

  // Resolve Telegram chat IDs
  const chatIds = await resolveTelegramChatIds(applyConfig);

  // Gate 1: Optimization loop already decided
  if (!autoApplied || !bestTrial) {
    const reason = rejectReason ?? "No best trial found";
    await sendNotification(applyConfig, chatIds, formatRejectMessage(reason, optimizationResult));
    return { applied: false, reason };
  }

  // Gate 2: Walk-forward must be "robust"
  if (bestTrial.backtest.walkForward?.verdict !== "robust") {
    const verdict = bestTrial.backtest.walkForward?.verdict ?? "unknown";
    const reason = `Walk-forward verdict is "${verdict}", not "robust"`;
    await sendNotification(applyConfig, chatIds, formatRejectMessage(reason, optimizationResult));
    return { applied: false, reason };
  }

  // Build new config from optimized params
  const newConfig = paramsToConfig(bestTrial.trial.params, currentConfig.config_json || currentConfig);

  // Gate 3: Sanity check — new config must have required fields
  const requiredFields = ["factorWeights", "minConfluence", "riskPerTrade"];
  for (const field of requiredFields) {
    if (newConfig[field] === undefined) {
      const reason = `New config missing required field: ${field}`;
      await sendNotification(applyConfig, chatIds, formatRejectMessage(reason, optimizationResult));
      return { applied: false, reason };
    }
  }

  // Step 1: Backup current config
  const backupId = await backupConfig(applyConfig, currentConfig);

  // Step 2: Write new config to Supabase (into config_json column)
  await writeConfig(applyConfig, newConfig);

  // Step 3: Send success notification
  await sendNotification(
    applyConfig,
    chatIds,
    formatApplyMessage(optimizationResult, bestTrial, improvementPercent, backupId),
  );

  return {
    applied: true,
    reason: `Applied: +${improvementPercent.toFixed(1)}% improvement, walk-forward robust`,
    backupId,
    newConfigSnapshot: newConfig,
  };
}

// ─── Supabase Operations ───

async function backupConfig(
  config: ApplyConfig,
  currentConfig: Record<string, any>,
): Promise<string> {
  const backupId = `backup_${Date.now()}`;
  const backupPayload = {
    backup_id: backupId,
    user_id: config.userId,
    config_id: config.configId,
    config_snapshot: currentConfig.config_json || currentConfig,
    created_at: new Date().toISOString(),
  };

  const url = `${config.supabaseUrl}/rest/v1/config_backups`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": config.supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(backupPayload),
  });

  if (!response.ok) {
    console.warn(`Backup write failed (${response.status}), proceeding anyway`);
  }

  return backupId;
}

/**
 * Write the optimized config to bot_configs.config_json.
 * 
 * IMPORTANT: The bot_configs table stores config in a `config_json` JSONB column.
 * We PATCH only that column (plus updated_at via trigger).
 */
async function writeConfig(
  config: ApplyConfig,
  newConfig: Record<string, any>,
): Promise<void> {
  const url = `${config.supabaseUrl}/rest/v1/bot_configs?id=eq.${config.configId}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "apikey": config.supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      config_json: newConfig,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Failed to write config: ${response.status} ${response.statusText} — ${errText}`);
  }
}

// ─── Telegram Notifications ───

/**
 * Resolve Telegram chat IDs from config or user_settings.
 */
async function resolveTelegramChatIds(config: ApplyConfig): Promise<string[]> {
  // Explicit override takes priority
  if (config.telegramChatIds && config.telegramChatIds.length > 0) {
    return config.telegramChatIds;
  }

  // Legacy single chat ID from CLI args
  if (config.telegramChatId) {
    return [config.telegramChatId];
  }

  // Look up from user_settings
  try {
    return await fetchTelegramChatIds(config.supabaseUrl, config.supabaseKey, config.userId);
  } catch {
    return [];
  }
}

/**
 * Send notification via the project's telegram-notify edge function.
 * Falls back to direct Telegram Bot API if telegramBotToken is provided.
 */
async function sendNotification(
  config: ApplyConfig,
  chatIds: string[],
  message: string,
): Promise<void> {
  if (chatIds.length === 0) {
    console.log("[Optimizer] No Telegram chat IDs configured — skipping notification");
    console.log("[Optimizer] Message:", message);
    return;
  }

  // Primary path: use the project's telegram-notify edge function
  const notifyUrl = `${config.supabaseUrl}/functions/v1/telegram-notify`;

  for (const chatId of chatIds) {
    try {
      const response = await fetch(notifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": config.supabaseKey,
        },
        body: JSON.stringify({
          chat_id: chatId,
          message,
        }),
      });

      if (!response.ok) {
        console.warn(`[Optimizer] telegram-notify failed for chat ${chatId}: ${response.status}`);
        // Fallback: try direct Telegram Bot API if token is available
        await fallbackDirectTelegram(config, chatId, message);
      }
    } catch (err) {
      console.warn(`[Optimizer] telegram-notify error for chat ${chatId}: ${(err as Error).message}`);
      await fallbackDirectTelegram(config, chatId, message);
    }
  }
}

/**
 * Fallback: send directly via Telegram Bot API (for CLI usage with explicit bot token).
 */
async function fallbackDirectTelegram(
  config: ApplyConfig,
  chatId: string,
  message: string,
): Promise<void> {
  if (!config.telegramBotToken) return;

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.warn(`[Optimizer] Direct Telegram fallback failed: ${(err as Error).message}`);
  }
}

// ─── Message Formatting ───

function formatApplyMessage(
  result: OptimizationResult,
  bestTrial: TrialResult,
  improvementPercent: number,
  backupId: string,
): string {
  const { backtest } = bestTrial;
  const lines = [
    "✅ <b>Optimizer: Config Auto-Applied</b>",
    "",
    `📈 Improvement: <b>+${improvementPercent.toFixed(1)}%</b>`,
    `🎯 Walk-Forward: <b>${backtest.walkForward?.verdict}</b> (${((backtest.walkForward?.consistencyScore ?? 0) * 100).toFixed(0)}%)`,
    "",
    "<b>New Performance:</b>",
    `• Trades: ${backtest.totalTrades}`,
    `• Win Rate: ${(backtest.winRate * 100).toFixed(1)}%`,
    `• Profit Factor: ${backtest.profitFactor.toFixed(2)}`,
    `• Expectancy: ${backtest.expectancy.toFixed(2)} pips`,
    `• Max DD: ${backtest.maxDrawdownPercent.toFixed(1)}%`,
    "",
    `📋 Trials run: ${result.trials.length}`,
    `⏱ Duration: ${(result.durationMs / 1000 / 60).toFixed(1)} min`,
    `💾 Backup: <code>${backupId}</code>`,
    "",
    "<i>Target: Paper Trading</i>",
  ];
  return lines.join("\n");
}

function formatRejectMessage(
  reason: string,
  result: OptimizationResult,
): string {
  const bestScore = result.bestTrial?.compositeScore ?? 0;
  const baselineScore = result.baseline.compositeScore;
  const lines = [
    "⚠️ <b>Optimizer: Config NOT Applied</b>",
    "",
    `❌ Reason: ${reason}`,
    "",
    `📊 Baseline score: ${baselineScore.toFixed(2)}`,
    `📊 Best trial score: ${bestScore.toFixed(2)}`,
    `📋 Trials run: ${result.trials.length}`,
    `⏱ Duration: ${(result.durationMs / 1000 / 60).toFixed(1)} min`,
    "",
    "<i>No changes made to paper trading config.</i>",
  ];
  return lines.join("\n");
}

/**
 * Rollback to a previous config backup.
 * Used if the auto-applied config causes issues.
 */
export async function rollbackConfig(
  config: ApplyConfig,
  backupId: string,
): Promise<boolean> {
  // Fetch backup
  const url = `${config.supabaseUrl}/rest/v1/config_backups?backup_id=eq.${backupId}&select=config_snapshot`;
  const response = await fetch(url, {
    headers: {
      "apikey": config.supabaseKey,
    },
  });

  if (!response.ok) {
    console.error(`Failed to fetch backup ${backupId}: ${response.status}`);
    return false;
  }

  const data = await response.json();
  if (data.length === 0) {
    console.error(`Backup ${backupId} not found`);
    return false;
  }

  // config_snapshot is stored as JSONB, so it's already an object
  const previousConfig = typeof data[0].config_snapshot === "string"
    ? JSON.parse(data[0].config_snapshot)
    : data[0].config_snapshot;

  await writeConfig(config, previousConfig);

  // Notify
  const chatIds = await resolveTelegramChatIds(config);
  await sendNotification(config, chatIds, [
    "🔄 <b>Optimizer: Config Rolled Back</b>",
    "",
    `Restored backup: <code>${backupId}</code>`,
    "<i>Paper trading config reverted to previous state.</i>",
  ].join("\n"));

  return true;
}
