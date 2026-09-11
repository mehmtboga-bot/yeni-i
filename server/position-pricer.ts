import { TradeStore } from "./trade-store";
import { AutoTraderConfigStore } from "./auto-trader-config";
import type { Position } from "@shared/schema";

const JUP_PRICE_API = "https://lite-api.jup.ag/price/v3";
const DEX_SCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";

type PriceSource = "jupiter" | "dexscreener" | null;

export class PositionPricer {
  private store: TradeStore;
  private autoTraderConfigStore: AutoTraderConfigStore | null = null;
  private solPriceUsd: number = 0;
  private emit: (event: string, data: any) => void;
  private onAutoSell: ((positionId: string) => void) | null = null;
  private onHalfSell: ((positionId: string) => void) | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private autoSellInFlight: Set<string> = new Set();

  // Yanlış fiyat spike'larını filtrele: art arda kaç kez hedef aşıldı
  private aboveThresholdCount: Map<string, number> = new Map();
  // Son bilinen geçerli fiyat (spike tespiti için)
  private lastValidPrice: Map<string, number> = new Map();
  
  // Retry mekanizması: mint başına kaç kez başarısız olduğunu takip et
  private failureCount: Map<string, number> = new Map();
  private maxFailuresBeforeAlert = 5;

  // Yarı satış hedef sayaçları (debounce: 2 okuma)
  private halfSellTarget1Count: Map<string, number> = new Map();
  private halfSellTarget2Count: Map<string, number> = new Map();
  private halfSellTarget3Count: Map<string, number> = new Map();

  // Her pozisyon için hangi API'den fiyat alındığını takip et
  private positionPriceSource: Map<string, PriceSource> = new Map();

