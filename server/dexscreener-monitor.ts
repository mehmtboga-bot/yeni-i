type EventEmitter = (event: string, data: any) => void;

interface DexToken {
  address: string;
  name: string;
  symbol: string;
  createdAt: number;
  liquidity?: number;
  dex: string;
}

export class DexScreenerMonitor {
  private emit: EventEmitter;
  private isRunning = false;
  private fetchInterval: NodeJS.Timeout | null = null;
  private lastFetchTime = 0;

  constructor(emit: EventEmitter) {
    this.emit = emit;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("📊 DexScreener Monitor başlatıldı (son 12 dk PumpSwap tokenler)");
    this.fetchNewTokens();
    this.fetchInterval = setInterval(() => this.fetchNewTokens(), 30000); // 30 saniyede bir
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
    }
    console.log("🛑 DexScreener Monitor durduruldu");
  }

  private async fetchNewTokens() {
    try {
      const now = Date.now();
      const twelveMinutesAgo = now - 12 * 60 * 1000;

      // DexScreener API: Son 12 dakikada oluşmuş PumpSwap tokenler
      const res = await fetch(
        "https://api.dexscreener.com/latest/dex/tokens?chainId=solana&orderBy=createdAt&order=desc&limit=100",
        { signal: AbortSignal.timeout(10000) }
      );

      if (!res.ok) return;

      const data = await res.json();
      const tokens: any[] = data?.tokens ?? [];

      for (const token of tokens) {
        const createdAtMs = token.createdAt ? new Date(token.createdAt).getTime() : 0;

        // Son 12 dakikada oluşmuş mu?
        if (createdAtMs < twelveMinutesAgo) break;

        // PumpSwap mi?
        const isPumpSwap = token.pairs?.some((p: any) =>
          p.dexId === "pumpfun" || p.dexId === "pump"
        );
        if (!isPumpSwap) continue;

        const dexToken: DexToken = {
          address: token.address,
          name: token.name || "Bilinmiyor",
          symbol: token.symbol || "?",
          createdAt: createdAtMs,
          liquidity: token.pairs?.[0]?.liquidity?.usd ?? 0,
          dex: "pumpswap",
        };

        this.emit("dex_token_detected", dexToken);
      }

      this.lastFetchTime = now;
    } catch (err) {
      console.warn("⚠️ DexScreener fetch hatası:", (err as Error).message);
    }
  }
}
