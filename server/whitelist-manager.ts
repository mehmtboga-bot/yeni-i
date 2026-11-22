import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const WHITELIST_PATH = path.join(DATA_DIR, "whitelist.txt");
const CUSTOM_SECTION_HEADER = "---ÖZEL SÜRELİ---";

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class WhitelistManager {
  private whitelist: Set<string> = new Set();
  /** TOKEN → özel tutma süresi (ms). Bölüm 2'deki tokenler için. */
  private customDurations: Map<string, number> = new Map();
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
        // Varsayılan whitelist oluştur (iki bölümlü format)
        const defaultList =
          "PEPE\nDOGE\nSHIB\nFLOKI\n\n" +
          CUSTOM_SECTION_HEADER + "\n" +
          "# TOKEN:SANIYE formatında özel süreli tokenler\n" +
          "# Örnek: GDOR:300\n";
        fs.writeFileSync(WHITELIST_PATH, defaultList, "utf-8");
        console.log("📝 Whitelist dosyası oluşturuldu: data/whitelist.txt");
      }

      // Dosya değiştirildi mi kontrol et
      const stats = fs.statSync(WHITELIST_PATH);
      const fileModTime = stats.mtimeMs;

      // Dosya değiştirilmemişse, bellekteki listeyi kullan
      if (this.lastLoadTime > 0 && fileModTime === this.lastFileModTime) {
        console.log(`✅ Whitelist bellekten kullanılıyor (${this.whitelist.size} token, ${this.customDurations.size} özel süreli)`);
        return;
      }

      // Dosya değiştirilmişse, yeniden yükle
      const content = fs.readFileSync(WHITELIST_PATH, "utf-8");
      this.parseContent(content);

      this.lastLoadTime = Date.now();
      this.lastFileModTime = fileModTime;

      console.log(`✅ Whitelist yüklendi (${this.whitelist.size} token, ${this.customDurations.size} özel süreli)`);
    } catch (err) {
      console.error("❌ Whitelist yükleme hatası:", err);
      this.whitelist = new Set();
      this.customDurations = new Map();
    }
  }

  /**
   * Whitelist dosyasının içeriğini iki bölüme ayırarak parse et.
   *
   * Bölüm 1 (normal tokenler): Her satır bir token sembolü.
   * Bölüm 2 (özel süreli tokenler): "---ÖZEL SÜRELİ---" başlığından sonra
   *   TOKEN:SECONDS formatında satırlar (örn: GDOR:300).
   */
  private parseContent(content: string) {
    const newWhitelist = new Set<string>();
    const newCustomDurations = new Map<string, number>();

    const lines = content.split("\n");
    let inCustomSection = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Yorum satırlarını ve boş satırları atla
      if (line.length === 0 || line.startsWith("#")) continue;

      // Bölüm 2 başlığını tespit et
      if (line.toUpperCase() === CUSTOM_SECTION_HEADER.toUpperCase()) {
        inCustomSection = true;
        continue;
      }

      if (inCustomSection) {
        // TOKEN:SECONDS formatı
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const symbol = line.slice(0, colonIdx).trim().toUpperCase();
          const seconds = parseInt(line.slice(colonIdx + 1).trim(), 10);
          if (symbol.length > 0 && !isNaN(seconds) && seconds > 0) {
            newWhitelist.add(symbol);
            newCustomDurations.set(symbol, seconds * 1000); // saniyeyi ms'ye çevir
          }
        }
      } else {
        // Bölüm 1: normal token sembolü
        const symbol = line.toUpperCase();
        if (symbol.length > 0) {
          newWhitelist.add(symbol);
        }
      }
    }

    this.whitelist = newWhitelist;
    this.customDurations = newCustomDurations;
  }

  /**
   * Token whitelist'te mi?
   */
  isWhitelisted(symbol: string): boolean {
    this.loadIfNeeded(); // Dosya değiştirilmişse yükle
    return this.whitelist.has(symbol.toUpperCase());
  }

  /**
   * Token için özel tutma süresi var mı? Varsa ms cinsinden döndür.
   * Yoksa undefined döndür (global holdDurationMs kullanılacak).
   */
  getCustomHoldDurationMs(symbol: string): number | undefined {
    this.loadIfNeeded();
    return this.customDurations.get(symbol.toUpperCase());
  }

  /**
   * Whitelist'i al
   */
  getWhitelist(): string[] {
    this.loadIfNeeded(); // Dosya değiştirilmişse yükle
    return Array.from(this.whitelist).sort();
  }

  /**
   * Whitelist'i güncelle (ham dosya içeriğini olduğu gibi yaz ve yeniden parse et).
   * İki bölümlü formatı korur.
   */
  updateWhitelist(rawLines: string[]) {
    // Ham satırları dosyaya yaz (format korunur)
    ensureDir();
    const content = rawLines.join("\n") + (rawLines[rawLines.length - 1] === "" ? "" : "\n");
    fs.writeFileSync(WHITELIST_PATH, content, "utf-8");

    // Yeniden parse et
    this.parseContent(content);

    // Dosya mod zamanını güncelle
    const stats = fs.statSync(WHITELIST_PATH);
    this.lastFileModTime = stats.mtimeMs;
    this.lastLoadTime = Date.now();

    console.log(`✅ Whitelist güncellendi (${this.whitelist.size} token, ${this.customDurations.size} özel süreli)`);
  }

  /**
   * Dosya dışarıdan yazıldıktan sonra bellekteki listeyi yenile.
   * Dosyayı tekrar yazmaz — sadece okur ve parse eder.
   */
  reloadFromFile() {
    try {
      if (!fs.existsSync(WHITELIST_PATH)) return;
      const content = fs.readFileSync(WHITELIST_PATH, "utf-8");
      this.parseContent(content);
      const stats = fs.statSync(WHITELIST_PATH);
      this.lastFileModTime = stats.mtimeMs;
      this.lastLoadTime = Date.now();
      console.log(`✅ Whitelist yeniden yüklendi (${this.whitelist.size} token, ${this.customDurations.size} özel süreli)`);
    } catch (err) {
      console.error("❌ Whitelist yeniden yükleme hatası:", err);
    }
  }
}
