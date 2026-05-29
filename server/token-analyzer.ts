/**
 * Token Analyzer
 *
 * Trade store'daki pozisyon geçmişini analiz ederek
 * her token için risk skoru, win rate ve PnL istatistikleri üretir.
 * Aynı sembolle birden fazla token varsa gruplar ve karşılaştırır.
 */

import type { TradeStore } from "./trade-store";
import type { TokenStats } from "@shared/schema";

export class TokenAnalyzer {
  constructor(private tradeStore: TradeStore) {}

  /**
   * Tüm pozisyonlardan token istatistikleri üret
   */
  analyzeAll(): TokenStats[] {
    const positions = this.tradeStore.getAll();
    const grouped = new Map<string, typeof positions>();

    for (const pos of positions) {
      const key = pos.mintAddress;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(pos);
    }

    const stats: TokenStats[] = [];

    for (const [mintAddress, posList] of grouped.entries()) {
      const first = posList[0];
      const symbol = first.symbol || "?";
      const name = first.name || "Bilinmiyor";
      const detectedAt = first.buyTimestamp ?? Date.now();

      // Kaç dakika hayatta kaldı (en son satış veya şu an)
      const latestTimestamp = posList.reduce((max, p) => {
        const t = p.sellTimestamp ?? p.buyTimestamp ?? 0;
        return t > max ? t : max;
      }, detectedAt);
      const survivedMinutes = Math.round((latestTimestamp - detectedAt) / 60_000);

      // Trade istatistikleri
      const sold = posList.filter((p) => p.status === "closed");
      const wins = sold.filter((p) => (p.pnlPct ?? 0) > 0);
      const winRate = sold.length > 0 ? Math.round((wins.length / sold.length) * 100) : 0;
      const avgPnL =
        sold.length > 0
          ? Math.round(
              sold.reduce((sum, p) => sum + (p.pnlPct ?? 0), 0) / sold.length
            )
          : 0;

      // Risk skoru hesapla (0-100, düşük = iyi)
      const riskScore = this.calcRiskScore({
        survivedMinutes,
        winRate,
        avgPnL,
        totalTrades: posList.length,
        soldCount: sold.length,
      });

      stats.push({
        mintAddress,
        symbol,
        name,
        riskScore,
        survivedMinutes,
        trades: {
          total: posList.length,
          sold: sold.length,
          winRate,
          avgPnL,
        },
        detectedAt,
      });
    }

    return stats;
  }

  /**
   * Son 12 saatteki pozisyonları analiz et
   */
  analyzeLast12Hours(): TokenStats[] {
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    return this.analyzeAll().filter((t) => t.detectedAt >= cutoff);
  }

  /**
   * Aynı sembolle token'leri grupla ve karşılaştır
   */
  getTokensBySymbol(symbol: string): {
    symbol: string;
    tokens: TokenStats[];
    bestToken: TokenStats | null;
    worstToken: TokenStats | null;
  } {
    const allTokens = this.analyzeLast12Hours();
    const grouped = allTokens.filter(
      (t) => t.symbol.toUpperCase() === symbol.toUpperCase()
    );

    if (grouped.length === 0) {
      return { symbol, tokens: [], bestToken: null, worstToken: null };
    }

    // Risk score'a göre sırla (düşük risk önce)
    const sorted = [...grouped].sort((a, b) => a.riskScore - b.riskScore);

    return {
      symbol,
      tokens: sorted,
      bestToken: sorted[0],
      worstToken: sorted[sorted.length - 1],
    };
  }

  /**
   * Benzer isimde token'leri grupla (DOGE, DOGE2, DOGE3 vb.)
   */
  getTokensBySymbolPrefix(prefix: string): {
    prefix: string;
    groups: Array<{
      symbol: string;
      tokens: TokenStats[];
      bestToken: TokenStats | null;
    }>;
  } {
    const allTokens = this.analyzeLast12Hours();
    const grouped = new Map<string, TokenStats[]>();

    for (const token of allTokens) {
      if (token.symbol.toUpperCase().startsWith(prefix.toUpperCase())) {
        if (!grouped.has(token.symbol)) {
          grouped.set(token.symbol, []);
        }
        grouped.get(token.symbol)!.push(token);
      }
    }

    const groups = Array.from(grouped.entries()).map(([sym, tokens]) => {
      const sorted = [...tokens].sort((a, b) => a.riskScore - b.riskScore);
      return {
        symbol: sym,
        tokens: sorted,
        bestToken: sorted[0] ?? null,
      };
    });

    return {
      prefix,
      groups: groups.sort((a, b) => {
        const aRisk = a.bestToken?.riskScore ?? 100;
        const bRisk = b.bestToken?.riskScore ?? 100;
        return aRisk - bRisk;
      }),
    };
  }

  /**
   * Tüm duplicate token'leri bul (aynı sembolde birden fazla mint)
   */
  getAllDuplicateTokens(): Array<{
    symbol: string;
    count: number;
    tokens: TokenStats[];
    bestToken: TokenStats | null;
  }> {
    const allTokens = this.analyzeLast12Hours();
    const grouped = new Map<string, TokenStats[]>();

    for (const token of allTokens) {
      if (!grouped.has(token.symbol)) {
        grouped.set(token.symbol, []);
      }
      grouped.get(token.symbol)!.push(token);
    }

    return Array.from(grouped.entries())
      .filter(([, tokens]) => tokens.length > 1)
      .map(([sym, tokens]) => {
        const sorted = [...tokens].sort((a, b) => a.riskScore - b.riskScore);
        return {
          symbol: sym,
          count: tokens.length,
          tokens: sorted,
          bestToken: sorted[0] ?? null,
        };
      })
      .sort((a, b) => {
        const aRisk = a.bestToken?.riskScore ?? 100;
        const bRisk = b.bestToken?.riskScore ?? 100;
        return aRisk - bRisk;
      });
  }

  // ─── Yardımcı ────────────────────────────────────────────────────────────────

  private calcRiskScore(params: {
    survivedMinutes: number;
    winRate: number;
    avgPnL: number;
    totalTrades: number;
    soldCount: number;
  }): number {
    const { survivedMinutes, winRate, avgPnL, soldCount } = params;

    // Temel risk: 50
    let score = 50;

    // Uzun süre hayatta kaldıysa risk düşer
    if (survivedMinutes >= 240) score -= 20;
    else if (survivedMinutes >= 60) score -= 10;
    else if (survivedMinutes < 10) score += 20;

    // Win rate iyiyse risk düşer
    if (soldCount > 0) {
      if (winRate >= 70) score -= 15;
      else if (winRate >= 50) score -= 5;
      else if (winRate < 30) score += 15;
    }

    // Ortalama PnL iyiyse risk düşer
    if (soldCount > 0) {
      if (avgPnL >= 30) score -= 10;
      else if (avgPnL < -20) score += 10;
    }

    // Hiç satış yoksa belirsizlik — hafif risk artışı
    if (soldCount === 0) score += 5;

    return Math.max(0, Math.min(100, score));
  }
}
