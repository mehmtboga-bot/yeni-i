import { useMemo, useState, useEffect } from "react";
import { ExternalLink, Copy, Check, TrendingUp, TrendingDown, Wallet, Settings, Loader2, AlertCircle, Target, Timer, Plus, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TradingRecordsTable } from "@/components/TradingRecordsTable";
import type { Position, TradeConfig, TradeRecord } from "@shared/schema";

type Filter = "all" | "open" | "closed";

interface TradePanelProps {
  positions: Position[];
  config: TradeConfig;
  traderPublicKey?: string;
  traderReady: boolean;
  solPriceUsd: number;
  tradingRecords?: TradeRecord[];
  globalHoldDurationMs?: number;
  ws?: WebSocket | null;
  onBuy: (mintAddress: string, name: string, symbol: string, dex?: "jupiter" | "pumpswap", solAmount?: number) => void;
  onSell: (positionId: string) => void;
  onSellHalf: (positionId: string) => void;
  onDelete: (positionId: string) => void;
  onMarkRugPull: (positionId: string) => void;
  onUpdateConfig: (cfg: Partial<TradeConfig>) => void;
  onUpdateHoldDuration?: (positionId: string, holdDurationMs: number) => void;
}

const formatUsd = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n) || n <= 0) return "—";
  if (n >= 1) return `$${n.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  const log = Math.floor(Math.log10(n));
  const decimals = Math.min(18, Math.abs(log) + 4);
  return `$${n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "")}`;
};

const truncate = (addr?: string) => addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : "—";

const formatTime = (ts?: number) =>
  ts ? new Date(ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

const formatNumber = (n?: number, digits = 4) =>
  n === undefined || n === null || Number.isNaN(n) ? "—" : n.toLocaleString("tr-TR", { maximumFractionDigits: digits });

const formatPrice = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n) || n <= 0) return "—";
  if (n >= 0.001) return n.toFixed(6);
  const log = Math.floor(Math.log10(n));
  const decimals = Math.min(18, Math.abs(log) + 4);
  return n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
};

const formatCompact = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString("tr-TR", { maximumFractionDigits: 2 });
};

export function TradePanel({
  positions,
  config,
  traderPublicKey,
  traderReady,
  solPriceUsd,
  tradingRecords = [],
  globalHoldDurationMs,
  ws,
  onBuy: onBuyProp,
  onSell,
  onSellHalf,
  onDelete,
  onMarkRugPull,
  onUpdateConfig,
  onUpdateHoldDuration,
}: TradePanelProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [solAmountInput, setSolAmountInput] = useState(String(config.solAmount));
  const [slippageInput, setSlippageInput] = useState(String(config.slippageBps));
  const [priorityManualInput, setPriorityManualInput] = useState(() => {
    const saved = localStorage.getItem("priorityFeeManualMicroLamports");
    return saved ?? String(config.priorityFeeManualMicroLamports);
  });
  const [takeProfitInput, setTakeProfitInput] = useState(String(config.takeProfitPct ?? 0));
  const [quickBuyMintInput, setQuickBuyMintInput] = useState<string>("");
  const [isQuickBuying, setIsQuickBuying] = useState(false);
  const [quickBuyError, setQuickBuyError] = useState<string>("");

  const onBuy = (mintAddress: string, name: string, symbol: string, dex: "jupiter" | "pumpswap" = "jupiter", solAmount?: number) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error("❌ WebSocket bağlantısı yok");
      onBuyProp(mintAddress, name, symbol, dex, solAmount);
      return;
    }

    console.log(`🔄 [TradePanel] Alım tetikleniyor: ${symbol} | ${solAmount} SOL`);

    ws.send(
      JSON.stringify({
        type: "buy_token",
        data: {
          mintAddress,
          name,
          symbol,
          dex,
          solAmount,
        },
      })
    );
  };

  const copyAddress = async (address: string, id: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const filtered = useMemo(() => {
    if (filter === "open") return positions.filter((p) => p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell");
    if (filter === "closed") return positions.filter((p) => p.status === "closed" || p.status === "failed");
    return positions;
  }, [positions, filter]);

  // Açık pozisyonları iki gruba böl
  const { globalHoldPositions, customHoldPositions } = useMemo(() => {
    const openFiltered = filtered.filter(
      (p) => p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell"
    );
    const globalHoldPositions = openFiltered.filter((p) => !p.customHoldDurationMs);
    const customHoldPositions = openFiltered.filter((p) => !!p.customHoldDurationMs);
    return { globalHoldPositions, customHoldPositions };
  }, [filtered]);

  const nonOpenFiltered = useMemo(
    () => filtered.filter((p) => p.status !== "open" && p.status !== "pending_buy" && p.status !== "pending_sell"),
    [filtered]
  );

  const stats = useMemo(() => {
    const open = positions.filter((p) => p.status === "open" || p.status === "pending_sell");
    const closed = positions.filter((p) => p.status === "closed");
    const totalSpent = open.reduce((s, p) => s + p.buySolAmount, 0);
    const realized = closed.reduce((s, p) => s + (p.pnlSol ?? 0), 0);
    return { openCount: open.length, closedCount: closed.length, totalSpent, realized };
  }, [positions]);

  const handleQuickBuy = async () => {
    const mint = quickBuyMintInput.trim();
    if (!mint) {
      setQuickBuyError("Mint address yazmalısın");
      return;
    }

    // Mint address validation (44 karakter, base58)
    if (mint.length !== 44) {
      setQuickBuyError("Geçersiz mint address (44 karakter olmalı)");
      return;
    }

    setIsQuickBuying(true);
    setQuickBuyError("");

    console.log(`🚀 [QuickBuy] Mint bilgileri çekiliyor: ${mint}`);

    try {
      const res = await fetch("/api/quick-buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintAddress: mint,
          solAmount: config.solAmount,
          slippageBps: config.slippageBps,
          priorityFeeMicroLamports: config.priorityFeeManualMicroLamports,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Bilinmeyen hata" }));
        setQuickBuyError(err.error || "Alım başarısız");
        console.error("Quick-buy hatası:", err);
        setIsQuickBuying(false);
        return;
      }

      const result = await res.json();
      console.log(`✅ [QuickBuy] Alım başarılı:`, result);

      // Input'u temizle
      setQuickBuyMintInput("");
      setQuickBuyError("");

      // WebSocket üzerinden position güncellemesi gelecek
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Bağlantı hatası";
      setQuickBuyError(errorMsg);
      console.error("Quick-buy isteği hatası:", err);
    } finally {
      setIsQuickBuying(false);
    }
  };

  const saveConfig = () => {
    const sol = parseFloat(solAmountInput);
    const slip = parseInt(slippageInput, 10);
    const prioManual = parseInt(priorityManualInput, 10);
    const tp = parseFloat(takeProfitInput);
    const partial: Partial<TradeConfig> = {};
    if (!Number.isNaN(sol) && sol > 0) partial.solAmount = sol;
    if (!Number.isNaN(slip) && slip >= 50) partial.slippageBps = slip;
    if (!Number.isNaN(prioManual) && prioManual >= 0) {
      partial.priorityFeeManualMicroLamports = prioManual;
      localStorage.setItem("priorityFeeManualMicroLamports", String(prioManual));
    }
    if (!Number.isNaN(tp) && tp >= 0) partial.takeProfitPct = tp;
    if (Object.keys(partial).length) onUpdateConfig(partial);
  };

  const takeProfitPct = config.takeProfitPct ?? 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Üst Bilgi */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Cüzdan kartı */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Wallet className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Trader Cüzdanı</h2>
            {traderReady ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/40">Aktif</Badge>
            ) : (
              <Badge className="bg-destructive/15 text-destructive border border-destructive/40">Devre Dışı</Badge>
            )}
          </div>
          {traderReady && traderPublicKey ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono text-muted-foreground bg-muted px-2 py-1.5 rounded-md truncate" data-testid="text-trader-pubkey">
                {traderPublicKey}
              </code>
              <Button size="icon" variant="ghost" onClick={() => copyAddress(traderPublicKey, "pubkey")} className="h-8 w-8 shrink-0">
                {copiedId === "pubkey" ? <Check className="h-4 w-4 text-chart-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <span>TRADER_PRIVATE_KEY tanımlı değil. Dosyalar sekmesinden ekleyebilirsin.</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <Stat label="Açık Pozisyon" value={stats.openCount} color="text-primary" />
            <Stat label="Kapanan" value={stats.closedCount} color="text-chart-2" />
            <Stat
              label="Toplam Yatırım"
              value={`${stats.totalSpent.toFixed(4)} SOL`}
              sub={solPriceUsd > 0 ? formatUsd(stats.totalSpent * solPriceUsd) : undefined}
              color="text-chart-4"
            />
            <Stat
              label="Realize PnL"
              value={`${stats.realized >= 0 ? "+" : ""}${stats.realized.toFixed(4)} SOL`}
              sub={solPriceUsd > 0 ? `${stats.realized >= 0 ? "+" : ""}${formatUsd(Math.abs(stats.realized) * solPriceUsd)}` : undefined}
              color={stats.realized >= 0 ? "text-emerald-400" : "text-destructive"}
            />
          </div>
        </Card>

        {/* Ayarlar kartı */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-chart-2" />
            <h2 className="text-base font-semibold">Trade Ayarları</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="sol-amount" className="text-xs">İşlem Başına SOL</Label>
              <Input id="sol-amount" type="number" step="0.01" min="0.0001" value={solAmountInput}
                onChange={(e) => setSolAmountInput(e.target.value)} data-testid="input-sol-amount" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="slippage" className="text-xs">Slippage (bps)</Label>
              <Input id="slippage" type="number" step="1000" min="50" value={slippageInput}
                onChange={(e) => setSlippageInput(e.target.value)} data-testid="input-slippage" />
              <p className="text-[10px] text-muted-foreground">
                {Math.floor(parseInt(slippageInput || "0") / 100)}%
                {parseInt(slippageInput || "0") > 9900 && (
                  <span className="text-amber-400 ml-1">· Jup: max %99</span>
                )}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="take-profit" className="text-xs flex items-center gap-1">
                <Target className="h-3 w-3 text-emerald-400" />
                Kar Hedefi (%)
              </Label>
              <Input id="take-profit" type="number" step="5" min="0" max="10000" value={takeProfitInput}
                onChange={(e) => setTakeProfitInput(e.target.value)} data-testid="input-take-profit"
                className={parseFloat(takeProfitInput) > 0 ? "border-emerald-500/50 text-emerald-400" : ""} />
              <p className="text-[10px] text-muted-foreground">
                {parseFloat(takeProfitInput) > 0 ? `+%${takeProfitInput}'de otomatik sat` : "0 = devre dışı"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-1">
              <Label htmlFor="priority-manual" className="text-xs">Manuel Fee (µLamports)</Label>
              <Input id="priority-manual" type="number" step="100000" min="0" value={priorityManualInput}
                onChange={(e) => setPriorityManualInput(e.target.value)} data-testid="input-priority-manual" />
              <p className="text-[10px] text-muted-foreground">
                Manuel alım · {(parseInt(priorityManualInput || "0") / 1_000_000_000).toFixed(6)} SOL
              </p>
            </div>
          </div>
          <Button onClick={saveConfig} className="w-full" data-testid="button-save-config">
            Ayarları Kaydet
          </Button>
          {takeProfitPct > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1.5">
              <Target className="h-3.5 w-3.5 shrink-0" />
              Kar hedefi aktif: +%{takeProfitPct}'ye ulaşınca otomatik satış
            </div>
          )}
        </Card>
      </div>

      {/* Quick Buy Kartı */}
      <Card className="p-4 space-y-3 border-emerald-500/30 bg-emerald-500/5">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-emerald-400" />
          <h2 className="text-base font-semibold">⚡ Hızlı Alım</h2>
        </div>

        <div className="space-y-2">
          <Label htmlFor="quick-buy-mint" className="text-sm">Mint Address</Label>
          <div className="flex gap-2">
            <Input
              id="quick-buy-mint"
              type="text"
              placeholder="Mint address yapıştır (44 karakter)"
              value={quickBuyMintInput}
              onChange={(e) => {
                setQuickBuyMintInput(e.target.value);
                setQuickBuyError("");
              }}
              disabled={isQuickBuying}
              className="flex-1 font-mono text-xs"
            />
            <Button
              onClick={handleQuickBuy}
              disabled={isQuickBuying || !quickBuyMintInput}
              className="bg-emerald-600 hover:bg-emerald-700"
              data-testid="button-quick-buy"
            >
              {isQuickBuying ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Alınıyor...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  Al
                </>
              )}
            </Button>
          </div>

          {quickBuyError && (
            <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5 flex items-center gap-1">
              <AlertCircle className="h-3 w-3 shrink-0" />
              {quickBuyError}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Manual trader ayarları kullanılır: {config.solAmount} SOL, {Math.floor(config.slippageBps / 100)}% slippage
          </p>
        </div>
      </Card>

      {/* Filtre */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold mr-2">Pozisyonlar</h2>
        {(["all", "open", "closed"] as Filter[]).map((f) => (
          <Button key={f} variant={filter === f ? "default" : "outline"} size="sm"
            onClick={() => setFilter(f)} data-testid={`button-filter-${f}`}>
            {f === "all" ? "Tümü" : f === "open" ? `Açık (${stats.openCount})` : `Kapanan (${stats.closedCount})`}
          </Button>
        ))}
      </div>

      {/* Pozisyon listesi */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Wallet className="h-10 w-10 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Henüz pozisyon yok. Dashboard'daki "Jup Al" veya "Pump Al" ile işlem başlat.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Bölüm 1: Global tutma süreli pozisyonlar */}
          {globalHoldPositions.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Timer className="h-4 w-4 text-amber-400" />
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">
                  Otomatik Satış (Global - {globalHoldDurationMs ? Math.round(globalHoldDurationMs / 60000) : 10} dk)
                </span>
                <span className="text-xs text-muted-foreground">({globalHoldPositions.length})</span>
              </div>
              {globalHoldPositions.map((p) => (
                <PositionRow key={p.id} position={p} copiedId={copiedId} solPriceUsd={solPriceUsd}
                  takeProfitPct={takeProfitPct} onCopy={copyAddress} onBuy={onBuy} onSell={onSell} onSellHalf={onSellHalf} onDelete={onDelete}
                  onMarkRugPull={onMarkRugPull} onUpdateHoldDuration={onUpdateHoldDuration} />
              ))}
            </div>
          )}

          {/* Bölüm 2: Özel tutma süreli pozisyonlar */}
          {customHoldPositions.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Timer className="h-4 w-4 text-violet-400" />
                <span className="text-xs font-semibold text-violet-400 uppercase tracking-wide">
                  Özel Tutma Süresi
                </span>
                <span className="text-xs text-muted-foreground">({customHoldPositions.length})</span>
              </div>
              {customHoldPositions.map((p) => (
                <PositionRow key={p.id} position={p} copiedId={copiedId} solPriceUsd={solPriceUsd}
                  takeProfitPct={takeProfitPct} onCopy={copyAddress} onBuy={onBuy} onSell={onSell} onSellHalf={onSellHalf} onDelete={onDelete}
                  onMarkRugPull={onMarkRugPull} onUpdateHoldDuration={onUpdateHoldDuration} />
              ))}
            </div>
          )}

          {/* Kapalı / başarısız pozisyonlar */}
          {nonOpenFiltered.length > 0 && (
            <div className="space-y-2">
              {(globalHoldPositions.length > 0 || customHoldPositions.length > 0) && (
                <div className="border-t border-card-border pt-2" />
              )}
              {nonOpenFiltered.map((p) => (
                <PositionRow key={p.id} position={p} copiedId={copiedId} solPriceUsd={solPriceUsd}
                  takeProfitPct={takeProfitPct} onCopy={copyAddress} onBuy={onBuy} onSell={onSell} onSellHalf={onSellHalf} onDelete={onDelete}
                  onMarkRugPull={onMarkRugPull} onUpdateHoldDuration={onUpdateHoldDuration} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Trading Records Tablosu */}
      {tradingRecords && tradingRecords.length > 0 && (
        <div className="mt-8 pt-6 border-t border-card-border">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-chart-3" />
            İşlem Geçmişi
          </h2>
          <TradingRecordsTable
            records={tradingRecords}
            solPrice={solPriceUsd}
            emptyMessage="Henüz kapatılan işlem yok"
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color, sub }: { label: string; value: string | number; color: string; sub?: string }) {
  return (
    <div className="bg-muted/30 rounded-md px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground/70 font-mono">{sub}</p>}
    </div>
  );
}

interface PositionRowProps {
  position: Position;
  copiedId: string | null;
  solPriceUsd: number;
  takeProfitPct: number;
  onCopy: (addr: string, id: string) => void;
  onBuy: (mintAddress: string, name: string, symbol: string, dex?: "jupiter" | "pumpswap", solAmount?: number) => void;
  onSell: (positionId: string) => void;
  onSellHalf: (positionId: string) => void;
  onDelete: (positionId: string) => void;
  onMarkRugPull: (positionId: string) => void;
  onUpdateHoldDuration?: (positionId: string, holdDurationMs: number) => void;
}

function PositionRow({ position: p, copiedId, solPriceUsd, takeProfitPct, onCopy, onBuy, onSell, onSellHalf, onDelete, onMarkRugPull, onUpdateHoldDuration }: PositionRowProps) {
  const isOpen = p.status === "open";
  const isPending = p.status === "pending_buy" || p.status === "pending_sell";
  const [holdDurationInput, setHoldDurationInput] = useState<string>(
    p.customHoldDurationMs ? String(Math.round(p.customHoldDurationMs / 1000)) : ""
  );
  const [isHalfSelling, setIsHalfSelling] = useState(false);
  const [additionalBuyInput, setAdditionalBuyInput] = useState<string>("");
  const [isAdditionalBuying, setIsAdditionalBuying] = useState(false);
  const [buyRetries, setBuyRetries] = useState(0);

  // İşlem sunucuya ulaşınca (pending_sell) veya kapanınca loading'i temizle
  useEffect(() => {
    if (isHalfSelling && (p.status === "pending_sell" || p.status === "closed" || p.status === "failed")) {
      setIsHalfSelling(false);
    }
  }, [p.status, isHalfSelling]);

  // Tekrar alım fonksiyonu
  const handleAdditionalBuy = async () => {
    const solAmount = parseFloat(additionalBuyInput);
    if (Number.isNaN(solAmount) || solAmount <= 0) {
      console.warn("❌ Geçersiz SOL miktarı");
      return;
    }

    setIsAdditionalBuying(true);
    setBuyRetries(0);

    const attemptBuy = (retryCount: number) => {
      console.log(`🔄 [PositionRow] Alım denemesi ${retryCount + 1}/3: ${p.symbol} | ${solAmount} SOL`);

      onBuy(p.mintAddress, p.name, p.symbol, p.dex, solAmount);

      // 5 saniye sonra kontrol et - alım başarılı mı?
      const checkTimeout = setTimeout(() => {
        if (retryCount < 2) {
          console.log(`⚠️ [PositionRow] Alım yanıt vermedi, tekrar deneniyor...`);
          setBuyRetries(retryCount + 1);
          attemptBuy(retryCount + 1);
        } else {
          console.error(`❌ [PositionRow] Alım 3 denemede başarısız oldu`);
          setIsAdditionalBuying(false);
        }
      }, 5000);

      return () => clearTimeout(checkTimeout);
    };

    attemptBuy(0);
  };

  // Position buySolAmount güncellenince alım başarılı sayılır — state'i temizle
  useEffect(() => {
    if (isAdditionalBuying && p.status === "open") {
      setAdditionalBuyInput("");
      setIsAdditionalBuying(false);
      console.log(`✅ [PositionRow] Alım başarılı: ${p.symbol}`);
    }
  }, [p.buySolAmount, isAdditionalBuying]);

  const pnlPositive = (p.pnlSol ?? 0) >= 0;
  const profitPct = isOpen ? (p.unrealizedPnlPct ?? null) : (p.pnlPct ?? null);
  const profitPositive = (profitPct ?? 0) >= 0;
  const nearTarget = takeProfitPct > 0 && isOpen && profitPct !== null && profitPct >= takeProfitPct * 0.8;

  // Auto-sell countdown
  const [autoSellSecsLeft, setAutoSellSecsLeft] = useState<number | null>(() => {
    if (!p.autoSellAt) return null;
    return Math.max(0, Math.floor((p.autoSellAt - Date.now()) / 1000));
  });

  useEffect(() => {
    if (!p.autoSellAt) {
      setAutoSellSecsLeft(null);
      return;
    }
    const update = () => {
      setAutoSellSecsLeft(Math.max(0, Math.floor((p.autoSellAt! - Date.now()) / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [p.autoSellAt]);

  // Özel tutma süresi countdown
  const [customHoldSecsLeft, setCustomHoldSecsLeft] = useState<number | null>(() => {
    if (!p.customHoldDurationMs || !p.buyTimestamp) return null;
    const elapsed = Date.now() - p.buyTimestamp;
    return Math.max(0, Math.floor((p.customHoldDurationMs - elapsed) / 1000));
  });

  useEffect(() => {
    if (!p.customHoldDurationMs || !p.buyTimestamp) {
      setCustomHoldSecsLeft(null);
      return;
    }
    const update = () => {
      const elapsed = Date.now() - p.buyTimestamp!;
      setCustomHoldSecsLeft(Math.max(0, Math.floor((p.customHoldDurationMs! - elapsed) / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [p.customHoldDurationMs, p.buyTimestamp]);

  return (
    <div
      className={`bg-card border rounded-lg overflow-hidden ${
        p.status === "closed" && p.error === "Rug Pull" ? "border-red-500/50"
        : p.status === "closed" ? (pnlPositive ? "border-emerald-500/30" : "border-destructive/30")
        : p.status === "failed" ? "border-destructive/40"
        : isOpen ? "border-primary/40"
        : "border-card-border"
      }`}
      data-testid={`row-position-${p.id}`}
    >
      <div className="p-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm" data-testid="text-pos-name">{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.symbol}</span>
              <StatusBadge status={p.status} error={p.error} />
              {p.dex && (
                <Badge className={`text-[10px] ${p.dex === "pumpswap" ? "bg-orange-500/15 text-orange-400 border border-orange-500/30" : "bg-primary/15 text-primary border border-primary/30"}`}>
                  {p.dex === "pumpswap" ? "PumpSwap" : "Jupiter"}
                </Badge>
              )}
              {profitPct !== null && (
                <Badge
                  className={`text-xs gap-1 font-bold ${
                    profitPositive
                      ? nearTarget
                        ? "bg-emerald-500/30 text-emerald-300 border border-emerald-400/60 animate-pulse"
                        : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/40"
                      : "bg-destructive/15 text-destructive border border-destructive/40"
                  }`}
                  data-testid="badge-pos-pnl-pct"
                >
                  {profitPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {profitPositive ? "+" : ""}{profitPct.toFixed(1)}%
                  {nearTarget && takeProfitPct > 0 && ` → %${takeProfitPct}`}
                </Badge>
              )}
              {autoSellSecsLeft !== null && isOpen && (
                <Badge
                  className={`text-xs gap-1 font-bold font-mono ${
                    autoSellSecsLeft === 0
                      ? "bg-orange-500/20 text-orange-300 border border-orange-400/60 animate-pulse"
                      : autoSellSecsLeft <= 10
                      ? "bg-red-500/20 text-red-300 border border-red-400/60 animate-pulse"
                      : autoSellSecsLeft <= 30
                      ? "bg-orange-500/15 text-orange-400 border border-orange-500/40"
                      : "bg-amber-500/15 text-amber-400 border border-amber-500/40"
                  }`}
                  title="Auto-trader otomatik satış zamanı"
                >
                  <Timer className="h-3 w-3" />
                  {autoSellSecsLeft === 0 ? "Satış Bekleniyor" : `Satışa Kalan: ${autoSellSecsLeft}s`}
                </Badge>
              )}
              {customHoldSecsLeft !== null && isOpen && (
                <Badge
                  className={`text-xs gap-1 font-bold font-mono ${
                    customHoldSecsLeft === 0
                      ? "bg-violet-500/20 text-violet-300 border border-violet-400/60 animate-pulse"
                      : customHoldSecsLeft <= 10
                      ? "bg-red-500/20 text-red-300 border border-red-400/60 animate-pulse"
                      : customHoldSecsLeft <= 30
                      ? "bg-orange-500/15 text-orange-400 border border-orange-500/40"
                      : "bg-violet-500/15 text-violet-400 border border-violet-500/40"
                  }`}
                  title="Özel tutma süresi countdown"
                >
                  <Timer className="h-3 w-3" />
                  {customHoldSecsLeft === 0 ? "Satış Bekleniyor" : `Kaldı: ${customHoldSecsLeft}s`}
                </Badge>
              )}
              {isHalfSelling && (
                <Badge className="text-xs gap-1 font-bold bg-amber-500/20 text-amber-300 border border-amber-400/60 animate-pulse">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Yarısını Sat
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto">{formatTime(p.buyTimestamp)}</span>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <code className="text-[11px] font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                {truncate(p.mintAddress)}
              </code>
              <Button size="icon" variant="ghost" onClick={() => onCopy(p.mintAddress, p.id)} className="h-6 w-6" data-testid="button-copy-pos-address">
                {copiedId === p.id ? <Check className="h-3 w-3 text-chart-4" /> : <Copy className="h-3 w-3" />}
              </Button>
              <Button size="sm" variant="ghost" asChild className="h-6 px-1.5 text-xs">
                <a href={`https://dexscreener.com/solana/${p.mintAddress}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3 w-3 mr-1" />Dex
                </a>
              </Button>
              <Button size="sm" variant="ghost" asChild className="h-6 px-1.5 text-xs">
                <a href={`https://jup.ag/swap/SOL-${p.mintAddress}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3 w-3 mr-1" />Jup
                </a>
              </Button>
              {p.buyTxSignature && (
                <Button size="sm" variant="ghost" asChild className="h-6 px-1.5 text-xs">
                  <a href={`https://solscan.io/tx/${p.buyTxSignature}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" />Buy TX
                  </a>
                </Button>
              )}
              {p.sellTxSignature && (
                <Button size="sm" variant="ghost" asChild className="h-6 px-1.5 text-xs">
                  <a href={`https://solscan.io/tx/${p.sellTxSignature}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" />Sell TX
                  </a>
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] pt-1">
              <Cell
                label="Harcanan"
                value={`${p.buySolAmount.toFixed(4)} SOL`}
                sub={solPriceUsd > 0 ? formatUsd(p.buySolAmount * solPriceUsd) : undefined}
              />
              <Cell
                label="Alınan Token"
                value={p.buyTokenAmount ? `${formatCompact(p.buyTokenAmount)} ${p.symbol}` : "—"}
                sub={p.buyTokenAmount ? formatNumber(p.buyTokenAmount, 4) : undefined}
              />
              <Cell
                label={isOpen && p.currentPriceUsd ? "Şu Anki Fiyat" : "Alım Fiyatı"}
                value={
                  isOpen && p.currentPriceUsd ? formatUsd(p.currentPriceUsd)
                  : solPriceUsd > 0 && p.buyPriceSol ? formatUsd(p.buyPriceSol * solPriceUsd)
                  : `${formatPrice(p.buyPriceSol)} SOL`
                }
                sub={
                  isOpen && p.currentPriceUsd && p.buyPriceSol
                    ? `Aldığın: ${formatUsd(p.buyPriceSol * solPriceUsd)}`
                    : solPriceUsd > 0 && p.buyPriceSol ? `${formatPrice(p.buyPriceSol)} SOL` : undefined
                }
              />
              <Cell
                label={isOpen && p.unrealizedPnlSol !== undefined ? "Unrealized PnL" : "Satış Fiyatı"}
                value={
                  isOpen && p.unrealizedPnlSol !== undefined
                    ? `${p.unrealizedPnlSol >= 0 ? "+" : ""}${formatUsd(Math.abs(p.unrealizedPnlSol * solPriceUsd))}`
                    : p.sellPriceSol
                      ? solPriceUsd > 0 ? formatUsd(p.sellPriceSol * solPriceUsd) : `${formatPrice(p.sellPriceSol)} SOL`
                      : "—"
                }
                sub={
                  isOpen && p.unrealizedPnlPct !== undefined
                    ? `${p.unrealizedPnlPct >= 0 ? "+" : ""}${p.unrealizedPnlPct.toFixed(2)}%`
                    : p.sellSolAmount
                      ? `${p.sellSolAmount.toFixed(4)} SOL${solPriceUsd > 0 ? ` (${formatUsd(p.sellSolAmount * solPriceUsd)})` : ""}`
                      : undefined
                }
                highlight={isOpen && (p.unrealizedPnlPct ?? 0) >= 0 ? "green" : isOpen ? "red" : undefined}
              />
            </div>

            {p.error && (
              <div className="text-[11px] text-destructive bg-destructive/10 rounded px-2 py-1">⚠️ {p.error}</div>
            )}

            {/* Özel tutma süresi ayarı — sadece açık pozisyonlar için */}
            {isOpen && onUpdateHoldDuration && (
              <div className="flex items-center gap-2 pt-1">
                <Label htmlFor={`hold-dur-${p.id}`} className="text-[10px] text-muted-foreground whitespace-nowrap flex items-center gap-1">
                  <Timer className="h-3 w-3 text-violet-400" />
                  Tutma Süresi (sn)
                </Label>
                <Input
                  id={`hold-dur-${p.id}`}
                  type="number"
                  min="1"
                  step="30"
                  placeholder={p.customHoldDurationMs ? String(Math.round(p.customHoldDurationMs / 1000)) : "örn: 300"}
                  value={holdDurationInput}
                  onChange={(e) => setHoldDurationInput(e.target.value)}
                  className="h-6 text-xs w-24 px-2"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs border-violet-500/50 text-violet-400 hover:bg-violet-500/10"
                  onClick={() => {
                    const secs = parseInt(holdDurationInput, 10);
                    if (!Number.isNaN(secs) && secs > 0) {
                      onUpdateHoldDuration(p.id, secs * 1000);
                    }
                  }}
                >
                  ✓
                </Button>
                {p.customHoldDurationMs && (
                  <span className="text-[10px] text-violet-400">
                    ✓ {Math.round(p.customHoldDurationMs / 1000)}s ayarlı
                  </span>
                )}
              </div>
            )}

            {/* Tekrar alım — sadece açık pozisyonlar için */}
            {isOpen && (
              <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                <Label htmlFor={`additional-buy-${p.id}`} className="text-[10px] text-muted-foreground whitespace-nowrap flex items-center gap-1">
                  <Plus className="h-3 w-3 text-emerald-400" />
                  Tekrar Al (SOL)
                </Label>
                <Input
                  id={`additional-buy-${p.id}`}
                  type="number"
                  step="0.01"
                  min="0.0001"
                  placeholder="0.1"
                  value={additionalBuyInput}
                  onChange={(e) => setAdditionalBuyInput(e.target.value)}
                  disabled={isAdditionalBuying}
                  className="h-6 text-xs w-20 px-2"
                />
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 px-3 text-xs bg-emerald-600 hover:bg-emerald-700"
                  disabled={isAdditionalBuying || !additionalBuyInput}
                  onClick={handleAdditionalBuy}
                  data-testid={`button-additional-buy-${p.id}`}
                >
                  {isAdditionalBuying ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Alınıyor ({buyRetries + 1}/3)
                    </>
                  ) : (
                    <>
                      <Plus className="h-3 w-3 mr-1" />
                      Al
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>

          <div className="shrink-0 flex gap-2">
            {isOpen && (
              <>
                <Button size="sm" variant="destructive" onClick={() => onSell(p.id)} data-testid={`button-sell-${p.id}`}>
                  Sat
                </Button>
                {(p.buyTokenAmount ?? 0) > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-500/50 text-amber-400 hover:bg-amber-500/10"
                    disabled={isPending || isHalfSelling}
                    onClick={() => {
                      setIsHalfSelling(true);
                      onSellHalf(p.id);
                    }}
                    data-testid={`button-half-sell-${p.id}`}
                  >
                    {isHalfSelling ? (
                      <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Satılıyor</>
                    ) : (
                      "½ Sat"
                    )}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500/50 text-red-400 hover:bg-red-500/10"
                  onClick={() => {
                    if (confirm(`${p.symbol} rug pull olarak kapatsın? -%100 zarar kaydedilecek ve "Kapanan" bölümünde görünecek.`)) {
                      onMarkRugPull(p.id);
                    }
                  }}
                  data-testid={`button-rug-${p.id}`}
                >
                  🚨 Rug
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (confirm(`${p.symbol} işlemini iptal etmek istediğine emin misin?`)) {
                      onDelete(p.id);
                    }
                  }}
                  data-testid={`button-cancel-${p.id}`}
                >
                  ✕ İptal
                </Button>
              </>
            )}
            {p.status === "failed" && p.buyTxSignature && (
              <Button size="sm" variant="destructive" onClick={() => onSell(p.id)} data-testid={`button-retry-sell-${p.id}`}>
                Tekrar Sat
              </Button>
            )}
            {isPending && (
              <Button size="sm" variant="outline" disabled>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                {p.status === "pending_buy" ? "Alınıyor" : "Satılıyor"}
              </Button>
            )}
            {!isOpen && (
              <Button
                size="icon" variant="ghost"
                onClick={() => {
                  if (isPending) {
                    if (confirm(`${p.status === "pending_buy" ? "Alım" : "Satış"} iptal edilecek, emin misin?`)) onDelete(p.id);
                  } else {
                    onDelete(p.id);
                  }
                }}
                className="h-8 w-8 text-destructive/60 hover:text-destructive"
                title={isPending ? "İşlemi iptal et" : "Pozisyonu sil"}
              >
                ✕
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Cell({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: "green" | "red" }) {
  return (
    <div className={`rounded px-2 py-1 ${
      highlight === "green" ? "bg-emerald-500/10" : highlight === "red" ? "bg-destructive/10" : "bg-muted/30"
    }`}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`font-mono ${highlight === "green" ? "text-emerald-400" : highlight === "red" ? "text-destructive" : ""}`}>{value}</p>
      {sub && <p className="text-[9px] text-muted-foreground/70 font-mono truncate" title={sub}>{sub}</p>}
    </div>
  );
}

function StatusBadge({ status, error }: { status: Position["status"]; error?: string }) {
  if (status === "closed" && error === "Rug Pull") {
    return (
      <Badge className="text-xs bg-red-500/20 text-red-400 border border-red-500/50">
        🚨 Rug Pull
      </Badge>
    );
  }
  const map: Record<Position["status"], { label: string; cls: string }> = {
    pending_buy:  { label: "Alınıyor",  cls: "bg-primary/15 text-primary border border-primary/40" },
    open:         { label: "Açık",      cls: "bg-chart-4/15 text-chart-4 border border-chart-4/40" },
    pending_sell: { label: "Satılıyor", cls: "bg-primary/15 text-primary border border-primary/40" },
    closed:       { label: "Kapandı",   cls: "bg-muted text-muted-foreground border border-muted-foreground/30" },
    failed:       { label: "Başarısız", cls: "bg-destructive/15 text-destructive border border-destructive/40" },
  };
  const cfg = map[status];
  return <Badge className={`text-xs ${cfg.cls}`}>{cfg.label}</Badge>;
}
