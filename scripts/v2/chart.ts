// V2 replay review chart: one self-contained HTML/SVG page per setup (local files only, nothing uploaded).
// 1H panel: candles, swings, break events, bias, leg box, POIs (own + opposing), target candidates and the selected target.
// 5m panel: touch/arm, protected swing, CHoCH, entry, SL, TP, exit. Footer: terminal reason / outcome and the event rows.
import type { EngineResult, V2Event } from "../../supabase/functions/_shared/v2/engine.ts";
import { fromPoints, type Series } from "../../supabase/functions/_shared/v2/barStore.ts";
import type { Pair } from "../../supabase/functions/_shared/v2/spec.ts";
import { nyParts } from "../../supabase/functions/_shared/v2/calendar.ts";

const W = 1180, PH = 330, PAD = 48;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const nyLabel = (t: number) => { const p = nyParts(t); return `${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`; };

interface Panel { s: Series; from: number; to: number; lo: number; hi: number; y0: number }
function px(p: Panel, i: number) { return PAD + ((i - p.from + 0.5) / (p.to - p.from + 1)) * (W - 2 * PAD); }
function py(p: Panel, v: number) { return p.y0 + 16 + (1 - (v - p.lo) / (p.hi - p.lo)) * (PH - 40); }
function slotOf(s: Series, t: number) { let lo = 0, hi = s.grid.length - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.grid[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; }

function candles(p: Panel): string {
  const w = Math.max(1, ((W - 2 * PAD) / (p.to - p.from + 1)) * 0.6);
  let out = "";
  for (let i = p.from; i <= p.to; i++) {
    const b = p.s.bars[i];
    const x = px(p, i);
    if (!b) { out += `<rect x="${x - w / 2}" y="${p.y0 + 16}" width="${w}" height="${PH - 40}" fill="#fde2e2" opacity="0.6"><title>MISSING ${nyLabel(p.s.grid[i])}</title></rect>`; continue; }
    const up = b.c >= b.o, col = up ? "#1f8a4c" : "#c0392b";
    out += `<line x1="${x}" x2="${x}" y1="${py(p, b.h)}" y2="${py(p, b.l)}" stroke="${col}"/>`;
    out += `<rect x="${x - w / 2}" y="${py(p, Math.max(b.o, b.c))}" width="${w}" height="${Math.max(1, Math.abs(py(p, b.o) - py(p, b.c)))}" fill="${col}"><title>${nyLabel(p.s.grid[i])} NY</title></rect>`;
  }
  return out;
}
function hline(p: Panel, v: number, from: number, to: number, col: string, label: string, dash = "") {
  const x1 = px(p, Math.max(p.from, from)), x2 = px(p, Math.min(p.to, to));
  return `<line x1="${x1}" x2="${x2}" y1="${py(p, v)}" y2="${py(p, v)}" stroke="${col}" stroke-width="1.5" ${dash ? `stroke-dasharray="${dash}"` : ""}/>` +
    `<text x="${x2 + 3}" y="${py(p, v) + 4}" font-size="10" fill="${col}">${esc(label)}</text>`;
}
function marker(p: Panel, i: number, v: number, col: string, label: string) {
  return `<circle cx="${px(p, i)}" cy="${py(p, v)}" r="4" fill="${col}"/><text x="${px(p, i) + 6}" y="${py(p, v) - 6}" font-size="10" fill="${col}">${esc(label)}</text>`;
}

export function renderSetup(res: EngineResult, pair: Pair, setupId: string, confirmT?: number): string {
  const s1 = res.store.series[pair]["1h"], s5 = res.store.series[pair]["5m"], ix1 = res.structure[pair]["1h"];
  const pts = (v: number) => fromPoints(pair, v).toFixed(pair.endsWith("JPY") ? 3 : 5);
  const evs = res.events.filter((e) => e.pair === pair && (e.id === setupId || e.id.startsWith(setupId + "@")));
  const poiEv = res.events.filter((e) => e.pair === pair && e.entity === "POI");
  const q = (id: string) => poiEv.find((e) => e.id === id && e.event === "QUALIFIED");
  const [, dir, oT, bT] = setupId.split("|");
  const armed = evs.find((e) => e.entity === "SETUP" && e.event === "ARMED")!;
  const terminal = [...evs].reverse().find((e) => e.entity === "SETUP" && e.event !== "ARMED" && e.event !== "CONFIRMED")!;
  const confirmed = evs.find((e) => e.event === "CONFIRMED");
  const exit = evs.find((e) => e.entity === "TRADE");
  const endT = exit?.t ?? terminal?.t ?? armed.t;
  const tKey = confirmT ?? confirmed?.t;
  const target = tKey ? res.targets.get(`${setupId}@${tKey}`) : undefined;
  const meta = q(setupId)!.data!;

  // 1H panel window: 25 bars before the origin to 6 bars after the end
  const o1 = slotOf(s1, +oT), b1 = slotOf(s1, +bT), e1 = slotOf(s1, endT);
  const p1: Panel = { s: s1, from: Math.max(0, o1 - 25), to: Math.min(s1.grid.length - 1, e1 + 6), lo: Infinity, hi: -Infinity, y0: 30 };
  // 5m panel: from 12 bars before the arm to 24 bars after the end
  const a5 = slotOf(s5, armed.t - 300_000), e5 = slotOf(s5, endT - 300_000);
  const p5: Panel = { s: s5, from: Math.max(0, a5 - 36), to: Math.min(s5.grid.length - 1, e5 + 24), lo: Infinity, hi: -Infinity, y0: 30 + PH + 30 };
  for (const p of [p1, p5]) for (let i = p.from; i <= p.to; i++) { const b = p.s.bars[i]; if (b) { p.lo = Math.min(p.lo, b.l); p.hi = Math.max(p.hi, b.h); } }
  const ent = terminal?.data ?? {};
  for (const v of [ent.entry, ent.sl, ent.tp, meta.low, meta.high].filter((x) => typeof x === "number") as number[]) { p5.lo = Math.min(p5.lo, v); p5.hi = Math.max(p5.hi, v); p1.lo = Math.min(p1.lo, v); p1.hi = Math.max(p1.hi, v); }
  for (const p of [p1, p5]) { const m = (p.hi - p.lo) * 0.06 || 1; p.lo -= m; p.hi += m; }

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${2 * PH + 80}" font-family="monospace">`;
  svg += `<text x="${PAD}" y="20" font-size="13" font-weight="bold">1H — structure, bias, leg, POIs, targets</text>`;
  svg += `<text x="${PAD}" y="${p5.y0 + 4}" font-size="13" font-weight="bold">5m — touch/arm, protected swing, CHoCH, entry, SL, TP, exit</text>`;
  // leg box
  svg += `<rect x="${px(p1, o1) - 4}" y="${py(p1, Math.max(...[o1, b1].map((i) => s1.bars[i]!.h)))}" width="${px(p1, b1) - px(p1, o1) + 8}" height="${Math.abs(py(p1, s1.bars[b1]!.h) - py(p1, s1.bars[o1]!.l))}" fill="none" stroke="#8e44ad" stroke-dasharray="4 3"/>`;
  svg += `<text x="${px(p1, o1)}" y="${py(p1, s1.bars[o1]!.l) + 14}" font-size="10" fill="#8e44ad">leg o→b (${dir})</text>`;
  // POIs on this pair qualified in the window: own leg (blue), same direction (light blue), opposing (orange)
  for (const e of poiEv.filter((x) => x.event === "QUALIFIED")) {
    const d = e.data!, bt = +e.id.split("|")[3];
    const bi = slotOf(s1, bt);
    const end = poiEv.find((x) => x.id === e.id && x.event !== "QUALIFIED");
    // draw every POI whose lifetime overlaps the window (an older opposing POI can still constrain this entry)
    if (bi > p1.to || (end && slotOf(s1, end.t) < p1.from)) continue;
    const opp = !e.id.includes(`|${dir}|`);
    const own = e.id === setupId;
    const col = own ? "#2471a3" : opp ? "#e67e22" : "#85c1e9";
    const x1 = px(p1, Math.max(p1.from, bi + 1)), x2 = end ? px(p1, Math.min(p1.to, slotOf(s1, end.t))) : px(p1, p1.to);
    svg += `<rect x="${x1}" y="${py(p1, d.high as number)}" width="${Math.max(2, x2 - x1)}" height="${Math.max(1, py(p1, d.low as number) - py(p1, d.high as number))}" fill="${col}" opacity="${own ? 0.35 : 0.2}" stroke="${col}"><title>${esc(e.id)} → ${end?.event ?? "live"}</title></rect>`;
    svg += `<text x="${x1 + 2}" y="${py(p1, d.high as number) - 2}" font-size="9" fill="${col}">${d.type}${own ? " (this setup)" : opp ? " opposing" : ""} → ${end?.event ?? "live"}</text>`;
  }
  svg += candles(p1);
  // swings and break events
  for (const sw of ix1.swings) {
    if (sw.i < p1.from || sw.i > p1.to) continue;
    svg += `<path d="M ${px(p1, sw.i) - 4} ${py(p1, sw.level) + (sw.kind === "H" ? -6 : 6)} l 4 ${sw.kind === "H" ? -6 : 6} l 4 ${sw.kind === "H" ? 6 : -6} z" fill="#555"/>`;
    if (sw.breakIdx !== -1 && sw.breakIdx <= p1.to) svg += hline(p1, sw.level, sw.i, sw.breakIdx, sw.kind === "H" ? "#1f8a4c" : "#c0392b", sw.kind === "H" ? "BOS↑" : "BOS↓", "2 2");
  }
  const dirEv = [...res.events].filter((e) => e.pair === pair && e.entity === "DIR" && e.t <= armed.t).pop();
  svg += `<text x="${W - PAD - 260}" y="20" font-size="12">bias at arm: ${esc(String(dirEv?.event))} (${esc(String(dirEv?.data?.status))})</text>`;
  // target candidates and selected target
  if (target) {
    for (const c of target.candidates) if (c.price !== null) svg += hline(p1, c.price, p1.from, p1.to, c.state === "VALID" ? "#16a085" : c.state === "SWEPT" ? "#aaa" : "#d35400", `${c.type} ${c.state}`, "6 4");
    if (target.selected !== null) svg += hline(p1, target.selected, p1.from, p1.to, "#0b5345", `TARGET${target.limitedBy ? " (opposing POI limit)" : ""}`);
  }
  // 5m panel
  svg += candles(p5);
  svg += hline(p5, meta.high as number, a5 - 36, e5 + 24, "#2471a3", "POI high", "1 3");
  svg += hline(p5, meta.low as number, a5 - 36, e5 + 24, "#2471a3", "POI low", "1 3");
  const armSlot = slotOf(s5, armed.t - 300_000);
  svg += marker(p5, armSlot, dir === "LONG" ? s5.bars[armSlot]!.l : s5.bars[armSlot]!.h, "#2471a3", "touch/arm");
  if (confirmed?.data) {
    const ps = slotOf(s5, confirmed.data.protectedSwing as number), k = slotOf(s5, confirmed.t - 300_000);
    svg += hline(p5, confirmed.data.level as number, ps, k, "#7d3c98", "protected swing");
    svg += marker(p5, k, s5.bars[k]!.c, "#7d3c98", "CHoCH");
  }
  if (typeof ent.entry === "number") svg += hline(p5, ent.entry, armSlot, e5 + 24, "#000", `entry ${pts(ent.entry)}`);
  if (typeof ent.sl === "number") svg += hline(p5, ent.sl, armSlot, e5 + 24, "#c0392b", `SL ${pts(ent.sl)}`);
  if (typeof ent.tp === "number") svg += hline(p5, ent.tp, armSlot, e5 + 24, "#1f8a4c", `TP ${pts(ent.tp)}`);
  if (exit) { const x = slotOf(s5, exit.t - 300_000); svg += marker(p5, x, exit.data!.exitPrice as number, exit.event === "EXIT_TP" ? "#1f8a4c" : "#c0392b", exit.event); }
  svg += `</svg>`;

  const trade = res.trades.find((t) => t.id.startsWith(setupId + "@"));
  const outcome = exit ? `${exit.event} at ${pts(exit.data!.exitPrice as number)}${trade?.netR != null ? ` — net R ${trade.netR.toFixed(3)}` : ""}${exit.data!.gapDuring ? " (DATA_GAP_DURING_TRADE)" : ""}` : terminal?.event ?? "open";
  const rows = [...poiEv.filter((e) => e.id === setupId), ...evs.filter((e) => e.entity !== "POI")]
    .sort((a, b) => a.t - b.t)
    .map((e: V2Event) => `<tr><td>${nyLabel(e.t)}</td><td>${e.entity}</td><td>${esc(e.event)}</td><td>${esc(JSON.stringify(e.data ?? {}))}</td></tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>V2 ${esc(pair)} ${esc(setupId)}</title>
<body style="font-family:monospace;margin:16px"><h3>V2 setup ${esc(pair)} ${esc(dir)} — terminal: ${esc(terminal?.event ?? "")} — outcome: ${esc(outcome)}</h3>
<div>POI ${esc(String(meta.type))} [${pts(meta.low as number)}, ${pts(meta.high as number)}] · times are America/New_York · spec v2.0.1</div>
${svg}<table border="1" cellspacing="0" cellpadding="3" style="font-size:11px;margin-top:8px"><tr><th>NY time</th><th>entity</th><th>event</th><th>data (points)</th></tr>${rows}</table></body>`;
}

/** Every setup (armed POI) in a result. */
export function setupsOf(res: EngineResult): { pair: Pair; id: string; confirmT?: number }[] {
  return res.events.filter((e) => e.entity === "SETUP" && e.event === "ARMED").map((e) => ({
    pair: e.pair, id: e.id, confirmT: res.events.find((x) => x.id === e.id && x.event === "CONFIRMED" && x.t >= e.t)?.t,
  }));
}
