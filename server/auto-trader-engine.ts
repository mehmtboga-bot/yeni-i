/**
 * Otomatik Trading Motoru
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
  shouldSellAt: number;
  buyTxSignature?: string;
  status: "pending" | "active" | "sold" | "failed" | "closed" | "rug_detected";
  error?: string;
  buyPriceSol?: number;
  buyTokenAmount?: number;
  sellPriceSol?: number;
  pnlSol?: number;
  pnlPct?: number;
  initialLiquidityUsd?: number;
  closedAt?: number;
}

type EventEmitter = (event: string, data: any) => void;

export class AutoTraderEngine {
  private configStore: AutoTraderConfigStore;
  private tradeStore: TradeStore;
  private emit: EventEmitter;
  private trader: any;

  private records: Map<string, AutoTradeRecord> = new Map();
  private isRunning = false;
  private sellCheckInterval: NodeJS.Timeout | null = null;
  private processedLPs: Set<string> = new Set();
  private seenTokenSymbols: Set<string> = new Set();
  private recentlyClosedTrades: Array<{ symbol: string; closedAt: number }> = [];
  private readonly MAX_RECENT_TRADES = 7;

  // Satış tetikleme takibi — sell() kendi sonsuz döngüsünü yönetir, engine sadece ilk çağrıyı yapar
  private sellInProgress: Set<string> = new Set(); // mint → sell() zaten tetiklendi mi


  constructor(
    configStore: AutoTraderConfigStore,
    tradeStore: TradeStore,
    emit: EventEmitter,
    trader?: any
  ) {
    this.configStore = configStore;
    this.tradeStore = tradeStore;
    this.emit = emit;
    this.trader = trader;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("🤖 Otomatik Trading Motoru başlatıldı");
    this.startSellChecker();
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.sellCheckInterval) {
      clearInterval(this.sellCheckInterval);
      this.sellCheckInterval = null;
    }
    console.log("🛑 Otomatik Trading Motoru durduruldu");
  }

  getIsRunning(): boolean { return this.isRunning; }
  getRecords(): AutoTradeRecord[] { return Array.from(this.records.values()); }

  /**
   * LP tespit edildiğinde çağrılır
   */
  async onLPDetected(lpData: any) {
    const config = this.configStore.getConfig();
    if (!config.enabled) return;

    const { mintAddress, name, symbol } = lpData;
    if (!mintAddress) return;

    if (this.processedLPs.has(mintAddress)) {
      console.log(`⏭️ [Auto-Trader] ${symbol} zaten işlendi, atlanıyor`);
      return;
    }

    const liquidityUsd: number | undefined = lpData.liquidityUsd ?? lpData.tvlUsd;
    if (config.minLiquidityUsd > 0 && (liquidityUsd === undefined || liquidityUsd < config.minLiquidityUsd)) {
      console.log(`🚫 [Auto-Trader] Düşük likidite — ${symbol} atlanıyor | Likidite: ${liquidityUsd?.toFixed(0) ?? "?"} | Eşik: ${config.minLiquidityUsd}`);
      return;
    }

    const tokenKey = `${symbol}:${name}`.toLowerCase();
    if (this.seenTokenSymbols.has(tokenKey)) {
      console.log(`⏭️ [Auto-Trader] ${symbol} (${name}) daha önce görüldü, atlanıyor`);
      return;
    }
    this.seenTokenSymbols.add(tokenKey);

    const openPositions = this.tradeStore.getAll().filter(
      (p) => p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell"
    );
    if (openPositions.length >= config.maxTokensHeld) {
      console.warn(`⚠️ [Auto-Trader] Max token sayısına ulaşıldı (${openPositions.length}/${config.maxTokensHeld}), ${symbol} atlanıyor`);
      return;
    }

    this.processedLPs.add(mintAddress);
    const recordId = `auto-${mintAddress}-${Date.now()}`;
    const customHoldDurationMs: number | undefined = lpData.customHoldDurationMs;
    const holdMs = customHoldDurationMs ?? config.holdDurationMs;

    const record: AutoTradeRecord = {
      id: recordId,
      mintAddress,
      tokenName: name || "Bilinmiyor",
      tokenSymbol: symbol || "?",
      buyTimestamp: Date.now(),
      shouldSellAt: Date.now() + holdMs,
      status: "pending",
      initialLiquidityUsd: liquidityUsd,
    };
    this.records.set(recordId, record);
    this.emit("auto_trade_record_updated", record);

    console.log(`🤖 [Auto-Trader] İşlem başlatılıyor: ${symbol} | Tutma süresi: ${(holdMs / 1000).toFixed(0)}s${customHoldDurationMs !== undefined ? " (özel süre)" : ""}`);
    this.emit("auto_buy_ready", { mintAddress, name, symbol, dex: lpData.dex });
  }

  // ─────────────────────────────────────────────
  //  SATIŞ KONTROLÜ
  // ─────────────────────────────────────────────

  private startSellChecker() {
    this.sellCheckInterval = setInterval(() => this.checkAndSell(), 100);
  }

  private checkAndSell() {
    if (!this.isRunning) return;

    const now = Date.now();

    for (const [, record] of this.records.entries()) {
      if (record.status !== "active") continue;

      const position = this.tradeStore.getByMint(record.mintAddress);
      if (!position || position.status !== "open") continue;

      // sell() zaten tetiklendi mi? — tekrar tetikleme (sell() kendi döngüsünü yönetir)
      if (this.sellInProgress.has(record.mintAddress)) continue;

      const config = this.configStore.getConfig();

      // ─── Kar hedefi kontrolü ───
      const shouldSellForProfit =
        config.profitTargetPct > 0 && (position.unrealizedPnlPct ?? 0) >= config.profitTargetPct;

      // ─── Süre doldu mu? ───
      const shouldSellForTime = now >= record.shouldSellAt;

      if (!shouldSellForProfit && !shouldSellForTime) continue;

      const reason = shouldSellForProfit
        ? `Kar hedefi: +${(position.unrealizedPnlPct ?? 0).toFixed(1)}% (Hedef: ${config.profitTargetPct}%)`
        : `Tutma süresi doldu (${((now - record.buyTimestamp) / 1000).toFixed(0)}s)`;

      console.log(`💰 [Auto-Trader] Satış tetiklendi: ${record.tokenSymbol} — ${reason}`);

      // sell() ilk kez tetikleniyor — kendi sonsuz döngüsünü yönetir
      this.sellInProgress.add(record.mintAddress);
      record.status = "sold";
      this.emit("auto_trade_record_updated", record);

      if (this.trader) {
        this.trader.sell(position.id)
          .catch((err: any) => {
            console.error(`❌ [Auto-Trader] ${record.tokenSymbol} sell() başlatma hatası: ${err?.message ?? err}`);
          })
          .finally(() => {
            this.sellInProgress.delete(record.mintAddress);
          });
      } else {
        // Trader direkt bağlı değil — event yayınla
        this.emit("auto_sell_ready", { positionId: position.id });
        this.sellInProgress.delete(record.mintAddress);
      }
    }
  }

  // ─────────────────────────────────────────────
  //  KAYIT GÜNCELLEME METOTları
  // ─────────────────────────────────────────────

  updateRecordAfterBuy(
    mintAddress: string,
    buyTxSignature: string,
    buyPriceSol?: number,
    buyTokenAmount?: number
  ) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && record.status === "pending") {
        record.status = "active";
        record.buyTxSignature = buyTxSignature;
        record.buyPriceSol = buyPriceSol;
        record.buyTokenAmount = buyTokenAmount;

        const config = this.configStore.getConfig();
        const position = this.tradeStore.getByMint(mintAddress);
        const holdMs = position?.customHoldDurationMs ?? config.holdDurationMs;
        record.shouldSellAt = Date.now() + holdMs;

        this.emit("auto_trade_record_updated", record);
        this.emit("auto_sell_at_updated", { mintAddress, autoSellAt: record.shouldSellAt });
        console.log(
          `✅ [Auto-Trader] Alım tamamlandı: ${record.tokenSymbol} | TX: ${buyTxSignature.slice(0, 16)}... | ` +
          `Satış: ${(holdMs / 1000).toFixed(0)}s sonra${position?.customHoldDurationMs ? " (özel süre)" : ""}`
        );
        break;
      }
    }
  }

  updatePositionHoldDuration(mintAddress: string, holdDurationMs: number) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && (record.status === "active" || record.status === "pending")) {
        const newSellAt = record.buyTimestamp + holdDurationMs;
        record.shouldSellAt = newSellAt;
        this.emit("auto_trade_record_updated", record);
        this.emit("auto_sell_at_updated", { mintAddress, autoSellAt: newSellAt });
        console.log(`⏱️ [Auto-Trader] ${record.tokenSymbol} özel tutma süresi güncellendi: ${(holdDurationMs / 1000).toFixed(0)}s`);
        break;
      }
    }
  }

  getShouldSellAt(mintAddress: string): number | undefined {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && (record.status === "active" || record.status === "pending")) {
        return record.shouldSellAt;
      }
    }
    return undefined;
  }

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
        console.log(`✅ [Auto-Trader] Satış tamamlandı: ${record.tokenSymbol} | PnL: ${pnlSol?.toFixed(4) || "?"} SOL (${pnlPct?.toFixed(1) || "?"}%)`);
        const tokenKey = `${record.tokenSymbol}:${record.tokenName}`.toLowerCase();
        this.seenTokenSymbols.add(tokenKey);
        this.recentlyClosedTrades.push({ symbol: record.tokenSymbol, closedAt: Date.now() });
        if (this.recentlyClosedTrades.length > this.MAX_RECENT_TRADES) this.recentlyClosedTrades.shift();
        this.sellInProgress.delete(mintAddress);
        break;
      }
    }
  }

  markRecordClosed(mintAddress: string) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && (record.status === "active" || record.status === "sold")) {
        record.status = "closed";
        record.closedAt = Date.now();
        this.emit("auto_trade_record_updated", record);
        console.log(`✅ [Auto-Trader] ${record.tokenSymbol} manuel satıldı, record kapatıldı`);
        this.sellInProgress.delete(mintAddress);
        break;
      }
    }
  }

  markRecordFailed(mintAddress: string, error: string) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && (record.status === "pending" || record.status === "active")) {
        record.status = "failed";
        record.error = error;
        this.emit("auto_trade_record_updated", record);
        console.error(`❌ [Auto-Trader] Hata: ${record.tokenSymbol} | ${error}`);
        break;
      }
    }
  }

  markRecordRugDetected(mintAddress: string, reason: string) {
    for (const [, record] of this.records.entries()) {
      if (record.mintAddress === mintAddress && (record.status === "active" || record.status === "sold")) {
        record.status = "rug_detected";
        record.error = reason;
        record.pnlPct = -100;
        record.closedAt = Date.now();
        this.emit("auto_trade_record_updated", record);
        console.error(`🚨 [Auto-Trader] Rug pull tespit edildi: ${record.tokenSymbol} | ${reason}`);
        this.sellInProgress.delete(mintAddress);
        break;
      }
    }
  }
}