  constructor(
    store: TradeStore,
    solPriceUsd: number,
    emit: (event: string, data: any) => void,
    onAutoSell?: (positionId: string) => void,
    onHalfSell?: (positionId: string) => void,
    autoTraderConfigStore?: AutoTraderConfigStore,
  ) {
    this.store = store;
    this.solPriceUsd = solPriceUsd;
    this.emit = emit;
    this.onAutoSell = onAutoSell ?? null;
    this.onHalfSell = onHalfSell ?? null;
    this.autoTraderConfigStore = autoTraderConfigStore ?? null;
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

  private async fetchFromJupiter(mints: string[]): Promise<Record<string, { usdPrice?: number; price?: number }> | null> {
    const mintsStr = mints.join(",");
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        
        const res = await fetch(`${JUP_PRICE_API}?ids=${mintsStr}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        
        if (!res.ok) {
          console.warn(`⚠️ [Pricer] Jupiter HTTP ${res.status} (deneme ${attempt}/3)`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }
        
        const json = await res.json();
        const data = json?.data ?? json;
        
        if (!data || Object.keys(data).length === 0) {
          console.warn(`⚠️ [Pricer] Jupiter boş veri döndü (deneme ${attempt}/3)`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }

        // Gelen verilerde gerçekten fiyat var mı kontrol et
        const hasValidPrices = Object.values(data).some(item => 
          item?.usdPrice && item.usdPrice > 0
        );

        if (!hasValidPrices) {
          console.warn(`⚠️ [Pricer] Jupiter geçerli fiyat verisi yok (deneme ${attempt}/3)`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }
        
        console.log("✅ [Pricer] Jupiter API başarılı");
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️ [Pricer] Jupiter hatası: ${msg} (deneme ${attempt}/3)`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    return null;
  }

  private async fetchFromDexScreener(mints: string[]): Promise<Record<string, { usdPrice?: number }> | null> {
    try {
      const promises = mints.map(mint =>
        fetch(`${DEX_SCREENER_API}/${mint}`, { signal: AbortSignal.timeout(5000) })
          .then(res => res.ok ? res.json() : null)
          .catch(() => null)
      );
      
      const results = await Promise.all(promises);
      const data: Record<string, { usdPrice?: number }> = {};
      
      results.forEach((result, idx) => {
        if (result?.pairs?.[0]?.priceUsd) {
          data[mints[idx]] = { usdPrice: parseFloat(result.pairs[0].priceUsd) };
        }
      });
      
      return Object.keys(data).length > 0 ? data : null;
    } catch (err) {
      console.warn(`⚠️ [Pricer] Dex Screener hatası: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async updatePrices() {
    const positions = this.store.getAll();
    const openPositions = positions.filter((p) => p.status === "open");
    if (openPositions.length === 0) return;

    // Pozisyonları kaynak türüne göre böl
    const jupiterMints: string[] = [];
    const dexscreenerMints: string[] = [];

    for (const pos of openPositions) {
      const source = this.positionPriceSource.get(pos.id);
      
      if (source === "dexscreener") {
        dexscreenerMints.push(pos.mintAddress);
      } else {
        // null veya "jupiter" ise Jupiter'dan çek
        jupiterMints.push(pos.mintAddress);
      }
    }

    let allData: Record<string, { usdPrice?: number; price?: number }> = {};

    // Jupiter'dan fiyat çek
    if (jupiterMints.length > 0) {
      const jupiterData = await this.fetchFromJupiter(jupiterMints);
      if (jupiterData) {
        // Jupiter başarılı olan mintleri işaretle
        jupiterMints.forEach(mint => {
          const pos = openPositions.find(p => p.mintAddress === mint);
          if (pos && jupiterData[mint]?.usdPrice) {
            this.positionPriceSource.set(pos.id, "jupiter");
          }
        });
        allData = { ...allData, ...jupiterData };
      } else {
        // Jupiter başarısız olan mintleri Dex Screener'a ekle
        console.log("🔄 [Pricer] Başarısız Jupiter mintleri Dex Screener'a geçiliyor...");
        dexscreenerMints.push(...jupiterMints);
      }
    }

    // Dex Screener'dan fiyat çek
    if (dexscreenerMints.length > 0) {
      const dexData = await this.fetchFromDexScreener(dexscreenerMints);
      if (dexData) {
        // Dex Screener başarılı olan mintleri işaretle
        dexscreenerMints.forEach(mint => {
          const pos = openPositions.find(p => p.mintAddress === mint);
          if (pos && dexData[mint]?.usdPrice) {
            this.positionPriceSource.set(pos.id, "dexscreener");
          }
        });
        allData = { ...allData, ...dexData };
      }
    }

    if (Object.keys(allData).length === 0) {
      console.error("❌ [Pricer] Tüm API'ler başarısız, fiyat verisi alınamadı");
      return;
    }

    const config = this.store.getConfig();
    const autoConfig = this.autoTraderConfigStore?.getConfig();
    const takeProfitPct = config.takeProfitPct ?? autoConfig?.profitTargetPct ?? 0;

    for (const pos of openPositions) {
      const priceData = allData[pos.mintAddress];
      const source = this.positionPriceSource.get(pos.id) || "jupiter";

      const solPrice = this.solPriceUsd > 0 ? this.solPriceUsd : 101;
      const currentPriceUsd = priceData?.usdPrice ?? 0;

      // Fiyat verisi gelmediyse bu pozisyonu atla
      if (!currentPriceUsd || currentPriceUsd <= 0) {
        const fails = (this.failureCount.get(pos.mintAddress) ?? 0) + 1;
        this.failureCount.set(pos.mintAddress, fails);
        
        if (fails === this.maxFailuresBeforeAlert) {
          console.warn(`⚠️ [Pricer] ${pos.symbol} (${pos.mintAddress}) fiyatı alınamıyor (${fails}x) - Kaynak: ${source}`);
        }
        continue;
      }

      const priceInSol = currentPriceUsd / solPrice;

      // Başarılı okuma — sayacı sıfırla
      this.failureCount.delete(pos.mintAddress);

      // Alış fiyatı
      const buyPriceSol = pos.buyPriceSol;

      if (!buyPriceSol || buyPriceSol <= 0) {
        console.warn(`⚠️ [Pricer] ${pos.symbol} buyPriceSol tanımlı değil, atlanıyor`);
        continue;
      }

      // Alış fiyatını USD'ye çevir
      const buyPriceUsd = buyPriceSol * solPrice;

      // P&L yüzdesini doğrudan USD fiyatları üzerinden hesapla
      const unrealizedPnlPct =
        buyPriceUsd > 0 && currentPriceUsd > 0 
        ? ((currentPriceUsd - buyPriceUsd) / buyPriceUsd) * 100
        : 0;

      // unrealizedPnlSol'u doğru hesapla: yatırılan SOL × kar%
      const unrealizedPnlSol = (pos.buySolAmount ?? 0) * (unrealizedPnlPct / 100);

      const updated: Position = { ...pos, currentPriceUsd, unrealizedPnlSol, unrealizedPnlPct };
      this.store.upsert(updated);
      this.emit("position_update", updated);

      // Position başına kar hedefi varsa onu kullan, yoksa global config'i kullan
      const effectiveTakeProfitPct = (pos.takeProfitPct != null && pos.takeProfitPct > 0)
        ? pos.takeProfitPct
        : takeProfitPct;

      // Take-profit: yanlış tetiklenmeyi önlemek için art arda 2 okuma gerekli
      if (effectiveTakeProfitPct > 0 && unrealizedPnlPct >= effectiveTakeProfitPct) {
        const count = (this.aboveThresholdCount.get(pos.id) ?? 0) + 1;
        this.aboveThresholdCount.set(pos.id, count);

        if (count >= 2 && !this.autoSellInFlight.has(pos.id) && this.onAutoSell) {
          this.autoSellInFlight.add(pos.id);
          this.aboveThresholdCount.delete(pos.id);
          console.log(`🎯 [Pricer] Kar hedefi: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% (Kaynak: ${source})`);
          this.onAutoSell(pos.id);
        }
      } else {
        // Hedef altına düştü — sayacı sıfırla
        if (this.aboveThresholdCount.has(pos.id)) {
          this.aboveThresholdCount.delete(pos.id);
        }
        // Satış tamamlandıysa inFlight'ı temizle ve kaynak bilgisini sil
        if (this.autoSellInFlight.has(pos.id)) {
          const fresh = this.store.getById(pos.id);
          if (!fresh || fresh.status === "closed") {
            this.autoSellInFlight.delete(pos.id);
            this.positionPriceSource.delete(pos.id); // Kapanınca kaynak bilgisini sil
          }
        }
      }

      // Yarı satış hedef 1
      if ((autoConfig?.halfSellTarget1 ?? 0) > 0 && unrealizedPnlPct >= (autoConfig?.halfSellTarget1 ?? 0) && (effectiveTakeProfitPct === 0 || unrealizedPnlPct < effectiveTakeProfitPct)) {
        const count = (this.halfSellTarget1Count.get(pos.id) ?? 0) + 1;
        this.halfSellTarget1Count.set(pos.id, count);
        if (count >= 2 && !this.autoSellInFlight.has(pos.id) && this.onHalfSell) {
          this.autoSellInFlight.add(pos.id);
          this.halfSellTarget1Count.delete(pos.id);
          console.log(`✂️ [Pricer] Yarı satış 1: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% (hedef: ${autoConfig?.halfSellTarget1}%, Kaynak: ${source})`);
          this.onHalfSell(pos.id);
        }
      } else if ((autoConfig?.halfSellTarget1 ?? 0) > 0 && unrealizedPnlPct < (autoConfig?.halfSellTarget1 ?? 0)) {
        this.halfSellTarget1Count.delete(pos.id);
      }

      // Yarı satış hedef 2
      if ((autoConfig?.halfSellTarget2 ?? 0) > 0 && unrealizedPnlPct >= (autoConfig?.halfSellTarget2 ?? 0) && (effectiveTakeProfitPct === 0 || unrealizedPnlPct < effectiveTakeProfitPct)) {
        const count = (this.halfSellTarget2Count.get(pos.id) ?? 0) + 1;
        this.halfSellTarget2Count.set(pos.id, count);
        if (count >= 2 && !this.autoSellInFlight.has(pos.id) && this.onHalfSell) {
          this.autoSellInFlight.add(pos.id);
          this.halfSellTarget2Count.delete(pos.id);
          console.log(`✂️ [Pricer] Yarı satış 2: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% (hedef: ${autoConfig?.halfSellTarget2}%, Kaynak: ${source})`);
          this.onHalfSell(pos.id);
        }
      } else if ((autoConfig?.halfSellTarget2 ?? 0) > 0 && unrealizedPnlPct < (autoConfig?.halfSellTarget2 ?? 0)) {
        this.halfSellTarget2Count.delete(pos.id);
      }

      // Yarı satış hedef 3
      if ((autoConfig?.halfSellTarget3 ?? 0) > 0 && unrealizedPnlPct >= (autoConfig?.halfSellTarget3 ?? 0) && (effectiveTakeProfitPct === 0 || unrealizedPnlPct < effectiveTakeProfitPct)) {
        const count = (this.halfSellTarget3Count.get(pos.id) ?? 0) + 1;
        this.halfSellTarget3Count.set(pos.id, count);
        if (count >= 2 && !this.autoSellInFlight.has(pos.id) && this.onHalfSell) {
          this.autoSellInFlight.add(pos.id);
          this.halfSellTarget3Count.delete(pos.id);
          console.log(`✂️ [Pricer] Yarı satış 3: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% (hedef: ${autoConfig?.halfSellTarget3}%, Kaynak: ${source})`);
          this.onHalfSell(pos.id);
        }
      } else if ((autoConfig?.halfSellTarget3 ?? 0) > 0 && unrealizedPnlPct < (autoConfig?.halfSellTarget3 ?? 0)) {
        this.halfSellTarget3Count.delete(pos.id);
      }
    }

    // Kapalı pozisyonların geçici verilerini temizle
    for (const id of this.autoSellInFlight) {
      const p = this.store.getById(id);
      if (!p || p.status === "closed") {
        this.autoSellInFlight.delete(id);
        this.positionPriceSource.delete(id); // Kaynak bilgisini sil
      }
    }
  }
}
