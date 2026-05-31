import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const WHITELIST_PATH = path.join(DATA_DIR, "whitelist.txt");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class WhitelistManager {
  private whitelist: Set<string> = new Set();
  private lastLoadTime: number = 0;
  private lastFileModTime: number = 0;

  constructor() {
    this.loadIfNeeded();
  }

  /**
   * Dosya değiştirilmişse yeniden yükle, yoksa bellekteki listeyi kullan
   */
  private loadIfNeeded() {
    try {
      ensureDir();

      // Dosya var mı kontrol et
      if (!fs.existsSync(WHITELIST_PATH)) {
        // Varsayılan whitelist oluştur
        const defaultList = "PEPE\nDOGE\nSHIB\nFLOKI\n";
        fs.writeFileSync(WHITELIST_PATH, defaultList, "utf-8");
        console.log("📝 Whitelist dosyası oluşturuldu: data/whitelist.txt");
      }

      // Dosya değiştirildi mi kontrol et
      const stats = fs.statSync(WHITELIST_PATH);
      const fileModTime = stats.mtimeMs;

      // Dosya değiştirilmemişse, bellekteki listeyi kullan
      if (this.lastLoadTime > 0 && fileModTime === this.lastFileModTime) {
        console.log(`✅ Whitelist bellekten kullanılıyor (${this.whitelist.size} token)`);
        return;
      }

      // Dosya değiştirilmişse, yeniden yükle
      const content = fs.readFileSync(WHITELIST_PATH, "utf-8");
      this.whitelist = new Set(
        content
          .split("\n")
          .map((line) => line.trim().toUpperCase())
          .filter((line) => line.length > 0)
      );

      this.lastLoadTime = Date.now();
      this.lastFileModTime = fileModTime;

      console.log(`✅ Whitelist yüklendi (${this.whitelist.size} token)`);
    } catch (err) {
      console.error("❌ Whitelist yükleme hatası:", err);
      this.whitelist = new Set();
    }
  }

  /**
   * Token whitelist'te mi?
   */
  isWhitelisted(symbol: string): boolean {
    this.loadIfNeeded(); // Dosya değiştirilmişse yükle
    return this.whitelist.has(symbol.toUpperCase());
  }

  /**
   * Whitelist'i al
   */
  getWhitelist(): string[] {
    this.loadIfNeeded(); // Dosya değiştirilmişse yükle
    return Array.from(this.whitelist).sort();
  }

  /**
   * Whitelist'i güncelle
   */
  updateWhitelist(symbols: string[]) {
    this.whitelist = new Set(
      symbols
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    );

    ensureDir();
    const content = Array.from(this.whitelist).sort().join("\n") + "\n";
    fs.writeFileSync(WHITELIST_PATH, content, "utf-8");

    // Dosya mod zamanını güncelle
    const stats = fs.statSync(WHITELIST_PATH);
    this.lastFileModTime = stats.mtimeMs;
    this.lastLoadTime = Date.now();

    console.log(`✅ Whitelist güncellendi (${this.whitelist.size} token)`);
  }
}
