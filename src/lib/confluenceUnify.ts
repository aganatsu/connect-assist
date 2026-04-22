// Unifies SMC + Extended ICT factors into a single grouped confluence view.
// Supports BOTH the new 9-group factor array (from updated scoring engine)
// and the legacy flat analysis shape (backward compatibility).

export type FactorItem = {
  label: string;
  pass: boolean;
  detail?: string;
  weight?: number;
};

export type FactorGroup = {
  name: string;
  items: FactorItem[];
  /** Sum of weights for items that passed in this group */
  groupScore?: number;
  /** Maximum possible score for this group (cap) */
  groupCap?: number;
};

export type UnifiedConfluence = {
  total: number; // 0-100 percentage (new) or 0-10 (legacy)
  smcScore: number; // same as total for new format, 0-10 for legacy
  extScore: number; // same as total for new format, 0-10 for legacy
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  groups: FactorGroup[];
  passCount: number;
  totalFactors: number;
};

// ─── Group ordering & caps (mirrors backend groupCaps) ──────────────
const GROUP_ORDER: string[] = [
  'Market Structure',
  'Daily Bias',
  'Order Flow Zones',
  'Premium/Discount & Fib',
  'Timing',
  'Price Action',
  'AMD / Power of 3',
  'Macro Confirmation',
  'Volume Profile',
];

const GROUP_CAPS: Record<string, number> = {
  'Market Structure': 2.5,
  'Daily Bias': 1.0,
  'Order Flow Zones': 3.0,
  'Premium/Discount & Fib': 2.5,
  'Timing': 1.5,
  'Price Action': 2.5,
  'AMD / Power of 3': 1.5,
  'Macro Confirmation': 2.0,
  'Volume Profile': 0.75,
};

// ─── New-format parser ──────────────────────────────────────────────
// The backend now returns `factors: ReasoningFactor[]` where each factor
// has { name, present, weight, detail, group }.

interface BackendFactor {
  name: string;
  present: boolean;
  weight: number;
  detail?: string;
  group?: string;
}

function unifyFromFactors(analysis: any): UnifiedConfluence {
  const factors: BackendFactor[] = analysis.factors || [];
  const score: number = Number(analysis.score ?? 0);

  // Direction: prefer backend-computed direction
  let direction: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (analysis.direction === 'long') direction = 'BUY';
  else if (analysis.direction === 'short') direction = 'SELL';

  // Group factors by their `group` tag
  const groupMap = new Map<string, FactorItem[]>();
  for (const f of factors) {
    const groupName = f.group || 'Other';
    if (!groupMap.has(groupName)) groupMap.set(groupName, []);
    groupMap.get(groupName)!.push({
      label: f.name,
      pass: f.present,
      detail: f.detail,
      weight: f.weight,
    });
  }

  // Build groups in canonical order; append any unexpected groups at the end
  const orderedGroups: FactorGroup[] = [];
  const seen = new Set<string>();

  for (const gName of GROUP_ORDER) {
    const items = groupMap.get(gName);
    if (items && items.length > 0) {
      const groupScore = items
        .filter((i) => i.pass)
        .reduce((sum, i) => sum + (i.weight ?? 0), 0);
      orderedGroups.push({
        name: gName,
        items,
        groupScore: Math.min(groupScore, GROUP_CAPS[gName] ?? Infinity),
        groupCap: GROUP_CAPS[gName],
      });
      seen.add(gName);
    }
  }

  // Append any groups not in GROUP_ORDER (future-proofing)
  for (const [gName, items] of groupMap) {
    if (!seen.has(gName)) {
      const groupScore = items
        .filter((i) => i.pass)
        .reduce((sum, i) => sum + (i.weight ?? 0), 0);
      orderedGroups.push({
        name: gName,
        items,
        groupScore,
      });
    }
  }

  const allItems = orderedGroups.flatMap((g) => g.items);
  const passCount = allItems.filter((i) => i.pass).length;

  return {
    total: score,
    smcScore: score,
    extScore: score,
    direction,
    groups: orderedGroups,
    passCount,
    totalFactors: allItems.length,
  };
}

// ─── Legacy-format parser (backward compatibility) ──────────────────
// For scan results that don't have the new `factors` array.

const DEFAULT_WEIGHTS = { smc: 0.5, ext: 0.5 };

