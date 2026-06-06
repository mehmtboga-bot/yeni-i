/**
 * LiquidityMonitor
 *
 * After a token is purchased, waits 15 seconds then polls DexScreener
 * every 5 seconds to check liquidity. If liquidity drops below $300
 * (and the response is valid), triggers the rug pull callback.
 */

const DEXSCREENER_API_BASE = "https://api.dexscreener.com/tokens/v1/solana";
const RUG_LIQUIDITY_THRESHOLD_USD = 300;
const INITIAL_DELAY_MS = 15_000;  // Wait 15s after purchase before first check
const POLL_INTERVAL_MS = 5_000;   // Check every 5s
const API_TIMEOUT_MS   = 5_000;   // Max 5s per API call

export class LiquidityMonitor {
  private positionId: string;
  private mintAddress: string;
  private symbol: string;
  private onRugDetected: (positionId: string) => void;

  private stopped = false;
  private initialTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    positionId: string,
    mintAddress: string,
    symbol: string,
    onRugDetected: (positionId: string) => void,
  ) {
    this.positionId   = positionId;
    this.mintAddress  = mintAddress;
    this.symbol       = symbol;
    this.onRugDetected = onRugDetected;

    // Start monitoring after the initial delay
    this.initialTimer = setTimeout(() => {
      if (this.stopped) return;
      this.check();
      this.pollTimer = setInterval(() => {
        if (this.stopped) {
          this.clearPoll();
          return;
        }
        this.check();
      }, POLL_INTERVAL_MS);
    }, INITIAL_DELAY_MS);

    console.log(`🔍 [LiquidityMonitor] ${this.symbol} (${this.positionId}) izleme başlatıldı — 15s sonra kontrol başlayacak`);
  }

  /** Stop monitoring (call when position is closed). */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    this.clearPoll();
    console.log(`🛑 [LiquidityMonitor] ${this.symbol} (${this.positionId}) izleme durduruldu`);
  }

  private clearPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async check() {
    if (this.stopped) return;

    try {
      const url = `${DEXSCREENER_API_BASE}/${this.mintAddress}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} API yanıtı: ${res.status} — sonraki döngüde tekrar denenecek`);
        return;
      }

      const json = await res.json();

      // Debug: log the raw response structure on the first unexpected shape
      // Resolve pairs from either a root-level array or the `pairs` property
      let pairs: any[] | null = null;
      if (Array.isArray(json)) {
        // API returned the pairs array directly at the root
        pairs = json;
      } else if (json && Array.isArray(json.pairs)) {
        // API returned { pairs: [...] }
        pairs = json.pairs;
      } else {
        // Unexpected shape — log the actual response so we can diagnose it
        const preview = JSON.stringify(json)?.slice(0, 300);
        console.warn(
          `⚠️ [LiquidityMonitor] ${this.symbol} geçersiz API yanıtı — ` +
          `beklenen yapı bulunamadı. Gerçek yanıt: ${preview} — atlanıyor`
        );
        return;
      }

      if (pairs.length === 0) {
        // No pairs yet — data not available, skip this check
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} henüz pair bulunamadı — atlanıyor`);
        return;
      }

      // Find the highest liquidity pair
      let maxLiquidityUsd = -1;
      for (const pair of pairs) {
        const liq = pair?.liquidity?.usd;
        if (typeof liq === "number" && liq > maxLiquidityUsd) {
          maxLiquidityUsd = liq;
        }
      }

      if (maxLiquidityUsd < 0) {
        // Liquidity field missing from all pairs — data invalid, skip
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} likidite verisi eksik — atlanıyor`);
        return;
      }

      console.log(`💧 [LiquidityMonitor] ${this.symbol} likidite: $` + `${maxLiquidityUsd.toFixed(0)} (${pairs.length} pair)`);

      if (maxLiquidityUsd < RUG_LIQUIDITY_THRESHOLD_USD) {
        console.log(`🚨 [LiquidityMonitor] ${this.symbol} likidite $${maxLiquidityUsd.toFixed(0)} < $${RUG_LIQUIDITY_THRESHOLD_USD} — RUG PULL tespit edildi!`);
        this.stop();
        this.onRugDetected(this.positionId);
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} API isteği zaman aşımına uğradı — sonraki döngüde tekrar denenecek`);
      } else {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} kontrol hatası: ${err?.message ?? err} — sonraki döngüde tekrar denenecek`);
      }
      // Don't crash — retry on next poll cycle
    }
  }
}
