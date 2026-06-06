/**
 * Rugpull Detector
 *
 * 2 kritere göre rug pull tespiti yapar:
 *
 * 1. Likidite Kontrolü — DexScreener'dan USD likidite < $2000 ise rug pull
 * 2. Satış Başarısızlığı — 3 kez ardışık satış başarısızlığı ise rug pull
 *
 * Eski RemoveLiquidity log analizi de korunmuştur (geriye dönük uyumluluk).
 */

import type { Position } from "@shared/schema";

// DexScreener API endpoint (Solana token çifti sorgulama)
const DEXSCREENER_API = "https://api.dexscreener.com/tokens/v1/solana";
// Pool SOL eşiği — bu değerin altındaysa rug pull
const POOL_SOL_THRESHOLD = 2;
// Likidite USD eşiği — bu değerin altındaysa rug pull
const LIQUIDITY_USD_THRESHOLD = 2000;

export interface RugpullAlert {
  id: string;
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  reason: "pool_liquidity" | "liquidity_usd" | "loss_threshold" | "remove_liquidity" | "sell_failure";
  detail: string;
  detectedAt: number;
  // Eski alanlar (geriye dönük uyumluluk)
  lpTokenAmountIn?: number;
  lpTokenAmountOut?: number;
  signature?: string;
}

type OnRugpullDetected = (alert: RugpullAlert, affectedPositions: Position[]) => void;

// ─── Ana sınıf ────────────────────────────────────────────────────────────────
export class RugpullDetector {
  private onRugpullDetected: OnRugpullDetected | null = null;
  private processedSignatures: Set<string> = new Set();

  constructor(onRugpullDetected?: OnRugpullDetected) {
    this.onRugpullDetected = onRugpullDetected ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Pool Liquidity Kontrolü (Helius — SOL bazlı, geriye dönük uyumluluk)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Helius monitor'dan gelen liquidityAmount (SOL) değerini kontrol eder.
   * Pool SOL < POOL_SOL_THRESHOLD ise true döner (rug pull).
   */
  checkPoolLiquidity(poolSol: number | undefined): boolean {
    if (poolSol === undefined || poolSol === null) return false;
    return poolSol < POOL_SOL_THRESHOLD;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. DexScreener Likidite Kontrolü (USD bazlı, ana rug detection sinyali)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * DexScreener API'den token'ın USD likiditesini çeker.
   * pairs[0].liquidity.usd < $2000 ise RugpullAlert döner, aksi halde null.
   *
   * @param mint  Token mint adresi (Solana)
   */
  async checkLiquidityRugpull(mint: string): Promise<RugpullAlert | null> {
    const url = `${DEXSCREENER_API}/${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`DexScreener API ${res.status}`);
    const json = await res.json();

    const liquidityUsd: number | undefined = json?.pairs?.[0]?.liquidity?.usd;

    // Veri yoksa rug pull sayma — token henüz listelenmemiş olabilir
    if (liquidityUsd === undefined || liquidityUsd === null) return null;

    if (liquidityUsd < LIQUIDITY_USD_THRESHOLD) {
      const alert: RugpullAlert = {
        id: `rugpull-${mint}-${Date.now()}`,
        tokenMint: mint,
        tokenName: mint,
        tokenSymbol: mint,
        reason: "liquidity_usd",
        detail: `Rug Pull: Liquidity < $2000 (mevcut: ${liquidityUsd.toFixed(2)})`,
        detectedAt: Date.now(),
      };
      console.error(`🚨 [Rug Pull] Likidite < $2000 — ${liquidityUsd.toFixed(2)} USD (mint: ${mint.slice(0, 16)}...)`);
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
