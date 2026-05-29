/**
 * Token Analyzer
 *
 * Kapatılmış pozisyonları analiz ederek aynı isimde token'leri gruplar
 * ve tavsiye oranına göre sıralar.
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
}
