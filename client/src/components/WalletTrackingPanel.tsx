import { useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, Play, Square, Wallet, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WalletMintEvent, WalletTrackingState } from "@shared/wallet-tracking";

interface WalletTrackingPanelProps {
  state: WalletTrackingState;
  traderReady: boolean;
  openMints: Set<string>;
  error?: string;
  onSaveAddress: (address: string) => void;
  onToggleWatching: (enabled: boolean) => void;
  onToggleAutoBuy: (enabled: boolean) => void;
  onBuy: (token: WalletMintEvent) => void;
}

const buyStatusLabel: Record<WalletMintEvent["autoBuyStatus"], string> = {
  watch_only: "Yalnızca izleniyor",
  waiting: "Filtreler / likidite bekleniyor",
  bought: "Otomatik alındı",
  skipped: "Filtre nedeniyle atlandı",
  failed: "Alım başarısız",
};

export function WalletTrackingPanel({
  state,
  traderReady,
  openMints,
  error,
  onSaveAddress,
  onToggleWatching,
  onToggleAutoBuy,
  onBuy,
}: WalletTrackingPanelProps) {
  const [address, setAddress] = useState(state.walletAddress);

  useEffect(() => setAddress(state.walletAddress), [state.walletAddress]);

  return (
    <div className="space-y-5">
      <Card className="space-y-5 p-5" data-testid="panel-wallet-tracking">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Cüzdan Takibi</h2>
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
          <Label htmlFor="watched-wallet-address">İzlenecek Solana cüzdan adresi</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="watched-wallet-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Cüzdan adresini girin"
              disabled={state.isWatching}
              className="font-mono"
              data-testid="input-watched-wallet"
            />
            <Button
              variant="outline"
              onClick={() => onSaveAddress(address)}
              disabled={state.isWatching || !address.trim()}
              data-testid="button-wallet-save"
            >
              Cüzdanı Kaydet
            </Button>
          </div>
          {error && <p className="text-xs text-destructive" data-testid="text-wallet-error">{error}</p>}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
          <Button
            onClick={() => onToggleWatching(true)}
            disabled={state.isWatching || !state.walletAddress}
            data-testid="button-start-wallet-watch"
          >
            <Eye className="mr-2 h-4 w-4" />
            İzle
          </Button>
          <Button
            onClick={() => onToggleWatching(false)}
            disabled={!state.isWatching}
            variant="outline"
            data-testid="button-stop-wallet-watch"
          >
            <EyeOff className="mr-2 h-4 w-4" />
            İzlemeyi Durdur
          </Button>
          <Button
            onClick={() => onToggleAutoBuy(true)}
            disabled={!state.isWatching || state.autoBuyRunning || !traderReady}
            className="bg-emerald-600 hover:bg-emerald-700"
            data-testid="button-start-wallet-auto-buy"
            title={!traderReady ? "Trader cüzdanı hazır değil" : undefined}
          >
            <Play className="mr-2 h-4 w-4" />
            Başlat
          </Button>
          <Button
            onClick={() => onToggleAutoBuy(false)}
            disabled={!state.autoBuyRunning}
            variant="destructive"
            data-testid="button-stop-wallet-auto-buy"
          >
            <Square className="mr-2 h-4 w-4" />
            Durdur
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Başlat yalnızca bu cüzdanın izleme başladıktan sonra oluşturduğu yeni mintlerde otomatik alım dener.
          Whitelist ve aynı sembol filtresinden bağımsızdır; Otomatik Ticaret likidite ve pozisyon sınırı filtreleri uygulanır.
          Durdur yeni alım denemelerini keser.
        </p>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="font-semibold">İzlenen cüzdandan yeni tokenler</h3>
        <Badge variant="outline">{state.tokens.length}</Badge>
      </div>

      {state.tokens.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          Yeni mint tespit edilmedi. İzleme başladığında bu cüzdanın oluşturduğu tokenler burada görünür.
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {state.tokens.map((token) => {
            const hasPosition = openMints.has(token.mintAddress);
            return (
              <Card key={token.id} className="space-y-4 p-4" data-testid={`card-wallet-mint-${token.mintAddress}`}>
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
                  {token.autoBuyMessage && <p className="text-amber-400">{token.autoBuyMessage}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!traderReady || hasPosition}
                    onClick={() => onBuy(token)}
                    data-testid={`button-wallet-mint-buy-${token.mintAddress}`}
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
  );
}
