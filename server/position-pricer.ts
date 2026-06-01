import { TradeStore } from "./trade-store";
import type { Position } from "@shared/schema";

const JUP_PRICE_API = "https://lite-api.jup.ag/price/v3";
const UPDATE_INTERVAL_MS = 3000;
const BATCH_SIZE = 50;
const INTER_BATCH_DELAY_MS = 500;

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
    console.log(`🎯 [Pricer] Başlatıldı (${UPDATE_INTERVAL_MS / 1000}s aralık, batch=${BATCH_SIZE})`);
    this.updateInterval = setInterval(() => this.updatePrices(), UPDATE_INTERVAL_MS);
    this.updatePrices();
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      console.log("⏹️ [Pricer] Durduruldu");
    }
  }

  /**
   * Verilen mint listesi için Jupiter API'sini sorgular.
   * Exponential backoff ile 3 deneme yapar.
   * Başarısızlık durumunda null döner.
   */
  private async fetchBatch(
    mints: string[],
    batchIndex: number,
  ): Promise<Record<string, { usdPrice?: number; price?: number }> | null> {
    const ids = mints.join(",");
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(`${JUP_PRICE_API}?ids=${ids}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          // Exponential backoff: 1s, 2s, 4s
          const backoff = Math.pow(2, attempt - 1) * 1000;
          console.warn(
            `⚠️ [Pricer] Batch ${batchIndex} HTTP ${res.status} (deneme ${attempt}/${maxAttempts}, ${backoff}ms bekle)`,
          );
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        const data = await res.json();
        if (!data || Object.keys(data).length === 0) {
          const backoff = Math.pow(2, attempt - 1) * 1000;
          console.warn(
            `⚠️ [Pricer] Batch ${batchIndex} boş yanıt (deneme ${attempt}/${maxAttempts}, ${backoff}ms bekle)`,
          );
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        return data;
      } catch (err) {
        const backoff = Math.pow(2, attempt - 1) * 1000;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `⚠️ [Pricer] Batch ${batchIndex} hata: ${msg} (deneme ${attempt}/${maxAttempts}, ${backoff}ms bekle)`,
        );
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoff));
      }
    }

    console.warn(`❌ [Pricer] Batch ${batchIndex} ${maxAttempts} deneme sonrası başarısız`);
    return null;
  }

  private async updatePrices() {
    const positions = this.store.getAll();
    const openPositions = positions.filter((p) => p.status === "open");
    if (openPositions.length === 0) return;

    // Tüm mint'leri BATCH_SIZE'lık gruplara böl
    const allMints = openPositions.map((p) => p.mintAddress);
    const batches: string[][] = [];
    for (let i = 0; i < allMints.length; i += BATCH_SIZE) {
      batches.push(allMints.slice(i, i + BATCH_SIZE));
    }

    if (batches.length > 1) {
      console.log(`📦 [Pricer] ${openPositions.length} pozisyon → ${batches.length} batch`);
    }

    // Tüm batch'lerden gelen fiyat verilerini birleştir
    const mergedData: Record<string, { usdPrice?: number; price?: number }> = {};

    for (let i = 0; i < batches.length; i++) {
      const batchData = await this.fetchBatch(batches[i], i + 1);
      if (batchData) {
        Object.assign(mergedData, batchData);
      }
      // Son batch değilse batch'ler arası bekle (rate limit'e saygı)
      if (i < batches.length - 1) {
        await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
      }
    }

    if (Object.keys(mergedData).length === 0) {
      console.warn("❌ [Pricer] Hiçbir batch'ten veri alınamadı");
      return;
    }

    const data = mergedData;
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
