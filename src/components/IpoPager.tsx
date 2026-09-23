/**
 * Shared pagination footer for the IPO views.
 *
 * One component so Previous/Next, the page indicator and the size selector
 * behave identically in the scanner, the decision list and the trade history —
 * three places that would otherwise drift apart.
 */
import React from "react";
import { PAGE_SIZES, pageLabel, rangeLabel, type Page } from "@/lib/paginate";

export function IpoPager({
  page, onPage, size, onSize, sizes = PAGE_SIZES, label = "rows",
}: {
  page: Page<unknown>;
  onPage: (n: number) => void;
  size: number;
  onSize?: (n: number) => void;
  sizes?: readonly number[];
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap px-2 py-1 border-t border-border bg-card/60 shrink-0">
      <button
        type="button"
        onClick={() => onPage(page.page - 1)}
        disabled={!page.hasPrev}
        className="h-6 px-2 text-[10px] border border-input disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted"
      >
        Previous
      </button>
      <span className="text-[10px] font-mono tabular-nums" aria-live="polite">
        {pageLabel(page)}
      </span>
      <button
        type="button"
        onClick={() => onPage(page.page + 1)}
        disabled={!page.hasNext}
        className="h-6 px-2 text-[10px] border border-input disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted"
      >
        Next
      </button>
      <span className="text-[10px] text-muted-foreground">{rangeLabel(page)}</span>
      {onSize && (
        <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>{label} per page</span>
          {/* A native select: the shadcn Select renders into a portal, which
              makes it awkward to assert on and adds nothing at three options. */}
          <select
            value={size}
            onChange={(e) => onSize(Number(e.target.value))}
            aria-label={`${label} per page`}
            className="h-6 bg-background border border-input text-foreground text-[10px] px-1"
          >
            {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
