import { TradeStore } from "./trade-store";
import type { Position } from "@shared/schema";

const JUP_PRICE_API = "https://lite-api.jup.ag/price/v3";

export class PositionPricer {
  private store: TradeStore;
  private solPriceUsd: number = 0;
  private emit: (event: string, data: any) => void;
  private onAutoSell: ((positionId: string, isHalfSell?: boolean) => void) | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private autoSellInFlight: Set<string> = new Set();

  // Yanlış fiyat spike'larını filtrele: art arda kaç kez hedef aşıldı
  private aboveThresholdCount: Map<string, number> = new Map();
  // %100 kazanç yarı satış: art arda kaç kez eşik aşıldı
  private halfSellCount: Map<string, number> = new Map();
  // Son bilinen geçerli fiyat (spike tespiti için)
  private lastValidPrice: Map<string, number> = new Map();
  
  // Retry mekanizması: mint başına kaç kez başarısız olduğunu takip et
  private failureCount: Map<string, number> = new Map();
  private maxFailuresBeforeAlert = 5;

  constructor(
    store: TradeStore,
    solPriceUsd: number,
    emit: (event: string, data: any) => void,
    onAutoSell?: (positionId: string, isHalfSell?: boolean) => void,
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

      const solPrice = this.solPriceUsd > 0 ? this.solPriceUsd : 68;
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

      // Fiyat spike koruması: önceki geçerli fiyata göre 10x'ten büyük sıçramayı yoksay
      const lastPrice = this.lastValidPrice.get(pos.mintAddress);
      if (lastPrice && lastPrice > 0 && priceInSol > lastPrice * 10) {
        console.warn(`⚠️ [Pricer] Spike: ${pos.symbol} ${lastPrice.toFixed(8)} → ${priceInSol.toFixed(8)} SOL`);
        continue;
      }
      this.lastValidPrice.set(pos.mintAddress, priceInSol);

      // buyPriceSol: alım sırasında bir kez doğru set edilir, pricer tarafından değiştirilmez
      const buyPriceSol = pos.buyPriceSol;
      if (!buyPriceSol || buyPriceSol <= 0) {
        console.warn(`⚠️ [Pricer] ${pos.symbol} buyPriceSol tanımlı değil, atlanıyor`);
        continue;
      }

      // P&L hesaplamaları — tümü aynı priceInSol değerini kullanır
      const unrealizedPnlSol =
        (pos.buyTokenAmount ?? 0) * (priceInSol - buyPriceSol);

      // ✅ DÜZELTİLDİ: SOL bazlı hesap — SOL/USD kuru dalgalanmasından etkilenmez
      const unrealizedPnlPct =
        buyPriceSol > 0 ? ((priceInSol - buyPriceSol) / buyPriceSol) * 100 : 0;

      const updated: Position = { ...pos, currentPriceUsd, unrealizedPnlSol, unrealizedPnlPct };
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

        // %100 Kazanç Yarı Satış: take-profit hedefine ulaşılmadıysa ve süre dolmadıysa
        // Yanlış tetiklenmeyi önlemek için art arda 2 okuma gerekli
        if (
          unrealizedPnlPct >= 100 &&
          takeProfitPct > 0 &&
          unrealizedPnlPct < takeProfitPct &&
          !this.autoSellInFlight.has(pos.id)
        ) {
          // Süre doldu mu kontrol et — autoSellAt varsa kullan, yoksa pozisyon hala açık demektir
          const autoSellAt = pos.autoSellAt ?? Infinity;
          const timeNotExpired = Date.now() < autoSellAt;

          if (timeNotExpired) {
            const halfCount = (this.halfSellCount.get(pos.id) ?? 0) + 1;
            this.halfSellCount.set(pos.id, halfCount);

            if (halfCount >= 2 && this.onAutoSell) {
              this.autoSellInFlight.add(pos.id);
              this.halfSellCount.delete(pos.id);
              console.log(`🎯 [Pricer] %100 Kazanç: ${pos.symbol} +${unrealizedPnlPct.toFixed(1)}% — Yarısı satılıyor`);
              this.onAutoSell(pos.id, true); // true = yarı satış
            }
          } else {
            // Süre doldu — yarı satış sayacını sıfırla
            if (this.halfSellCount.has(pos.id)) {
              this.halfSellCount.delete(pos.id);
            }
          }
        } else if (unrealizedPnlPct < 100) {
          // %100 altına düştü — yarı satış sayacını sıfırla
          if (this.halfSellCount.has(pos.id)) {
            this.halfSellCount.delete(pos.id);
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
    for (const id of this.halfSellCount.keys()) {
      const p = this.store.getById(id);
      if (!p || p.status === "closed") {
        this.halfSellCount.delete(id);
      }
    }
  }
}
