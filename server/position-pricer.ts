import { TradeStore } from "./trade-store";
import { SellScheduler } from "./sell-scheduler";
import type { Position } from "@shared/schema";

const JUP_PRICE_API = "https://lite-api.jup.ag/price/v3";

export class PositionPricer {
  private store: TradeStore;
  private solPriceUsd: number = 0;
  private emit: (event: string, data: any) => void;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private autoSellInFlight: Set<string> = new Set();

  // Yanlış fiyat spike'larını filtrele: art arda kaç kez hedef aşıldı
  private aboveThresholdCount: Map<string, number> = new Map();
  // Son bilinen geçerli fiyat (spike tespiti için)
  private lastValidPrice: Map<string, number> = new Map();

  // Retry mekanizması: mint başına kaç kez başarısız olduğunu takip et
  private failureCount: Map<string, number> = new Map();
  private maxFailuresBeforeAlert = 5;

  // Satış kuyruğu — recursive setTimeout yerine setInterval tabanlı scheduler
  private sellScheduler: SellScheduler;

  constructor(
    store: TradeStore,
    solPriceUsd: number,
    emit: (event: string, data: any) => void,
    onAutoSell?: (positionId: string) => Promise<{ status: string } | null>,
  ) {
    this.store = store;
    this.solPriceUsd = solPriceUsd;
    this.emit = emit;
    this.sellScheduler = new SellScheduler(
      onAutoSell ?? (() => Promise.resolve(null)),
    );
  }

  setSolPrice(price: number) { this.solPriceUsd = price; }

  start() {
    if (this.updateInterval) return;
    console.log("🎯 [Pricer] Başlatıldı (1.5s aralık)");
    this.sellScheduler.start();
    this.updateInterval = setInterval(() => this.updatePrices(), 1500);
    this.updatePrices();
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      this.sellScheduler.stop();
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
        
        data = await res.json();
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
      const currentPriceUsd = priceData?.usdPrice ?? priceData?.price ?? 0;
      
      // Veri gelmediyse
      if (!currentPriceUsd || currentPriceUsd <= 0) {
        const fails = (this.failureCount.get(pos.mintAddress) ?? 0) + 1;
        this.failureCount.set(pos.mintAddress, fails);
        
        if (fails === this.maxFailuresBeforeAlert) {
          console.warn(`⚠️ [Pricer] ${pos.symbol} fiyatı alınamıyor (${fails}x)`);
        }
        continue;
      }

      // Başarılı okuma — sayacı sıfırla
      this.failureCount.delete(pos.mintAddress);

      const solPrice = this.solPriceUsd > 0 ? this.solPriceUsd : 87;
      const currentPriceSol = currentPriceUsd / solPrice;

      // Fiyat spike koruması: önceki geçerli fiyata göre 10x'ten büyük sıçramayı yoksay
      const lastPrice = this.lastValidPrice.get(pos.mintAddress);
      if (lastPrice && lastPrice > 0 && currentPriceSol > lastPrice * 10) {
        console.warn(`⚠️ [Pricer] Spike: ${pos.symbol} ${lastPrice.toFixed(8)} → ${currentPriceSol.toFixed(8)} SOL`);
        continue;
      }
      this.lastValidPrice.set(pos.mintAddress, currentPriceSol);

      // buyPriceSol: bir kez kalıcı olarak ayarlandıktan sonra pricer tarafından değiştirilemez
      let buyPriceSol = pos.buyPriceSol;
      let updated: Position = { ...pos };
      if (!buyPriceSol || buyPriceSol <= 0) {
        buyPriceSol = currentPriceSol;
        updated = { ...updated, buyPriceSol };
        console.log(`📌 [Pricer] İlk fiyat: ${pos.symbol} = $${currentPriceUsd.toFixed(6)}`);
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

        if (count >= 2 && !this.autoSellInFlight.has(pos.id)) {
          this.autoSellInFlight.add(pos.id);
          this.aboveThresholdCount.delete(pos.id);
          console.log(`🎯 [Pricer] Kar hedefi: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% — satış kuyruğuna ekleniyor`);
          this.sellScheduler.enqueue(pos.id);
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
