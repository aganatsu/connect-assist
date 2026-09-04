import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Three management switches have two names each — a legacy short form
 * (trailingStop / breakEven / partialTP) and the current *Enabled form.
 *
 * The toggles in BotConfigModal write both, so using them is safe. Presets did
 * not: they set only the *Enabled form. Applying a preset updated one name and
 * left the other stale, and because the config merge read the legacy name FIRST,
 * the stale value won and silently defeated the setting.
 *
 * Observed 2026-09-04: trailing could not be switched off. Both keys read true,
 * the config had genuinely saved (bot_configs.updated_at 01:05), and a position
 * opened at 02:40 still carried trailingStopEnabled: true. STYLE_OVERRIDES for
 * scalper wants trailing off — "BE/trailing hurt performance by cutting winners
 * short on 5m noise" — but that only applies when the stored value still equals
 * DEFAULTS, so any stale explicit value beats it.
 *
 * Fix is in two halves and both are needed: current name takes precedence, and
 * presets write both names so they cannot leave the pair inconsistent.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const modal = await Deno.readTextFile(
  new URL("../../../src/components/BotConfigModal.tsx", import.meta.url),
);

const PAIRS: Array<[string, string]> = [
  ["trailingStopEnabled", "trailingStop"],
  ["breakEvenEnabled", "breakEven"],
  ["partialTPEnabled", "partialTP"],
];

Deno.test("the current key is read before the legacy key", () => {
  for (const [current, legacy] of PAIRS) {
    const re = new RegExp(`${current}: exit\\.${current} \\?\\? exit\\.${legacy}\\b`);
    assert(
      re.test(scanner),
      `${current} must read exit.${current} before exit.${legacy} — reading the ` +
        `legacy name first lets a stale value defeat the UI`,
    );
  }
});

Deno.test("the legacy key is still honoured as a fallback", () => {
  // Configs written before the rename only have the legacy name. Dropping it
  // would silently reset those users to the default.
  for (const [current, legacy] of PAIRS) {
    assert(
      new RegExp(`exit\\.${legacy}\\b`).test(scanner),
      `exit.${legacy} must remain as a fallback for pre-rename configs`,
    );
  }
});

Deno.test("every preset writes both names", () => {
  // A preset setting only one name is what created the stale pair.
  for (const [current, legacy] of PAIRS) {
    const assignments = modal.match(new RegExp(`${current}: (true|false),`, "g")) ?? [];
    assert(assignments.length > 0, `no preset assignments found for ${current}`);
    const paired = modal.match(
      new RegExp(`${current}: (true|false), ${legacy}: (true|false),`, "g"),
    ) ?? [];
    assert(
      paired.length === assignments.length,
      `${assignments.length} presets set ${current} but only ${paired.length} also ` +
        `set ${legacy} — the unpaired ones will leave a stale value`,
    );
  }
});

Deno.test("presets set both names to the same value", () => {
  for (const [current, legacy] of PAIRS) {
    const re = new RegExp(`${current}: (true|false), ${legacy}: (true|false),`, "g");
    for (const m of modal.matchAll(re)) {
      assert(
        m[1] === m[2],
        `a preset sets ${current}=${m[1]} but ${legacy}=${m[2]} — they must agree`,
      );
    }
  }
});

Deno.test("the toggles still write both names", () => {
  // The toggles were already correct; this guards against a later refactor
  // dropping the legacy write while old configs still carry it.
  for (const [current, legacy] of PAIRS) {
    assert(
      modal.includes(`updateField('exit', '${legacy}', v); updateField('exit', '${current}', v)`),
      `the ${current} toggle must keep writing both names`,
    );
  }
});
