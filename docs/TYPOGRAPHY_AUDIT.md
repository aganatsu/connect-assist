# Typography and text audit

Measured against `src/` on 2026-09-15. Counts are occurrences, not files.

## The baseline this uses

The brief asks for "polished, mature B2B SaaS". This application is not that,
deliberately: `index.css` defines `.panel` as *"Brutalist panel with thick
border"*, plus `.glow-cyan`, tier colours, and a mono face for numerics. It is a
dense trading terminal, and density is the point — an operator wants eight
panels visible, not generous whitespace.

So the baseline is the **strongest existing pattern**, per the brief, not an
imported SaaS style. Nothing here makes the UI airier. It makes the existing
density consistent.

## 1. Font size — the largest problem

**Fourteen distinct sizes.**

| | |
|---|---|
| `text-[10px]` | 523 |
| `text-xs` (12px) | 379 |
| `text-[9px]` | 265 |
| `text-sm` (14px) | 262 |
| `text-[11px]` | 178 |
| `text-[8px]` | 90 |
| `text-lg` | 24 |
| `text-[12px]` | 22 |
| `text-xl` | 16 |
| `text-2xl` | 11 |
| `text-base` | 5 |
| `text-[7px]` | 2 |
| `text-4xl` | 2 |
| `text-[13px]` | 1 |

Two problems, not one:

**Arbitrary values outnumber the scale 1,081 to 699.** Sizes are chosen per
component rather than from a ladder.

**Two ways to write the same size.** `text-[12px]` (22) and `text-xs` (379) are
identical. So are `text-[14px]` and `text-sm`. A reader cannot tell whether a
difference is intentional.

`text-[7px]` and `text-[8px]` (92 occurrences) are below the threshold where
most people can read a number reliably, on a screen showing prices.

## 2. Font weight

| | |
|---|---|
| `font-bold` | 365 |
| `font-medium` | 275 |
| `font-semibold` | 84 |
| `font-normal` | 7 |
| `font-black` | 1 |

`font-bold` is the most common weight in the entire application. When
two-thirds of text is bold, bold stops signalling anything. `font-semibold` —
the conventional heading weight — is the *third* most used, which means
headings are frequently lighter than the body text around them.

## 3. Colour — already good, with a leak

| | |
|---|---|
| `text-muted-foreground` | 1,123 |
| `text-destructive` | 232 |
| `text-foreground` | 214 |
| `text-success` | 203 |
| `text-primary` | 112 |
| `text-warning` | 59 |

This is a genuinely strong pattern and should be left alone.

The leak is ~260 raw palette classes doing the same jobs:

| Raw | Semantic equivalent | |
|---|---|---|
| `text-zinc-400` (35) | `text-muted-foreground` (1,123) | 3% |
| `text-green-400` (29) | `text-success` (203) | 12% |
| `text-red-400` (21) | `text-destructive` (232) | 8% |

Also `text-cyan-*` (54), `text-amber-*` (17), `text-orange-*` (16),
`text-yellow-*` (15). Raw palette does not follow the light/dark theme, so these
are the components that will look wrong when the theme switches.

## 4. Page titles

Nineteen headings, six different treatments:

```
text-xl font-bold                    7   ← the pattern
text-sm font-semibold                2
text-sm font-bold                    2
text-xl font-semibold text-foreground 2
text-xs font-bold uppercase tracking-wider 2
text-sm md:text-base font-bold truncate 1
```

`text-xl font-bold` is the plurality and is the right baseline. The `text-sm`
headings are the same element rendered three sizes smaller on some pages.

## 5. Labels — the one strong convention

191 `uppercase` and 161 `tracking-wider`, almost always together with
`text-[10px]` and `text-muted-foreground`. This is the most consistent thing in
the application and should become the canonical label token, not be changed.

## 6. Empty states

At least sixteen distinct phrasings for "there is nothing here":

```
No data yet (3)   No data (2)   No results (2)
No trades         No trades recorded yet      No trade history yet
No open positions No positions to compare     No paper account
No recommendations yet   No resolved setups yet
No rejected setups in this period
```

Three different sentences for *no trades* alone. No terminal punctuation on
some, none anywhere consistently.

## 7. Terminology

| Term | Count | |
|---|---|---|
| `Watchlist` | 21 | UI name |
| `Staged` | 20 | database name (`staged_setups`) |

The same concept, split almost exactly down the middle. The UI tab says
"Watchlist", the table is `staged_setups`, and the code uses
`isPromotedFromStaging`. A reader has to learn both.

Also `Zone Setup` (7) versus `Pending Order` (2) for one table
(`pending_orders`), and `Setup` (75) / `Signal` (86) used loosely for
overlapping ideas.

## What is proposed

Tokens in `src/index.css @layer components`, alongside the existing
`.text-profit` / `.panel` conventions — the same mechanism the codebase already
uses, so this is not a new system.

| Token | Resolves to | Replaces |
|---|---|---|
| `.ts-page-title` | 20px bold | the six heading variants |
| `.ts-section-title` | 14px bold | ad-hoc `text-sm font-bold` |
| `.ts-card-title` | 12px bold uppercase tracking-wider | the panel-header pattern |
| `.ts-label` | 10px bold uppercase tracking-wider muted | the 191/161 convention, named |
| `.ts-body` | 11px | `text-[11px]` |
| `.ts-body-sm` | 10px | `text-[10px]` |
| `.ts-caption` | 9px muted | `text-[9px]` |
| `.ts-table-header` | 10px bold uppercase tracking-wider muted | |
| `.ts-table-cell` | 11px | |
| `.ts-kpi-value` | mono bold | |
| `.ts-kpi-label` | 10px uppercase muted | |
| `.ts-helper` | 9px muted | |

Deliberately preserves 9/10/11/12px density. This is not a move to 14px body
text.

## What is deliberately NOT done

**No mechanical rewrite of 1,081 size sites.** A find-and-replace across every
component is a large visual change that cannot be verified here — there is no
browser automation on this machine (npm returns 503, Chrome is killed under
device policy), so nothing would catch a layout break. Tokens are introduced
and applied to the highest-traffic surfaces; the rest convert as files are
touched.

**`text-[7px]` and `text-[8px]` are flagged, not changed.** Raising them
reflows the panels they sit in. It is a design decision with visual
consequences, not a consistency fix.

**Terminology is reported, not renamed.** Watchlist/Staged spans database
columns, function names and user-facing copy. Renaming is a migration, not a
text change, and belongs in its own piece of work.
