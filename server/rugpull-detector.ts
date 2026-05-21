import type { Position } from "@shared/schema";

const WSOL = "So11111111111111111111111111111111111111112";

interface RemoveLiquidityData {
  tokenMint: string | null;
  lpMint: string | null;
  lpTokenAmountIn?: number; // 🚨 ANA RUGPULL SİNYALİ
  solAmountOut?: number;
}

interface RugpullDetection {
  tokenMint: string;
  lpMint: string | null;
  name: string;
  symbol: string;
  lpTokenAmountIn: number;
  solAmountOut?: number;
  rugpullConfidence: "HIGH" | "MEDIUM" | "LOW";
  txSignature: string;
}

/**
 * Rugpull Detector — RemoveLiquidity işlemlerini analiz eder
 * 
 * 🚨 ANA SINYAL: lpTokenAmountIn > 0
 * 
 * Bu değer görüldüğü anda likidite çekme işlemi başlamış demektir.
 * Derhal acil satış (emergency sell) tetiklenir.
 */
export class RugpullDetector {
  private processedSignatures: Set<string> = new Set();

  async analyzeRemoveLiquidity(
    signature: string,
    meta: any,
    tokenMint: string,
    lpMint: string | null,
    metadata: { name: string; symbol: string }
  ): Promise<RugpullDetection | null> {
    if (this.processedSignatures.has(signature)) return null;
    this.processedSignatures.add(signature);

    // Memory optimization
    if (this.processedSignatures.size > 1000) {
      const first = this.processedSignatures.values().next().value;
      if (first) this.processedSignatures.delete(first);
    }

    try {
      const { lpTokenAmountIn, solAmountOut } = this.extractRemoveLiquidityData(meta, lpMint);

      // 🚨 SINYAL: lpTokenAmountIn > 0 = Likidite çekme başladı
      if (!lpTokenAmountIn || lpTokenAmountIn <= 0) {
        return null; // Rugpull değil
      }

      const rugpullConfidence = this.assessConfidence(lpTokenAmountIn, solAmountOut);

      console.error(
        `🚨 [RUGPULL] ${metadata.symbol} | LPTokenIn: ${lpTokenAmountIn.toFixed(4)} | ` +
        `SOL Out: ${solAmountOut?.toFixed(4) ?? "?"} | Confidence: ${rugpullConfidence}`
      );

      return {
        tokenMint,
        lpMint,
        name: metadata.name,
        symbol: metadata.symbol,
        lpTokenAmountIn,
        solAmountOut,
        rugpullConfidence,
        txSignature: signature,
      };
    } catch (err) {
      console.error("❌ RugpullDetector hata:", err);
      return null;
    }
  }

  private extractRemoveLiquidityData(
    meta: any,
    lpMint: string | null
  ): { lpTokenAmountIn?: number; solAmountOut?: number } {
    try {
      const post: any[] = meta.postTokenBalances || [];
      const pre: any[] = meta.preTokenBalances || [];

      // LP Token girişi (lpTokenAmountIn) — rugpull sinyali
      let lpTokenAmountIn: number | undefined;
      if (lpMint) {
        for (const p of post) {
          if (p.mint === lpMint) {
            const prevEntry = pre.find((x: any) => x.accountIndex === p.accountIndex);
            const preAmt = BigInt(prevEntry?.uiTokenAmount?.amount || "0");
            const postAmt = BigInt(p.uiTokenAmount?.amount || "0");
            const net = postAmt - preAmt;
            if (net < BigInt(0)) {
              // Negatif = çıkış (removal)
              lpTokenAmountIn = Math.abs(Number(net)) / Math.pow(10, p.uiTokenAmount?.decimals || 6);
              break;
            }
          }
        }
      }

      // SOL miktarı (likidite)
      let solAmountOut: number | undefined;
      let totalWsolOut = BigInt(0);
      for (const wp of post.filter((p: any) => p.mint === WSOL)) {
        const prevEntry = pre.find((x: any) => x.accountIndex === wp.accountIndex);
        const preAmt = BigInt(prevEntry?.uiTokenAmount?.amount || "0");
        const postAmt = BigInt(wp.uiTokenAmount?.amount || "0");
        const net = postAmt - preAmt;
        if (net > BigInt(0)) totalWsolOut += net;
      }
      if (totalWsolOut > BigInt(0)) solAmountOut = Number(totalWsolOut) / 1e9;

      return { lpTokenAmountIn, solAmountOut };
    } catch (err) {
      console.error("❌ extractRemoveLiquidityData hatası:", err);
      return {};
    }
  }

  private assessConfidence(lpTokenAmountIn: number, solAmountOut?: number): "HIGH" | "MEDIUM" | "LOW" {
    // Yüksek LP token çekişi + gelen SOL = Güçlü rugpull
    if (lpTokenAmountIn > 10 && (solAmountOut ?? 0) > 5) {
      return "HIGH";
    }
    if (lpTokenAmountIn > 1) {
      return "MEDIUM";
    }
    return "LOW";
  }

  clear() {
    this.processedSignatures.clear();
  }
}
