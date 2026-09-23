import { describe, it, expect } from "vitest";
import { paginate, pageLabel, rangeLabel, PAGE_SIZES } from "./paginate";

const items = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("paginate", () => {
  it("offers the requested page sizes", () => {
    expect([...PAGE_SIZES]).toEqual([10, 20, 50]);
  });

  it("slices the right window and reports 1-based bounds", () => {
    const p = paginate(items(37), 2, 10);
    expect(p.items).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(p.from).toBe(11);
    expect(p.to).toBe(20);
    expect(p.total).toBe(37);
    expect(p.totalPages).toBe(4);
  });

  it("gives a short last page rather than padding it", () => {
    const p = paginate(items(37), 4, 10);
    expect(p.items).toEqual([31, 32, 33, 34, 35, 36, 37]);
    expect(p.to).toBe(37);
    expect(p.hasNext).toBe(false);
    expect(p.hasPrev).toBe(true);
  });

  it("clamps a page past the end to the last real page", () => {
    // The filter-shrinks-the-list case: the caller still holds page 4.
    const p = paginate(items(3), 4, 10);
    expect(p.page).toBe(1);
    expect(p.items).toEqual([1, 2, 3]);
    expect(p.totalPages).toBe(1);
  });

  it("clamps a page below the start", () => {
    expect(paginate(items(30), 0, 10).page).toBe(1);
    expect(paginate(items(30), -5, 10).page).toBe(1);
  });

  it("reports one page, not zero, on an empty list", () => {
    const p = paginate([], 1, 10);
    expect(p.items).toEqual([]);
    expect(p.totalPages).toBe(1);
    expect(p.total).toBe(0);
    expect(p.from).toBe(0);
    expect(p.to).toBe(0);
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(false);
  });

  it("survives a nonsense page size instead of dividing by zero", () => {
    expect(paginate(items(5), 1, 0).items).toHaveLength(1);
    expect(Number.isFinite(paginate(items(5), 1, 0).totalPages)).toBe(true);
  });

  it("changing page size repartitions the same list", () => {
    expect(paginate(items(37), 1, 10).totalPages).toBe(4);
    expect(paginate(items(37), 1, 20).totalPages).toBe(2);
    expect(paginate(items(37), 1, 50).totalPages).toBe(1);
  });

  it("does not reorder, filter or drop anything", () => {
    const all = items(25);
    const rejoined = [1, 2, 3].flatMap((n) => paginate(all, n, 10).items);
    expect(rejoined).toEqual(all);
  });
});

describe("labels", () => {
  it("reads Page 2 of 4", () => {
    expect(pageLabel(paginate(items(37), 2, 10))).toBe("Page 2 of 4");
  });

  it("never says Page 1 of 0", () => {
    expect(pageLabel(paginate([], 1, 10))).toBe("Page 1 of 1");
  });

  it("describes the visible window", () => {
    expect(rangeLabel(paginate(items(37), 2, 10))).toBe("Showing 11–20 of 37");
    expect(rangeLabel(paginate([], 1, 10))).toBe("No rows");
  });
});
