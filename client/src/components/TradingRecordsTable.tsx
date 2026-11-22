import { useState } from "react";
import { ExternalLink, Copy, Check, TrendingUp, TrendingDown, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TradeRecord } from "@shared/schema";

interface TradingRecordsTableProps {
  records: TradeRecord[];
  solPrice?: number;
  emptyMessage?: string;
}

type SortField = "timestamp" | "profit" | "duration" | "roi";
type SortOrder = "asc" | "desc";
type FilterStatus = "all" | "profit" | "loss";

export function TradingRecordsTable({
  records,
  solPrice,
  emptyMessage,
}: TradingRecordsTableProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("timestamp");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [searchTerm, setSearchTerm] = useState("");

  const copyAddress = async (address: string, id: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const truncateAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-6)}`;

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString("tr-TR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  };

  const calculateROI = (record: TradeRecord) => {
    if (record.buyPrice === 0) return 0;
    return ((record.sellPrice - record.buyPrice) / record.buyPrice) * 100;
  };

  let filtered = records.filter((record) => {
    const matchesSearch =
      record.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      record.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
      record.mintAddress.toLowerCase().includes(searchTerm.toLowerCase());

    if (!matchesSearch) return false;

    if (filterStatus === "profit") return record.profitLoss > 0;
    if (filterStatus === "loss") return record.profitLoss < 0;
    return true;
  });

  filtered = [...filtered].sort((a, b) => {
    let aVal: number;
    let bVal: number;

    switch (sortField) {
      case "timestamp":
        aVal = a.timestamp;
        bVal = b.timestamp;
        break;
      case "profit":
        aVal = a.profitLoss;
        bVal = b.profitLoss;
        break;
      case "duration":
        aVal = a.sellTime - a.buyTime;
        bVal = b.sellTime - b.buyTime;
        break;
      case "roi":
        aVal = calculateROI(a);
        bVal = calculateROI(b);
        break;
    }

    return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
  });

  if (filtered.length === 0) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <Clock className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">{emptyMessage ?? "İşlem kaydı bulunamadı"}</p>
      </div>
    );
  }

  const totalTrades = filtered.length;
  const profitableTrades = filtered.filter((r) => r.profitLoss > 0).length;
  const totalProfit = filtered.reduce((sum, r) => sum + r.profitLoss, 0);
  const winRate = totalTrades > 0 ? ((profitableTrades / totalTrades) * 100).toFixed(1) : "0";

  return (
    <div className="space-y-4">
      <Card className="p-4 bg-muted/50">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Toplam İşlem</p>
            <p className="font-semibold text-lg">{totalTrades}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Kazançlı</p>
            <p className="font-semibold text-lg text-emerald-400">{profitableTrades}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Başarı Oranı</p>
            <p className="font-semibold text-lg">{winRate}%</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Toplam Kar/Zarar</p>
            <p className={`font-semibold text-lg font-mono ${totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {totalProfit >= 0 ? "+" : ""}{totalProfit.toFixed(4)} SOL
            </p>
          </div>
        </div>
      </Card>

      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          placeholder="Token adı, sembol veya adres ara..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="flex-1"
          data-testid="input-trading-search"
        />
        <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as FilterStatus)}>
          <SelectTrigger className="w-full sm:w-40" data-testid="select-trading-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tümü</SelectItem>
            <SelectItem value="profit">Kazançlı</SelectItem>
            <SelectItem value="loss">Zararlı</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
          <SelectTrigger className="w-full sm:w-40" data-testid="select-trading-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="timestamp">Tarih</SelectItem>
            <SelectItem value="profit">Kar/Zarar</SelectItem>
            <SelectItem value="duration">Süre</SelectItem>
            <SelectItem value="roi">ROI</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
          data-testid="button-trading-sort-order"
        >
          {sortOrder === "asc" ? "↑" : "↓"}
        </Button>
      </div>

      <div className="space-y-2">
        {filtered.map((record, index) => {
          const roi = calculateROI(record);
          const duration = record.sellTime - record.buyTime;
          const isProfit = record.profitLoss > 0;
          const profitUsd = solPrice ? record.profitLoss * solPrice : null;

          return (
            <div
              key={record.id}
              className={`bg-card border rounded-lg p-3 hover-elevate transition-all ${
                index === 0 ? "animate-in slide-in-from-top-1" : ""
              } ${isProfit ? "border-emerald-500/40 bg-emerald-950/10" : "border-red-500/40 bg-red-950/10"}`}
              data-testid={`row-trade-${record.id}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-foreground text-sm" data-testid="text-trade-name">
                      {record.name}
                    </span>
                    <span className="text-sm font-medium text-muted-foreground" data-testid="text-trade-symbol">
                      {record.symbol}
                    </span>
                    <Badge
                      className={`gap-1 text-xs font-semibold ${
                        isProfit
                          ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/40"
                          : "bg-red-500/15 text-red-400 border border-red-500/40"
                      }`}
                      data-testid="badge-trade-status"
                    >
                      {isProfit ? (
                        <>
                          <TrendingUp className="h-3 w-3" />
                          Kazanç
                        </>
                      ) : (
                        <>
                          <TrendingDown className="h-3 w-3" />
                          Zarar
                        </>
                      )}
                    </Badge>
                    <span className="text-xs text-muted-foreground ml-auto" data-testid="text-trade-date">
                      {formatDate(record.timestamp)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded" data-testid="text-trade-address">
                      {truncateAddress(record.mintAddress)}
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => copyAddress(record.mintAddress, record.id)}
                      className="h-6 w-6"
                      data-testid="button-copy-trade-address"
                    >
                      {copiedId === record.id ? (
                        <Check className="h-3 w-3 text-chart-4" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>

                    {record.dexscreenerUrl && (
                      <Button
                        size="sm"
                        variant="ghost"
                        asChild
                        className="h-6 px-1.5 text-xs"
                        data-testid="button-trade-dex"
                      >
                        <a href={record.dexscreenerUrl} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3 w-3 mr-1" />
                          Dex
                        </a>
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="space-y-0.5">
                      <p className="text-muted-foreground">Alış</p>
                      <p className="font-mono font-semibold">{record.buyPrice.toFixed(8)}</p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-muted-foreground">Satış</p>
                      <p className="font-mono font-semibold">{record.sellPrice.toFixed(8)}</p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-muted-foreground">Miktar</p>
                      <p className="font-mono font-semibold">{record.quantity.toLocaleString("en-US", { maximumFractionDigits: 2 })}</p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-muted-foreground">Süre</p>
                      <p className="font-mono font-semibold">{formatDuration(duration)}</p>
                    </div>
                  </div>
                </div>

                <div className="shrink-0 space-y-2 sm:text-right">
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">Kar/Zarar</p>
                    <p
                      className={`font-mono font-semibold text-sm ${
                        isProfit ? "text-emerald-400" : "text-red-400"
                      }`}
                      data-testid="text-trade-profit"
                    >
                      {isProfit ? "+" : ""}{record.profitLoss.toFixed(4)} SOL
                    </p>
                    {profitUsd && (
                      <p className="text-xs text-muted-foreground">
                        ${profitUsd.toFixed(2)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">ROI</p>
                    <p
                      className={`font-mono font-semibold text-sm ${
                        roi >= 0 ? "text-emerald-400" : "text-red-400"
                      }`}
                      data-testid="text-trade-roi"
                    >
                      {roi >= 0 ? "+" : ""}{roi.toFixed(2)}%
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
