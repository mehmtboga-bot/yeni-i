import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import type { TokenStats } from "@shared/schema";

interface TokenComparisonPanelProps {
  duplicateTokens?: Array<{
    symbol: string;
    count: number;
    tokens: TokenStats[];
    bestToken: TokenStats | null;
  }>;
  onSelectToken?: (mintAddress: string, symbol: string) => void;
}

function RiskBadge({ score }: { score: number }) {
  if (score < 30) {
    return (
      <Badge className="bg-green-500/15 text-green-400 border-green-500/30">
        Risk: {score}/100
      </Badge>
    );
  }
  if (score > 70) {
    return (
      <Badge className="bg-red-500/15 text-red-400 border-red-500/30">
        Risk: {score}/100
      </Badge>
    );
  }
  return (
    <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30">
      Risk: {score}/100
    </Badge>
  );
}

export function TokenComparisonPanel({
  duplicateTokens = [],
  onSelectToken,
}: TokenComparisonPanelProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const selectedGroup = duplicateTokens.find((g) => g.symbol === selectedSymbol);

  const copyAddress = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopied(address);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">
          Token Karşılaştırması
        </h2>
        <Badge className="bg-primary/15 text-primary border-primary/30">
          {duplicateTokens.length} Grup
        </Badge>
      </div>

      {duplicateTokens.length === 0 ? (
        <Card className="p-6 text-center text-muted-foreground">
          <p className="text-sm">Aynı isimde token bulunamadı.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* Token Grupları */}
          <div className="flex flex-wrap gap-2">
            {duplicateTokens.map((group) => (
              <Button
                key={group.symbol}
                variant={selectedSymbol === group.symbol ? "default" : "outline"}
                size="sm"
                onClick={() =>
                  setSelectedSymbol(
                    selectedSymbol === group.symbol ? null : group.symbol
                  )
                }
                className="gap-1.5"
              >
                {group.symbol}
                <Badge
                  className={
                    selectedSymbol === group.symbol
                      ? "bg-primary-foreground/20"
                      : "bg-muted"
                  }
                >
                  {group.count}
                </Badge>
              </Button>
            ))}
          </div>

          {/* Seçili Grup Detayları */}
          {selectedGroup && (
            <div className="space-y-3 mt-4">
              <div className="text-sm font-semibold text-foreground">
                {selectedGroup.symbol} — {selectedGroup.count} Token
              </div>

              {/* Tavsiye Edilen (En İyi) */}
              {selectedGroup.bestToken && (
                <Card className="p-3 bg-green-950/20 border-green-500/30">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <div className="text-xs font-semibold text-green-400">
                        ✅ Tavsiye Edilen
                      </div>
                      <div className="text-sm font-bold text-green-300 mt-1 font-mono">
                        {selectedGroup.bestToken.mintAddress.slice(0, 8)}...
                        {selectedGroup.bestToken.mintAddress.slice(-4)}
                      </div>
                    </div>
                    <RiskBadge score={selectedGroup.bestToken.riskScore} />
                  </div>

                  <div className="text-xs text-muted-foreground space-y-1 mb-2">
                    <div>
                      ⏱ Durdu: {selectedGroup.bestToken.survivedMinutes}dk
                    </div>
                    {selectedGroup.bestToken.trades.sold > 0 && (
                      <>
                        <div>
                          📊 Win Rate: {selectedGroup.bestToken.trades.winRate}%
                        </div>
                        <div>
                          💰 Ort. PnL:{" "}
                          {selectedGroup.bestToken.trades.avgPnL > 0 ? "+" : ""}
                          {selectedGroup.bestToken.trades.avgPnL}%
                        </div>
                      </>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      className="flex-1 text-xs"
                      onClick={() =>
                        onSelectToken?.(
                          selectedGroup.bestToken!.mintAddress,
                          selectedGroup.symbol
                        )
                      }
                    >
                      Bunu Al
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() =>
                        copyAddress(selectedGroup.bestToken!.mintAddress)
                      }
                    >
                      {copied === selectedGroup.bestToken!.mintAddress ? (
                        <Check className="h-3.5 w-3.5 text-green-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </Card>
              )}

              {/* Diğer Token'ler */}
              {selectedGroup.tokens.length > 1 && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground">
                    Diğer Seçenekler
                  </div>
                  {selectedGroup.tokens.slice(1).map((token) => (
                    <Card
                      key={token.mintAddress}
                      className="p-2 bg-muted/50 border-border"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-mono text-muted-foreground truncate">
                            {token.mintAddress.slice(0, 8)}...
                            {token.mintAddress.slice(-4)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            ⏱ {token.survivedMinutes}dk | Win:{" "}
                            {token.trades.winRate}%
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <RiskBadge score={token.riskScore} />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => copyAddress(token.mintAddress)}
                          >
                            {copied === token.mintAddress ? (
                              <Check className="h-3 w-3 text-green-400" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
