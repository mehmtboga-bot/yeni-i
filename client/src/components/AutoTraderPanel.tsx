import { useState, useEffect } from "react";
import { Settings, Play, Square, AlertCircle, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AutoTraderConfig } from "@shared/schema";

interface AutoTraderPanelProps {
  config: AutoTraderConfig;
  isRunning: boolean;
  onConfigUpdate: (cfg: Partial<AutoTraderConfig>) => void;
  onToggle: (enabled: boolean) => void;
}

export function AutoTraderPanel({
  config,
  isRunning,
  onConfigUpdate,
  onToggle,
}: AutoTraderPanelProps) {
  const [solAmountInput, setSolAmountInput] = useState(String(config.solAmountPerTrade));
  const [maxTokensInput, setMaxTokensInput] = useState(String(config.maxTokensHeld));
  const [holdDurationInput, setHoldDurationInput] = useState(String(config.holdDurationMs / 1000));
  const [profitTargetInput, setProfitTargetInput] = useState(String(config.profitTargetPct));
  const [stopLossInput, setStopLossInput] = useState(String(config.stopLossPct));
  const [slippageInput, setSlippageInput] = useState(String(config.slippageBps));
  const [priorityInput, setPriorityInput] = useState(String(config.priorityFeeMicroLamports));
  const [minLiquidityInput, setMinLiquidityInput] = useState(String(config.minLiquidityUsd ?? 5000));

  // Sunucudan gelen config değiştiğinde (positions_snapshot veya auto_trader_config_update)
  // input state'lerini güncelle — böylece sayfa yenilemesinde veya yeniden bağlanmada
  // sunucunun kalıcı olarak sakladığı ayarlar panele yansır.
  useEffect(() => {
    setSolAmountInput(String(config.solAmountPerTrade));
    setMaxTokensInput(String(config.maxTokensHeld));
    setHoldDurationInput(String(config.holdDurationMs / 1000));
    setProfitTargetInput(String(config.profitTargetPct));
    setStopLossInput(String(config.stopLossPct));
    setSlippageInput(String(config.slippageBps));
    setPriorityInput(String(config.priorityFeeMicroLamports));
    setMinLiquidityInput(String(config.minLiquidityUsd ?? 5000));
  }, [config]);

  const saveConfig = () => {
    const partial: Partial<AutoTraderConfig> = {};

    const sol = parseFloat(solAmountInput);
    if (!Number.isNaN(sol) && sol > 0) partial.solAmountPerTrade = sol;

    const maxTokens = parseInt(maxTokensInput, 10);
    if (!Number.isNaN(maxTokens) && maxTokens > 0) partial.maxTokensHeld = maxTokens;

    const holdDuration = parseInt(holdDurationInput, 10);
    if (!Number.isNaN(holdDuration) && holdDuration > 0) partial.holdDurationMs = holdDuration * 1000;

    const profitTarget = parseFloat(profitTargetInput);
    if (!Number.isNaN(profitTarget) && profitTarget >= 0) partial.profitTargetPct = profitTarget;

    const stopLoss = parseFloat(stopLossInput);
    if (!Number.isNaN(stopLoss) && stopLoss >= 0) partial.stopLossPct = stopLoss;

    const slippage = parseInt(slippageInput, 10);
    if (!Number.isNaN(slippage) && slippage >= 50) partial.slippageBps = slippage;

    const priority = parseInt(priorityInput, 10);
    if (!Number.isNaN(priority) && priority >= 0) partial.priorityFeeMicroLamports = priority;

    const minLiquidity = parseFloat(minLiquidityInput);
    if (!Number.isNaN(minLiquidity) && minLiquidity >= 0) partial.minLiquidityUsd = minLiquidity;

    if (Object.keys(partial).length > 0) {
      onConfigUpdate(partial);
    }
  };

  const resetToDefaults = () => {
    setSolAmountInput("0.035");
    setMaxTokensInput("2");
    setHoldDurationInput("500");
    setProfitTargetInput("135");
    setStopLossInput("80");
    setSlippageInput("9900");
    setPriorityInput("3000000");
    setMinLiquidityInput("3000");
  };

  return (
    <div className="space-y-6">
      {/* Başlık */}
      <div className="flex items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-6 w-6 text-chart-3" />
          <h2 className="text-lg font-semibold">🤖 Otomatik Trading</h2>
          {config.enabled ? (
            <Badge className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/40">
              {isRunning ? "🟢 Çalışıyor" : "⏸️ Durduruldu"}
            </Badge>
          ) : (
            <Badge className="bg-muted text-muted-foreground border border-muted-foreground/30">
              ⚪ Devre Dışı
            </Badge>
          )}
        </div>

        {/* Başlat/Durdur Butonları */}
        <div className="flex gap-2">
          <Button
            onClick={() => onToggle(true)}
            variant={config.enabled ? "default" : "outline"}
            size="sm"
            className={config.enabled ? "bg-emerald-600 hover:bg-emerald-700" : ""}
            data-testid="button-auto-trader-start"
          >
            <Play className="h-4 w-4 mr-2" />
            Başlat
          </Button>
          <Button
            onClick={() => onToggle(false)}
            variant={!config.enabled ? "default" : "outline"}
            size="sm"
            className={!config.enabled ? "bg-destructive hover:bg-destructive/90" : ""}
            data-testid="button-auto-trader-stop"
          >
            <Square className="h-4 w-4 mr-2" />
            Durdur
          </Button>
        </div>
      </div>

      {/* Ana Konfigürasyon Kartı */}
      <Card className="p-6 space-y-6">
        {/* Başlık */}
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-chart-2" />
          <h3 className="text-base font-semibold">Ayarlar</h3>
        </div>

        {/* Uyarı */}
        {!config.enabled && (
          <div className="flex items-start gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-md">
            <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-400">
              Otomatik trading kapalı. Başlat butonuna basarak etkinleştirebilirsin.
            </p>
          </div>
        )}

        {/* Grid Ayarları */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Satır 1: SOL Miktarı & Max Token */}
          <div className="space-y-2">
            <Label htmlFor="auto-sol-amount" className="text-sm font-medium">
              💰 İşlem Başına SOL
            </Label>
            <Input
              id="auto-sol-amount"
              type="number"
              step="0.01"
              min="0.0001"
              value={solAmountInput}
              onChange={(e) => setSolAmountInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-sol-amount"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Her LP algılandığında kaç SOL harcanacak
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-max-tokens" className="text-sm font-medium">
              📦 Max Tutulacak Token
            </Label>
            <Input
              id="auto-max-tokens"
              type="number"
              step="1"
              min="1"
              value={maxTokensInput}
              onChange={(e) => setMaxTokensInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-max-tokens"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Aynı anda tutulacak maksimum pozisyon sayısı
            </p>
          </div>

          {/* Satır 2: Tutma Süresi & Kar Hedefi */}
          <div className="space-y-2">
            <Label htmlFor="auto-hold-duration" className="text-sm font-medium">
              ⏱️ Tutma Süresi (saniye)
            </Label>
            <Input
              id="auto-hold-duration"
              type="number"
              step="10"
              min="10"
              value={holdDurationInput}
              onChange={(e) => setHoldDurationInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-hold-duration"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {parseInt(holdDurationInput) < 60 ? `${parseInt(holdDurationInput)}s` : `${(parseInt(holdDurationInput) / 60).toFixed(1)}m`} tutunca otomatik sat
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-profit-target" className="text-sm font-medium">
              📈 Kar Hedefi (%)
            </Label>
            <Input
              id="auto-profit-target"
              type="number"
              step="5"
              min="0"
              value={profitTargetInput}
              onChange={(e) => setProfitTargetInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-profit-target"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Alış fiyatından bu yüzde fiyat yükselince otomatik sat
            </p>
          </div>

          {/* Satır 3: Zarar Limiti & Slippage */}
          <div className="space-y-2">
            <Label htmlFor="auto-stop-loss" className="text-sm font-medium">
              📉 Stop Loss (%)
            </Label>
            <Input
              id="auto-stop-loss"
              type="number"
              step="5"
              min="0"
              value={stopLossInput}
              onChange={(e) => setStopLossInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-stop-loss"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Alış fiyatından bu yüzde düşünce acil sat
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-slippage" className="text-sm font-medium">
              Slippage (bps)
            </Label>
            <Input
              id="auto-slippage"
              type="number"
              step="100"
              min="50"
              value={slippageInput}
              onChange={(e) => setSlippageInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-slippage"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {Math.floor(parseInt(slippageInput) / 100)}% slippage toleransı
            </p>
          </div>

          {/* Satır 4: Priority Fee & Min Liquidity */}
          <div className="space-y-2">
            <Label htmlFor="auto-priority" className="text-sm font-medium">
              ⚡ Priority Fee (µLamports)
            </Label>
            <Input
              id="auto-priority"
              type="number"
              step="100000"
              min="0"
              value={priorityInput}
              onChange={(e) => setPriorityInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-priority"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              İşlem hızı için ödenen ek ücret
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-min-liquidity" className="text-sm font-medium">
              💧 Min Likidite (USD)
            </Label>
            <Input
              id="auto-min-liquidity"
              type="number"
              step="500"
              min="0"
              value={minLiquidityInput}
              onChange={(e) => setMinLiquidityInput(e.target.value)}
              disabled={isRunning}
              data-testid="input-auto-min-liquidity"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {parseFloat(minLiquidityInput) === 0
                ? "Filtre devre dışı — tüm LP'ler işlenir"
                : `$${Number(minLiquidityInput).toLocaleString()} altı likidite atlanır`}
            </p>
          </div>
        </div>

        {/* Butonlar */}
        <div className="flex gap-2 pt-2">
          <Button
            onClick={saveConfig}
            disabled={isRunning}
            className="flex-1 bg-primary hover:bg-primary/90"
            data-testid="button-auto-save-config"
          >
            💾 Ayarları Kaydet
          </Button>
          <Button
            onClick={resetToDefaults}
            disabled={isRunning}
            variant="outline"
            data-testid="button-auto-reset-config"
          >
            🔄 Varsayılana Dön
          </Button>
        </div>
      </Card>

      {/* Özet Bilgi */}
      <Card className="p-4 bg-muted/50 space-y-3">
        <h3 className="text-sm font-semibold">📋 Özet</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div className="space-y-1">
            <p className="text-muted-foreground">Per Trade</p>
            <p className="font-mono font-semibold">{solAmountInput} SOL</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">Max Tokens</p>
            <p className="font-mono font-semibold">{maxTokensInput}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">Hold Time</p>
            <p className="font-mono font-semibold">
              {parseInt(holdDurationInput) < 60 
                ? `${parseInt(holdDurationInput)}s` 
                : `${(parseInt(holdDurationInput) / 60).toFixed(1)}m`}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">Targets</p>
            <p className="font-mono font-semibold">
              +{profitTargetInput}% / -{stopLossInput}%
            </p>
          </div>
          <div className="space-y-1 md:col-span-2">
            <p className="text-muted-foreground">Min Liquidity</p>
            <p className="font-mono font-semibold">
              {parseFloat(minLiquidityInput) === 0
                ? "Devre Dışı"
                : `$${Number(minLiquidityInput).toLocaleString()}`}
            </p>
          </div>
        </div>
        {config.enabled && isRunning && (
          <div className="mt-3 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-xs text-emerald-400 flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            Otomatik trading aktif - LP'leri otomatik olarak takip ediyor
          </div>
        )}
      </Card>
    </div>
  );
}
