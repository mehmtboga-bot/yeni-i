/**
 * Cüzdan Takibi — izlenen cüzdan adresi ve kendi Başlat/Durdur durumu.
 * Otomatik Trading'in enabled ayarından bağımsızdır.
 */
import fs from "fs";
import path from "path";
import type { WatchedWalletConfig } from "../shared/wallet-tracking";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "wallet-tracking.json");
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class WalletTracker {
  private cfg: WatchedWalletConfig = { walletAddress: "", running: false };

  constructor() {
    try {
      if (fs.existsSync(FILE)) {
        const d = JSON.parse(fs.readFileSync(FILE, "utf-8"));
        this.cfg.walletAddress = typeof d.walletAddress === "string" ? d.walletAddress : "";
      }
    } catch {}
    // Yeniden başlatmada güvenli taraf: her zaman durdurulmuş başla
  }

  private persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({ walletAddress: this.cfg.walletAddress }, null, 2));
    } catch (e) {
      console.error("Cüzdan takibi kaydedilemedi:", e);
    }
  }

  getConfig(): WatchedWalletConfig { return { ...this.cfg }; }

  setAddress(addr: string): { ok: boolean; error?: string } {
    const a = (addr || "").trim();
    if (a && !BASE58.test(a)) return { ok: false, error: "Geçersiz Solana cüzdan adresi" };
    if (this.cfg.running && a !== this.cfg.walletAddress) {
      return { ok: false, error: "Adresi değiştirmek için önce Durdur'a bas" };
    }
    this.cfg.walletAddress = a;
    this.persist();
    return { ok: true };
  }

  start(): { ok: boolean; error?: string } {
    if (!this.cfg.walletAddress) return { ok: false, error: "Önce cüzdan adresi kaydet" };
    this.cfg.running = true;
    return { ok: true };
  }

  stop() { this.cfg.running = false; }
}
