import { EventStore } from "./event-store";
import { TradeStore } from "./trade-store";

interface TokenStats {
  symbol: string;
  mintAddress: string;
  detectedAt: number;
  rugPullDetected: boolean;
  rugPullTime?: number; // Kaç dakikada rug oldu
  survivedMinutes: number; // Kaç dakika durdu
  trades: {
    bought: number;
    sold: number;
    failed: number;
    avgPnL: number;
    winRate: number;
  };
  riskScore: number; // 0-100
  recommendation: "BUY" | "AVOID" | "CAUTION";
}

interface AnalysisSummary {
  totalTokens: number;
  rugPullCount: number;
  rugPullPercentage: number;
  avgSurvivalMinutes: number;
  avgRugSpeedMinutes: number;
  longestSurvivalToken: TokenStats | null;
  shortestRugToken: TokenStats | null;
  mostRugTokens: TokenStats[];
  safestTokens: TokenStats[];
  categories: {
    safe: TokenStats[];
    medium: TokenStats[];
    risky: TokenStats[];
    veryRisky: TokenStats[];
  };
}

export class TokenAnalyzer {
  private eventStore: EventStore;
  private tradeStore: TradeStore;

  constructor(eventStore: EventStore, tradeStore: TradeStore) {
    this.eventStore = eventStore;
    this.tradeStore = tradeStore;
  }

  /**
   * Son 12 saatte çıkan token'leri analiz et
   */
  analyzeLast12Hours(): TokenStats[] {
    const now = Date.now();
    const twelveHoursAgo = now - 12 * 60 * 60 * 1000;

    const allEvents = this.eventStore.getAfter(0, 10000);
    const lpEvents = allEvents.filter(
      (e) => e.type === "lp_detected" && e.timestamp >= twelveHoursAgo
    );

    const tokenMap = new Map<string, any>();
    for (const event of lpEvents) {
      const { symbol, mintAddress, detectedAt } = event.data;
      const key = mintAddress || symbol;
      if (!tokenMap.has(key)) {
        tokenMap.set(key, {
          symbol,
          mintAddress,
          detectedAt,
          lastSeen: detectedAt,
          count: 0,
        });
      }
      const token = tokenMap.get(key)!;
      token.count++;
      token.lastSeen = Math.max(token.lastSeen, detectedAt);
    }

    const stats: TokenStats[] = [];
    for (const token of tokenMap.values()) {
      const analysis = this.analyzeToken(token);
      stats.push(analysis);
    }

    return stats.sort((a, b) => a.riskScore - b.riskScore);
  }

  /**
   * Detaylı analiz özeti
   */
  getAnalysisSummary(): AnalysisSummary {
    const allTokens = this.analyzeLast12Hours();

    const rugPullTokens = allTokens.filter((t) => t.rugPullDetected);
    const rugPullPercentage =
      allTokens.length > 0
        ? (rugPullTokens.length / allTokens.length) * 100
        : 0;

    const avgSurvivalMinutes =
      allTokens.length > 0
        ? allTokens.reduce((sum, t) => sum + t.survivedMinutes, 0) /
          allTokens.length
        : 0;

    const rugSpeedTokens = rugPullTokens.filter(
      (t) => t.rugPullTime !== undefined
    );
    const avgRugSpeedMinutes =
      rugSpeedTokens.length > 0
        ? rugSpeedTokens.reduce((sum, t) => sum + (t.rugPullTime || 0), 0) /
          rugSpeedTokens.length
        : 0;

    const longestSurvivalToken =
      allTokens.length > 0
        ? allTokens.reduce((max, t) =>
            t.survivedMinutes > max.survivedMinutes ? t : max
          )
        : null;

    const shortestRugToken =
      rugPullTokens.length > 0
        ? rugPullTokens.reduce((min, t) =>
            (t.rugPullTime || Infinity) < (min.rugPullTime || Infinity)
              ? t
              : min
          )
        : null;

    const mostRugTokens = rugPullTokens
      .sort((a, b) => (a.rugPullTime || 0) - (b.rugPullTime || 0))
      .slice(0, 5);

    const safestTokens = allTokens
      .filter((t) => t.recommendation === "BUY")
      .slice(0, 5);

    const categories = {
      safe: allTokens.filter((t) => t.riskScore < 30),
      medium: allTokens.filter((t) => t.riskScore >= 30 && t.riskScore < 60),
      risky: allTokens.filter((t) => t.riskScore >= 60 && t.riskScore < 85),
      veryRisky: allTokens.filter((t) => t.riskScore >= 85),
    };

    return {
      totalTokens: allTokens.length,
      rugPullCount: rugPullTokens.length,
      rugPullPercentage: Math.round(rugPullPercentage * 100) / 100,
      avgSurvivalMinutes: Math.round(avgSurvivalMinutes * 100) / 100,
      avgRugSpeedMinutes: Math.round(avgRugSpeedMinutes * 100) / 100,
      longestSurvivalToken,
      shortestRugToken,
      mostRugTokens,
      safestTokens,
      categories,
    };
  }

