import { useMemo, useState } from "react";
import { ExternalLink, Copy, Check, TrendingUp, TrendingDown, AlertCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { AutoTradeRecord } from "@shared/schema";

interface AutoTraderRecordsTableProps {
  records: AutoTradeRecord[];
  solPriceUsd: number;
}

type Filter = "all" | "pending" | "active" | "sold" | "failed";

const formatTime = (ts: number) => {
  const date = new Date(ts);
  return date.toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const formatDate = (ts: number) => {
  const date = new Date(ts);
  return date.toLocaleDateString("tr-TR");
};

const formatUsd = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n) || n <= 0) return "—";
  if (n >= 1) return `$${n.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
};

const formatCompact = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
};

const formatPrice = (n?: number) => {
  if (!n) return "—";
  if (n < 0.00001) return n.toExponential(2);
  return n.toFixed(6);
};

export function AutoTraderRecordsTable({
  records,
  solPriceUsd,
}: AutoTraderRecordsTableProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyAddress = async (address: string, id: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const filtered = useMemo(() => {
    if (filter === "pending") return records.filter((r) => r.status === "pending");
    if (filter === "active") return records.filter((r) => r.status === "active");
    if (filter === "sold") return records.filter((r) => r.status === "sold");
    if (filter === "failed") return records.filter((r) => r.status === "failed");
    return records;
  }, [records, filter]);

  const stats = useMemo(() => {
    const pending = records.filter((r) => r.status === "pending").length;
    const active = records.filter((r) => r.status === "active").length;
    const sold = records.filter((r) => r.status === "sold").length;
    const failed = records.filter((r) => r.status === "failed").length;
    const totalPnl = records
      .filter((r) => r.status === "sold")
      .reduce((sum, r) => sum + (r.pnlSol ?? 0), 0);
    const totalInvested = records
      .filter((r) => r.status === "sold" || r.status === "active")
      .reduce((sum, r) => sum + r.buyAmountSol, 0);

    return { pending, active, sold, failed, totalPnl, totalInvested };
  }, [records]);

  return (
    <div className="space-y-4">
      {/* Başlık & Filtreler */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-base font-semibold">📊 Trading Kayıtları</h2>
        <div className="flex items-center gap-1 flex-wrap">
          {(["all", "pending", "active", "sold", "failed"] as Filter[]).map((f) => {
            let count = 0;
            if (f === "all") count = records.length;
            else if (f === "pending") count = stats.pending;
            else if (f === "active") count = stats.active;
            else if (f === "sold") count = stats.sold;
            else if (f === "failed") count = stats.failed;

            const labels: Record<Filter, string> = {
              all: "Tümü",
              pending: "Bekleme",
              active: "Aktif",
              sold: "Satıldı",
              failed: "Başarısız",
            };

            return (
              <Button
                key={f}
                variant={filter === f ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(f)}
                data-testid={`button-auto-records-filter-${f}`}
              >
                {labels[f]} ({count})
              </Button>
            );
          })}
        </div>
      </div>

      {/* İstatistikler */}
      <Card className="p-4 bg-muted/50">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Stat
            label="Bekleme"
            value={stats.pending}
            color="text-amber-400"
          />
          <Stat
            label="Aktif"
            value={stats.active}
            color="text-primary"
          />
          <Stat
            label="Satıldı"
            value={stats.sold}
            color="text-emerald-400"
          />
          <Stat
            label="Başarısız"
            value={stats.failed}
            color="text-destructive"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs pt-3 border-t border-border">
          <Stat
            label="Toplam Yatırım"
            value={`${stats.totalInvested.toFixed(4)} SOL`}
            sub={solPriceUsd > 0 ? formatUsd(stats.totalInvested * solPriceUsd) : undefined}
            color="text-chart-4"
          />
          <Stat
            label="Realize PnL"
            value={`${stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(4)} SOL`}
            sub={solPriceUsd > 0 ? formatUsd(stats.totalPnl * solPriceUsd) : undefined}
            color={stats.totalPnl >= 0 ? "text-emerald-400" : "text-destructive"}
          />
        </div>
      </Card>

      {/* Kayıtlar Tablosu */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <AlertCircle className="h-10 w-10 mx-auto mb-2 opacity-40" />
          <p className="text-sm">
            {records.length === 0
              ? "Henüz otomatik trading kaydı yok."
              : `Bu filtrede kayıt bulunmuyor.`}
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {filtered.map((record) => (
            <AutoTradeRecordRow
              key={record.id}
              record={record}
              copiedId={copiedId}
              solPriceUsd={solPriceUsd}
              onCopy={copyAddress}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AutoTradeRecordRowProps {
  record: AutoTradeRecord;
  copiedId: string | null;
  solPriceUsd: number;
  onCopy: (addr: string, id: string) => void;
}

function AutoTradeRecordRow({
  record: r,
  copiedId,
  solPriceUsd,
  onCopy,
}: AutoTradeRecordRowProps) {
  const isSold = r.status === "sold";
  const isActive = r.status === "active";
  const isPending = r.status === "pending";
  const isFailed = r.status === "failed";

  const pnlPositive = (r.pnlSol ?? 0) >= 0;
  const pnlPct = r.pnlPct ?? null;

  const borderColor = isSold
    ? pnlPositive
      ? "border-emerald-500/30"
      : "border-destructive/30"
    : isFailed
      ? "border-destructive/40"
      : isActive
        ? "border-primary/40"
        : "border-card-border";

  return (
    <div className={`bg-card border rounded-lg p-3 ${borderColor}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Sol: Token Bilgileri */}
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Token Adı ve Durum */}
            <span className="font-semibold text-sm" data-testid={`text-auto-record-name-${r.id}`}>
              {r.tokenName}
            </span>
            <span className="text-xs text-muted-foreground">{r.tokenSymbol}</span>

            {/* Durum Badge */}
            <StatusBadge status={r.status} />

            {/* PnL Yüzdesi (satıldıysa göster) */}
            {isSold && pnlPct !== null && (
              <Badge
                className={`text-xs gap-1 font-bold ${
                  pnlPositive
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/40"
                    : "bg-destructive/15 text-destructive border border-destructive/40"
                }`}
              >
                {pnlPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {pnlPositive ? "+" : ""}{pnlPct.toFixed(1)}%
              </Badge>
            )}

            {/* Zaman */}
            <span className="text-[10px] text-muted-foreground ml-auto">
              {formatDate(r.detectedAt)} {formatTime(r.detectedAt)}
            </span>
          </div>

          {/* Mint Address */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <code className="text-[11px] font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded truncate">
              {r.mintAddress.slice(0, 8)}...{r.mintAddress.slice(-8)}
            </code>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onCopy(r.mintAddress, r.id)}
              className="h-6 w-6"
              data-testid={`button-copy-auto-record-${r.id}`}
            >
              {copiedId === r.id ? (
                <Check className="h-3 w-3 text-chart-4" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              asChild
              className="h-6 px-1.5 text-xs"
            >
              <a
                href={`https://dexscreener.com/solana/${r.mintAddress}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Dex
              </a>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              asChild
              className="h-6 px-1.5 text-xs"
            >
              <a
                href={`https://jup.ag/swap/SOL-${r.mintAddress}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Jup
              </a>
            </Button>
            {r.buyTxSignature && (
              <Button
                size="sm"
                variant="ghost"
                asChild
                className="h-6 px-1.5 text-xs"
              >
                <a
                  href={`https://solscan.io/tx/${r.buyTxSignature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Buy
                </a>
              </Button>
            )}
            {r.sellTxSignature && (
              <Button
                size="sm"
                variant="ghost"
                asChild
                className="h-6 px-1.5 text-xs"
              >
                <a
                  href={`https://solscan.io/tx/${r.sellTxSignature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Sell
                </a>
              </Button>
            )}
          </div>

          {/* Bilgi Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] pt-1">
            {/* Harcanan SOL */}
            <Cell
              label="Harcanan"
              value={`${r.buyAmountSol.toFixed(4)} SOL`}
              sub={solPriceUsd > 0 ? formatUsd(r.buyAmountSol * solPriceUsd) : undefined}
            />

            {/* Alınan Token */}
            <Cell
              label="Alınan Token"
              value={r.buyTokenAmount ? `${formatCompact(r.buyTokenAmount)} ${r.tokenSymbol}` : "—"}
              sub={r.buyTokenAmount ? formatPrice(r.buyTokenAmount) : undefined}
            />

            {/* Alım Fiyatı veya Şu Anki */}
            {isActive ? (
              <Cell
                label="Şu Anki Fiyat"
                value={r.currentPrice ? formatUsd(r.currentPrice) : "—"}
                sub={r.buyPrice ? `Aldığın: ${formatUsd(r.buyPrice)}` : undefined}
              />
            ) : (
              <Cell
                label="Alım Fiyatı"
                value={r.buyPrice ? formatUsd(r.buyPrice) : "—"}
              />
            )}

            {/* PnL veya Satış Fiyatı */}
            {isSold ? (
              <Cell
                label="Satış Fiyatı"
                value={r.sellPrice ? formatUsd(r.sellPrice) : "—"}
                sub={
                  r.pnlSol !== undefined && r.sellAmountSol
                    ? `${r.pnlSol >= 0 ? "+" : ""}${r.pnlSol.toFixed(4)} SOL`
                    : undefined
                }
                highlight={isSold && (r.pnlSol ?? 0) >= 0 ? "green" : "red"}
              />
            ) : isPending || isActive ? (
              <Cell
                label="Durum"
                value={isPending ? "⏳ Alınıyor" : "🟢 Aktif"}
                sub={isActive ? `Tutuluyor...` : undefined}
              />
            ) : (
              <Cell
                label="Hata"
                value={isFailed ? "❌ Başarısız" : "—"}
              />
            )}
          </div>

          {/* Tutma Süresi (aktifse) */}
          {isActive && r.buyTimestamp && (
            <div className="flex items-center gap-1.5 text-[10px] text-primary bg-primary/10 rounded px-2 py-1 w-fit">
              <Clock className="h-3 w-3" />
              Tutuluyor: {formatHoldTime(r.buyTimestamp)}
            </div>
          )}

          {/* Hata Mesajı */}
          {isFailed && r.error && (
            <div className="text-[11px] text-destructive bg-destructive/10 rounded px-2 py-1">
              ⚠️ {r.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string | number;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="bg-muted/30 rounded-md px-2 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold ${color || "text-foreground"}`}>{value}</p>
      {sub && (
        <p className="text-[10px] text-muted-foreground/70 font-mono truncate">
          {sub}
        </p>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: "green" | "red";
}) {
  return (
    <div
      className={`rounded px-2 py-1 ${
        highlight === "green"
          ? "bg-emerald-500/10"
          : highlight === "red"
            ? "bg-destructive/10"
            : "bg-muted/30"
      }`}
    >
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p
        className={`font-mono ${
          highlight === "green"
            ? "text-emerald-400"
            : highlight === "red"
              ? "text-destructive"
              : ""
        }`}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[9px] text-muted-foreground/70 font-mono truncate" title={sub}>
          {sub}
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AutoTradeRecord["status"] }) {
  const map: Record<
    AutoTradeRecord["status"],
    { label: string; cls: string; icon: string }
  > = {
    pending: {
      label: "Bekleme",
      cls: "bg-amber-500/15 text-amber-400 border border-amber-500/40",
      icon: "⏳",
    },
    active: {
      label: "Aktif",
      cls: "bg-primary/15 text-primary border border-primary/40",
      icon: "🟢",
    },
    sold: {
      label: "Satıldı",
      cls: "bg-muted text-muted-foreground border border-muted-foreground/30",
      icon: "✓",
    },
    failed: {
      label: "Başarısız",
      cls: "bg-destructive/15 text-destructive border border-destructive/40",
      icon: "✕",
    },
  };
  const cfg = map[status];
  return (
    <Badge className={`text-xs ${cfg.cls}`}>
      {cfg.icon} {cfg.label}
    </Badge>
  );
}

function formatHoldTime(buyTs: number): string {
  const elapsed = Date.now() - buyTs;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
