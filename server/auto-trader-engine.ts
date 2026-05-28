/**
 * Otomatik Trading Motoru
 * 
 * LP tespit edildiğinde otomatik alım yapan
 * ve tutma süresine göre otomatik satış yapan sistem
 */

import type { AutoTraderConfig } from "./auto-trader-config";
import type { AutoTraderConfigStore } from "./auto-trader-config";
import type { TradeStore } from "./trade-store";
import type { Position } from "@shared/schema";

interface AutoTradeRecord {
  id: string;
  mintAddress: string;
  tokenName: string;
  tokenSymbol: string;
  buyTimestamp: number;
  shouldSellAt: number;  // Satış yapılacak zaman
  buyTxSignature?: string;
  status: "pending" | "active" | "sold" | "failed";
  error?: string;
  buyPriceSol?: number;
  buyTokenAmount?: number;
  sellPriceSol?: number;
  pnlSol?: number;
  pnlPct?: number;
  initialLiquidityUsd?: number;  // Alındığı sıradaki likidite (USD)
}

type EventEmitter = (event: string, data: any) => void;

export class AutoTraderEngine {
  private configStore: AutoTraderConfigStore;
  private tradeStore: TradeStore;
  private emit: EventEmitter;
  
  private records: Map<string, AutoTradeRecord> = new Map();
  private isRunning = false;
  private sellCheckInterval: NodeJS.Timeout | null = null;
  private processedLPs: Set<string> = new Set();
  private seenTokenSymbols: Set<string> = new Set(); // Daha önce görülen symbol/name kombinasyonları
  private recentlyClosedTrades: Array<{ symbol: string; closedAt: number }> = [];
  private readonly MAX_RECENT_TRADES = 7;
  private liquidityDropInFlight: Set<string> = new Set(); // Likidite kontrolü devam eden kayıtlar

  constructor(
    configStore: AutoTraderConfigStore,
    tradeStore: TradeStore,
    emit: EventEmitter
  ) {
    this.configStore = configStore;
    this.tradeStore = tradeStore;
    this.emit = emit;
  }

