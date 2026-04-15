import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Clock, TrendingUp, TrendingDown, BarChart3, Grid3X3,
  Activity, Target, Sun, Moon, Calendar
} from "lucide-react";

const SYMBOLS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "AUD/USD", "USD/CAD", "XAU/USD", "BTC/USD"];

const SESSIONS = [
  { name: "Sydney", start: 21, end: 6, color: "hsl(270, 55%, 70%)" },
  { name: "Asian", start: 0, end: 8, color: "hsl(280, 60%, 65%)" },
  { name: "London", start: 7, end: 16, color: "hsl(210, 100%, 52%)" },
  { name: "New York", start: 12, end: 21, color: "hsl(38, 92%, 50%)" },
];

const KILL_ZONES = [
  { name: "Asian KZ", start: 0, end: 3, color: "hsl(280, 60%, 65%)" },
  { name: "London KZ", start: 7, end: 9, color: "hsl(210, 100%, 52%)" },
  { name: "NY KZ", start: 12, end: 14, color: "hsl(38, 92%, 50%)" },
  { name: "London Close KZ", start: 15, end: 16, color: "hsl(142, 72%, 45%)" },
];

// Simulated currency strength
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const STRENGTH_DATA = CURRENCIES.map(c => ({
  currency: c,
  strength: Math.random() * 200 - 100,
  change: Math.random() * 4 - 2,
}));

