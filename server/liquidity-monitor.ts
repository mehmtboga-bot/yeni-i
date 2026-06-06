/**
 * LiquidityMonitor
 *
 * After a token is purchased, waits 5 seconds then polls DexScreener
 * every 5 seconds. If liquidity drops below $2000 (and the data is
 * valid), it fires the onRugDetected callback so the position can be
 * marked as a rug pull.
 */

const DEXSCREENER_API = "https://api.dexscreener.com/tokens/v1/solana";
const INITIAL_DELAY_MS = 5_000;   // Wait 5s after buy before first check
const POLL_INTERVAL_MS = 5_000;   // Check every 5s
const RUG_LIQUIDITY_THRESHOLD = 2_000; // USD
const API_TIMEOUT_MS = 5_000;

export class LiquidityMonitor {
  private positionId: string;
  private mintAddress: string;
  private symbol: string;
  private onRugDetected: (positionId: string) => void;

  private initialTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    positionId: string,
    mintAddress: string,
    symbol: string,
    onRugDetected: (positionId: string) => void,
  ) {
    this.positionId = positionId;
    this.mintAddress = mintAddress;
    this.symbol = symbol;
    this.onRugDetected = onRugDetected;

    // Start monitoring after the initial delay
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      if (!this.stopped) {
        this.check();
        this.pollTimer = setInterval(() => {
          if (!this.stopped) this.check();
        }, POLL_INTERVAL_MS);
      }
    }, INITIAL_DELAY_MS);

    console.log(`🔍 [LiquidityMonitor] ${this.symbol} izleme başlatıldı (${INITIAL_DELAY_MS / 1000}s sonra ilk kontrol)`);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(`🛑 [LiquidityMonitor] ${this.symbol} izleme durduruldu`);
  }

  private async check() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(`${DEXSCREENER_API}/${this.mintAddress}`, {
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

      const data = await res.json();

      // Validate response structure
      const pairs: any[] = data?.pairs;
      if (!Array.isArray(pairs) || pairs.length === 0) {
        // No pairs yet — data not valid, skip this check
        return;
      }

      // Find the highest-liquidity pair
      let maxLiquidity = -1;
      for (const pair of pairs) {
        const liq = pair?.liquidity?.usd;
        if (typeof liq === "number" && liq > maxLiquidity) {
          maxLiquidity = liq;
        }
      }

      // Data must be valid (at least one pair with a numeric liquidity value)
      if (maxLiquidity < 0) {
        // Liquidity field missing — skip this check
        return;
      }

      console.log(`💧 [LiquidityMonitor] ${this.symbol} likidite: $${maxLiquidity.toFixed(0)}`);

      if (maxLiquidity < RUG_LIQUIDITY_THRESHOLD) {
        console.log(`🚨 [LiquidityMonitor] ${this.symbol} likidite $${maxLiquidity.toFixed(0)} < $${RUG_LIQUIDITY_THRESHOLD} — RUG PULL tespit edildi!`);
        this.stop();
        this.onRugDetected(this.positionId);
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} API isteği zaman aşımına uğradı — sonraki döngüde tekrar denenecek`);
      } else {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} kontrol hatası — sonraki döngüde tekrar denenecek:`, err?.message ?? err);
      }
      // Don't crash — retry on next poll cycle
    }
  }
}
