/**
 * Rugpull Detector
 *
 * 3 kritere göre rug pull tespiti yapar:
 *
 * 1. Jupiter Quote Hataları — 5 kez üst üste quote alınamazsa rug pull
 * 2. Pool Liquidity Kontrolü — Pool SOL < 2 SOL ise rug pull
 * 3. Zararlı Pozisyon Kontrolü — %-80 veya daha kötü zarardaysa rug pull
 *
 * Eski RemoveLiquidity log analizi de korunmuştur (geriye dönük uyumluluk).
 */

import type { Position } from "@shared/schema";

const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const SOL_MINT  = "So11111111111111111111111111111111111111112";

// Pool SOL eşiği — bu değerin altındaysa rug pull
const POOL_SOL_THRESHOLD = 2;
// Jupiter quote hata eşiği — bu kadar üst üste hata gelirse rug pull
const JUPITER_QUOTE_ERROR_THRESHOLD = 5;
// Pozisyon zarar eşiği — bu kadar veya daha fazla zarardaysa rug pull
const LOSS_THRESHOLD_PCT = 80;

export interface RugpullAlert {
  id: string;
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  reason: "jupiter_quote_errors" | "pool_liquidity" | "loss_threshold" | "remove_liquidity";
  detail: string;
  detectedAt: number;
  // Eski alanlar (geriye dönük uyumluluk)
  lpTokenAmountIn?: number;
  lpTokenAmountOut?: number;
  signature?: string;
}

type OnRugpullDetected = (alert: RugpullAlert, affectedPositions: Position[]) => void;

// ─── Yardımcı: timeout'lu fetch ───────────────────────────────────────────────
function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ─── Ana sınıf ────────────────────────────────────────────────────────────────
export class RugpullDetector {
  private onRugpullDetected: OnRugpullDetected | null = null;
  private processedSignatures: Set<string> = new Set();