  start() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    console.log("🤖 Otomatik Trading Motoru başlatıldı");
    this.startSellChecker();
  }

  stop() {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;
    if (this.sellCheckInterval) {
      clearInterval(this.sellCheckInterval);
      this.sellCheckInterval = null;
    }
    console.log("🛑 Otomatik Trading Motoru durduruldu");
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  getRecords(): AutoTradeRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * LP tespit edildiğinde çağrılır
   */
  async onLPDetected(lpData: any) {
    const config = this.configStore.getConfig();
    if (!config.enabled) return;

    const { mintAddress, name, symbol } = lpData;
    if (!mintAddress) return;

    // Tekrar işleme koruması
    if (this.processedLPs.has(mintAddress)) {
      console.log(`⏭️ [Auto-Trader] ${symbol} zaten işlendi, atlanıyor`);
      return;
    }

    // Minimum likidite kontrolü
    const liquidityUsd: number | undefined = lpData.liquidityUsd ?? lpData.tvlUsd;
    if (config.minLiquidityUsd > 0 && (liquidityUsd === undefined || liquidityUsd < config.minLiquidityUsd)) {
      console.log(
        `🚫 [Auto-Trader] Düşük likidite — ${symbol} atlanıyor | Likidite: ${liquidityUsd?.toFixed(0) ?? "?"} | Eşik: ${config.minLiquidityUsd}`
      );
      return;
    }

    // Daha önce görülen symbol/name kombinasyonu mu?
    const tokenKey = `${symbol}:${name}`.toLowerCase();
    if (this.seenTokenSymbols.has(tokenKey)) {
      console.log(
        `⏭️ [Auto-Trader] ${symbol} (${name}) daha önce görüldü, atlanıyor`
      );
      return;
    }
    this.seenTokenSymbols.add(tokenKey);

    // Son 7 işlemde aynı symbol varsa, almaz
    if (config.skipRecentlyTradedSymbols) {
      const isRecentlyTraded = this.recentlyClosedTrades.some((t) => t.symbol === symbol);
      if (isRecentlyTraded) {
        console.log(
          `⏭️ [Auto-Trader] ${symbol} son 7 işlemde var, atlanıyor`
        );
        return;
      }
    }

    // Max token kontrol — trade-store'daki açık pozisyonlara göre
    const openPositions = this.tradeStore.getAll().filter(
      (p) => p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell"
    );
    if (openPositions.length >= config.maxTokensHeld) {
      console.warn(
        `⚠️ [Auto-Trader] Max token sayısına ulaşıldı (${openPositions.length}/${config.maxTokensHeld}), ${symbol} atlanıyor`
      );
      return;
    }

    this.processedLPs.add(mintAddress);
    const recordId = `auto-${mintAddress}-${Date.now()}`;

    // Record oluştur
    const record: AutoTradeRecord = {
      id: recordId,
      mintAddress,
      tokenName: name || "Bilinmiyor",
      tokenSymbol: symbol || "?",
      buyTimestamp: Date.now(),
      shouldSellAt: Date.now() + config.holdDurationMs,
      status: "pending",
      initialLiquidityUsd: liquidityUsd,  // LP'nin başlangıç likidite bilgisini kaydet
    };
    this.records.set(recordId, record);
    this.emit("auto_trade_record_updated", record);

    console.log(
      `🤖 [Auto-Trader] İşlem başlatılıyor: ${symbol} | Tutma süresi: ${(config.holdDurationMs / 1000).toFixed(0)}s`
    );

    // Alım emri ver — routes.ts bu event'i dinleyip trader.buy() çağırır
    this.emit("auto_buy_ready", { mintAddress, name, symbol, dex: lpData.dex });
  }

  /**
   * Satış zamanı gelmiş işlemleri kontrol et
   */
  private startSellChecker() {
    this.sellCheckInterval = setInterval(() => {
      this.checkAndSell();
    }, 1000); // 1 saniyede bir kontrol et
  }

  private checkAndSell() {
    if (!this.isRunning) return;

    const now = Date.now();
    for (const [recordId, record] of this.records.entries()) {
      if (record.status !== "active") continue;

      // Likidite %80 düşüş kontrolü (async, arka planda)
      if (
        record.initialLiquidityUsd &&
        record.initialLiquidityUsd > 0 &&
        !this.liquidityDropInFlight.has(recordId)
      ) {
        this.liquidityDropInFlight.add(recordId);
        this.checkLiquidityDrop(recordId, record).finally(() => {
          this.liquidityDropInFlight.delete(recordId);
        });
      }

      // Satış zamanı geçmiş mi?
      if (now >= record.shouldSellAt) {
        console.log(
          `⏰ [Auto-Trader] Tutma süresi geçti: ${record.tokenSymbol} (${((now - record.buyTimestamp) / 1000).toFixed(0)}s)`
        );
        
        // İlgili pozisyonu bul
        const position = this.tradeStore.getByMint(record.mintAddress);
        if (position && position.status === "open") {
          this.emit("auto_sell_ready", { positionId: position.id });
          record.status = "sold";
          this.emit("auto_trade_record_updated", record);
        }
      }
    }
  }

  /**
   * DexScreener'dan canlı likidite çek, %80 düşmüşse işlemi zarar olarak kapat
   */
  private async checkLiquidityDrop(recordId: string, record: AutoTradeRecord): Promise<void> {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${record.mintAddress}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return;

      const data = await res.json();
      const pairs: any[] = data?.pairs ?? [];
      if (pairs.length === 0) return;

      // En yüksek likiditeye sahip pair'i al
      const bestPair = pairs.reduce((best: any, p: any) => {
        const liq = p?.liquidity?.usd ?? 0;
        return liq > (best?.liquidity?.usd ?? 0) ? p : best;
      }, pairs[0]);

      const currentLiquidityUsd: number = bestPair?.liquidity?.usd ?? 0;
      if (currentLiquidityUsd <= 0) return;

      const initialLiq = record.initialLiquidityUsd!;
      const dropPct = ((initialLiq - currentLiquidityUsd) / initialLiq) * 100;

      if (dropPct >= 80) {
        // Kaydı tekrar kontrol et — bu sürede satılmış olabilir
        const freshRecord = this.records.get(recordId);
        if (!freshRecord || freshRecord.status !== "active") return;

        console.log(
          `🚨 [Auto-Trader] Likidite %${dropPct.toFixed(0)} düştü: ${record.tokenSymbol} | ` +
          `Başlangıç: ${initialLiq.toFixed(0)} → Şimdi: ${currentLiquidityUsd.toFixed(0)} | ` +
          `Rug pull olarak kapatılıyor`
        );

        const position = this.tradeStore.getByMint(record.mintAddress);
        if (position && position.status === "open") {
          this.emit("auto_sell_ready", {
            positionId: position.id,
            forceClose: true,
            pnlPct: -100,
            reason: "liquidity_drop",
          });
          freshRecord.status = "sold";
          freshRecord.pnlPct = -100;
          this.emit("auto_trade_record_updated", freshRecord);
        }
      }
    } catch {
      // Sessizce devam et — likidite kontrolü kritik değil
    }
  }

  /**
   * Manuel olarak alım kaydını güncelle (routes.ts tarafından çağrılır)
   */
  updateRecordAfterBuy(
    mintAddress: string,
    buyTxSignature: string,
    buyPriceSol?: number,
    buyTokenAmount?: number
  ) {
    // mintAddress ile başlayan record'u bul
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && record.status === "pending") {
        record.status = "active";
        record.buyTxSignature = buyTxSignature;
        record.buyPriceSol = buyPriceSol;
        record.buyTokenAmount = buyTokenAmount;

        // Satış zamanını alım onaylandığında yeniden hesapla
        const config = this.configStore.getConfig();
        record.shouldSellAt = Date.now() + config.holdDurationMs;

        this.emit("auto_trade_record_updated", record);
        // Position'a autoSellAt bilgisini ekle
        this.emit("auto_sell_at_updated", { mintAddress, autoSellAt: record.shouldSellAt });
        console.log(
          `✅ [Auto-Trader] Alım tamamlandı: ${record.tokenSymbol} | TX: ${buyTxSignature.slice(0, 16)}... | Satış: ${(config.holdDurationMs / 1000).toFixed(0)}s sonra`
        );
        break;
      }
    }
  }

  /**
   * Belirli bir mintAddress için shouldSellAt değerini döndür
   */
  getShouldSellAt(mintAddress: string): number | undefined {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && (record.status === "active" || record.status === "pending")) {
        return record.shouldSellAt;
      }
    }
    return undefined;
  }

  /**
   * Satış sonrası record'u güncelle
   */
  updateRecordAfterSell(
    mintAddress: string,
    sellTxSignature: string,
    sellPriceSol?: number,
    pnlSol?: number,
    pnlPct?: number
  ) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && record.status === "sold") {
        record.sellPriceSol = sellPriceSol;
        record.pnlSol = pnlSol;
        record.pnlPct = pnlPct;
        this.emit("auto_trade_record_updated", record);
        console.log(
          `✅ [Auto-Trader] Satış tamamlandı: ${record.tokenSymbol} | PnL: ${pnlSol?.toFixed(4) || "?"} SOL (${pnlPct?.toFixed(1) || "?"}%)`
        );
        // Görülen symbol/name kombinasyonlarına ekle (tekrar almamak için)
        const tokenKey = `${record.tokenSymbol}:${record.tokenName}`.toLowerCase();
        this.seenTokenSymbols.add(tokenKey);
        // Son 7 işlem kaydına ekle
        this.recentlyClosedTrades.push({ symbol: record.tokenSymbol, closedAt: Date.now() });
        if (this.recentlyClosedTrades.length > this.MAX_RECENT_TRADES) {
          this.recentlyClosedTrades.shift(); // En eski işlemi çıkar
        }
        break;
      }
    }
  }


  /**
   * Hata durumunda record'u güncelle
   */
  markRecordFailed(mintAddress: string, error: string) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && (record.status === "pending" || record.status === "active")) {
        record.status = "failed";
        record.error = error;
        this.emit("auto_trade_record_updated", record);
        console.error(
          `❌ [Auto-Trader] Hata: ${record.tokenSymbol} | ${error}`
        );
        break;
      }
    }
  }
}
