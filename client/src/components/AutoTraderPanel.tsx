import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Settings, Play, Square } from "lucide-react";
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
  return (
    <Card className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings className="h-6 w-6 text-chart-2" />
          <div>
            <h2 className="text-lg font-bold">Otomatik Trading Ayarları</h2>
            <p className="text-xs text-muted-foreground">LP tespit edildiğinde otomatik alım-satış</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {isRunning && (
            <Badge className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/40 gap-1">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Çalışıyor
            </Badge>
          )}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Etkin:</span>
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => onToggle(checked)}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <InputField
          label="İşlem Başına SOL"
          value={config.solAmountPerTrade}
          onChange={(val) => onConfigUpdate({ solAmountPerTrade: val })}
          step={0.01}
          min={0.001}
        />
        <InputField
          label="Max Token Sayısı"
          value={config.maxTokensHeld}
          onChange={(val) => onConfigUpdate({ maxTokensHeld: val })}
          step={1}
          min={1}
        />
        <InputField
          label="Tutma Süresi (ms)"
          value={config.holdDurationMs}
          onChange={(val) => onConfigUpdate({ holdDurationMs: val })}
          step={1000}
          min={1000}
        />
        <InputField
          label="Kar Hedefi (%)"
          value={config.profitTargetPct}
          onChange={(val) => onConfigUpdate({ profitTargetPct: val })}
          step={5}
          min={0}
        />
        <InputField
          label="Stop Loss (%)"
          value={config.stopLossPct}
          onChange={(val) => onConfigUpdate({ stopLossPct: val })}
          step={1}
          min={0}
        />
        <InputField
          label="Slippage (bps)"
          value={config.slippageBps}
          onChange={(val) => onConfigUpdate({ slippageBps: val })}
          step={100}
          min={50}
        />
        <InputField
          label="Priority Fee (µL)"
          value={config.priorityFeeMicroLamports}
          onChange={(val) => onConfigUpdate({ priorityFeeMicroLamports: val })}
          step={1000000}
          min={0}
        />
      </div>

      <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-400">
        <span>⚙️ Ayarlar kaydedildi. Değişiklikler anında uygulanır.</span>
      </div>
    </Card>
  );
}

function InputField({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        step={step}
        min={min}
        className="h-8"
      />
    </div>
  );
}
