import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Users } from "lucide-react";
import { invokeFunction } from "@/lib/api";
import { useIsAdmin } from "@/hooks/useIsAdmin";

interface PaperAccount {
  id: string;
  bot_id: string | null;
  balance: number | null;
  is_running: boolean | null;
  is_paused: boolean | null;
  execution_mode: string | null;
}

interface AdminUserRow {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  provider: string | null;
  is_admin: boolean;
  is_new: boolean;
  bot_running: boolean;
  paper_accounts: PaperAccount[];
  scans: number;
  last_scan_at: string | null;
  closed_trades: number;
  realized_pnl: number;
  last_trade_at: string | null;
  open_positions: number;
  backtests: number;
  has_bot_config: boolean;
  broker_connections: number;
  enabled_tasks: number;
}

interface Overview {
  generated_at: string;
  users: AdminUserRow[];
  orphan_accounts: (PaperAccount & { user_id: string })[];
  error?: string;
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const minutes = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const formatDate = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** Admin-only: every account in the app, with sign-in facts and bot activity. Read-only. */
export default function Admin() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, isFetching, refetch } = useQuery<Overview>({
    queryKey: ["admin-users-overview"],
    queryFn: () => invokeFunction<Overview>("admin-users", { action: "overview" }),
    enabled: isAdmin,
    refetchInterval: 60000,
  });

  if (!isAdmin) {
    return (
      <AppShell>
        <div className="p-4 max-w-6xl mx-auto text-sm text-muted-foreground">This page is only available to app admins.</div>
      </AppShell>
    );
  }

  const users = data?.users ?? [];
  const others = users.filter((u) => !u.is_admin);

  return (
    <AppShell>
      <div className="p-4 max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Admin · Users</h1>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            {data?.generated_at ? `Updated ${formatTimeAgo(data.generated_at)}` : "Refresh"}
          </button>
        </div>

        {data?.error && <div className="text-sm text-destructive">Could not load users: {data.error}</div>}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Accounts", value: users.length },
            { label: "Other users", value: others.length },
            { label: "New (7 days)", value: users.filter((u) => u.is_new).length },
            { label: "Bots running", value: users.filter((u) => u.bot_running).length },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="p-3">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{s.label}</div>
                <div className="text-2xl font-semibold">{isLoading ? "…" : s.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">All accounts</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Signed up</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Bot</TableHead>
                  <TableHead className="text-right">Paper balance</TableHead>
                  <TableHead className="text-right">Scans</TableHead>
                  <TableHead className="text-right">Trades · P&amp;L</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Backtests</TableHead>
                  <TableHead>Setup</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="font-medium">{u.email ?? u.id}</div>
                      <div className="flex gap-1 mt-0.5">
                        {u.is_admin && <Badge variant="secondary" className="text-[10px]">Admin</Badge>}
                        {u.is_new && <Badge className="text-[10px]">New</Badge>}
                        {!u.email_confirmed_at && <Badge variant="outline" className="text-[10px]">Email not confirmed</Badge>}
                        <span className="text-[10px] text-muted-foreground">{u.provider ?? ""}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDate(u.created_at)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatTimeAgo(u.last_sign_in_at)}</TableCell>
                    <TableCell>
                      <Badge variant={u.bot_running ? "default" : "outline"} className="text-[10px]">
                        {u.bot_running ? "Running" : "Stopped"}
                      </Badge>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{u.enabled_tasks} tasks on</div>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {u.paper_accounts.length ? u.paper_accounts.map((a) => <div key={a.id}>{money(a.balance)}</div>) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <div>{u.scans.toLocaleString()}</div>
                      <div className="text-[10px] text-muted-foreground">last {formatTimeAgo(u.last_scan_at)}</div>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <div>{u.closed_trades}</div>
                      <div className={`text-[10px] ${u.realized_pnl >= 0 ? "text-success" : "text-destructive"}`}>{money(u.realized_pnl)}</div>
                    </TableCell>
                    <TableCell className="text-right text-xs">{u.open_positions}</TableCell>
                    <TableCell className="text-right text-xs">{u.backtests}</TableCell>
                    <TableCell className="text-[10px] text-muted-foreground whitespace-nowrap">
                      <div>{u.has_bot_config ? "Own settings" : "Default settings"}</div>
                      <div>{u.broker_connections ? `${u.broker_connections} broker` : "No broker"}</div>
                    </TableCell>
                  </TableRow>
                ))}
                {!isLoading && users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-xs text-muted-foreground">No users</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {(data?.orphan_accounts?.length ?? 0) > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Paper accounts with no user</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-1">
              <p>Left behind when a user was deleted: the paper ledger is append-only, so its account row stays.</p>
              {data!.orphan_accounts.map((a) => (
                <div key={a.id} className="flex gap-3">
                  <span className="font-mono">{a.id.slice(0, 8)}</span>
                  <span>{money(a.balance)}</span>
                  <span>{a.is_running ? "Running" : "Stopped"}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
