# Known control defects — `smc-zone-impulse-control-v1`

Behaviours the frozen control reproduces **on purpose** because production runs
them, even though they are wrong. The causal baseline must describe the
strategy that actually traded, not a corrected one — otherwise the baseline
measures something that has never existed.

Each entry stays here until it has been tested as CONTROL vs EXPERIMENT on its
own evidence, separately from any extraction work.

---

## KNOWN_CONTROL_DEFECT #1 — scanner-local `calculatePremiumDiscount` shadows the fixed shared one

**Status:** preserved in the control. Do not fix during Stage 2H.

`supabase/functions/bot-scanner/index.ts:757` defines a local
`calculatePremiumDiscount` that shadows the export from
`_shared/smcAnalysis.ts`. The shared version was fixed on **2026-09-03**
(`48e37245`, *"premium/discount reads past 100% and below 0%, and does so
anti-trend"*): it clamps `zonePercent` to 0–100 and reports `rawPercent`,
`outOfRange`, `swingHigh` and `swingLow`.

**The scanner has never run that fix.** The local copy is the pre-fix version:
unclamped, and returning only `{ currentZone, zonePercent, oteZone }`.

### Evidence

Measured across the Stage 2G corpus, not inferred:

- **0 of 152** stored HTF bundles contain `rawPercent`
- a USD/CAD row records `zonePercent = 166.67` — a value the fixed version
  cannot emit, since it clamps at 100
- raw values agree to 12 decimal places, so the inputs are identical and only
  the implementation differs

Found by the extraction parity harness, which compared the module's output
against what production actually recorded.

### What depends on it

`zonePercent` drives `currentZone` (premium >55, discount <45) and `oteZone`
(62–79). Those feed premium/discount scoring and the HTF bundle passed to the
zone engine. Switching implementations changes which zones read premium vs
discount, and therefore changes trade selection.

### How the control handles it

`_shared/smcHtfContext.ts` exports `calculatePremiumDiscountAsProduction`, a
verbatim copy of the scanner-local version, and uses it. A test pins the
absence of `rawPercent`/`outOfRange` so that if production behaviour ever
changes, the change is deliberate rather than discovered later.

### Planned experiment, AFTER the causal baseline exists

| arm | implementation |
|---|---|
| CONTROL | current shadowed behaviour (unclamped) |
| EXPERIMENT | shared fixed implementation (clamped, anti-trend) |

Not to be mixed into Stage 2H extraction.
