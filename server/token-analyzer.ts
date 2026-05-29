/**
 * Token Analyzer
 *
 * Kapatılmış pozisyonları analiz ederek aynı isimde token'leri gruplar
 * ve tavsiye oranına göre sıralar.
 * Son 12 saatteki token'leri analiz ederek rug pull riski hesaplar.
 */

import type { TradeStore } from "./trade-store";
import type { Position } from "@shared/schema";

export interface TokenStats {
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

export interface TokenAnalysis {
  mintAddress: string;
  symbol: string;
  name: string;
  detectedAt: number;
  rugPullDetected: boolean;
  rugPullTime?: number;
  rugPullRiskScore: number;
  survivedMinutes: number;
  trades: {
    total: number;
    bought: number;
    sold: number;
    failed: number;
    winRate: number;
    avgPnL: number;
  };
  recommendation: "BUY" | "CAUTION" | "AVOID";
  recommendationScore: number;
}

export class TokenAnalyzer {
  private tradeStore: TradeStore;

  constructor(tradeStore: TradeStore) {
    this.tradeStore = tradeStore;
  }

  /**
   * Tüm pozisyonları analiz ederek TokenStats listesi döndürür
   */
  analyzeAll(): TokenStats[] {
    const positions = this.tradeStore.getAll();
    const byMint = new Map<string, Position[]>();

    for (const pos of positions) {
      if (!byMint.has(pos.mintAddress)) {
        byMint.set(pos.mintAddress, []);
      }
      byMint.get(pos.mintAddress)!.push(pos);
    }

    const result: TokenStats[] = [];

    for (const [mintAddress, posList] of byMint.entries()) {
      const first = posList[0];
      const symbol = first.symbol;

      const bought = posList.filter(
        (p) => p.status === "open" || p.status === "closed" || p.status === "pending_sell"
      ).length;
      const sold = posList.filter((p) => p.status === "closed").length;
      const failed = posList.filter((p) => p.status === "failed").length;

      const closedWithPnl = posList.filter(
        (p) => p.status === "closed" && typeof p.pnlPct === "number"
      );
      const avgPnL =
        closedWithPnl.length > 0
          ? closedWithPnl.reduce((sum, p) => sum + (p.pnlPct ?? 0), 0) /
            closedWithPnl.length
          : 0;

      const wins = closedWithPnl.filter((p) => (p.pnlPct ?? 0) > 0).length;
      const winRate =
        closedWithPnl.length > 0
          ? Math.round((wins / closedWithPnl.length) * 100)
          : 0;

      // Rug pull tespiti: pnlPct === -100 veya error içinde "Rug" geçiyor
      const rugPullPos = posList.find(
        (p) =>
          p.pnlPct === -100 ||
          (p.error && p.error.toLowerCase().includes("rug"))
      );
      const rugPullDetected = !!rugPullPos;
      const rugPullTime = rugPullPos?.sellTimestamp;

      // Hayatta kalma süresi (dakika): ilk alımdan son satışa kadar
      const buyTs = Math.min(...posList.map((p) => p.buyTimestamp ?? Date.now()));
      const sellTs = Math.max(
        ...posList
          .filter((p) => p.sellTimestamp)
          .map((p) => p.sellTimestamp!)
      );
      const survivedMinutes =
        sellTs > buyTs
          ? Math.round((sellTs - buyTs) / 60000)
          : Math.round((Date.now() - buyTs) / 60000);

      // Risk skoru hesapla (0-100)
      let riskScore = 50;

      if (rugPullDetected) riskScore += 40;
      if (avgPnL < -20) riskScore += 20;
      else if (avgPnL > 20) riskScore -= 20;
      if (winRate < 30) riskScore += 15;
      else if (winRate > 60) riskScore -= 15;
      if (survivedMinutes < 10) riskScore += 10;
      else if (survivedMinutes > 60) riskScore -= 10;
      if (failed > bought * 0.5) riskScore += 10;

      riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));

      // Tavsiye
      let recommendation: "BUY" | "AVOID" | "CAUTION";
      if (riskScore < 35) {
        recommendation = "BUY";
      } else if (riskScore >= 65) {
        recommendation = "AVOID";
      } else {
        recommendation = "CAUTION";
      }

      result.push({
        symbol,
        mintAddress,
        detectedAt: buyTs,
        rugPullDetected,
        rugPullTime,
        survivedMinutes,
        trades: {
          bought,
          sold,
          failed,
          avgPnL: Math.round(avgPnL * 10) / 10,
          winRate,
        },
        riskScore,
        recommendation,
      });
    }

