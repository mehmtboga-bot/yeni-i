import { useState } from "react";
import { ExternalLink, Copy, Check, Lock, Unlock, Droplet, Zap } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { MintedToken } from "@shared/schema";

interface MintedTokenCardProps {
  token: MintedToken;
  isNew?: boolean;
  traderReady?: boolean;
  hasOpenPosition?: boolean;
  onBuy?: (mintAddress: string, name: string, symbol: string, dex: "jupiter" | "pumpswap") => void;
}

export function MintedTokenCard({
  token,
  isNew = false,
  traderReady = false,
  hasOpenPosition = false,
  onBuy,
}: MintedTokenCardProps) {
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    await navigator.clipboard.writeText(token.mintAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const dexscreenerUrl = `https://dexscreener.com/solana/${token.mintAddress}`;
  const canBuy = traderReady && !hasOpenPosition;

  return (
    <Card
      className={`p-4 hover-elevate transition-all duration-300 ${isNew ? "animate-in slide-in-from-top-2 border-primary" : ""}`}
      data-testid={`card-token-${token.id}`}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-foreground truncate" data-testid="text-token-name">{token.name}</h3>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge className="bg-gradient-to-r from-primary to-chart-2 text-primary-foreground border-0" data-testid="badge-symbol">
                {token.symbol}
              </Badge>
              {token.isLocked ? (
                <Badge variant="outline" className="gap-1 border-chart-2 text-chart-2 bg-chart-2/10" data-testid="badge-token-locked">
                  <Lock className="h-3 w-3" />
                  Kilitli {token.lockDuration && `(${token.lockDuration})`}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 border-destructive text-destructive bg-destructive/10" data-testid="badge-token-unlocked">
                  <Unlock className="h-3 w-3" />
                  Kilit Açık
                </Badge>
              )}
              {token.liquidityAmount !== undefined && (
                <Badge variant="secondary" className="bg-chart-4/10 text-chart-4 border-chart-4/20" data-testid="badge-token-liquidity">
                  <Droplet className="h-3 w-3 mr-1" />
                  {token.liquidityAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs font-mono text-muted-foreground bg-muted px-2 py-1.5 rounded-md truncate" data-testid="text-mint-address">
            {token.mintAddress.slice(0, 4)}...{token.mintAddress.slice(-4)}
          </code>
          <Button size="icon" variant="ghost" onClick={copyAddress} className="h-8 w-8 shrink-0" data-testid="button-copy-address">
            {copied ? <Check className="h-3.5 w-3.5 text-chart-4" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          {onBuy && (
            <>
              {/* Jupiter Al */}
              <Button
                size="sm"
                variant="default"
                disabled={!canBuy}
                onClick={() => onBuy(token.mintAddress, token.name, token.symbol, "jupiter")}
                className="flex-1 min-w-[70px]"
                data-testid="button-buy-jupiter"
                title={!traderReady ? "Trader cüzdanı tanımlı değil" : hasOpenPosition ? "Portföyde" : "Jupiter ile al"}
              >
                <Zap className="h-3.5 w-3.5 mr-1.5" />
                {hasOpenPosition ? "Portföyde" : "Jup Al"}
              </Button>
              {/* PumpSwap Al */}
              <Button
                size="sm"
                variant="outline"
                disabled={!canBuy}
                onClick={() => onBuy(token.mintAddress, token.name, token.symbol, "pumpswap")}
                className="flex-1 min-w-[70px] border-orange-500/50 text-orange-400 hover:bg-orange-500/10"
                data-testid="button-buy-pumpswap"
                title={!traderReady ? "Trader cüzdanı tanımlı değil" : hasOpenPosition ? "Portföyde" : "PumpSwap ile al"}
              >
                {hasOpenPosition ? "Portföyde" : "Pump Al"}
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" asChild className="flex-1 min-w-[70px]" data-testid="button-dexscreener">
            <a href={dexscreenerUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />Dex
            </a>
          </Button>
        </div>
      </div>
    </Card>
  );
}
