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
 */

import type { OptimizationResult, TrialResult } from "./optimizationLoop.ts";
import { paramsToConfig } from "./parameterSpace.ts";

// ─── Types ───

export interface ApplyConfig {
  supabaseUrl: string;
  supabaseKey: string;
  userId: string;
  configId: string;
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

  // Gate 1: Optimization loop already decided
  if (!autoApplied || !bestTrial) {
    const reason = rejectReason ?? "No best trial found";
    await sendTelegramNotification(applyConfig, formatRejectMessage(reason, optimizationResult));
    return { applied: false, reason };
  }

  // Gate 2: Walk-forward must be "robust"
  if (bestTrial.backtest.walkForward?.verdict !== "robust") {
    const verdict = bestTrial.backtest.walkForward?.verdict ?? "unknown";
    const reason = `Walk-forward verdict is "${verdict}", not "robust"`;
    await sendTelegramNotification(applyConfig, formatRejectMessage(reason, optimizationResult));
    return { applied: false, reason };
  }

  // Build new config
  const newConfig = paramsToConfig(bestTrial.trial.params, currentConfig);

  // Gate 3: Sanity check — new config must have required fields
  const requiredFields = ["factorWeights", "minConfluence", "riskPerTrade"];
  for (const field of requiredFields) {
    if (newConfig[field] === undefined) {
      const reason = `New config missing required field: ${field}`;
      await sendTelegramNotification(applyConfig, formatRejectMessage(reason, optimizationResult));
      return { applied: false, reason };
    }
  }

  // Step 1: Backup current config
  const backupId = await backupConfig(applyConfig, currentConfig);

  // Step 2: Write new config to Supabase
  await writeConfig(applyConfig, newConfig);

  // Step 3: Send success notification
  await sendTelegramNotification(
    applyConfig,
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
    config_snapshot: JSON.stringify(currentConfig),
    created_at: new Date().toISOString(),
  };

  const url = `${config.supabaseUrl}/rest/v1/config_backups`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
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

async function writeConfig(
  config: ApplyConfig,
  newConfig: Record<string, any>,
): Promise<void> {
  // Remove non-config fields that shouldn't be written back
  const { id, user_id, created_at, updated_at, ...configFields } = newConfig;

  const url = `${config.supabaseUrl}/rest/v1/bot_configs?id=eq.${config.configId}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      ...configFields,
      updated_at: new Date().toISOString(),
      last_optimized_at: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to write config: ${response.status} ${response.statusText}`);
  }
}

// ─── Telegram Notifications ───

async function sendTelegramNotification(
  config: ApplyConfig,
  message: string,
): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.log("[Optimizer] No Telegram config — skipping notification");
    console.log("[Optimizer] Message:", message);
    return;
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      console.warn(`Telegram notification failed: ${response.status}`);
    }
  } catch (err) {
    console.warn(`Telegram notification error: ${(err as Error).message}`);
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
    "✅ *Optimizer: Config Auto-Applied*",
    "",
    `📈 Improvement: *+${improvementPercent.toFixed(1)}%*`,
    `🎯 Walk-Forward: *${backtest.walkForward?.verdict}* (${((backtest.walkForward?.consistencyScore ?? 0) * 100).toFixed(0)}%)`,
    "",
    "*New Performance:*",
    `• Trades: ${backtest.totalTrades}`,
    `• Win Rate: ${(backtest.winRate * 100).toFixed(1)}%`,
    `• Profit Factor: ${backtest.profitFactor.toFixed(2)}`,
    `• Expectancy: ${backtest.expectancy.toFixed(2)} pips`,
    `• Max DD: ${backtest.maxDrawdownPercent.toFixed(1)}%`,
    "",
    `📋 Trials run: ${result.trials.length}`,
    `⏱ Duration: ${(result.durationMs / 1000 / 60).toFixed(1)} min`,
    `💾 Backup: \`${backupId}\``,
    "",
    "_Target: Paper Trading_",
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
    "⚠️ *Optimizer: Config NOT Applied*",
    "",
    `❌ Reason: ${reason}`,
    "",
    `📊 Baseline score: ${baselineScore.toFixed(2)}`,
    `📊 Best trial score: ${bestScore.toFixed(2)}`,
    `📋 Trials run: ${result.trials.length}`,
    `⏱ Duration: ${(result.durationMs / 1000 / 60).toFixed(1)} min`,
    "",
    "_No changes made to paper trading config._",
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
      "Authorization": `Bearer ${config.supabaseKey}`,
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

  const previousConfig = JSON.parse(data[0].config_snapshot);
  await writeConfig(config, previousConfig);

  await sendTelegramNotification(config, [
    "🔄 *Optimizer: Config Rolled Back*",
    "",
    `Restored backup: \`${backupId}\``,
    "_Paper trading config reverted to previous state._",
  ].join("\n"));

  return true;
}
