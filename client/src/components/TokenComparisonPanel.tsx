import { useState } from "react";
import { ChevronDown, ChevronUp, TrendingUp, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface TokenStats {
  symbol: string;
  mintAddress: string;
  detectedAt: number;
  rugPullDetected: boolean;
  rugPullTime?: number;
  survivedMinutes: number;
  trades: {
    bought: number;
    sold: number;
    failed: number;
    avgPnL: number;
    winRate: number;
  };
  riskScore: number;
  recommendation: "BUY" | "AVOID" | "CAUTION";
}

interface TokenComparisonItem {
  symbol: string;
  tokens: TokenStats[];
  count: number;
  bestRecommendation: string;
  bestRiskScore: number;
}

interface TokenComparisonPanelProps {
  data?: TokenComparisonItem[];
  onRefresh?: () => void;
}

function RecommendationBadge({ recommendation }: { recommendation: string }) {
  if (recommendation === "BUY") {
    return (
      <Badge className="bg-green-500/15 text-green-400 border-green-500/30 gap-1">
        <TrendingUp className="h-3 w-3" />
        Tavsiye
      </Badge>
    );
  }
  if (recommendation === "AVOID") {
    return (
      <Badge className="bg-red-500/15 text-red-400 border-red-500/30 gap-1">
        <AlertTriangle className="h-3 w-3" />
        Kaçın
      </Badge>
    );
  }
  return (
    <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30">
      Dikkatli
    </Badge>
  );
}

function RiskScoreBadge({ score }: { score: number }) {
  let className = "text-xs border ";
  if (score < 30) {
    className += "bg-green-500/15 text-green-400 border-green-500/30";
  } else if (score < 60) {
    className += "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
  } else if (score < 85) {
    className += "bg-orange-500/15 text-orange-400 border-orange-500/30";
  } else {
    className += "bg-red-500/15 text-red-400 border-red-500/30";
  }
  return <Badge className={className}>{score}/100</Badge>;
}

export function TokenComparisonPanel({
  data = [],
  onRefresh,
}: TokenComparisonPanelProps) {
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(
    new Set()
  );

  const toggleExpand = (symbol: string) => {
    const newExpanded = new Set(expandedSymbols);
    if (newExpanded.has(symbol)) {
      newExpanded.delete(symbol);
    } else {
      newExpanded.add(symbol);
    }
    setExpandedSymbols(newExpanded);
  };

  if (data.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p className="text-sm">Aynı isimde token bulunamadı.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">
          Token Karşılaştırması
        </h2>
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            className="text-xs"
          >
            Yenile
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {data.map((item) => {
          const isExpanded = expandedSymbols.has(item.symbol);

          return (
            <div key={item.symbol}>
              {/* Başlık */}
              <Button
                variant="outline"
                className="w-full justify-between h-auto py-3 px-4 hover:bg-muted/50"
                onClick={() => toggleExpand(item.symbol)}
              >
                <div className="flex items-center gap-3 flex-1 text-left">
                  <div>
                    <div className="font-semibold text-foreground text-base">
                      {item.symbol}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {item.count} token · En iyi: {item.bestRecommendation}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <RecommendationBadge
                    recommendation={item.bestRecommendation}
                  />
                  <RiskScoreBadge score={item.bestRiskScore} />
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </Button>

              {/* Detaylar */}
              {isExpanded && (
                <div className="mt-2 space-y-2 pl-4 border-l-2 border-muted">
                  {item.tokens.map((token, idx) => (
                    <Card
                      key={token.mintAddress}
                      className={`p-3 ${
                        idx === 0
                          ? "bg-green-950/20 border-green-500/30"
                          : token.recommendation === "AVOID"
                            ? "bg-red-950/20 border-red-500/30"
                            : "bg-yellow-950/20 border-yellow-500/30"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-mono text-muted-foreground">
                              {token.mintAddress.slice(0, 8)}...
                            </span>
                            {idx === 0 && (
                              <Badge className="text-xs bg-green-500/20 text-green-400 border-green-500/30">
                                En İyi
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground space-x-2">
                            <span>⏱ {token.survivedMinutes}dk</span>
                            {token.trades.sold > 0 && (
                              <>
                                <span>· Win {token.trades.winRate}%</span>
                                <span>
                                  · PnL{" "}
                                  {token.trades.avgPnL > 0 ? "+" : ""}
                                  {token.trades.avgPnL}%
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <RecommendationBadge
                            recommendation={token.recommendation}
                          />
                          <RiskScoreBadge score={token.riskScore} />
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
