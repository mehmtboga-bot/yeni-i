import { TradeStore } from "./trade-store";
import { AutoTraderConfigStore } from "./auto-trader-config";
import type { Position } from "@shared/schema";

// 3 tane API — sırayla denesin, hangisinden veri gelirse o devam etsin
const PRICE_APIS = [
  { name: "Jupiter v3", url: "https://lite-api.jup.ag/price/v3" },
  { name: "Jupiter v2", url: "https://api.jup.ag/price/v2" },
  { name: "DexScreener", url: "https://api.dexscreener.com/latest/dex/tokens" },
];

export class PositionPricer {
  private store: TradeStore;
  private autoTraderConfigStore: AutoTraderConfigStore | null = null;
  private solPriceUsd: number = 0;
  private emit: (event: string, data: any) => void;
  private onAutoSell: ((positionId: string) => void) | null = null;
  private onHalfSell: ((positionId: string, percentage?: number) => void) | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private autoSellInFlight: Set<string> = new Set();
  
  // Hangi API'nin çalıştığını takip et
  private lastWorkingApiIndex: number = 0;

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
  
  // Her yarı satış hedefi için ayrı in-flight setleriyle bloke önleme
  private halfSellInFlight1: Set<string> = new Set();
  private halfSellInFlight2: Set<string> = new Set();
  private halfSellInFlight3: Set<string> = new Set();

