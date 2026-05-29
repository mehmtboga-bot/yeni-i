import { TrendingUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

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

interface TokenAnalysisPanelProps {
  topRecommendations?: TokenStats[];
  tokensToAvoid?: TokenStats[];
  allAnalysis?: TokenStats[];
  summary?: any;
  onRefresh?: () => void;
}

function RiskBadge({ score }: { score: number }) {
  let className = "text-xs border ";
  let label = "";

  if (score < 30) {
    className += "bg-green-500/15 text-green-400 border-green-500/30";
    label = `${score}/100`;
  } else if (score < 60) {
    className += "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
    label = `${score}/100`;
  } else if (score < 85) {
    className += "bg-orange-500/15 text-orange-400 border-orange-500/30";
    label = `${score}/100`;
  } else {
    className += "bg-red-500/15 text-red-400 border-red-500/30";
    label = `${score}/100`;
  }

  return <Badge className={className}>{label}</Badge>;
}

export function TokenAnalysisPanel({
  topRecommendations = [],
  tokensToAvoid = [],
  allAnalysis = [],
  summary,
  onRefresh,
}: TokenAnalysisPanelProps) {
  const cautionTokens = allAnalysis.filter((t) => t.recommendation === "CAUTION");

  return (
    <div className="space-y-5">
      {/* Başlık + Yenile */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">
          Token Analizi — Son 12 Saat
        </h2>
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Yenile
          </Button>
        )}
      </div>

      {/* Özet İstatistikler */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Card className="p-3 bg-muted/50 border-border">
            <div className="text-xs text-muted-foreground">Toplam Token</div>
            <div className="text-lg font-bold text-foreground mt-1">
              {summary.totalTokens}
            </div>
          </Card>
          <Card className="p-3 bg-red-950/20 border-red-500/20">
            <div className="text-xs text-red-400">Rug Pull</div>
            <div className="text-lg font-bold text-red-400 mt-1">
              {summary.rugPullCount} ({summary.rugPullPercentage}%)
            </div>
          </Card>
          <Card className="p-3 bg-green-950/20 border-green-500/20">
            <div className="text-xs text-green-400">Ort. Durma Süresi</div>
            <div className="text-lg font-bold text-green-400 mt-1">
              {summary.avgSurvivalMinutes}dk
            </div>
          </Card>
          <Card className="p-3 bg-orange-950/20 border-orange-500/20">
            <div className="text-xs text-orange-400">Ort. Rug Hızı</div>
            <div className="text-lg font-bold text-orange-400 mt-1">
              {summary.avgRugSpeedMinutes}dk
            </div>
          </Card>
        </div>
      )}

      {/* En Uzun Duran Token */}
      {summary?.longestSurvivalToken && (
        <Card className="p-3 bg-green-950/20 border-green-500/30">
          <div className="text-xs text-green-400 font-semibold mb-1">
            ⏱️ En Uzun Duran Token
          </div>
          <div className="text-sm font-bold text-green-300">
            {summary.longestSurvivalToken.symbol}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {summary.longestSurvivalToken.survivedMinutes}dk durdu | Win:{" "}
            {summary.longestSurvivalToken.trades.winRate}% | PnL:{" "}
            {summary.longestSurvivalToken.trades.avgPnL}%
          </div>
        </Card>
      )}

      {/* En Hızlı Rug Olan Token */}
      {summary?.shortestRugToken && (
        <Card className="p-3 bg-red-950/20 border-red-500/30">
          <div className="text-xs text-red-400 font-semibold mb-1">
            ⚡ En Hızlı Rug Olan Token
          </div>
          <div className="text-sm font-bold text-red-300">
            {summary.shortestRugToken.symbol}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            🚨 {summary.shortestRugToken.rugPullTime}dk sonra rug oldu
          </div>
        </Card>
      )}

      {/* En Çok Rug Olan Token'ler */}
      {summary?.mostRugTokens && summary.mostRugTokens.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-red-400 mb-2">
            🚨 En Çok Rug Olan Token'ler
          </div>
          <div className="space-y-1.5">
            {summary.mostRugTokens.map((token: TokenStats) => (
              <Card
                key={token.mintAddress}
                className="p-2 bg-red-950/10 border-red-500/20"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-red-300">
                    {token.symbol}
                  </span>
                  <span className="text-xs text-red-400">
                    {token.rugPullTime}dk
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Kategoriler */}
      {summary?.categories && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Card className="p-2 bg-green-950/20 border-green-500/20 text-center">
            <div className="text-green-400 font-bold">
              {summary.categories.safe.length}
            </div>
            <div className="text-green-400/70 text-xs">Güvenli</div>
          </Card>
          <Card className="p-2 bg-yellow-950/20 border-yellow-500/20 text-center">
            <div className="text-yellow-400 font-bold">
              {summary.categories.medium.length}
            </div>
            <div className="text-yellow-400/70 text-xs">Orta</div>
          </Card>
          <Card className="p-2 bg-orange-950/20 border-orange-500/20 text-center">
            <div className="text-orange-400 font-bold">
              {summary.categories.risky.length}
            </div>
            <div className="text-orange-400/70 text-xs">Riskli</div>
          </Card>
          <Card className="p-2 bg-red-950/20 border-red-500/20 text-center">
            <div className="text-red-400 font-bold">
              {summary.categories.veryRisky.length}
            </div>
            <div className="text-red-400/70 text-xs">Çok Riskli</div>
          </Card>
        </div>
      )}

      {/* Tavsiye Edilen Token'ler */}
      {topRecommendations.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-green-500" />
            <h3 className="text-sm font-semibold text-foreground">
              Tavsiye Edilen Token'ler
            </h3>
            <Badge className="bg-green-500/15 text-green-400 border-green-500/30 text-xs">
              {topRecommendations.length}
            </Badge>
          </div>
          <div className="space-y-2">
            {topRecommendations.map((token) => (
              <Card
                key={token.mintAddress}
                className="p-3 bg-green-950/20 border-green-500/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-green-400 truncate">
                      {token.symbol}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 space-x-2">
                      <span>⏱ {token.survivedMinutes}dk durdu</span>
                      {token.trades.sold > 0 && (
                        <>
                          <span>· Win: {token.trades.winRate}%</span>
                          <span>
                            · PnL:{" "}
                            {token.trades.avgPnL > 0 ? "+" : ""}
                            {token.trades.avgPnL}%
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <RiskBadge score={token.riskScore} />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Veri yoksa boş durum */}
      {!summary && (
        <div className="text-center py-8 text-muted-foreground">
          <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Token analizi yükleniyor...</p>
        </div>
      )}
    </div>
  );
}
