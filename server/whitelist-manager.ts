import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const WHITELIST_PATH = path.join(DATA_DIR, "whitelist.txt");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class WhitelistManager {
  private whitelist: Set<string> = new Set();

  constructor() {
    this.load();
  }

  private load() {
    try {
      ensureDir();
      if (!fs.existsSync(WHITELIST_PATH)) {
        // Varsayılan whitelist oluştur
        const defaultList = "PEPE\nDOGE\nSHIB\nFLOKI\n";
        fs.writeFileSync(WHITELIST_PATH, defaultList, "utf-8");
        console.log("📝 Whitelist dosyası oluşturuldu: data/whitelist.txt");
      }

      const content = fs.readFileSync(WHITELIST_PATH, "utf-8");
      this.whitelist = new Set(
        content
          .split("\n")
          .map((line) => line.trim().toUpperCase())
          .filter((line) => line.length > 0)
      );

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
    return this.whitelist.has(symbol.toUpperCase());
  }

  /**
   * Whitelist'i al
   */
  getWhitelist(): string[] {
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
    console.log(`✅ Whitelist güncellendi (${this.whitelist.size} token)`);
  }
}