  constructor(
    store: TradeStore,
    solPriceUsd: number,
    emit: (event: string, data: any) => void,
    onAutoSell?: (positionId: string) => void,
    onHalfSell?: (positionId: string, percentage?: number) => void,
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
    console.log("🎯 [Pricer] Başlatıldı (1.5s aralık) | 3 API testi yapılacak");
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

  private async fetchPricesFromApi(apiIndex: number, mints: string): Promise<Record<string, { usdPrice?: number; price?: number }> | null> {
    const api = PRICE_APIS[apiIndex];
    
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        
        let url = "";
        if (api.name.includes("Jupiter")) {
          url = `${api.url}?ids=${mints}`;
        } else if (api.name === "DexScreener") {
          url = `${api.url}?tokens=${mints}`;
        }
        
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        
        if (!res.ok) {
          console.warn(`⚠️ [${api.name}] HTTP ${res.status} (${attempt}/2)`);
          if (attempt < 2) await new Promise(r => setTimeout(r, 300));
          continue;
        }
        
        const json = await res.json();
        
        // Her API'nin farklı response formatı var
        let data: Record<string, any> | null = null;
        
        if (api.name.includes("Jupiter")) {
          // Jupiter: { "data": { mint: { usdPrice } } }
          data = json?.data ?? json;
        } else if (api.name === "DexScreener") {
          // DexScreener: { "pairs": [ { address: mint, priceUsd } ] }
          const pairs = json?.pairs || [];
          data = {};
          for (const pair of pairs) {
            if (pair?.baseToken?.address) {
              data[pair.baseToken.address] = { 
                usdPrice: parseFloat(pair.priceUsd) || 0 
              };
            }
          }
        }
        
        if (!data || Object.keys(data).length === 0) {
          console.warn(`⚠️ [${api.name}] Boş yanıt (${attempt}/2)`);
          if (attempt < 2) await new Promise(r => setTimeout(r, 300));
          continue;
        }
        
        console.log(`✅ [${api.name}] Veri alındı (${Object.keys(data).length} token)`);
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️ [${api.name}] ${msg} (${attempt}/2)`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 300));
      }
    }
    
    return null;
  }

  private async updatePrices() {
    const positions = this.store.getAll();
    const openPositions = positions.filter((p) => p.status === "open");
    if (openPositions.length === 0) return;

    const mints = openPositions.map((p) => p.mintAddress).join(",");
    
    let data: Record<string, { usdPrice?: number; price?: number }> | null = null;
    
    // 1️⃣ Son çalışan API'den başla (öncelik ver)
    data = await this.fetchPricesFromApi(this.lastWorkingApiIndex, mints);
    
    // 2️⃣ Veri yok → diğer API'leri sırayla dene
    if (!data) {
      for (let i = 0; i < PRICE_APIS.length; i++) {
        if (i === this.lastWorkingApiIndex) continue; // Zaten denedik
        data = await this.fetchPricesFromApi(i, mints);
        if (data) {
          this.lastWorkingApiIndex = i; // Çalışan API'yi kaydet
          console.log(`🔄 [Pricer] Çalışan API güncellenmiş: ${PRICE_APIS[i].name}`);
          break;
        }
      }
    }

    // 3️⃣ Hiçbirinden veri yok
    if (!data) {
      console.warn("❌ [Pricer] Tüm API'ler başarısız, sonraki döngüde tekrar denenir");
      return;
    }

    const config = this.store.getConfig();
    const autoConfig = this.autoTraderConfigStore?.getConfig();
    const takeProfitPct = config.takeProfitPct ?? autoConfig?.profitTargetPct ?? 0;

    for (const pos of openPositions) {
      const priceData = data[pos.mintAddress];

      const solPrice = this.solPriceUsd > 0 ? this.solPriceUsd : 101;
      const currentPriceUsd = priceData?.usdPrice ?? 0;
      const priceInSol = currentPriceUsd / solPrice;

      // Veri gelmediyse
      if (!priceInSol || priceInSol <= 0) {
        const fails = (this.failureCount.get(pos.mintAddress) ?? 0) + 1;
        this.failureCount.set(pos.mintAddress, fails);
        
        if (fails === this.maxFailuresBeforeAlert) {
          console.warn(`⚠️ [Pricer] ${pos.symbol} fiyatı alınamıyor (${fails}x)`);
        }
        continue;
      }

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
        ? ((currentPriceUsd - buyPriceUsd) / buyPriceUsd) * 100: 0;

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

      // Yarı satış hedef 1 — %55 sat
      if ((autoConfig?.halfSellTarget1 ?? 0) > 0 && unrealizedPnlPct >= (autoConfig?.halfSellTarget1 ?? 0)) {
        const count = (this.halfSellTarget1Count.get(pos.id) ?? 0) + 1;
        this.halfSellTarget1Count.set(pos.id, count);
        if (count >= 2 && !this.halfSellInFlight1.has(pos.id) && this.onHalfSell) {
          this.halfSellInFlight1.add(pos.id);
          this.halfSellTarget1Count.delete(pos.id);
          console.log(`✂️ [Pricer] Yarı satış 1: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% (hedef: ${autoConfig?.halfSellTarget1}%, satış: %55)`);
          this.onHalfSell(pos.id, 55);
        }
      } else if ((autoConfig?.halfSellTarget1 ?? 0) > 0 && unrealizedPnlPct < (autoConfig?.halfSellTarget1 ?? 0)) {
        this.halfSellTarget1Count.delete(pos.id);
      }

      // Yarı satış hedef 2 — %50 sat
      if ((autoConfig?.halfSellTarget2 ?? 0) > 0 && unrealizedPnlPct >= (autoConfig?.halfSellTarget2 ?? 0)) {
        const count = (this.halfSellTarget2Count.get(pos.id) ?? 0) + 1;
        this.halfSellTarget2Count.set(pos.id, count);
        if (count >= 2 && !this.halfSellInFlight2.has(pos.id) && this.onHalfSell) {
          this.halfSellInFlight2.add(pos.id);
          this.halfSellTarget2Count.delete(pos.id);
          console.log(`✂️ [Pricer] Yarı satış 2: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% (hedef: ${autoConfig?.halfSellTarget2}%, satış: %35)`);
          this.onHalfSell(pos.id, 35);
        }
      } else if ((autoConfig?.halfSellTarget2 ?? 0) > 0 && unrealizedPnlPct < (autoConfig?.halfSellTarget2 ?? 0)) {
        this.halfSellTarget2Count.delete(pos.id);
      }

      // Yarı satış hedef 3 — %50 sat
      if ((autoConfig?.halfSellTarget3 ?? 0) > 0 && unrealizedPnlPct >= (autoConfig?.halfSellTarget3 ?? 0)) {
        const count = (this.halfSellTarget3Count.get(pos.id) ?? 0) + 1;
        this.halfSellTarget3Count.set(pos.id, count);
        if (count >= 2 && !this.halfSellInFlight3.has(pos.id) && this.onHalfSell) {
          this.halfSellInFlight3.add(pos.id);
          this.halfSellTarget3Count.delete(pos.id);
          console.log(`✂️ [Pricer] Yarı satış 3: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% (hedef: ${autoConfig?.halfSellTarget3}%, satış: %70)`);
          this.onHalfSell(pos.id, 70);
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
      }
    }
    
    // Yarı satış verilerini de temizle (her hedef için ayrı set)
    for (const id of this.halfSellInFlight1) {
      const p = this.store.getById(id);
      if (!p || p.status === "closed") {
        this.halfSellInFlight1.delete(id);
      }
    }
    for (const id of this.halfSellInFlight2) {
      const p = this.store.getById(id);
      if (!p || p.status === "closed") {
        this.halfSellInFlight2.delete(id);
      }
    }
    for (const id of this.halfSellInFlight3) {
      const p = this.store.getById(id);
      if (!p || p.status === "closed") {
        this.halfSellInFlight3.delete(id);
      }
    }
  }
}

