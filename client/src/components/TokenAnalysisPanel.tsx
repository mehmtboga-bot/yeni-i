import { AlertTriangle, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { TokenStats } from "@shared/schema";

interface TokenAnalysisPanelProps {
  topRecommendations?: TokenStats[];
  tokensToAvoid?: TokenStats[];
  allAnalysis?: TokenStats[];
  onRefresh?: () => void;
}

function RiskBadge({ score }: { score: number }) {
  if (score < 30) {
    return (
      <Badge className="bg-green-500/20 text-green-400 border-green-500/50 shrink-0">
        Risk: {score}/100
      </Badge>
    );
  }
  if (score > 70) {
    return (
      <Badge className="bg-red-500/20 text-red-400 border-red-500/50 shrink-0">
        Risk: {score}/100
      </Badge>
    );
  }
  return (
    <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/50 shrink-0">
      Risk: {score}/100
    </Badge>
  );
}

export function TokenAnalysisPanel({
  topRecommendations = [],
  tokensToAvoid = [],
  allAnalysis = [],
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

      {/* Özet istatistikler */}
      {allAnalysis.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-3 text-center bg-green-950/20 border-green-500/20">
            <div className="text-xl font-bold text-green-400">{topRecommendations.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Tavsiye</div>
          </Card>
          <Card className="p-3 text-center bg-yellow-950/20 border-yellow-500/20">
            <div className="text-xl font-bold text-yellow-400">{cautionTokens.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Dikkatli</div>
          </Card>
          <Card className="p-3 text-center bg-red-950/20 border-red-500/20">
            <div className="text-xl font-bold text-red-400">{tokensToAvoid.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Kaçın</div>
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
                          <span>· PnL: {token.trades.avgPnL > 0 ? "+" : ""}{token.trades.avgPnL}%</span>
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

      {/* Kaçınılması Gereken Token'ler */}
      {tokensToAvoid.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <h3 className="text-sm font-semibold text-foreground">
              Kaçınılması Gereken Token'ler
            </h3>
            <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-xs">
              {tokensToAvoid.length}
            </Badge>
          </div>
          <div className="space-y-2">
            {tokensToAvoid.map((token) => (
              <Card
                key={token.mintAddress}
                className="p-3 bg-red-950/20 border-red-500/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-red-400 truncate">
                      {token.symbol}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {token.rugPullDetected ? (
                        <span className="text-red-400/80">
                          🚨 Rug Pull
                          {token.rugPullTime !== undefined
                            ? ` — ${token.rugPullTime}dk sonra`
                            : ""}
                        </span>
                      ) : (
                        <span>⏱ {token.survivedMinutes}dk durdu</span>
                      )}
                      {token.trades.failed > 0 && (
                        <span className="ml-2">· {token.trades.failed} başarısız işlem</span>
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

      {/* Dikkatli Olunması Gereken Token'ler */}
      {cautionTokens.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingDown className="h-4 w-4 text-yellow-500" />
            <h3 className="text-sm font-semibold text-foreground">
              Dikkatli Olunması Gereken Token'ler
            </h3>
            <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-xs">
              {cautionTokens.length}
            </Badge>
          </div>
          <div className="space-y-2">
            {cautionTokens.map((token) => (
              <Card
                key={token.mintAddress}
                className="p-3 bg-yellow-950/20 border-yellow-500/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-yellow-400 truncate">
                      {token.symbol}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 space-x-2">
                      <span>⏱ {token.survivedMinutes}dk durdu</span>
                      {token.trades.sold > 0 && (
                        <>
                          <span>· Win: {token.trades.winRate}%</span>
                          <span>· PnL: {token.trades.avgPnL > 0 ? "+" : ""}{token.trades.avgPnL}%</span>
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

      {/* Boş durum */}
      {allAnalysis.length === 0 && topRecommendations.length === 0 && tokensToAvoid.length === 0 && (
        <div className="text-center py-10 text-muted-foreground">
          <TrendingUp className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Son 12 saatte analiz edilecek token bulunamadı.</p>
          <p className="text-xs mt-1 opacity-60">LP tespitleri geldikçe burada görünecek.</p>
        </div>
      )}
    </div>
  );
}
