/**
 * Auto Trader Engine
 * Otomatik alım-satım motoru - LP tespit edildiğinde otomatik işlem yapar
 */

import type { Position } from "@shared/schema";
import { AutoTraderConfigStore, type AutoTraderConfig } from "./auto-trader-config";
import { TradeStore } from "./trade-store";

export interface AutoTradeRecord {
  id: string;
  mintAddress: string;
  tokenSymbol: string;
  status: "pending" | "bought" | "sold" | "cancelled" | "failed";
  lpDetectedAt: number;
  buyTxSignature?: string;
  buyPrice?: number;
  buyAmount?: number;
  sellTxSignature?: string;
  sellPrice?: number;
  pnl?: number;
  pnlPct?: number;
  reason?: string;
}

type Emitter = (event: string, data: any) => void;

export class AutoTraderEngine {
  private configStore: AutoTraderConfigStore;
  private tradeStore: TradeStore;
  private emitter: Emitter;
  private records: Map<string, AutoTradeRecord> = new Map();
  private running = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    configStore: AutoTraderConfigStore,
    tradeStore: TradeStore,
    emitter: Emitter
  ) {
    this.configStore = configStore;
    this.tradeStore = tradeStore;
    this.emitter = emitter;
  }

  start() {
    if (this.running) {
      console.log("⚠️ Auto-trader zaten çalışıyor");
      return;
    }

    this.running = true;
    console.log("🚀 Auto-trader başlatıldı");

    // Her 5 saniyede kontrol et
    this.checkInterval = setInterval(() => this.checkAndExecute(), 5000);
  }

  stop() {
    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("🛑 Auto-trader durduruldu");
  }

  /**
   * LP tespit edildiğinde çağırılır
   */
  async onLPDetected(lpData: any) {
    if (!this.configStore.getConfig().enabled) return;

    const { mintAddress, name, symbol } = lpData;
    const record: AutoTradeRecord = {
      id: `${mintAddress}-${Date.now()}`,
      mintAddress,
      tokenSymbol: symbol || "?",
      status: "pending",
      lpDetectedAt: Date.now(),
      reason: "LP detected",
    };

    this.records.set(record.id, record);
    console.log(`📝 Auto-trader kaydı oluşturuldu: ${symbol} (${mintAddress.slice(0, 8)}...)`);

    this.emitter("auto_trade_record_updated", record);
  }

  /**
   * Periyodik olarak pending satışları kontrol et
   */
  private checkAndExecute() {
    const config = this.configStore.getConfig();
    if (!config.enabled || !this.running) return;

    const now = Date.now();

    for (const [recordId, record] of this.records.entries()) {
      // Satın aldı ve tutma süresi geçti mi?
      if (record.status === "bought" && record.buyTxSignature && record.buyPrice !== undefined) {
        const holdTime = now - (record.lpDetectedAt ?? 0);

        if (holdTime > config.holdDurationMs) {
          console.log(
            `⏱️ Auto-sell trigger: ${record.tokenSymbol} | Tutma süresi geçti (${(holdTime / 1000).toFixed(0)}s)`
          );
          this.emitter("auto_sell_ready", { positionId: record.id, record });
        }
      }
    }
  }

  /**
   * Satın alma tamamlandığında çağırılır
   */
  updateRecordAfterBuy(mintAddress: string, txSignature: string, buyPrice: number, buyAmount?: number) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && record.status === "pending") {
        record.status = "bought";
        record.buyTxSignature = txSignature;
        record.buyPrice = buyPrice;
        record.buyAmount = buyAmount;
        console.log(`✅ Auto-trade satın alındı: ${record.tokenSymbol}`);
        this.emitter("auto_trade_record_updated", record);
        break;
      }
    }
  }

  /**
   * Satış tamamlandığında çağırılır
   */
  updateRecordAfterSell(
    mintAddress: string,
    txSignature: string,
    sellPrice: number,
    pnl?: number,
    pnlPct?: number
  ) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && record.status === "bought") {
        record.status = "sold";
        record.sellTxSignature = txSignature;
        record.sellPrice = sellPrice;
        record.pnl = pnl;
        record.pnlPct = pnlPct;
        console.log(`✅ Auto-trade satışı tamamlandı: ${record.tokenSymbol} | PnL: ${(pnlPct ?? 0).toFixed(2)}%`);
        this.emitter("auto_trade_record_updated", record);
        break;
      }
    }
  }

  getRecords(): AutoTradeRecord[] {
    return Array.from(this.records.values()).reverse();
  }

  isRunning(): boolean {
    return this.running;
  }
}
