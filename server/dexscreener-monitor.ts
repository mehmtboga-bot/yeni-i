/**
 * DexScreenerMonitor
 *
 * DexScreener API'sini polling yaparak son 12 dakikada PumpSwap'te
 * oluşturulan yeni token çiftlerini tespit eder ve eventEmitter
 * aracılığıyla "dex_token_detected" olayı yayar.
 */

const DEX_API_URL =
  "https://api.dexscreener.com/token-profiles/latest/v1";

// Kaç dakika geriye bakılacak
const LOOKBACK_MS = 12 * 60 * 1000;

// Polling aralığı (ms)
const POLL_INTERVAL_MS = 60 * 1000; // 1 dakika

export interface DexTokenEvent {
  address: string;
  name: string;
  symbol: string;
  liquidity: number;
  pairCreatedAt: number;
}

export class DexScreenerMonitor {
  private eventEmitter: (event: string, data: any) => void;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private seenAddresses: Set<string> = new Set();

  constructor(eventEmitter: (event: string, data: any) => void) {
    this.eventEmitter = eventEmitter;
  }

  start() {
    if (this.isRunning) {
      console.log("⚠️ DexScreener Monitor zaten çalışıyor");
      return;
    }
    this.isRunning = true;
    console.log("🚀 DexScreener Monitor başlatılıyor (PumpSwap — son 12 dk)...");
    // İlk çekimi hemen yap, sonra periyodik olarak tekrarla
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (!this.isRunning) {
      console.log("⚠️ DexScreener Monitor zaten durdurulmuş");
      return;
    }
    console.log("🛑 DexScreener Monitor durduruluyor...");
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.seenAddresses.clear();
  }

  private async poll() {
    try {
      const res = await fetch(DEX_API_URL, {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        console.warn(`⚠️ [DexScreener] API yanıtı: ${res.status}`);
        return;
      }

      const items: any[] = await res.json();
      if (!Array.isArray(items)) return;

      const cutoff = Date.now() - LOOKBACK_MS;

      for (const item of items) {
        // Sadece Solana + PumpSwap çiftlerini işle
        if (item.chainId !== "solana") continue;
        if (
          typeof item.dexId === "string" &&
          !item.dexId.toLowerCase().includes("pump")
        )
          continue;

        const address: string = item.tokenAddress ?? item.address;
        if (!address) continue;

        // Daha önce işlendiyse atla
        if (this.seenAddresses.has(address)) continue;

        // Oluşturulma zamanı kontrolü
        const createdAt: number =
          item.pairCreatedAt ?? item.createdAt ?? 0;
        if (createdAt > 0 && createdAt < cutoff) continue;

        this.seenAddresses.add(address);

        // Bellek sızıntısını önle
        if (this.seenAddresses.size > 2000) {
          const first = this.seenAddresses.values().next().value;
          if (first) this.seenAddresses.delete(first);
        }

        const name: string = item.name ?? item.baseToken?.name ?? "Bilinmiyor";
        const symbol: string =
          item.symbol ?? item.baseToken?.symbol ?? "?";
        const liquidity: number =
          item.liquidity?.usd ?? item.liquidityUsd ?? 0;

        const tokenEvent: DexTokenEvent = {
          address,
          name,
          symbol,
          liquidity,
          pairCreatedAt: createdAt,
        };

        console.log(
          `🔍 [DexScreener] Yeni PumpSwap token: ${symbol} (${address.slice(0, 8)}...) | Likidite: $${liquidity.toFixed(0)}`
        );

        this.eventEmitter("dex_token_detected", tokenEvent);
      }
    } catch (err) {
      console.error("❌ [DexScreener] Poll hatası:", err);
    }
  }
}