    return result;
  }

  /**
   * Aynı isimde token'leri grupla
   */
  getTokensBySymbol(): Map<string, TokenStats[]> {
    const allTokens = this.analyzeAll();
    const grouped = new Map<string, TokenStats[]>();

    for (const token of allTokens) {
      const symbol = token.symbol;
      if (!grouped.has(symbol)) {
        grouped.set(symbol, []);
      }
      grouped.get(symbol)!.push(token);
    }

    // Her grup içinde tavsiye oranına göre sırala
    for (const [, tokens] of grouped.entries()) {
      tokens.sort((a, b) => {
        // BUY → CAUTION → AVOID sırası
        const recommendationOrder: Record<string, number> = {
          BUY: 0,
          CAUTION: 1,
          AVOID: 2,
        };
        const orderA = recommendationOrder[a.recommendation];
        const orderB = recommendationOrder[b.recommendation];

        if (orderA !== orderB) return orderA - orderB;

        // Aynı tavsiye ise risk score'a göre sırala (düşük risk önce)
        return a.riskScore - b.riskScore;
      });
    }

    return grouped;
  }

  /**
   * Birden fazla token'e sahip symbol'leri getir
   */
  getSymbolsWithMultipleTokens(): Map<string, TokenStats[]> {
    const grouped = this.getTokensBySymbol();
    const result = new Map<string, TokenStats[]>();

    for (const [symbol, tokens] of grouped.entries()) {
      if (tokens.length > 1) {
        result.set(symbol, tokens);
      }
    }

    return result;
  }

  // ─── Son 12 Saat Analizi ────────────────────────────────────────────────────

  /**
   * Son 12 saatteki tüm token'leri analiz eder, rug pull riski hesaplar
   * ve tavsiye oranına göre sıralar.
   */
  analyzeLast12Hours(): TokenAnalysis[] {
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    const positions = this.tradeStore.getAll();

    console.log(`📊 Token Analyzer: ${positions.length} toplam position, cutoff: ${new Date(cutoff).toISOString()}`);

    const grouped = new Map<string, Position[]>();
    for (const pos of positions) {
      if ((pos.buyTimestamp ?? 0) < cutoff) {
        continue;
      }
      const key = pos.mintAddress;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(pos);
    }

    console.log(`📊 Token Analyzer: ${grouped.size} token analiz ediliyor`);

    const result: TokenAnalysis[] = [];

    for (const [mintAddress, posList] of grouped.entries()) {
      const first = posList[0];
      const symbol = first.symbol || "?";
      const name = first.name || "Bilinmiyor";
      const detectedAt = first.buyTimestamp ?? Date.now();

      const rugPullPos = posList.find(
        (p) =>
          p.pnlPct === -100 ||
          (p.error && p.error.toLowerCase().includes("rug"))
      );
      const rugPullDetected = !!rugPullPos;
      const rugPullTime = rugPullPos?.sellTimestamp;

      const latestTimestamp = posList.reduce((max, p) => {
        const t = p.sellTimestamp ?? p.buyTimestamp ?? 0;
        return t > max ? t : max;
      }, detectedAt);
      const survivedMinutes = Math.round(
        (latestTimestamp - detectedAt) / 60_000
      );

      const bought = posList.filter((p) => p.status !== "failed").length;
      const sold = posList.filter((p) => p.status === "closed").length;
      const failed = posList.filter((p) => p.status === "failed").length;

      const closedWithPnl = posList.filter(
        (p) => p.status === "closed" && typeof p.pnlPct === "number"
      );
      const wins = closedWithPnl.filter((p) => (p.pnlPct ?? 0) > 0).length;
      const winRate =
        closedWithPnl.length > 0
          ? Math.round((wins / closedWithPnl.length) * 100)
          : 0;
      const avgPnL =
        closedWithPnl.length > 0
          ? Math.round(
              closedWithPnl.reduce((sum, p) => sum + (p.pnlPct ?? 0), 0) /
                closedWithPnl.length
            )
          : 0;

      let rugPullRiskScore = 0;
      if (rugPullDetected) {
        rugPullRiskScore = 100;
      } else if (survivedMinutes < 5) {
        rugPullRiskScore = 80;
      } else if (survivedMinutes < 15) {
        rugPullRiskScore = 60;
      } else if (survivedMinutes < 60) {
        rugPullRiskScore = 40;
      } else if (survivedMinutes >= 240) {
        rugPullRiskScore = 10;
      } else {
        rugPullRiskScore = 20;
      }

      let recommendationScore = 100 - rugPullRiskScore;
      if (winRate >= 70) recommendationScore += 10;
      else if (winRate < 30) recommendationScore -= 10;
      if (avgPnL >= 30) recommendationScore += 10;
      else if (avgPnL < -20) recommendationScore -= 10;
      recommendationScore = Math.max(0, Math.min(100, recommendationScore));

      let recommendation: "BUY" | "CAUTION" | "AVOID";
      if (recommendationScore >= 70) {
        recommendation = "BUY";
      } else if (recommendationScore >= 40) {
        recommendation = "CAUTION";
      } else {
        recommendation = "AVOID";
      }

      result.push({
        mintAddress,
        symbol,
        name,
        detectedAt,
        rugPullDetected,
        rugPullTime,
        rugPullRiskScore,
        survivedMinutes,
        trades: { total: posList.length, bought, sold, failed, winRate, avgPnL },
        recommendation,
        recommendationScore,
      });
    }

    console.log(`📊 Token Analyzer: ${result.length} token analiz edildi`);
    return result.sort((a, b) => b.recommendationScore - a.recommendationScore);
  }

  /**
   * Aynı/benzer sembol adına sahip token'leri gruplar ve istatistik döndürür.
   */
  getSimilarSymbolGroups(): any[] {
    const allTokens = this.analyzeLast12Hours();
    const grouped = new Map<string, TokenAnalysis[]>();

    for (const token of allTokens) {
      if (!grouped.has(token.symbol)) {
        grouped.set(token.symbol, []);
      }
      grouped.get(token.symbol)!.push(token);
    }

    // Sayısal suffix'i kaldırarak base sembol oluştur
    const similarGroups = new Map<string, Map<string, TokenAnalysis[]>>();
    for (const [symbol, tokens] of grouped.entries()) {
      const baseSymbol = symbol.replace(/\d+$/, "");
      if (!similarGroups.has(baseSymbol)) {
        similarGroups.set(baseSymbol, new Map());
      }
      similarGroups.get(baseSymbol)!.set(symbol, tokens);
    }

    const result = Array.from(similarGroups.entries())
      .map(([baseSymbol, variants]) => {
        const variantArray = Array.from(variants.entries()).map(
          ([symbol, tokens]) => {
            const rugPullCount = tokens.filter((t) => t.rugPullDetected).length;
            const avgRugPullRisk = Math.round(
              tokens.reduce((sum, t) => sum + t.rugPullRiskScore, 0) /
                tokens.length
            );
            const avgSurvivedMinutes = Math.round(
              tokens.reduce((sum, t) => sum + t.survivedMinutes, 0) /
                tokens.length
            );
            return {
              symbol,
              count: tokens.length,
              tokens,
              bestToken: tokens[0] ?? null,
              stats: {
                avgRugPullRisk,
                avgSurvivedMinutes,
                rugPullCount,
                totalCount: tokens.length,
              },
            };
          }
        );

        variantArray.sort((a, b) => {
          const aScore = a.bestToken?.recommendationScore ?? 0;
          const bScore = b.bestToken?.recommendationScore ?? 0;
          return bScore - aScore;
        });

        const allTokensInGroup = variantArray.flatMap((v) => v.tokens);
        const bestOverall = allTokensInGroup[0] ?? null;
        const rugPullCount = allTokensInGroup.filter(
          (t) => t.rugPullDetected
        ).length;
        const avgRugPullRisk = Math.round(
          allTokensInGroup.reduce((sum, t) => sum + t.rugPullRiskScore, 0) /
            allTokensInGroup.length
        );
        const avgSurvivedMinutes = Math.round(
          allTokensInGroup.reduce((sum, t) => sum + t.survivedMinutes, 0) /
            allTokensInGroup.length
        );
        const rugPullPercentage = Math.round(
          (rugPullCount / allTokensInGroup.length) * 100
        );

        return {
          baseSymbol,
          variants: variantArray,
          totalCount: allTokensInGroup.length,
          bestOverall,
          groupStats: {
            avgRugPullRisk,
            avgSurvivedMinutes,
            rugPullCount,
            rugPullPercentage,
          },
        };
      })
      .filter((g) => g.variants.length > 1)
      .sort((a, b) => {
        const aScore = a.bestOverall?.recommendationScore ?? 0;
        const bScore = b.bestOverall?.recommendationScore ?? 0;
        return bScore - aScore;
      });

    return result;
  }

  /**
   * Son 12 saatteki genel istatistikleri döndürür.
   */
  getOverallStats(): any {
    const allTokens = this.analyzeLast12Hours();

    if (allTokens.length === 0) {
      return {
        totalTokens: 0,
        rugPullCount: 0,
        rugPullPercentage: 0,
        avgSurvivedMinutes: 0,
        avgRugPullRisk: 0,
        bestTokens: [],
        worstTokens: [],
      };
    }

    const rugPullCount = allTokens.filter((t) => t.rugPullDetected).length;
    const avgSurvivedMinutes = Math.round(
      allTokens.reduce((sum, t) => sum + t.survivedMinutes, 0) / allTokens.length
    );
    const avgRugPullRisk = Math.round(
      allTokens.reduce((sum, t) => sum + t.rugPullRiskScore, 0) / allTokens.length
    );
    const rugPullPercentage = Math.round(
      (rugPullCount / allTokens.length) * 100
    );

    return {
      totalTokens: allTokens.length,
      rugPullCount,
      rugPullPercentage,
      avgSurvivedMinutes,
      avgRugPullRisk,
      bestTokens: allTokens.slice(0, 5),
      worstTokens: allTokens.slice(-5).reverse(),
    };
  }
}