  private analyzeToken(token: any): TokenStats {
    const now = Date.now();
    const detectedAt = token.detectedAt;
    const survivedMinutes = Math.floor((now - detectedAt) / 60000);

    const allPositions = this.tradeStore.getAll();
    const tokenTrades = allPositions.filter(
      (p) => p.mintAddress === token.mintAddress || p.symbol === token.symbol
    );

    let rugPullDetected = false;
    let rugPullTime: number | undefined;

    for (const trade of tokenTrades) {
      if (
        trade.error?.includes("Rug Pull") ||
        trade.error?.includes("Likidite") ||
        trade.pnlPct === -100
      ) {
        rugPullDetected = true;
        if (trade.buyTimestamp && trade.sellTimestamp) {
          rugPullTime = Math.floor(
            (trade.sellTimestamp - trade.buyTimestamp) / 60000
          );
        }
      }
    }

    const bought = tokenTrades.filter(
      (p) =>
        p.status === "open" ||
        p.status === "closed" ||
        p.status === "pending_sell"
    ).length;
    const sold = tokenTrades.filter(
      (p) => p.status === "closed" && !p.error
    ).length;
    const failed = tokenTrades.filter(
      (p) => p.status === "failed" || (p.status === "closed" && !!p.error)
    ).length;

    let avgPnL = 0;
    let winCount = 0;
    if (sold > 0) {
      const pnls = tokenTrades
        .filter(
          (p) =>
            p.status === "closed" && p.pnlPct !== undefined && !p.error
        )
        .map((p) => p.pnlPct!);
      if (pnls.length > 0) {
        avgPnL = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        winCount = pnls.filter((p) => p > 0).length;
      }
    }

    const winRate = sold > 0 ? (winCount / sold) * 100 : 0;

    let riskScore = 50;

    if (rugPullDetected) {
      riskScore = 90;
      if (rugPullTime !== undefined && rugPullTime < 5) riskScore = 100;
      if (rugPullTime !== undefined && rugPullTime < 2) riskScore = 100;
    } else if (survivedMinutes > 120) {
      riskScore = 15; // 2 saat+ → çok güvenli
    } else if (survivedMinutes > 60) {
      riskScore = 25; // 1 saat+ → güvenli
    } else if (survivedMinutes > 30) {
      riskScore = 40; // 30+ dakika → nispeten güvenli
    }

    if (winRate > 80) riskScore -= 20;
    if (winRate > 60) riskScore -= 10;
    if (avgPnL > 100) riskScore -= 15;
    if (avgPnL > 50) riskScore -= 10;
    if (bought > 0 && failed > bought * 0.5) riskScore += 25;

    riskScore = Math.max(0, Math.min(100, riskScore));

    let recommendation: "BUY" | "AVOID" | "CAUTION" = "CAUTION";
    if (riskScore < 30) recommendation = "BUY";
    else if (riskScore > 70) recommendation = "AVOID";

    return {
      symbol: token.symbol,
      mintAddress: token.mintAddress,
      detectedAt,
      rugPullDetected,
      rugPullTime,
      survivedMinutes,
      trades: {
        bought,
        sold,
        failed,
        avgPnL: Math.round(avgPnL * 100) / 100,
        winRate: Math.round(winRate * 100) / 100,
      },
      riskScore: Math.round(riskScore),
      recommendation,
    };
  }

  getTopRecommendations(limit = 5): TokenStats[] {
    const all = this.analyzeLast12Hours();
    return all.filter((t) => t.recommendation === "BUY").slice(0, limit);
  }

  getTokensToAvoid(limit = 5): TokenStats[] {
    const all = this.analyzeLast12Hours();
    return all.filter((t) => t.recommendation === "AVOID").slice(0, limit);
  }
}
