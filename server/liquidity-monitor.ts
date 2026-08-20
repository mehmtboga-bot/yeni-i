/**
 * LiquidityMonitor - Updated with Birraum API
 *
 * After a token is purchased, waits 15 seconds then polls Birraum
 * every 5 seconds to check liquidity. If liquidity drops below $300
 * (and the response is valid), triggers the rug pull callback.
 *
 * Falls back to DexScreener if Birraum fails.
 */

const BIRRAUM_API_BASE = "https://api.birraum.com/solana/token";
const DEXSCREENER_API_BASE = "https://api.dexscreener.com/tokens/v1/solana";
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
      // Try Birraum first (faster, more accurate)
      let liq = await this.checkBirraum();
      
      // Fallback to DexScreener if Birraum fails
      if (liq === null) {
        console.log(`💧 [LiquidityMonitor] ${this.symbol} Birraum başarısız, DexScreener'a geçiliyor...`);
        liq = await this.checkDexScreener();
      }

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

  private async checkBirraum(): Promise<number | null> {
    try {
      const url = `${BIRRAUM_API_BASE}/${this.mintAddress}`;

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
        console.warn(`⚠️ [LiquidityMonitor-Birraum] ${this.symbol} API yanıtı: ${res.status}`);
        return null;
      }

      const json = await res.json();

      // Birraum response format: { liquidity: { usd: 12345 } }
      if (json && json.liquidity && typeof json.liquidity.usd === "number") {
        const liq = json.liquidity.usd;
        console.log(`💧 [LiquidityMonitor-Birraum] ${this.symbol} likidite: $${liq.toFixed(0)}`);
        return liq;
      }

      console.warn(`⚠️ [LiquidityMonitor-Birraum] ${this.symbol} geçersiz yanıt yapısı`);
      return null;
    } catch (err) {
      console.warn(`⚠️ [LiquidityMonitor-Birraum] ${this.symbol} hatası:`, (err as Error).message);
      return null;
    }
  }

  private async checkDexScreener(): Promise<number | null> {
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
        console.warn(`⚠️ [LiquidityMonitor-DexScreener] ${this.symbol} API yanıtı: ${res.status}`);
        return null;
      }

      const json = await res.json();

      let pairs: any[] | null = null;
      if (Array.isArray(json)) {
        pairs = json;
      } else if (json && Array.isArray(json.pairs)) {
        pairs = json.pairs;
      } else {
        console.warn(`⚠️ [LiquidityMonitor-DexScreener] ${this.symbol} geçersiz yanıt yapısı`);
        return null;
      }

      if (pairs.length === 0) {
        console.warn(`⚠️ [LiquidityMonitor-DexScreener] ${this.symbol} henüz pair bulunamadı`);
        return null;
      }

      // Find max liquidity
      let maxLiquidityUsd: number | null = null;
      for (const pair of pairs) {
        const liq = pair?.liquidity?.usd;
        if (typeof liq === "number" && liq > 0) {
          if (maxLiquidityUsd === null || liq > maxLiquidityUsd) {
            maxLiquidityUsd = liq;
          }
        }
      }

      if (maxLiquidityUsd === null) {
        console.warn(`⚠️ [LiquidityMonitor-DexScreener] ${this.symbol} likidite verisi eksik`);
        return null;
      }

      console.log(`💧 [LiquidityMonitor-DexScreener] ${this.symbol} likidite: $${maxLiquidityUsd.toFixed(0)} (${pairs.length} pair)`);
      return maxLiquidityUsd;
    } catch (err) {
      console.warn(`⚠️ [LiquidityMonitor-DexScreener] ${this.symbol} hatası:`, (err as Error).message);
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
        let liq = await this.checkBirraum();
        if (liq === null) {
          liq = await this.checkDexScreener();
        }

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

