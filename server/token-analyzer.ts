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
    winRate: number; // % kaç işlem kazandı
  };
  riskScore: number; // 0-100 (0=güvenli, 100=çok riskli)
  recommendation: "BUY" | "AVOID" | "CAUTION";
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

    // Event store'dan son 12 saatteki lp_detected event'lerini al
    const allEvents = this.eventStore.getAfter(0, 10000);
    const lpEvents = allEvents.filter(
      (e) => e.type === "lp_detected" && e.timestamp >= twelveHoursAgo
    );

    // Token'leri mintAddress'e göre grupla (aynı symbol farklı mint olabilir)
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

    // Her token için analiz yap
    const stats: TokenStats[] = [];
    for (const token of tokenMap.values()) {
      const analysis = this.analyzeToken(token);
      stats.push(analysis);
    }

    // Risk score'a göre sırala (düşük risk önce)
    return stats.sort((a, b) => a.riskScore - b.riskScore);
  }

  /**
   * Tek token'i analiz et
   */
  private analyzeToken(token: any): TokenStats {
    const now = Date.now();
    const detectedAt = token.detectedAt;
    const survivedMinutes = Math.floor((now - detectedAt) / 60000);

    // Trade store'dan bu token'in işlemlerini al
    const allPositions = this.tradeStore.getAll();
    const tokenTrades = allPositions.filter(
      (p) => p.mintAddress === token.mintAddress || p.symbol === token.symbol
    );

    // Rug pull tespiti
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

    // Trade istatistikleri
    const bought = tokenTrades.filter(
      (p) => p.status === "open" || p.status === "closed" || p.status === "pending_sell"
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
        .filter((p) => p.status === "closed" && p.pnlPct !== undefined && !p.error)
        .map((p) => p.pnlPct!);
      if (pnls.length > 0) {
        avgPnL = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        winCount = pnls.filter((p) => p > 0).length;
      }
    }

    const winRate = sold > 0 ? (winCount / sold) * 100 : 0;

    // Risk score hesapla (0-100)
    let riskScore = 50; // Başlangıç: orta risk

    if (rugPullDetected) {
      riskScore = 90; // Rug pull → çok riskli
      if (rugPullTime !== undefined && rugPullTime < 5) riskScore = 100; // Çok hızlı rug
    } else if (survivedMinutes > 60) {
      riskScore = 20; // 1 saat+ durdu → güvenli
    } else if (survivedMinutes > 30) {
      riskScore = 35; // 30+ dakika durdu → nispeten güvenli
    }

    if (winRate > 70) riskScore -= 15; // Yüksek win rate → daha güvenli
    if (avgPnL > 50) riskScore -= 10; // Yüksek kar → daha güvenli
    if (bought > 0 && failed > bought * 0.5) riskScore += 20; // Çok başarısız işlem → daha riskli

    riskScore = Math.max(0, Math.min(100, riskScore)); // 0-100 arasında

    // Tavsiye
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

  /**
   * En iyi token'leri tavsiye et (top N)
   */
  getTopRecommendations(limit = 5): TokenStats[] {
    const all = this.analyzeLast12Hours();
    return all
      .filter((t) => t.recommendation === "BUY")
      .slice(0, limit);
  }

  /**
   * Kaçınılması gereken token'ler
   */
  getTokensToAvoid(limit = 5): TokenStats[] {
    const all = this.analyzeLast12Hours();
    return all
      .filter((t) => t.recommendation === "AVOID")
      .slice(0, limit);
  }
}
