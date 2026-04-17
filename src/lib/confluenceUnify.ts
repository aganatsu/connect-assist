// Unifies SMC + Extended ICT factors into a single grouped confluence view.

export type FactorItem = {
  label: string;
  pass: boolean;
  detail?: string;
};

export type FactorGroup = {
  name: string;
  items: FactorItem[];
};

export type UnifiedConfluence = {
  total: number; // 0-10
  smcScore: number; // 0-10
  extScore: number; // 0-10
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  groups: FactorGroup[];
  passCount: number;
  totalFactors: number;
};

const DEFAULT_WEIGHTS = { smc: 0.5, ext: 0.5 };

export function unifyConfluence(analysis: any): UnifiedConfluence {
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

  const activeOBs = orderBlocks.filter((o) => !o.mitigated);
  const activeFVGs = fvgs.filter((f) => !f.mitigated);
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
  if (ext?.vwap?.position) vote(ext.vwap.position === 'above' ? 'bull' : 'bear');
  if (pd?.currentZone === 'discount') bullVotes++;
  else if (pd?.currentZone === 'premium') bearVotes++;

  const direction: 'BUY' | 'SELL' | 'NEUTRAL' =
    bullVotes > bearVotes + 1 ? 'BUY' : bearVotes > bullVotes + 1 ? 'SELL' : 'NEUTRAL';

  const groups: FactorGroup[] = [
    {
      name: 'Structure & Bias',
      items: [
        { label: 'HTF Bias', pass: bias !== 'neutral', detail: bias },
        { label: 'Trend', pass: !!structure.trend && structure.trend !== 'neutral', detail: structure.trend || 'N/A' },
        { label: 'BOS / CHoCH', pass: !!(lastBOS || lastCHOCH), detail: `${structure.bos?.length || 0} BOS · ${structure.choch?.length || 0} CHoCH` },
        { label: 'Power of 3', pass: !!ext?.powerOf3?.complete || !!ext?.powerOf3?.manipulation,
          detail: ext?.powerOf3?.complete ? `Complete · ${ext.powerOf3.expansion}` : ext?.powerOf3?.phase ? `Phase: ${ext.powerOf3.phase}${ext.powerOf3.manipulation ? ' · ' + ext.powerOf3.manipulation : ''}` : 'unknown' },
      ],
    },
    {
      name: 'Zones',
      items: [
        { label: 'Order Block', pass: activeOBs.length > 0, detail: activeOBs.length > 0 ? `${activeOBs.length} active` : 'None' },
        { label: 'Fair Value Gap', pass: activeFVGs.length > 0, detail: activeFVGs.length > 0 ? `${activeFVGs.length} unfilled` : 'None' },
        { label: 'Breaker Block', pass: (ext?.breakers?.length || 0) > 0, detail: (ext?.breakers?.length || 0) > 0 ? `${ext.breakers.length} flipped OB(s)` : 'None active' },
        { label: 'Unicorn Setup', pass: (ext?.unicorns?.length || 0) > 0, detail: (ext?.unicorns?.length || 0) > 0 ? `${ext.unicorns.length} breaker+FVG overlap` : 'No overlap' },
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
        { label: 'VWAP', pass: ext?.vwap?.vwap != null,
          detail: ext?.vwap?.vwap != null ? `${ext.vwap.position} @ ${Number(ext.vwap.vwap).toFixed(5)} (${Number(ext.vwap.distance).toFixed(2)}%)` : 'N/A' },
        { label: 'Liquidity Pools', pass: liquidityPools.length > 0, detail: liquidityPools.length > 0 ? `${liquidityPools.length} levels` : 'None' },
      ],
    },
  ];

  const allItems = groups.flatMap((g) => g.items);
  const passCount = allItems.filter((i) => i.pass).length;

  return { total, smcScore, extScore, direction, groups, passCount, totalFactors: allItems.length };
}
