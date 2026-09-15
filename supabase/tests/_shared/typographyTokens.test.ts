import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * docs/TYPOGRAPHY_AUDIT.md. Measured 2026-09-15: 14 distinct font sizes,
 * arbitrary px outnumbering the Tailwind scale 1,081 to 699, two spellings of
 * the same size, and ~260 raw palette classes bypassing semantic tokens that
 * already dominate 10:1.
 *
 * These tests hold the two things that were actually fixed. They do not assert
 * a size ladder across every component — 1,081 sites were deliberately not
 * rewritten, because nothing here can verify the visual result.
 */

const css = await Deno.readTextFile(new URL("../../../src/index.css", import.meta.url));

async function srcFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: URL) {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(`${e.name}${e.isDirectory ? "/" : ""}`, dir);
      if (e.isDirectory) await walk(u);
      else if (/\.tsx?$/.test(e.name)) out.push(await Deno.readTextFile(u));
    }
  }
  await walk(new URL("../../../src/", import.meta.url));
  return out;
}
const sources = await srcFiles();
const all = sources.join("\n");

Deno.test("typography tokens live in the existing component layer", () => {
  // Alongside .text-profit and .panel — the mechanism the codebase already
  // uses. A parallel system would be one more thing to be inconsistent with.
  const layer = css.slice(css.indexOf("@layer components"));
  for (const t of [
    "ts-page-title", "ts-section-title", "ts-card-title", "ts-label",
    "ts-body", "ts-caption", "ts-table-header", "ts-table-cell",
    "ts-kpi-value", "ts-kpi-label",
  ]) {
    assert(new RegExp(`\\.${t}\\s*\\{`).test(layer), `.${t} must be defined`);
  }
});

Deno.test("the label token matches the convention that already existed", () => {
  // 191 uppercase + 161 tracking-wider, almost always with text-[10px] and
  // text-muted-foreground. The token names that pattern; it must not redefine
  // it, or 191 existing usages silently disagree with the token.
  const m = css.match(/\.ts-label\s*\{\s*@apply ([^;]+);/);
  assert(m, ".ts-label defined");
  for (const part of ["text-[10px]", "uppercase", "tracking-wider", "text-muted-foreground"]) {
    assert(m![1].includes(part), `.ts-label must keep ${part}`);
  }
});

Deno.test("page title matches the plurality, not an invented size", () => {
  // text-xl font-bold was 7 of 19 headings. Picking anything else would make
  // the majority of existing pages wrong.
  const m = css.match(/\.ts-page-title\s*\{\s*@apply ([^;]+);/);
  assert(m![1].includes("text-xl") && m![1].includes("font-bold"));
});

Deno.test("density is preserved — this is a terminal, not a SaaS dashboard", () => {
  // The brief asked for B2B SaaS polish. index.css calls its own panel
  // "Brutalist" and the app shows eight at once. Widening body text to 14px
  // would reflow every screen.
  const body = css.match(/\.ts-body\s*\{\s*@apply ([^;]+);/);
  assert(/text-\[1[01]px\]/.test(body![1]), `.ts-body must stay 10-11px, got ${body![1]}`);
});

Deno.test("raw palette no longer duplicates a semantic token", () => {
  // text-zinc-400 vs text-muted-foreground, text-green-400 vs text-success,
  // text-red-400 vs text-destructive — same job, and the raw ones do not
  // follow the light/dark theme.
  for (const raw of ["text-zinc-400", "text-zinc-500", "text-green-400", "text-red-400"]) {
    assertEquals(
      (all.match(new RegExp(raw, "g")) ?? []).length, 0,
      `${raw} has a semantic equivalent and must not reappear`,
    );
  }
});

Deno.test("colours that carry meaning are left alone", () => {
  // cyan marks OTE/highlight, amber and orange mark degrees of warning. There
  // is no single semantic token for those, and inventing one would be a design
  // decision dressed as a consistency fix.
  assert((all.match(/text-cyan-\d+/g) ?? []).length > 0,
    "cyan should still be present — it was not part of this change");
});