export default function IctAnalysis() {
  const [selectedSymbol, setSelectedSymbol] = useState("EUR/USD");

  const currentHour = new Date().getUTCHours();

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">ICT Analysis</h1>
          <select
            value={selectedSymbol}
            onChange={(e) => setSelectedSymbol(e.target.value)}
            className="bg-card border border-border rounded px-3 py-1.5 text-sm"
          >
            {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <Accordion type="multiple" defaultValue={["session", "strength", "correlations", "pdpw", "premium"]}>
          {/* Session Map */}
          <AccordionItem value="session">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Clock className="h-4 w-4" /> Session Map & Kill Zones</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4">
                  {/* Session Timeline */}
                  <div className="space-y-3">
                    <div className="relative h-20">
                      <div className="absolute inset-0 flex">
                        {Array.from({ length: 24 }, (_, h) => (
                          <div key={h} className="flex-1 border-r border-border/30 relative">
                            {h % 3 === 0 && (
                              <span className="absolute -bottom-5 left-0 text-[9px] text-muted-foreground">{h}:00</span>
                            )}
                          </div>
                        ))}
                      </div>
                      {/* Current time indicator */}
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-primary z-10"
                        style={{ left: `${(currentHour / 24) * 100}%` }}
                      />
                      {/* Session bars */}
                      {SESSIONS.map((s, i) => {
                        const start = s.start < s.end ? s.start : 0;
                        const end = s.start < s.end ? s.end : s.end;
                        return (
                          <div
                            key={s.name}
                            className="absolute rounded-sm opacity-40"
                            style={{
                              left: `${(start / 24) * 100}%`,
                              width: `${((end - start) / 24) * 100}%`,
                              top: `${i * 18}px`,
                              height: '14px',
                              backgroundColor: s.color,
                            }}
                          >
                            <span className="text-[8px] font-medium px-1 leading-[14px] text-foreground">{s.name}</span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Kill Zones */}
                    <div className="flex flex-wrap gap-2 mt-8">
                      {KILL_ZONES.map(kz => {
                        const isActive = currentHour >= kz.start && currentHour < kz.end;
                        return (
                          <span
                            key={kz.name}
                            className={`px-2 py-1 rounded text-[10px] font-medium border ${
                              isActive ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
                            }`}
                          >
                            {kz.name} ({kz.start}:00-{kz.end}:00)
                            {isActive && <span className="ml-1 text-success">● Active</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* Currency Strength */}
          <AccordionItem value="strength">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Currency Strength</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4">
                  <div className="space-y-2">
                    {STRENGTH_DATA.sort((a, b) => b.strength - a.strength).map(d => (
                      <div key={d.currency} className="flex items-center gap-3 text-xs">
                        <span className="w-8 font-medium">{d.currency}</span>
                        <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden relative">
                          <div
                            className={`h-full rounded-full ${d.strength >= 0 ? 'bg-success' : 'bg-destructive'}`}
                            style={{ width: `${Math.abs(d.strength) / 2}%`, marginLeft: d.strength < 0 ? 'auto' : undefined }}
                          />
                        </div>
                        <span className={`w-12 text-right ${d.strength >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {d.strength > 0 ? '+' : ''}{d.strength.toFixed(0)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* Correlation Matrix */}
          <AccordionItem value="correlations">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Grid3X3 className="h-4 w-4" /> Correlation Matrix</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr>
                          <th className="p-1"></th>
                          {SYMBOLS.slice(0, 6).map(s => <th key={s} className="p-1 text-muted-foreground">{s.split('/')[0]}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {SYMBOLS.slice(0, 6).map((s1, i) => (
                          <tr key={s1}>
                            <td className="p-1 text-muted-foreground font-medium">{s1.split('/')[0]}</td>
                            {SYMBOLS.slice(0, 6).map((s2, j) => {
                              const val = i === j ? 1 : parseFloat((Math.random() * 2 - 1).toFixed(2));
                              const bg = val > 0.5 ? 'bg-success/20' : val < -0.5 ? 'bg-destructive/20' : 'bg-muted/30';
                              return (
                                <td key={s2} className={`p-1 text-center ${bg} rounded-sm`}>
                                  {val.toFixed(2)}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* Premium/Discount Zone */}
          <AccordionItem value="premium">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Target className="h-4 w-4" /> Premium / Discount Zone</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4">
                  <div className="space-y-3">
                    <div className="relative h-32 rounded border border-border overflow-hidden">
                      {/* Premium zone */}
                      <div className="absolute top-0 left-0 right-0 h-1/3 bg-destructive/10 flex items-center px-3">
                        <span className="text-[10px] text-destructive font-medium">PREMIUM — Sell Zone</span>
                      </div>
                      {/* Equilibrium */}
                      <div className="absolute top-1/3 left-0 right-0 h-1/3 bg-muted/20 flex items-center justify-center border-y border-dashed border-muted-foreground/30">
                        <span className="text-[10px] text-muted-foreground">EQUILIBRIUM — 50%</span>
                      </div>
                      {/* Discount zone */}
                      <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-success/10 flex items-center px-3">
                        <span className="text-[10px] text-success font-medium">DISCOUNT — Buy Zone</span>
                      </div>
                      {/* Current price indicator */}
                      <div className="absolute left-1/2 top-[40%] w-3 h-3 rounded-full bg-primary border-2 border-primary-foreground -translate-x-1/2 -translate-y-1/2 z-10" />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Swing High: 1.0920</span>
                      <span className="text-primary font-medium">Current: 1.0867</span>
                      <span>Swing Low: 1.0780</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Price is at <span className="text-primary font-medium">62%</span> of the range — slightly in premium territory.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* PD/PW Levels */}
          <AccordionItem value="pdpw">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Calendar className="h-4 w-4" /> PD / PW Levels</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4 space-y-3 text-xs">
                  <div>
                    <p className="text-muted-foreground mb-1 font-medium">Previous Day</p>
                    <div className="grid grid-cols-3 gap-2">
                      <div><span className="text-muted-foreground">High:</span> <span>1.0892</span></div>
                      <div><span className="text-muted-foreground">Low:</span> <span>1.0831</span></div>
                      <div><span className="text-muted-foreground">Close:</span> <span>1.0855</span></div>
                    </div>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1 font-medium">Previous Week</p>
                    <div className="grid grid-cols-3 gap-2">
                      <div><span className="text-muted-foreground">High:</span> <span>1.0920</span></div>
                      <div><span className="text-muted-foreground">Low:</span> <span>1.0780</span></div>
                      <div><span className="text-muted-foreground">Close:</span> <span>1.0867</span></div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </AppShell>
  );
}
