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
const API_TIMEOUT_MS            = 5_000;   // Max 5s per API call
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
    this.clearConfirmationTimer();
    console.log(`🛑 [LiquidityMonitor] ${this.symbol} (${this.positionId}) izleme durduruldu`);
  }

  private clearPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clearConfirmationTimer() {
    if (this.rugConfirmationTimer) {
      clearTimeout(this.rugConfirmationTimer);
      this.rugConfirmationTimer = null;
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

      // Find the highest liquidity pair.
      // null  = no liquidity field present in any pair (data missing, retry)
      // 0     = real zero liquidity (rug pull)
      let maxLiquidityUsd: number | null = null;
      for (const pair of pairs) {
        const liq = pair?.liquidity?.usd;
        if (typeof liq === "number") {
          if (maxLiquidityUsd === null || liq > maxLiquidityUsd) {
            maxLiquidityUsd = liq;
          }
        }
      }

      if (maxLiquidityUsd === null) {
        // Liquidity field missing from all pairs — data not yet available, skip
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} likidite verisi eksik — atlanıyor`);
        return;
      }

      console.log(`💧 [LiquidityMonitor] ${this.symbol} likidite: $` + `${maxLiquidityUsd.toFixed(0)} (${pairs.length} pair)`);

      if (maxLiquidityUsd < RUG_LIQUIDITY_THRESHOLD_USD) {
        console.log(`⚠️ [LiquidityMonitor] ${this.symbol} likidite ${maxLiquidityUsd.toFixed(0)} < ${RUG_LIQUIDITY_THRESHOLD_USD} — RUG PULL ŞÜPHESİ! Doğrulama başlatılıyor...`);
        // Pause normal polling and begin the confirmation sequence
        this.clearPoll();
        this.rugConfirmationAttempts = 0;
        this.scheduleNextConfirmation();
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

  /** Fetch liquidity once more to verify the suspected rug pull. */
  private async confirmRugPull() {
    if (this.stopped) return;

    this.rugConfirmationAttempts++;
    console.log(`🔎 [LiquidityMonitor] ${this.symbol} rug pull doğrulama ${this.rugConfirmationAttempts}/${RUG_CONFIRMATION_ATTEMPTS} — likidite kontrol ediliyor...`);

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

      let liquidityOk = false;

      if (res.ok) {
        const json = await res.json();

        let pairs: any[] | null = null;
        if (Array.isArray(json)) {
          pairs = json;
        } else if (json && Array.isArray(json.pairs)) {
          pairs = json.pairs;
        }

        if (pairs && pairs.length > 0) {
          let maxLiquidityUsd: number | null = null;
          for (const pair of pairs) {
            const liq = pair?.liquidity?.usd;
            if (typeof liq === "number") {
              if (maxLiquidityUsd === null || liq > maxLiquidityUsd) {
                maxLiquidityUsd = liq;
              }
            }
          }

          if (maxLiquidityUsd !== null && maxLiquidityUsd >= RUG_LIQUIDITY_THRESHOLD_USD) {
            liquidityOk = true;
            console.log(`✅ [LiquidityMonitor] ${this.symbol} likidite geri döndü (${maxLiquidityUsd.toFixed(0)}) — rug pull iptal, normal izleme devam ediyor`);
          } else if (maxLiquidityUsd !== null) {
            console.log(`⚠️ [LiquidityMonitor] ${this.symbol} doğrulama ${this.rugConfirmationAttempts}: likidite hâlâ düşük (${maxLiquidityUsd.toFixed(0)})`);
          } else {
            console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} doğrulama ${this.rugConfirmationAttempts}: likidite verisi eksik`);
          }
        } else {
          console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} doğrulama ${this.rugConfirmationAttempts}: pair bulunamadı`);
        }
      } else {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} doğrulama ${this.rugConfirmationAttempts}: API yanıtı ${res.status}`);
      }

      if (liquidityOk) {
        // Liquidity recovered — resume normal polling
        this.rugConfirmationAttempts = 0;
        this.pollTimer = setInterval(() => {
          if (this.stopped) {
            this.clearPoll();
            return;
          }
          this.check();
        }, POLL_INTERVAL_MS);
        return;
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} doğrulama ${this.rugConfirmationAttempts}: istek zaman aşımına uğradı`);
      } else {
        console.warn(`⚠️ [LiquidityMonitor] ${this.symbol} doğrulama ${this.rugConfirmationAttempts} hatası: ${err?.message ?? err}`);
      }
    }

    // Liquidity still missing/low — schedule next check or finalise
    if (this.rugConfirmationAttempts < RUG_CONFIRMATION_ATTEMPTS) {
      this.scheduleNextConfirmation();
    } else {
      this.finalizeRugPull();
    }
  }

  /** Schedule the next confirmation check after RUG_CONFIRMATION_DELAY_MS. */
  private scheduleNextConfirmation() {
    this.clearConfirmationTimer();
    this.rugConfirmationTimer = setTimeout(() => {
      this.rugConfirmationTimer = null;
      this.confirmRugPull();
    }, RUG_CONFIRMATION_DELAY_MS);
    console.log(`⏳ [LiquidityMonitor] ${this.symbol} sonraki doğrulama ${RUG_CONFIRMATION_DELAY_MS / 1_000}s içinde yapılacak`);
  }

  /** All confirmation attempts exhausted — trigger the rug pull callback. */
  private finalizeRugPull() {
    console.log(`🚨 [LiquidityMonitor] ${this.symbol} RUG PULL DOĞRULANMIŞTIR! (${RUG_CONFIRMATION_ATTEMPTS} doğrulama tamamlandı) — pozisyon kapatılıyor`);
    this.stop();
    this.onRugDetected(this.positionId);
  }
}

