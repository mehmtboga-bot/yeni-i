/**
 * Auto-Trader Konfigürasyon Yöneticisi
 * 
 * Otomatik trading ayarlarını tutar ve kalıcı olarak kaydeder
 */

import fs from "fs";
import path from "path";

export interface AutoTraderConfig {
  enabled: boolean;
  solAmountPerTrade: number;        // Her işlem başına SOL (örn: 0.1)
  maxTokensHeld: number;            // Maksimum tutulacak token sayısı
  holdDurationMs: number;           // Tutma süresi (ms)
  profitTargetPct: number;          // Kar hedefi (%)
  stopLossPct: number;              // Zarar limiti (%)
  slippageBps: number;              // Slippage (bps)
  priorityFeeMicroLamports: number; // Priority fee
  minLiquidityUsd: number;          // Minimum likidite eşiği (USD)
  skipRecentlyTradedSymbols: boolean; // Son 7 işlemde aynı symbol varsa atla
  halfSellTarget1: number;          // Yarı satış hedef 1 (%)
  halfSellTarget2: number;          // Yarı satış hedef 2 (%)
  halfSellTarget3: number;          // Yarı satış hedef 3 (%)
}

const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  solAmountPerTrade: 0.1,
  maxTokensHeld: 5,
  holdDurationMs: 5 * 1000,        // 5 saniye
  profitTargetPct: 50,             // %50 kar
  stopLossPct: 20,                 // %20 zarar
  slippageBps: 5000,               // %50 slippage
  priorityFeeMicroLamports: 1_000_000,
  minLiquidityUsd: 5000,           // Minimum $5,000 likidite
  skipRecentlyTradedSymbols: true, // Son 7 işlemde aynı symbol varsa atla
  halfSellTarget1: 0,
  halfSellTarget2: 0,
  halfSellTarget3: 0,
};

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "auto-trader-config.json");

export class AutoTraderConfigStore {
  private config: AutoTraderConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): AutoTraderConfig {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, "utf-8");
        const loaded = JSON.parse(data) as AutoTraderConfig;
        console.log("✅ Auto-trader konfigürasyonu yüklendi");
        return { ...DEFAULT_CONFIG, ...loaded };
      }
    } catch (err) {
      console.warn("⚠️ Auto-trader konfigürasyonu yüklenmedi, varsayılan kullanılıyor");
    }

    return { ...DEFAULT_CONFIG };
  }

  private saveConfig() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), "utf-8");
      console.log("💾 Auto-trader konfigürasyonu kaydedildi");
    } catch (err) {
      console.error("❌ Auto-trader konfigürasyonu kaydedilemedi:", err);
    }
  }

  getConfig(): AutoTraderConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<AutoTraderConfig>): AutoTraderConfig {
    this.config = { ...this.config, ...partial };
    this.saveConfig();
    
    const status = this.config.enabled ? "✅ AÇIK" : "❌ KAPALI";
    console.log(
      `🔧 Auto-trader güncellendi [${status}] | SOL/işlem: ${this.config.solAmountPerTrade} | Max token: ${this.config.maxTokensHeld} | Tutma: ${(this.config.holdDurationMs / 1000).toFixed(0)}s | Min Likidite: ${this.config.minLiquidityUsd}`
    );

    return { ...this.config };
  }
}