  constructor(onRugpullDetected?: OnRugpullDetected) {
    this.onRugpullDetected = onRugpullDetected ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Jupiter Quote Hataları
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Satış için Jupiter quote almayı dener.
   * Başarılıysa false döner (rug yok).
   * Başarısızsa true döner (bu deneme hata).
   */
  async checkJupiterQuoteError(
    mintAddress: string,
    tokenAmountRaw: string,
    slippageBps: number
  ): Promise<boolean> {
    try {
      const url = new URL(JUP_QUOTE);
      url.searchParams.set("inputMint", mintAddress);
      url.searchParams.set("outputMint", SOL_MINT);
      url.searchParams.set("amount", tokenAmountRaw);
      url.searchParams.set("slippageBps", String(Math.min(slippageBps, 9900)));
      url.searchParams.set("onlyDirectRoutes", "false");
      url.searchParams.set("asLegacyTransaction", "false");
      url.searchParams.set("restrictIntermediateTokens", "true");

      const res = await fetchWithTimeout(url.toString(), 3000);
      if (!res.ok) return true; // HTTP hata → quote yok

      const json = await res.json();
      if (!json?.outAmount || BigInt(json.outAmount) === 0n) return true; // Route yok

      return false; // Quote başarılı
    } catch {
      return true; // Timeout / ağ hatası → quote yok
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Pool Liquidity Kontrolü
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Helius monitor'dan gelen liquidityAmount (SOL) değerini kontrol eder.
   * Pool SOL < POOL_SOL_THRESHOLD ise true döner (rug pull).
   */
  checkPoolLiquidity(poolSol: number | undefined): boolean {
    if (poolSol === undefined || poolSol === null) return false; // Bilgi yoksa atla
    return poolSol < POOL_SOL_THRESHOLD;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Zararlı Pozisyon Kontrolü
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Pozisyonun mevcut unrealizedPnlPct değerine göre zarar eşiğini kontrol eder.
   * %-80 veya daha kötüyse true döner (rug pull — satış yapılmayacak).
   */
  checkLossThreshold(unrealizedPnlPct: number | undefined): boolean {
    if (unrealizedPnlPct === undefined || unrealizedPnlPct === null) return false;
    return unrealizedPnlPct <= -LOSS_THRESHOLD_PCT;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Rug Pull Tespiti — 3 kriteri birleştirir
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Tüm kriterleri kontrol eder. İlk eşleşen kriterde RugpullAlert döner.
   * Hiçbiri eşleşmezse null döner.
   *
   * @param symbol          Token sembolü (log için)
   * @param mintAddress     Token mint adresi
   * @param tokenAmountRaw  Satış için raw token miktarı (string, lamport cinsinden)
   * @param slippageBps     Slippage (Jupiter quote için)
   * @param jupiterErrorCount  Mevcut Jupiter quote hata sayacı (dışarıdan yönetilir)
   * @param poolSol         Pool SOL miktarı (Helius monitor'dan, opsiyonel)
   * @param unrealizedPnlPct  Mevcut gerçekleşmemiş PnL yüzdesi (opsiyonel)
   */
  async detectRugpull(opts: {
    symbol: string;
    mintAddress: string;
    tokenAmountRaw: string;
    slippageBps: number;
    jupiterErrorCount: number;
    poolSol?: number;
    unrealizedPnlPct?: number;
  }): Promise<RugpullAlert | null> {
    const { symbol, mintAddress, slippageBps, jupiterErrorCount, poolSol, unrealizedPnlPct } = opts;

    // Kriter 1: Jupiter quote hataları
    if (jupiterErrorCount >= JUPITER_QUOTE_ERROR_THRESHOLD) {
      const alert: RugpullAlert = {
        id: `rugpull-${mintAddress}-${Date.now()}`,
        tokenMint: mintAddress,
        tokenName: symbol,
        tokenSymbol: symbol,
        reason: "jupiter_quote_errors",
        detail: `Jupiter ${jupiterErrorCount} kez üst üste quote veremedi`,
        detectedAt: Date.now(),
      };
      console.error(`🚨 [Rug Pull] ${symbol} — Jupiter 5 kez quote veremedi, rug pull`);
      return alert;
    }

    // Kriter 2: Pool liquidity
    if (this.checkPoolLiquidity(poolSol)) {
      const alert: RugpullAlert = {
        id: `rugpull-${mintAddress}-${Date.now()}`,
        tokenMint: mintAddress,
        tokenName: symbol,
        tokenSymbol: symbol,
        reason: "pool_liquidity",
        detail: `Pool SOL < ${POOL_SOL_THRESHOLD} (${poolSol?.toFixed(4)} SOL)`,
        detectedAt: Date.now(),
      };
      console.error(`🚨 [Rug Pull] ${symbol} — Pool SOL < 2 (${poolSol?.toFixed(4)} SOL), rug pull`);
      return alert;
    }

    // Kriter 3: Zararlı pozisyon
    if (this.checkLossThreshold(unrealizedPnlPct)) {
      const loss = Math.abs(unrealizedPnlPct!);
      const alert: RugpullAlert = {
        id: `rugpull-${mintAddress}-${Date.now()}`,
        tokenMint: mintAddress,
        tokenName: symbol,
        tokenSymbol: symbol,
        reason: "loss_threshold",
        detail: `%-${loss.toFixed(1)} zararlı pozisyon`,
        detectedAt: Date.now(),
      };
      console.error(`🚨 [Rug Pull] ${symbol} — %-${loss.toFixed(1)} zararlı, satış yapılmayacak`);
      return alert;
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Eski RemoveLiquidity analizi (geriye dönük uyumluluk)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * RemoveLiquidity transaction loglarını analiz et.
   * lpTokenAmountIn > 0 bulunursa rugpull olarak işaretle.
   */
  async analyzeRemoveLiquidityTx(
    signature: string,
    logs: string[],
    tokenMint: string,
    tokenName: string,
    tokenSymbol: string
  ): Promise<RugpullAlert | null> {
    if (this.processedSignatures.has(signature)) return null;
    this.processedSignatures.add(signature);

    if (this.processedSignatures.size > 1000) {
      const first = this.processedSignatures.values().next().value;
      if (first) this.processedSignatures.delete(first);
    }

    const lpTokenAmountIn  = this.extractLpTokenAmount(logs, "lpTokenAmountIn");
    const lpTokenAmountOut = this.extractLpTokenAmount(logs, "lpTokenAmountOut");

    if (lpTokenAmountIn <= 0) {
      console.warn(
        `⚠️ [Rugpull] RemoveLiquidity tespit edildi ama lpTokenAmountIn = 0 → atlanıyor (${tokenSymbol})`
      );
      return null;
    }

    const alert: RugpullAlert = {
      id: `rugpull-${tokenMint}-${Date.now()}`,
      tokenMint,
      tokenName,
      tokenSymbol,
      reason: "remove_liquidity",
      detail: `LP Token Girişi: ${lpTokenAmountIn.toLocaleString()}`,
      lpTokenAmountIn,
      lpTokenAmountOut,
      detectedAt: Date.now(),
      signature,
    };

    console.error(
      `🚨🚨🚨 [RUGPULL] ${tokenSymbol} — Likidite çekme başladı!\n` +
      `   LP Token Girişi: ${lpTokenAmountIn.toLocaleString()}\n` +
      `   TX: ${signature.slice(0, 16)}...`
    );

    return alert;
  }

  private extractLpTokenAmount(logs: string[], fieldName: "lpTokenAmountIn" | "lpTokenAmountOut"): number {
    for (const log of logs) {
      const regex = new RegExp(`${fieldName}[:\\s=]+([0-9.]+)`, "i");
      const match = log.match(regex);
      if (match && match[1]) {
        const value = parseFloat(match[1]);
        if (!Number.isNaN(value) && value > 0) return value;
      }
    }
    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Callback yönetimi
  // ═══════════════════════════════════════════════════════════════════════════

  setOnRugpullDetected(callback: OnRugpullDetected) {
    this.onRugpullDetected = callback;
  }

  async triggerRugpullAlert(alert: RugpullAlert, affectedPositions: Position[]) {
    if (!this.onRugpullDetected) return;
    try {
      this.onRugpullDetected(alert, affectedPositions);
    } catch (err) {
      console.error("❌ [Rugpull] Callback hatası:", err);
    }
  }

  clearOldSignatures(maxSize: number = 1000) {
    if (this.processedSignatures.size > maxSize) {
      const toRemove = this.processedSignatures.size - maxSize;
      const iter = this.processedSignatures.values();
      for (let i = 0; i < toRemove; i++) {
        const sig = iter.next().value;
        if (sig) this.processedSignatures.delete(sig);
      }
    }
  }
}
