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

  // Yanlış fiyat spike'larını filtrele: art arda kaç kez hedef aşıldı
  private aboveThresholdCount: Map<string, number> = new Map();
  // Son bilinen geçerli fiyat (spike tespiti için)
  private lastValidPrice: Map<string, number> = new Map();

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
    const openPositions = positions.filter((p) => p.status === "open");
    if (openPositions.length === 0) return;

    const mints = openPositions.map((p) => p.mintAddress).join(",");
    try {
      const res = await fetch(`${JUP_PRICE_API}?ids=${mints}`);
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, { usdPrice?: number; price?: number }>;

      const config = this.store.getConfig();
      const takeProfitPct = config.takeProfitPct ?? 0;

      for (const pos of openPositions) {
        const priceData = data[pos.mintAddress];
        const currentPriceUsd = priceData?.usdPrice ?? priceData?.price ?? 0;
        if (!currentPriceUsd || currentPriceUsd <= 0) continue;

        const solPrice = this.solPriceUsd > 0 ? this.solPriceUsd : 87;
        const currentPriceSol = currentPriceUsd / solPrice;

        // Fiyat spike koruması: önceki geçerli fiyata göre 10x'ten büyük sıçramayı yoksay
        const lastPrice = this.lastValidPrice.get(pos.mintAddress);
        if (lastPrice && lastPrice > 0 && currentPriceSol > lastPrice * 10) {
          console.warn(`⚠️ [Pricer] Fiyat spike algılandı, atlanıyor: ${pos.symbol} ${lastPrice.toFixed(8)} → ${currentPriceSol.toFixed(8)} SOL`);
          continue;
        }
        this.lastValidPrice.set(pos.mintAddress, currentPriceSol);

        // buyPriceSol: bir kez kalıcı olarak ayarlandıktan sonra pricer tarafından değiştirilemez
        // (sunucu yeniden başlayınca sıfırlanma sorununu önler — sadece trades.json'dan gelir)
        let buyPriceSol = pos.buyPriceSol;
        let updated: Position = { ...pos };
        if (!buyPriceSol || buyPriceSol <= 0) {
          // İlk fiyat kaydı — ama sadece trades.json'a henüz yazılmamışsa yap
          buyPriceSol = currentPriceSol;
          updated = { ...updated, buyPriceSol };
          console.log(`📌 [Pricer] İlk alış fiyatı kaydedildi: ${pos.symbol} = ${currentPriceSol.toFixed(8)} SOL`);
        }

        const unrealizedPnlSol =
          (pos.buyTokenAmount ?? 0) * (currentPriceSol - buyPriceSol);
        const unrealizedPnlPct =
          buyPriceSol > 0 ? ((currentPriceSol - buyPriceSol) / buyPriceSol) * 100 : 0;

        updated = { ...updated, currentPriceUsd, unrealizedPnlSol, unrealizedPnlPct };
        this.store.upsert(updated);
        this.emit("position_update", updated);

        // Take-profit: yanlış tetiklenmeyi önlemek için art arda 2 okuma gerekli
        if (takeProfitPct > 0 && unrealizedPnlPct >= takeProfitPct) {
          const count = (this.aboveThresholdCount.get(pos.id) ?? 0) + 1;
          this.aboveThresholdCount.set(pos.id, count);

          if (count >= 2 && !this.autoSellInFlight.has(pos.id) && this.onAutoSell) {
            this.autoSellInFlight.add(pos.id);
            this.aboveThresholdCount.delete(pos.id);
            console.log(`🎯 Kar hedefi: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% ≥ %${takeProfitPct} (${count}. onay) — otomatik satış`);
            this.onAutoSell(pos.id);
            // autoSellInFlight: satış bitince pozisyon "closed" olur, "open" kalırsa yeniden denenebilir
            // Ama sadece pozisyon "pending_sell"den "open"a geri dönünce temizle — 30s sabit timeout yok
          }
        } else {
          // Hedef altına düştü — sayacı sıfırla
          if (this.aboveThresholdCount.has(pos.id)) {
            this.aboveThresholdCount.delete(pos.id);
          }
          // Satış tamamlandıysa inFlight'ı temizle
          if (this.autoSellInFlight.has(pos.id)) {
            const fresh = this.store.getById(pos.id);
            if (!fresh || fresh.status === "closed") {
              this.autoSellInFlight.delete(pos.id);
            }
          }
        }
      }

      // Kapalı pozisyonların geçici verilerini temizle
      for (const id of this.autoSellInFlight) {
        const p = this.store.getById(id);
        if (!p || p.status === "closed") {
          this.autoSellInFlight.delete(id);
        }
      }
    } catch {
      // Sessiz hata
    }
  }
}
