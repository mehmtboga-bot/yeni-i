/**
 * LiquidityMonitor
 *
 * After a token is purchased, waits 15 seconds then polls DexScreener
 * every 5 seconds to check liquidity. If liquidity drops below $300
 * (and the response is valid), triggers the rug pull callback.
 *
 * False-positive protection: when low liquidity is first detected, normal
 * polling is paused and the reading is confirmed with 2 additional checks
 * spaced 6 seconds apart before the rug pull is finalised.
 */

const DEXSCREENER_API_BASE = "https://api.dexscreener.com/latest/dex/tokens";
const RUG_LIQUIDITY_THRESHOLD_USD = 300;
const INITIAL_DELAY_MS          = 15_000;  // Wait 15s after purchase before first check
const POLL_INTERVAL_MS          = 5_000;   // Check every 5s
const API_TIMEOUT_MS            = 8_000;   // Max 8s per API call
const RUG_CONFIRMATION_DELAY_MS = 6_000;   // Wait 6s between confirmation checks
const RUG_CONFIRMATION_ATTEMPTS = 2;       // Number of extra checks before confirming rug

export class LiquidityMonitor {
  private positionId: string;
  private mintAddress: string;
  private symbol: string;
  private onRugDetected: (positionId: string) => void;

  private stopped = false;
  private initialTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private rugConfirmationTimer: NodeJS.Timeout | null = null;
  private rugConfirmationAttempts = 0;

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
  }

  private async check() {
    try {
      const liq = await this.fetchLiquidity();

      if (liq === null) {
        // No data available yet, skip
        return;
      }

      if (liq === 0) {
        // Real zero liquidity (rug pull detected)
        console.log(`🚨 [LiquidityMonitor] ${this.symbol} likidite = $0 — RUG PULL TESPİT EDİLDİ!`);
        this.confirmRugPull();
        return;
      }

      if (liq < RUG_LIQUIDITY_THRESHOLD_USD) {
        console.log(`⚠️ [LiquidityMonitor] ${this.symbol} likidite $${liq.toFixed(0)} < $${RUG_LIQUIDITY_THRESHOLD_USD} — RUG ŞÜPHESİ! Doğrulama başlatılıyor...`);
        this.confirmRugPull();
      }
    } catch (err) {
      console.error(`❌ [LiquidityMonitor] ${this.symbol} check hatası:`, err);
    }
  }

  private async fetchLiquidity(): Promise<number | null> {
    try {
      const url = `${DEXSCREENER_API_BASE}?tokens=${this.mintAddress}`;

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
        return null;
      }

      const json = await res.json();

      // Parse response: { pairs: [ { liquidity: { usd: X } } ] }
      let pairs: any[] | null = null;
      if (json && Array.isArray(json.pairs)) {
        pairs = json.pairs;
      } else if (Array.isArray(json)) {
        // Fallback for unexpected array response
        pairs = json;
      } else {
        const preview = JSON.stringify(json)?.slice(0, 300);
        console.warn(
          `⚠️ [LiquidityMonitor] ${this.symbol} geçersiz API yanıtı — ` +
          `beklenen yapı bulunamadı. Gerçek yanıt: ${preview} — atlanıyor`
        );
        return null;
      }

      if (pairs.length === 0) {
        // No pairs yet — data not available, skip this check
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} henüz pair bulunamadı — atlanıyor`);
        return null;
      }

      // Find the highest liquidity pair.
      // null  = no liquidity field present in any pair (data missing, retry)
      // 0     = real zero liquidity (rug pull)
      // >0    = valid liquidity amount
      let maxLiquidityUsd: number | null = null;
      for (const pair of pairs) {
        const liq = pair?.liquidity?.usd;
        if (typeof liq === "number" && liq >= 0) {
          if (maxLiquidityUsd === null || liq > maxLiquidityUsd) {
            maxLiquidityUsd = liq;
          }
        }
      }

      if (maxLiquidityUsd === null) {
        // Liquidity field missing from all pairs — data not yet available, skip
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} likidite verisi eksik — atlanıyor`);
        return null;
      }

      console.log(`💧 [LiquidityMonitor] ${this.symbol} likidite: $${maxLiquidityUsd.toFixed(0)} (${pairs.length} pair)`);
      return maxLiquidityUsd;
    } catch (err) {
      console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} API hatası:`, (err as Error).message);
      return null;
    }
  }

  private confirmRugPull() {
    // Pause normal polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.rugConfirmationAttempts = 0;
    this.confirmCheck();
  }

  private confirmCheck() {
    this.rugConfirmationTimer = setTimeout(async () => {
      try {
        const liq = await this.fetchLiquidity();

        if (liq !== null && liq >= RUG_LIQUIDITY_THRESHOLD_USD) {
          // False positive — liquidity recovered
          console.log(`✅ [LiquidityMonitor] ${this.symbol} likidite normal seviyeye döndü ($${liq.toFixed(0)}), rug pull yanlış alarm iptal edildi`);
          // Resume normal polling
          if (!this.stopped) {
            this.pollTimer = setInterval(() => {
              if (this.stopped) {
                this.clearPoll();
                return;
              }
              this.check();
            }, POLL_INTERVAL_MS);
          }
          return;
        }

        this.rugConfirmationAttempts++;
        if (this.rugConfirmationAttempts >= RUG_CONFIRMATION_ATTEMPTS) {
          // Confirmed rug pull
          console.log(`🚨 [LiquidityMonitor] ${this.symbol} RUG PULL ONAYLANDI (${RUG_CONFIRMATION_ATTEMPTS} doğrulama)`);
          this.onRugDetected(this.positionId);
          this.stop();
          return;
        }

        // Schedule next confirmation check
        this.confirmCheck();
      } catch (err) {
        console.error(`❌ [LiquidityMonitor] ${this.symbol} doğrulama hatası:`, err);
      }
    }, RUG_CONFIRMATION_DELAY_MS);
  }

  stop() {
    this.stopped = true;
    this.clearPoll();
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.rugConfirmationTimer) {
      clearTimeout(this.rugConfirmationTimer);
      this.rugConfirmationTimer = null;
    }
  }

  private clearPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

