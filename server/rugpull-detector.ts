/**
 * Rugpull Detector
 * 
 * RemoveLiquidity işlemlerini izler ve lpTokenAmountIn > 0 tespit edildiğinde
 * rugpull sinyali verir. Açık pozisyonları acil satış kuyruğuna alır.
 */

import type { Position } from "@shared/schema";

interface RugpullAlert {
  id: string;
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  lpTokenAmountIn: number;
  lpTokenAmountOut: number;
  detectedAt: number;
  signature: string;
}

type OnRugpullDetected = (alert: RugpullAlert, affectedPositions: Position[]) => void;

export class RugpullDetector {
  private onRugpullDetected: OnRugpullDetected | null = null;
  private processedSignatures: Set<string> = new Set();

  constructor(onRugpullDetected?: OnRugpullDetected) {
    this.onRugpullDetected = onRugpullDetected ?? null;
  }

  /**
   * RemoveLiquidity transaction loglarını analiz et
   * lpTokenAmountIn > 0 bulunursa rugpull olarak işaretle
   */
  async analyzeRemoveLiquidityTx(
    signature: string,
    logs: string[],
    tokenMint: string,
    tokenName: string,
    tokenSymbol: string
  ): Promise<RugpullAlert | null> {
    // Duplikasyon önle
    if (this.processedSignatures.has(signature)) {
      return null;
    }
    this.processedSignatures.add(signature);

    // Sayı sınırlaması
    if (this.processedSignatures.size > 1000) {
      const first = this.processedSignatures.values().next().value;
      if (first) this.processedSignatures.delete(first);
    }

    // RemoveLiquidity loglarından lpTokenAmountIn ve lpTokenAmountOut'u çıkar
    const lpTokenAmountIn = this.extractLpTokenAmount(logs, "lpTokenAmountIn");
    const lpTokenAmountOut = this.extractLpTokenAmount(logs, "lpTokenAmountOut");

    // lpTokenAmountIn > 0 → Likidite çekme işlemi başladı
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

  /**
   * Log arrayından lpTokenAmountIn veya lpTokenAmountOut değerini çıkar
   * 
   * Log formatı örneği:
   * "Program log: ... lpTokenAmountIn: 1234567890 ... lpTokenAmountOut: ..."
   */
  private extractLpTokenAmount(logs: string[], fieldName: "lpTokenAmountIn" | "lpTokenAmountOut"): number {
    for (const log of logs) {
      // "lpTokenAmountIn: 123456" veya "lpTokenAmountIn=123456" vb. formatları ara
      const regex = new RegExp(`${fieldName}[:\\s=]+([0-9.]+)`, "i");
      const match = log.match(regex);
      if (match && match[1]) {
        const value = parseFloat(match[1]);
        if (!Number.isNaN(value) && value > 0) {
          return value;
        }
      }
    }
    return 0;
  }

  /**
   * Rugpull tespit edildiğinde callback'i çağır
   */
  setOnRugpullDetected(callback: OnRugpullDetected) {
    this.onRugpullDetected = callback;
  }

  /**
   * Callback'i tetikle
   */
  async triggerRugpullAlert(alert: RugpullAlert, affectedPositions: Position[]) {
    if (!this.onRugpullDetected) return;
    try {
      this.onRugpullDetected(alert, affectedPositions);
    } catch (err) {
      console.error("❌ [Rugpull] Callback hatası:", err);
    }
  }

  /**
   * Eski signature'ları temizle (memory optimization)
   */
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

export type { RugpullAlert };
