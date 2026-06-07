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
  
  // Retry mekanizması: mint başına kaç kez başarısız olduğunu takip et
  private failureCount: Map<string, number> = new Map();
  private maxFailuresBeforeAlert = 5;

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
    console.log("🎯 [Pricer] Başlatıldı (1.5s aralık)");
    this.updateInterval = setInterval(() => this.updatePrices(), 1500);
    this.updatePrices();
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      console.log("⏹️ [Pricer] Durduruldu");
    }
  }

  private async updatePrices() {
    const positions = this.store.getAll();
    const openPositions = positions.filter((p) => p.status === "open");
    if (openPositions.length === 0) return;

    const mints = openPositions.map((p) => p.mintAddress).join(",");
    
    // Retry ile API çağrısı yap (3 deneme)
    let data: Record<string, { usdPrice?: number; price?: number }> | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        
        const res = await fetch(`${JUP_PRICE_API}?ids=${mints}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        
        if (!res.ok) {
          console.warn(`⚠️ [Pricer] HTTP ${res.status} (deneme ${attempt}/3)`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }
        
        const json = await res.json();
        data = json?.data ?? json; // API { "data": { ... } } veya { ... } döndürebilir
        if (!data || Object.keys(data).length === 0) {
          console.warn(`⚠️ [Pricer] Boş API yanıtı (deneme ${attempt}/3)`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }
        
        // Başarılı — döngüden çık
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️ [Pricer] Hata: ${msg} (deneme ${attempt}/3)`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }

    // Hala veri yok
    if (!data) {
      console.warn("❌ [Pricer] 3 deneme sonrası veri alınamadı");
      return;
    }

    const config = this.store.getConfig();
    const takeProfitPct = config.takeProfitPct ?? 0;

    for (const pos of openPositions) {
      const priceData = data[pos.mintAddress];

      // Jupiter Price API v3:
      //   priceData.price    → token fiyatı SOL cinsinden (varsa öncelikli kullan)
      //   priceData.usdPrice → token fiyatı USD cinsinden (SOL'a çevirmek gerekir)
      const solPrice = this.solPriceUsd > 0 ? this.solPriceUsd : 87;
      const currentPriceSol: number =
        priceData?.price != null
          ? priceData.price                          // Zaten SOL cinsinden — doğrudan kullan
          : priceData?.usdPrice != null
            ? priceData.usdPrice / solPrice          // USD → SOL çevirimi
            : typeof priceData === "number"
              ? priceData                            // Ham sayı (SOL varsayımı)
              : 0;

      // USD fiyatını UI için koru (currentPriceUsd alanı)
      const currentPriceUsd =
        priceData?.usdPrice != null
          ? priceData.usdPrice
          : currentPriceSol * solPrice;

      // Veri gelmediyse
      if (!currentPriceSol || currentPriceSol <= 0) {
        const fails = (this.failureCount.get(pos.mintAddress) ?? 0) + 1;
        this.failureCount.set(pos.mintAddress, fails);
        
        if (fails === this.maxFailuresBeforeAlert) {
          console.warn(`⚠️ [Pricer] ${pos.symbol} fiyatı alınamıyor (${fails}x)`);
        }
        continue;
      }

      // Başarılı okuma — sayacı sıfırla
      this.failureCount.delete(pos.mintAddress);

      // Fiyat spike koruması: önceki geçerli fiyata göre 10x'ten büyük sıçramayı yoksay
      const lastPrice = this.lastValidPrice.get(pos.mintAddress);
      if (lastPrice && lastPrice > 0 && currentPriceSol > lastPrice * 10) {
        console.warn(`⚠️ [Pricer] Spike: ${pos.symbol} ${lastPrice.toFixed(8)} → ${currentPriceSol.toFixed(8)} SOL`);
        continue;
      }
      this.lastValidPrice.set(pos.mintAddress, currentPriceSol);

      // buyPriceSol: alım sırasında bir kez doğru set edilir, pricer tarafından değiştirilmez
      const buyPriceSol = pos.buyPriceSol;
      if (!buyPriceSol || buyPriceSol <= 0) {
        console.warn(`⚠️ [Pricer] ${pos.symbol} buyPriceSol tanımlı değil, atlanıyor`);
        continue;
      }
      const unrealizedPnlSol =
        (pos.buyTokenAmount ?? 0) * (currentPriceSol - buyPriceSol);
      // PnL % = price change % relative to buy price (not ROI on SOL spent).
      // Using buySolAmount as denominator inflates it when fees/slippage cause
      // buyTokenAmount × buyPriceSol < buySolAmount, producing a far-too-small %.
      // The correct formula is simply: ((currentPrice - buyPrice) / buyPrice) × 100
      const unrealizedPnlPct = ((currentPriceSol - buyPriceSol) / buyPriceSol) * 100;

      console.log(`[Pricer Debug] ${pos.symbol}: buyPrice=${buyPriceSol.toFixed(8)}, currentPrice=${currentPriceSol.toFixed(8)}, pnlPct=${unrealizedPnlPct.toFixed(2)}%, pnlSol=${unrealizedPnlSol.toFixed(8)}`);

      const updated: Position = { ...pos, currentPriceUsd, currentPriceSol, unrealizedPnlSol, unrealizedPnlPct };
      this.store.upsert(updated);
      this.emit("position_update", updated);

      // Take-profit: yanlış tetiklenmeyi önlemek için art arda 2 okuma gerekli
      if (takeProfitPct > 0 && unrealizedPnlPct >= takeProfitPct) {
        const count = (this.aboveThresholdCount.get(pos.id) ?? 0) + 1;
        this.aboveThresholdCount.set(pos.id, count);

        if (count >= 2 && !this.autoSellInFlight.has(pos.id) && this.onAutoSell) {
          this.autoSellInFlight.add(pos.id);
          this.aboveThresholdCount.delete(pos.id);
          console.log(`🎯 [Pricer] Kar hedefi: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}%`);
          this.onAutoSell(pos.id);
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
  }
}
