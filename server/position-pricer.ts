import { TradeStore } from "./trade-store";
import type { Position } from "@shared/schema";

const JUP_PRICE_API = "https://lite-api.jup.ag/price/v3";

export class PositionPricer {
  private store: TradeStore;
  private solPriceUsd: number = 0;
  private emit: (event: string, data: any) => void;
  private onAutoSell: ((positionId: string) => void) | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private autoSellInFlight: Set<string> = new Set();

  constructor(
    store: TradeStore,
    solPriceUsd: number,
    emit: (event: string, data: any) => void,
    onAutoSell?: (positionId: string) => void,
  ) {
    this.store = store;
    this.solPriceUsd = solPriceUsd;
    this.emit = emit;
    this.onAutoSell = onAutoSell ?? null;
  }

  setSolPrice(price: number) { this.solPriceUsd = price; }

  start() {
    if (this.updateInterval) return;
    this.updateInterval = setInterval(() => this.updatePrices(), 1500);
    this.updatePrices();
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private async updatePrices() {
    const positions = this.store.getAll();
    const openPositions = positions.filter((p) => p.status === "open" && p.buyPriceSol);
    if (openPositions.length === 0) return;

    const mints = openPositions.map((p) => p.mintAddress).join(",");
    try {
      const res = await fetch(`${JUP_PRICE_API}?ids=${mints}`);
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, { price: number }>;

      const config = this.store.getConfig();
      const takeProfitPct = config.takeProfitPct ?? 0;

      for (const pos of openPositions) {
        const priceData = data[pos.mintAddress];
        if (!priceData || priceData.price <= 0) continue;

        const currentPriceUsd = priceData.price;
        const solPrice = this.solPriceUsd > 0 ? this.solPriceUsd : 87;
        const unrealizedPnlSol =
          (pos.buyTokenAmount ?? 0) * (currentPriceUsd / solPrice - (pos.buyPriceSol ?? 0));
        const unrealizedPnlPct =
          (pos.buyPriceSol ?? 0) > 0
            ? ((currentPriceUsd / solPrice - pos.buyPriceSol!) / pos.buyPriceSol!) * 100
            : 0;

        const updated: Position = { ...pos, currentPriceUsd, unrealizedPnlSol, unrealizedPnlPct };
        this.store.upsert(updated);
        this.emit("position_update", updated);

        // Take-profit kontrolü
        if (
          takeProfitPct > 0 &&
          unrealizedPnlPct >= takeProfitPct &&
          !this.autoSellInFlight.has(pos.id) &&
          this.onAutoSell
        ) {
          this.autoSellInFlight.add(pos.id);
          console.log(`🎯 Kar hedefi: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% ≥ %${takeProfitPct} — otomatik satış`);
          this.onAutoSell(pos.id);
          // Satış tamamlanınca (pozisyon kapanınca) inFlight'dan çıkar
          setTimeout(() => this.autoSellInFlight.delete(pos.id), 30_000);
        }
      }
    } catch {
      // Sessiz hata
    }
  }
}