function unifyFromLegacy(analysis: any): UnifiedConfluence {
  const smcScore = Number(analysis?.confluenceScore ?? 0);
  const extScore = Number(analysis?.extendedConfluenceScore ?? 0);
  const total = +(smcScore * DEFAULT_WEIGHTS.smc + extScore * DEFAULT_WEIGHTS.ext).toFixed(1);

  const bias: string = analysis?.bias || 'neutral';
  const structure = analysis?.structure || {};
  const orderBlocks: any[] = analysis?.orderBlocks || [];
  const fvgs: any[] = analysis?.fvgs || [];
  const liquidityPools: any[] = analysis?.liquidityPools || [];
  const pd = analysis?.premiumDiscount;
  const ext = analysis?.extendedFactors;

  const activeOBs = orderBlocks.filter((o: any) => !o.mitigated);
  const activeFVGs = fvgs.filter((f: any) => !f.mitigated);
  const lastBOS = structure.bos?.[structure.bos.length - 1];
  const lastCHOCH = structure.choch?.[structure.choch.length - 1];

  // Bullish/bearish bias signals (used for direction inference)
  let bullVotes = 0;
  let bearVotes = 0;
  const vote = (dir: 'bull' | 'bear' | null) => {
    if (dir === 'bull') bullVotes++;
    else if (dir === 'bear') bearVotes++;
  };
  vote(bias === 'bullish' ? 'bull' : bias === 'bearish' ? 'bear' : null);
  vote(structure.trend === 'bullish' ? 'bull' : structure.trend === 'bearish' ? 'bear' : null);
  if (ext?.displacement?.detected) vote(ext.displacement.lastDirection === 'up' ? 'bull' : 'bear');
  if (ext?.powerOf3?.expansion) vote(ext.powerOf3.expansion === 'up' ? 'bull' : 'bear');
  if (pd?.currentZone === 'discount') bullVotes++;
  else if (pd?.currentZone === 'premium') bearVotes++;

  const direction: 'BUY' | 'SELL' | 'NEUTRAL' =
    bullVotes > bearVotes + 1 ? 'BUY' : bearVotes > bullVotes + 1 ? 'SELL' : 'NEUTRAL';

  const groups: FactorGroup[] = [
    {
      name: 'Market Structure',
      items: [
        { label: 'HTF Bias', pass: bias !== 'neutral', detail: bias },
        { label: 'Trend', pass: !!structure.trend && structure.trend !== 'neutral', detail: structure.trend || 'N/A' },
        { label: 'BOS / CHoCH', pass: !!(lastBOS || lastCHOCH), detail: `${structure.bos?.length || 0} BOS · ${structure.choch?.length || 0} CHoCH` },
      ],
    },
    {
      name: 'Order Flow Zones',
      items: [
        { label: 'Order Block', pass: activeOBs.length > 0, detail: activeOBs.length > 0 ? `${activeOBs.length} active` : 'None' },
        { label: 'Fair Value Gap', pass: activeFVGs.length > 0, detail: activeFVGs.length > 0 ? `${activeFVGs.length} unfilled` : 'None' },
        { label: 'Breaker Block', pass: (ext?.breakers?.length || 0) > 0, detail: (ext?.breakers?.length || 0) > 0 ? `${ext.breakers.length} flipped OB(s)` : 'None active' },
        { label: 'Unicorn Setup', pass: (ext?.unicorns?.length || 0) > 0, detail: (ext?.unicorns?.length || 0) > 0 ? `${ext.unicorns.length} breaker+FVG overlap` : 'No overlap' },
      ],
    },
    {
      name: 'Premium/Discount & Fib',
      items: [
        { label: 'Premium / Discount', pass: !!pd?.currentZone && pd.currentZone !== 'equilibrium', detail: pd?.currentZone || 'N/A' },
      ],
    },
    {
      name: 'Timing',
      items: [
        { label: 'Kill Zone', pass: !!analysis?.killZone?.active, detail: analysis?.killZone?.active ? analysis.killZone.name : 'Outside' },
        { label: 'Silver Bullet', pass: !!ext?.silverBullet?.active, detail: ext?.silverBullet?.active ? ext.silverBullet.window : 'Outside window' },
        { label: 'Macro Time', pass: !!ext?.macroTime?.active, detail: ext?.macroTime?.active ? `xx:${String(ext.macroTime.utcMinute).padStart(2, '0')} UTC` : 'Outside macro' },
      ],
    },
    {
      name: 'Price Action',
      items: [
        { label: 'Displacement', pass: !!ext?.displacement?.detected,
          detail: ext?.displacement?.detected ? `${ext.displacement.count}× large body, last ${ext.displacement.lastDirection}` : 'No large-body candles' },
        { label: 'Liquidity Pools', pass: liquidityPools.length > 0, detail: liquidityPools.length > 0 ? `${liquidityPools.length} levels` : 'None' },
      ],
    },
    {
      name: 'AMD / Power of 3',
      items: [
        { label: 'Power of 3', pass: !!ext?.powerOf3?.complete || !!ext?.powerOf3?.manipulation,
          detail: ext?.powerOf3?.complete ? `Complete · ${ext.powerOf3.expansion}` : ext?.powerOf3?.phase ? `Phase: ${ext.powerOf3.phase}${ext.powerOf3.manipulation ? ' · ' + ext.powerOf3.manipulation : ''}` : 'unknown' },
      ],
    },
  ];

  const allItems = groups.flatMap((g) => g.items);
  const passCount = allItems.filter((i) => i.pass).length;

  return { total, smcScore, extScore, direction, groups, passCount, totalFactors: allItems.length };
}

// ─── Main entry point ───────────────────────────────────────────────
export function unifyConfluence(analysis: any): UnifiedConfluence {
  // New format: analysis has a `factors` array with group-tagged items
  if (Array.isArray(analysis?.factors) && analysis.factors.length > 0) {
    return unifyFromFactors(analysis);
  }
  // Legacy format: separate confluenceScore / extendedFactors shape
  return unifyFromLegacy(analysis);
}
