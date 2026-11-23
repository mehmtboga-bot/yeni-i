import { useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, Play, Square, Trash2, Wallet, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WalletMintEvent, WalletTrackingState } from "@shared/wallet-tracking";

interface WalletTrackingPanelProps {
  states: WalletTrackingState[];
  traderReady: boolean;
  openMints: Set<string>;
  errors: string[];
  onSaveAddress: (slot: number, address: string) => void;
  onToggleWatching: (slot: number, enabled: boolean) => void;
  onToggleAutoBuy: (slot: number, enabled: boolean) => void;
  onBuy: (slot: number, token: WalletMintEvent) => void;
  onClear: (slot: number) => void;
}

const buyStatusLabel: Record<WalletMintEvent["autoBuyStatus"], string> = {
  watch_only: "Yalnızca izleniyor",
  waiting: "Filtreler / likidite bekleniyor",
  bought: "Otomatik alındı",
  skipped: "Filtre nedeniyle atlandı",
  failed: "Alım başarısız",
};

export function WalletTrackingPanel({
  states,
  traderReady,
  openMints,
  errors,
  onSaveAddress,
  onToggleWatching,
  onToggleAutoBuy,
  onBuy,
  onClear,
}: WalletTrackingPanelProps) {
  const [addresses, setAddresses] = useState(["", ""]);
  const savedAddress1 = states[0]?.walletAddress ?? "";
  const savedAddress2 = states[1]?.walletAddress ?? "";

  useEffect(() => {
    setAddresses([savedAddress1, savedAddress2]);
  }, [savedAddress1, savedAddress2]);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {states.map((state, slot) => (
        <div key={slot} className="space-y-5">
      <Card className="space-y-5 p-5" data-testid={`panel-wallet-tracking-${slot + 1}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Cüzdan {slot + 1} Takibi</h2>
              <Badge variant={state.isWatching ? "default" : "secondary"}>
                {state.isWatching ? "İzleniyor" : "Durduruldu"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Kaydedilen cüzdanın oluşturduğu yeni token mintlerini takip edin.
            </p>
          </div>
          <Badge variant={state.autoBuyRunning ? "default" : "outline"}>
            {state.autoBuyRunning ? "Otomatik alım açık" : "Otomatik alım kapalı"}
          </Badge>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`watched-wallet-address-${slot + 1}`}>İzlenecek Solana cüzdan adresi</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`watched-wallet-address-${slot + 1}`}
              value={addresses[slot]}
              onChange={(event) => setAddresses((current) => current.map((value, index) => index === slot ? event.target.value : value))}
              placeholder="Cüzdan adresini girin"
              disabled={state.isWatching}
              className="font-mono"
              data-testid={`input-watched-wallet-${slot + 1}`}
            />
            <Button
              variant="outline"
              onClick={() => onSaveAddress(slot, addresses[slot])}
              disabled={state.isWatching || !addresses[slot].trim()}
              data-testid={`button-wallet-save-${slot + 1}`}
            >
              Cüzdanı Kaydet
            </Button>
          </div>
          {errors[slot] && <p className="text-xs text-destructive" data-testid={`text-wallet-error-${slot + 1}`}>{errors[slot]}</p>}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
          <Button
            onClick={() => onToggleWatching(slot, true)}
            disabled={state.isWatching || !state.walletAddress}
            data-testid={`button-start-wallet-watch-${slot + 1}`}
          >
            <Eye className="mr-2 h-4 w-4" />
            İzle
          </Button>
          <Button
            onClick={() => onToggleWatching(slot, false)}
            disabled={!state.isWatching}
            variant="outline"
            data-testid={`button-stop-wallet-watch-${slot + 1}`}
          >
            <EyeOff className="mr-2 h-4 w-4" />
            İzlemeyi Durdur
          </Button>
          <Button
            onClick={() => onToggleAutoBuy(slot, true)}
            disabled={!state.isWatching || state.autoBuyRunning || !traderReady}
            className="bg-emerald-600 hover:bg-emerald-700"
            data-testid={`button-start-wallet-auto-buy-${slot + 1}`}
            title={!traderReady ? "Trader cüzdanı hazır değil" : undefined}
          >
            <Play className="mr-2 h-4 w-4" />
            Başlat
          </Button>
          <Button
            onClick={() => onToggleAutoBuy(slot, false)}
            disabled={!state.autoBuyRunning}
            variant="destructive"
            data-testid={`button-stop-wallet-auto-buy-${slot + 1}`}
          >
            <Square className="mr-2 h-4 w-4" />
            Durdur
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Başlat yalnızca bu cüzdanın izleme başladıktan sonra oluşturduğu yeni mintlerde otomatik alım dener.
          Whitelist ve aynı sembol filtresinden bağımsızdır; Otomatik Ticaret likidite ve pozisyon sınırı filtreleri uygulanır.
          Solscan doğrulaması olmayan tokenlerde otomatik alım yapılmaz. Durdur yeni alım denemelerini keser.
        </p>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="font-semibold">İzlenen cüzdandan yeni tokenler</h3>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{state.tokens.length}/5</Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={state.tokens.length === 0}
            onClick={() => onClear(slot)}
            data-testid={`button-clear-wallet-mints-${slot + 1}`}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Tümünü Sil
          </Button>
        </div>
      </div>

      {state.tokens.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          Yeni mint tespit edilmedi. İzleme başladığında bu cüzdanın oluşturduğu tokenler burada görünür.
        </Card>
      ) : (
        <div className="grid gap-3">
          {state.tokens.map((token) => {
            const hasPosition = openMints.has(token.mintAddress);
            return (
              <Card key={token.id} className="space-y-4 p-4" data-testid={`card-wallet-mint-${slot + 1}-${token.mintAddress}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate font-semibold">{token.name}</h4>
                    <p className="text-sm text-muted-foreground">{token.symbol}</p>
                  </div>
                  <Badge variant={token.autoBuyStatus === "bought" ? "default" : "secondary"}>
                    {buyStatusLabel[token.autoBuyStatus]}
                  </Badge>
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>Mint adresi</p>
                  <code className="block break-all rounded bg-muted p-2 font-mono text-foreground">
                    {token.mintAddress}
                  </code>
                  <p>
                    {new Date(token.detectedAt).toLocaleString("tr-TR")}
                    {token.liquidityUsd !== undefined && ` · Likidite $${token.liquidityUsd.toLocaleString("tr-TR", { maximumFractionDigits: 0 })}`}
                  </p>
                  <p className={token.solscanVerified ? "text-emerald-500" : "text-amber-400"}>
                    {token.solscanMessage}
                  </p>
                  {token.autoBuyMessage && <p className="text-amber-400">{token.autoBuyMessage}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!traderReady || hasPosition}
                    onClick={() => onBuy(slot, token)}
                    data-testid={`button-wallet-mint-buy-${slot + 1}-${token.mintAddress}`}
                  >
                    <Zap className="mr-1.5 h-3.5 w-3.5" />
                    {hasPosition ? "Pozisyon açık" : "Jupiter ile Al"}
                  </Button>
                  {[
                    ["Jupiter", token.jupiterUrl],
                    ["DEX", token.dexscreenerUrl],
                    ["Pump.fun", token.pumpfunUrl],
                  ].map(([label, url]) => (
                    <Button key={label} size="sm" variant="outline" asChild>
                      <a href={url} target="_blank" rel="noopener noreferrer">
                        {label}
                        <ExternalLink className="ml-1 h-3 w-3" />
                      </a>
                    </Button>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
        </div>
      ))}
    </div>
  );
}
