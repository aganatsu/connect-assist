/**
 * Guard against code being swallowed by a `//` comment.
 *
 * A patch script that writes "line one\\n  line two" into a source file
 * produces a LITERAL backslash-n, not a newline. If the first line is a `//`
 * comment, everything after it on that physical line becomes part of the
 * comment — including real code.
 *
 * This happened on 2026-09-18 in smc-analysis/index.ts and cost a review
 * cycle. Two object properties were silently commented out:
 *
 *   dedupeKey: dayKey,   // symbol|side|date — for aggregate dedup\n
 *   archetype: ...,\n    turn, cont,
 *
 *   extendedPastPriorExtreme: tookPrior, sweptAndClosedBack: closedBack,
 *
 * Nothing caught it. `deno check` passes because the result is still valid
 * TypeScript — just with three fewer fields. The tests passed. CI was green.
 * The only symptom would have been missing keys in a diagnostic payload,
 * discovered after a deploy and a data run.
 *
 * That is the dangerous shape: a silent subtraction that type-checks. The
 * same class as the missing `analysis.atrValue` return that zeroed five
 * consumers, and the unmeasured factors that read as measured zeros.
 *
 * A comment that legitimately needs to discuss the two-character sequence
 * should reword or use a code fence — the false-positive cost is one edit,
 * the false-negative cost is a deploy.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";

Deno.test("no literal \\n inside a // comment (it would swallow the rest of the line)", async () => {
  const offenders: string[] = [];
  for await (
    const entry of walk("supabase/functions", {
      exts: [".ts"],
      includeDirs: false,
    })
  ) {
    const text = await Deno.readTextFile(entry.path);
    text.split("\n").forEach((line, idx) => {
      const at = line.indexOf("//");
      // Only the part AFTER the comment marker matters: a string literal
      // earlier in the line may legitimately contain an escaped newline.
      if (at >= 0 && line.slice(at).includes("\\n")) {
        offenders.push(`${entry.path}:${idx + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assertEquals(
    offenders,
    [],
    `Literal \\n after a // comment marker — the rest of the line is commented out:\n${offenders.join("\n")}`,
  );
});
