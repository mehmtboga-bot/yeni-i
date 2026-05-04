import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WS_URL = `wss://mainnet.helius-
rpc.com/?api-key=${HELIUS_API_KEY}`;
const HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramNotification(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram bilgileri eksik.");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    const data = await res.json();
    if (data.ok) {
      console.log("📲 Telegram bildirimi gönderildi.");
    } else {
      console.error("❌ Telegram hatası:", data.description);
    }
  } catch (err) {
    console.error("❌ Telegram bildirim hatası:", err);
  }
}

// ─── Program ID'leri ────────────────────────────────────────────────────────
const PUMPSWAP        = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMPFUN         = "6EF8rrecthR5Dkzon8Nwuxe8fuMDg6uG5TZAR4m226GG";
const RAYDIUM_AMM     = "675kPX9MHTjS2zt1qrXiE48DqBJ5R8k6rJsV5ln32Xw";
const RAYDIUM_CLMM    = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const METEORA_DLMM    = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const METEORA_DYNAMIC = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vA"; // DY2

// WS-2'nin dinleyeceği DEX programları
// Pump.fun burada YOK: graduation'lar zaten PumpSwap üzerinden yakalanıyor
const DEX_PROGRAMS: Record<string, string> = {
  [PUMPSWAP]:        "PumpSwap",
  [RAYDIUM_AMM]:     "Raydium AMM",
  [RAYDIUM_CLMM]:    "Raydium CLMM",
  [METEORA_DLMM]:    "Meteora DLMM",
  [METEORA_DYNAMIC]: "Meteora DY2",
};

// Gerçek LP locker programları — DEX program ID'leri burada YOK
// (token bir DEX pool'unda olması kilitli olduğu anlamına gelmez)
const LOCKER_MAP: Record<string, string> = {
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m": "Streamflow",
  "Lock7hkde9SshYpYm6QPY9B8p51T5T21yH5S93p57jS": "PinkSale",
  "TSLvdd1pWpHViyvS19BneW8S5Wv8V784L596Ym8p1S":  "Team Finance",
  "LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw": "Sol Incinerator",
  "7Vbmv1jt4vyuqBZcpYPpnVhrqVe5e6ZRT3gqRPLR85Rb": "Meteora Lock",
  "locker9XKiFLBkSMxiHMFJeXVDKMi9ZDRv2nTkLEF3kM": "Unicrypt",
  "CrX7kMhLC3cSsXJdT7JDgqrRVWGnUpX3gfEfxxU2NVLi": "Raydium Lock",
};

const BURN_ADDRESS = "11111111111111111111111111111111";
const WSOL         = "So11111111111111111111111111111111111111112";

const MAX_AGE_MS = 120000;
const MAX_TRACKED = 7;

// Telegram bildirimi için minimum TVL eşiği (USD)
// TVL = 2 × SOL × fiyat (havuzun toplam değeri)
const MIN_TVL_USD_NOTIFY = 40000;

// Trojan Solana Bot deeplink üreticisi (tıklayınca Trojan'da o token açılır)
// Format: r-REFKODU-MINT  → hem token sayfası açılır hem referans kazandırır
const TROJAN_BOT = "solana_trojanbot";
const TROJAN_REF = "mehmtbga";
const trojanUrl = (mint: string) => `https://t.me/${TROJAN_BOT}?start=r-${TROJAN_REF}-${mint}`;

// WS-2: Her DEX programına özel pool OLUŞTURMA keyword'leri
// Program bağlamına göre filtreleme → swap işlemleri elenir, false positive azalır
const DEX_LP_KEYWORDS: Record<string, string[]> = {
  [PUMPSWAP]:        ["Instruction: CreatePool"],
  [RAYDIUM_AMM]:     ["Instruction: Initialize2"],
  [RAYDIUM_CLMM]:    ["Instruction: CreatePool"],
  [METEORA_DLMM]:    ["Instruction: InitializeLbPair", "Instruction: InitializePermissionlessLbPair"],
  [METEORA_DYNAMIC]: ["Instruction: InitializePermissionlessConstantProductPool", "Instruction: InitializePermissionlessPool"],
};

// WS-1 per-token izleme için birleşik liste (token mint subscription bağlamında false positive riski düşük)
const LP_KEYWORDS = [...new Set(Object.values(DEX_LP_KEYWORDS).flat())];

interface TokenMetadata {
  name: string;
  symbol: string;
}

interface ActiveMint {
  timestamp: number;
  metadata: TokenMetadata;
  lpWebSocket?: WebSocket;
  lpLogged?: boolean;
}

interface LockResult {
  isLocked: boolean;
  lockDuration: string;
}

export class HeliusMonitor {
  // WS-1: Tüm yeni SPL mint tespiti
  private mainWebSocket: WebSocket | null = null;
  // WS-2: DEX LP izleme (PumpSwap + Raydium AMM/CLMM + Meteora DLMM/DY2)
  private dexWebSocket: WebSocket | null = null;
  // WS-3: Locker programlarını anlık dinle (Streamflow, Unicrypt, Raydium Lock vb.)
  private lockerWebSocket: WebSocket | null = null;

  private activeMints: Map<string, ActiveMint> = new Map();
  private processedDexSignatures: Set<string> = new Set();
  private processedLockerSignatures: Set<string> = new Set();

  private reconnectTimeoutMain: NodeJS.Timeout | null = null;
  private reconnectTimeoutDex: NodeJS.Timeout | null = null;
  private reconnectTimeoutLocker: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private eventEmitter: (event: string, data: any) => void;
  private isRunning = false;

  // Bot açılışında bir kere çekilen SOL/USD fiyatı — tüm USD/TVL hesapları bunu kullanır
  private solPriceUsd: number = 0;

  constructor(eventEmitter: (event: string, data: any) => void) {
    this.eventEmitter = eventEmitter;
  }

  async start() {
    if (this.isRunning) { console.log("⚠️ Monitor zaten çalışıyor"); return; }
    this.isRunning = true;
    console.log("🚀 Helius Monitor başlatılıyor (Üçlü WebSocket)...");
    this.eventEmitter("monitoring_state", { isMonitoring: true });

    // SOL fiyatını sadece bir kez çek; pipeline boyunca aynı değer kullanılacak
    await this.fetchSolPriceOnce();

    this.connectMain();
    this.connectDex();
    this.connectLocker();
    this.startHeartbeat();
  }

  // Bot başlatılırken bir kere SOL/USD fiyatını çek
  // Başarısız olursa fallback olarak $87 kullan → USD/TVL alanları HER ZAMAN dolu döner
  private async fetchSolPriceOnce(): Promise<void> {
    const FALLBACK_SOL_PRICE = 87;
    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // 1. Jupiter Lite API (yeni, public endpoint)
    try {
      const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
      const data = await res.json();
      const price = data?.[SOL_MINT]?.usdPrice;
      if (typeof price === "number" && price > 0) {
        this.solPriceUsd = price;
        console.log(`💵 SOL/USD fiyatı alındı (Jupiter): $${price.toFixed(2)} (oturum boyunca sabit)`);
        return;
      }
    } catch (err) {
      console.warn("⚠️ Jupiter fiyat API'si başarısız, CoinGecko deneniyor...", (err as Error).message);
    }

    // 2. CoinGecko fallback
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
      const data = await res.json();
      const price = data?.solana?.usd;
      if (typeof price === "number" && price > 0) {
        this.solPriceUsd = price;
        console.log(`💵 SOL/USD fiyatı alındı (CoinGecko): $${price.toFixed(2)} (oturum boyunca sabit)`);
        return;
      }
    } catch (err) {
      console.error(`❌ CoinGecko da başarısız:`, (err as Error).message);
    }

    // 3. Sabit fallback
    this.solPriceUsd = FALLBACK_SOL_PRICE;
    console.warn(`⚠️ Hiçbir fiyat API'si çalışmadı, sabit $${FALLBACK_SOL_PRICE} kullanılıyor.`);
  }

  // SOL → USD ve TVL hesabı
  // SOL = pool'un WSOL tarafı (havuzun yarısı)
  // USD = SOL × fiyat (bir tarafın dolar değeri)
  // TVL = 2 × SOL × fiyat = 2 × USD (havuzun toplam değeri = iki taraf)
  private toUsd(sol: number | undefined): { usd?: number; tvlUsd?: number } {
    if (!sol || !this.solPriceUsd) return {};
    const usd = sol * this.solPriceUsd;
    return { usd, tvlUsd: usd * 2 };
  }

  getState() { return this.isRunning; }

  async getWalletBalance(publicKey: string): Promise<number> {
    const res = await fetch(HTTP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getBalance",
        params: [publicKey, { commitment: "confirmed" }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const lamports = data.result?.value;
    if (lamports === undefined) throw new Error("Bakiye alınamadı");
    return lamports / 1e9;
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.sendHeartbeat();
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 60 * 60 * 1000);
  }

  private sendHeartbeat() {
    const now = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
    sendTelegramNotification(
      `📡 <b>Sistem Aktif — Taranıyor</b>\n\n` +
      `🕐 <b>Saat:</b> ${now}\n` +
      `✅ Helius bağlantısı canlı\n` +
      `🔍 Yeni SPL tokenlar izleniyor\n` +
      `🔍 PumpSwap + Raydium AMM/CLMM + Meteora DLMM/DY2 LP'leri izleniyor\n` +
      `🔒 Streamflow, Unicrypt, Raydium Lock vb. locker'lar anlık izleniyor\n\n` +
      `<i>LP kilitlendiği anda bildirim alacaksınız.</i>`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WS-1 — SPL Token Program: Tüm yeni mintleri yakala
  //         Raydium/PumpSwap/Meteora'da oluşan tokenlar da burada görünür
  // ═══════════════════════════════════════════════════════════════════════════
  private connectMain() {
    if (!HELIUS_API_KEY) {
      this.eventEmitter("error", { message: "HELIUS_API_KEY eksik", type: "config" });
      return;
    }
    this.mainWebSocket = new WebSocket(WS_URL);

    this.mainWebSocket.on("open", () => {
      console.log("✅ [WS-1] SPL Token WebSocket bağlandı");
      this.mainWebSocket?.send(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [SPL_TOKEN_PROGRAM_ID] }, { commitment: "confirmed" }],
      }));
      this.eventEmitter("connection_status", { connected: true, isMonitoring: true });
    });

    this.mainWebSocket.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const logs: string[] | undefined = msg?.params?.result?.value?.logs;
        const signature: string | undefined = msg?.params?.result?.value?.signature;
        if (!logs || !signature) return;

        for (const log of logs) {
          if (log.includes("Program log: Instruction: InitializeMint")) {
            await this.handleNewMint(signature);
            break;
          }
        }
      } catch (err) {
        console.error("❌ [WS-1] Mesaj hatası:", err);
      }
    });

    this.mainWebSocket.on("error", (err: any) => {
      console.error("❌ [WS-1] Hata:", err);
      const isAuth = err.message?.includes("401");
      if (isAuth) this.eventEmitter("error", { message: "API anahtarı hatalı", type: "auth" });
      this.eventEmitter("connection_status", {
        connected: false,
        message: isAuth ? "API anahtarı hatası" : "Bağlantı hatası",
        isMonitoring: this.isRunning,
      });
    });

    this.mainWebSocket.on("close", () => {
      console.log("🔌 [WS-1] Bağlantı kapandı");
      this.eventEmitter("connection_status", {
        connected: false,
        message: this.isRunning ? "Yeniden bağlanıyor..." : "Monitor durduruldu",
        isMonitoring: this.isRunning,
      });
      if (this.isRunning) {
        this.reconnectTimeoutMain = setTimeout(() => this.connectMain(), 3000);
      }
    });
  }

  // Yeni mint tespit edildi → arayüze bildir + LP izlemeye başla
  private async handleNewMint(signature: string) {
    try {
      const mintAddress = await this.fetchMintAddress(signature);
      if (!mintAddress || this.activeMints.has(mintAddress)) return;

      if (this.activeMints.size >= MAX_TRACKED) {
        const oldestKey = Array.from(this.activeMints.keys())[0];
        const oldest = this.activeMints.get(oldestKey);
        if (oldest?.lpWebSocket) oldest.lpWebSocket.close();
        this.activeMints.delete(oldestKey);
      }

      const metadata = await this.fetchTokenMetadata(mintAddress);
      if (!metadata) return;

      console.log(`🪙 [WS-1] Yeni mint: ${metadata.name} (${metadata.symbol}) — ${mintAddress}`);

      const detectedAt = Date.now();
      this.activeMints.set(mintAddress, { timestamp: detectedAt, metadata, lpLogged: false });

      this.eventEmitter("mint_detected", {
        id: mintAddress, mintAddress,
        name: metadata.name, symbol: metadata.symbol,
        detectedAt, expiresAt: detectedAt + 3 * 60 * 1000,
        isLocked: false,
      });

      // Per-token LP izleme (2 dakika içinde LP oluşursa yakalar)
      this.monitorLP(mintAddress, metadata);
    } catch (err) {
      console.error("❌ [WS-1] Mint tespit hatası:", err);
    }
  }

  // Per-token WebSocket: token mint'i için 2 dakika LP bekle
  private monitorLP(mintAddress: string, metadata: TokenMetadata) {
    const wsLP = new WebSocket(WS_URL);

    wsLP.on("open", () => {
      wsLP.send(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [mintAddress] }, { commitment: "confirmed" }],
      }));
    });

    wsLP.on("error", (err) => {
      console.error(`❌ LP WS hatası ${mintAddress}:`, err);
    });

    wsLP.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const logs: string[] | undefined = msg?.params?.result?.value?.logs;
        const txSignature: string | undefined = msg?.params?.result?.value?.signature;
        if (!logs || !txSignature) return;

        const mintData = this.activeMints.get(mintAddress);
        if (!mintData || Date.now() - mintData.timestamp > MAX_AGE_MS) {
          wsLP.close();
          this.activeMints.delete(mintAddress);
          return;
        }

        const hasLPKeyword = logs.some((log) => LP_KEYWORDS.some((kw) => log.includes(kw)));
        if (!hasLPKeyword) return;

        const { lpMint, liquidityAmount: txLiquidity } = await this.getLPMintFromTx(txSignature, mintAddress);
        const checkMint = lpMint || mintAddress;

        try {
          const lockResult = await this.checkLiquidityLock(checkMint);
          // TX'ten likidite çıkamadıysa pool'un gerçek TVL'sini zincirden çek
          // (Raydium CLMM / Meteora DLMM gibi pool önce boş kurulan tipler için kritik)
          let liquidityAmount = txLiquidity;
          if (!liquidityAmount && lpMint) {
            const poolLiq = await this.fetchPoolLiquidity(lpMint);
            if (poolLiq && poolLiq > 0) {
              liquidityAmount = poolLiq;
              console.log(`💧 [WS-1] TX'ten likidite çıkmadı, pool'dan alındı: ${poolLiq.toFixed(4)} SOL`);
            }
          }
          const platform = this.detectPlatformFromLogs(logs);

          const { usd: liquidityUsd, tvlUsd } = this.toUsd(liquidityAmount);

          if (!mintData.lpLogged) {
            const solStr = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "?";
            const usdStr = liquidityUsd ? ` ($${liquidityUsd.toFixed(0)})` : "";
            const tvlStr = tvlUsd ? ` | TVL ~$${tvlUsd.toFixed(0)}` : "";
            console.log(`${lockResult.isLocked ? "🔒" : "💧"} [WS-1] ${metadata.name} (${metadata.symbol}) | ${platform} | ${solStr}${usdStr}${tvlStr} | ${lockResult.isLocked ? lockResult.lockDuration : "Kilitsiz"}`);
            mintData.lpLogged = true;
          }

          // Tüm LP'leri (kilitli + kilitsiz) arayüze ilet
          const lpData = {
            id: `${mintAddress}-${Date.now()}`,
            mintAddress,
            lpMint: lpMint ?? undefined,
            name: metadata.name, symbol: metadata.symbol,
            detectedAt: Date.now(),
            expiresAt: Date.now() + 5 * 60 * 1000,
            isLocked: lockResult.isLocked,
            lockDuration: lockResult.lockDuration,
            liquidityAmount, liquidityUsd, tvlUsd, platform,
            jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
            dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
          };
          this.eventEmitter("lp_detected", lpData);

          // Telegram'a gönderim:
          //  • Kilitli LP'ler her zaman gönderilir
          //  • Kilitsiz olsa bile TVL ≥ $40.000 ise gönderilir
          //  TVL = 2 × SOL × fiyat (havuzun toplam değeri)
          const meetsUsdThreshold = (tvlUsd ?? 0) >= MIN_TVL_USD_NOTIFY;
          if (!lockResult.isLocked && !meetsUsdThreshold) {
            console.log(`🚫 [WS-1] Telegram atlandı | ${metadata.symbol} | likidite=${liquidityAmount?.toFixed(4) ?? "yok"} SOL | USD(tek taraf)=$${liquidityUsd?.toFixed(0) ?? "?"} | TVL=$${tvlUsd?.toFixed(0) ?? "?"} | eşik=$${MIN_TVL_USD_NOTIFY}`);
          }
          if (lockResult.isLocked || meetsUsdThreshold) {
            const sol = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "Bilinmiyor";
            const usdLine = liquidityUsd ? `\n💵 <b>USD:</b> $${liquidityUsd.toFixed(2)}` : "";
            const tvlLine = tvlUsd ? `\n📊 <b>TVL (~×2):</b> $${tvlUsd.toFixed(2)}` : "";
            const header = lockResult.isLocked
              ? `🔒 <b>KİLİTLİ LP!</b>`
              : `💰 <b>YÜKSEK LİKİDİTE LP! TVL: $${(tvlUsd ?? 0).toFixed(0)}</b>`;
            const lockLine = lockResult.isLocked
              ? `\n🏦 <b>Kilit:</b> ${lockResult.lockDuration}`
              : `\n🔓 <b>Kilit:</b> Yok (eşik üstü)`;
            sendTelegramNotification(
              `${header}\n\n` +
              `🏊 <b>Platform:</b> ${platform}\n` +
              `🪙 <b>Token:</b> ${metadata.name} (${metadata.symbol})` +
              `${lockLine}\n` +
              `💧 <b>Likidite:</b> ${sol}${usdLine}${tvlLine}\n` +
              `📋 <b>Mint:</b> <code>${mintAddress}</code>\n` +
              `🔗 <b>LP Mint:</b> <code>${checkMint}</code>\n\n` +
              `🔍 <a href="https://dexscreener.com/solana/${mintAddress}">Dexscreener</a> | ` +
              `🪐 <a href="https://jup.ag/swap/SOL-${mintAddress}">Jupiter</a> | ` +
              `🤖 <a href="${trojanUrl(mintAddress)}">Trojan ile Aç</a>`
            );
          }
        } catch (err) {
          console.error("❌ LP veri hatası:", err);
        } finally {
          wsLP.close();
          this.activeMints.delete(mintAddress);
        }
      } catch (err) {
        console.error("❌ LP mesaj hatası:", err);
      }
    });

    wsLP.on("close", () => { this.activeMints.delete(mintAddress); });

    const mintData = this.activeMints.get(mintAddress);
    if (mintData) mintData.lpWebSocket = wsLP;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WS-2 — DEX programları: PumpSwap + Raydium AMM/CLMM + Meteora DLMM/DY2
  //         LP oluşturma olaylarını direkt yakalar → LP mint kilidini kontrol eder
  //         Pump.fun → PumpSwap graduation dahil
  // ═══════════════════════════════════════════════════════════════════════════
  private connectDex() {
    if (!HELIUS_API_KEY) return;

    this.dexWebSocket = new WebSocket(WS_URL);

    this.dexWebSocket.on("open", () => {
      console.log("✅ [WS-2] DEX WebSocket bağlandı (PumpSwap + Raydium AMM/CLMM + Meteora DLMM/DY2)");
      // Her DEX için ayrı subscription
      Object.keys(DEX_PROGRAMS).forEach((programId, index) => {
        this.dexWebSocket?.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 100 + index,
          method: "logsSubscribe",
          params: [{ mentions: [programId] }, { commitment: "confirmed" }],
        }));
      });
    });

    this.dexWebSocket.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const logs: string[] | undefined = msg?.params?.result?.value?.logs;
        const signature: string | undefined = msg?.params?.result?.value?.signature;
        if (!logs || !signature) return;
        if (this.processedDexSignatures.has(signature)) return;

        // Önce hangi DEX programı olduğunu tespit et
        const programId = this.detectProgramIdFromLogs(logs);
        if (!programId) return;

        // O programa özgü keyword listesiyle LP oluşturma olayı mı kontrol et
        const dexKeywords = DEX_LP_KEYWORDS[programId] || [];
        const isLPEvent = logs.some((log) => dexKeywords.some((kw) => log.includes(kw)));
        if (!isLPEvent) return;

        this.processedDexSignatures.add(signature);
        if (this.processedDexSignatures.size > 500) {
          const first = this.processedDexSignatures.values().next().value;
          if (first) this.processedDexSignatures.delete(first);
        }

        const platform = DEX_PROGRAMS[programId] || "Bilinmeyen DEX";
        await this.handleDexLP(signature, platform);
      } catch (err) {
        console.error("❌ [WS-2] Mesaj hatası:", err);
      }
    });

    this.dexWebSocket.on("error", (err) => {
      console.error("❌ [WS-2] Hata:", err);
    });

    this.dexWebSocket.on("close", () => {
      console.log("🔌 [WS-2] DEX bağlantısı kapandı");
      if (this.isRunning) {
        this.reconnectTimeoutDex = setTimeout(() => this.connectDex(), 3000);
      }
    });
  }

  // DEX'te LP oluştu → token mint + LP mint bul → kilit kontrol et → bildir
  private async handleDexLP(signature: string, platform: string) {
    try {

      // İşlemden token mint, LP mint ve likidite miktarını çıkar (tek RPC çağrısı)
      const { tokenMint, lpMint, liquidityAmount: txLiquidity } = await this.extractMintsFromDexTx(signature);

      // tokenMint yoksa 3 retry sonrası da bulunamadı — swap işlemi olabilir, atla
      if (!tokenMint) {
        console.warn(`⚠️ [WS-2] ${platform} — token mint bulunamadı, swap işlemi olabilir.`);
        return;
      }

      // lpMint yoksa CLMM/DLMM pozisyon bazlı pool olabilir — kilit kontrolünü atla ama eventi yayınla
      const isPositionBased = !lpMint;
      const checkMint = lpMint || tokenMint;


      const [metadata, lockResult] = await Promise.all([
        this.fetchTokenMetadata(tokenMint),
        isPositionBased
          ? Promise.resolve({ isLocked: false, lockDuration: "CLMM/DLMM — LP mint yok" })
          : this.checkLiquidityLock(lpMint!),
      ]);

      // TX'ten alınan likidite değeri (sıfır gecikme, doğru değer)
      // TX'ten çıkmadıysa pool'un gerçek TVL'sini zincirden çek
      // (Raydium CLMM / Meteora DLMM / PumpSwap graduation için kritik)
      let liquidityAmount = txLiquidity;
      if (!liquidityAmount && lpMint) {
        const poolLiq = await this.fetchPoolLiquidity(lpMint);
        if (poolLiq && poolLiq > 0) {
          liquidityAmount = poolLiq;
          console.log(`💧 [WS-2] TX'ten likidite çıkmadı, pool'dan alındı: ${poolLiq.toFixed(4)} SOL`);
        }
      }

      // Metadata gelmese bile eventi yayınla — isim "Bilinmiyor" olarak gösterilir
      const name = metadata?.name || "Bilinmiyor";
      const symbol = metadata?.symbol || "?";
      const detectedAt = Date.now();
      const expiresAt = detectedAt + 5 * 60 * 1000;

      const { usd: liquidityUsd, tvlUsd } = this.toUsd(liquidityAmount);
      const sol = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "?";
      const usdStr = liquidityUsd ? ` ($${liquidityUsd.toFixed(0)})` : "";
      const tvlStr = tvlUsd ? ` | TVL ~$${tvlUsd.toFixed(0)}` : "";
      console.log(`${lockResult.isLocked ? "🔒" : "💧"} [WS-2] ${name} (${symbol}) | ${platform} | ${sol}${usdStr}${tvlStr} | ${lockResult.isLocked ? lockResult.lockDuration : "Kilitsiz"}`);

      // Tüm LP'leri arayüze ilet (kilitli ve kilitsiz)
      const lpData = {
        id: `${tokenMint}-${detectedAt}`,
        mintAddress: tokenMint,
        lpMint,
        name, symbol,
        detectedAt, expiresAt,
        isLocked: lockResult.isLocked,
        lockDuration: lockResult.lockDuration,
        liquidityAmount, liquidityUsd, tvlUsd, platform,
        jupiterUrl: `https://jup.ag/swap/SOL-${tokenMint}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
        pumpfunUrl: platform === "PumpSwap" ? `https://pump.fun/${tokenMint}` : undefined,
      };

      this.eventEmitter("lp_detected", lpData);

      // Telegram'a gönderim:
      //  • Kilitli LP'ler her zaman gönderilir
      //  • Kilitsiz olsa bile TVL ≥ $40.000 ise gönderilir
      //  TVL = 2 × SOL × fiyat (havuzun toplam değeri)
      const meetsUsdThreshold = (tvlUsd ?? 0) >= MIN_TVL_USD_NOTIFY;
      if (!lockResult.isLocked && !meetsUsdThreshold) {
        console.log(`🚫 [WS-2] Telegram atlandı | ${symbol} | ${platform} | likidite=${liquidityAmount?.toFixed(4) ?? "yok"} SOL | USD(tek taraf)=$${liquidityUsd?.toFixed(0) ?? "?"} | TVL=$${tvlUsd?.toFixed(0) ?? "?"} | eşik=$${MIN_TVL_USD_NOTIFY}`);
      }
      if (lockResult.isLocked || meetsUsdThreshold) {
        const usdLine = liquidityUsd ? `\n💵 <b>USD:</b> $${liquidityUsd.toFixed(2)}` : "";
        const tvlLine = tvlUsd ? `\n📊 <b>TVL (~×2):</b> $${tvlUsd.toFixed(2)}` : "";
        const header = lockResult.isLocked
          ? `🔒 <b>KİLİTLİ LP TESPİT EDİLDİ!</b>`
          : `💰 <b>YÜKSEK LİKİDİTE LP! TVL: $${(tvlUsd ?? 0).toFixed(0)}</b>`;
        const lockLine = lockResult.isLocked
          ? `\n🏦 <b>Kilit Türü:</b> ${lockResult.lockDuration}`
          : `\n🔓 <b>Kilit:</b> Yok (eşik üstü)`;
        sendTelegramNotification(
          `${header}\n\n` +
          `🏊 <b>Platform:</b> ${platform}\n` +
          `🪙 <b>Token:</b> ${name} (${symbol})` +
          `${lockLine}\n` +
          `💧 <b>Likidite:</b> ${sol}${usdLine}${tvlLine}\n` +
          `📋 <b>Token Mint:</b> <code>${tokenMint}</code>\n` +
          `🔗 <b>LP Mint:</b> <code>${lpMint ?? "Yok (CLMM/DLMM)"}</code>\n\n` +
          `🔍 <a href="https://dexscreener.com/solana/${tokenMint}">Dexscreener</a> | ` +
          `🪐 <a href="https://jup.ag/swap/SOL-${tokenMint}">Jupiter</a> | ` +
          `🤖 <a href="${trojanUrl(tokenMint)}">Trojan ile Aç</a>` +
          (platform === "PumpSwap" ? ` | 🌊 <a href="https://pump.fun/${tokenMint}">Pump.fun</a>` : "")
        );
      }
    } catch (err) {
      console.error("❌ [WS-2] DEX LP hatası:", err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Yardımcı: Log'lardan hangi DEX program ID'si geçtiğini döndür
  // WS-2 handler'da per-DEX keyword eşleşmesi için kullanılır
  // ═══════════════════════════════════════════════════════════════════════════
  private detectProgramIdFromLogs(logs: string[]): string | null {
    for (const log of logs) {
      for (const programId of Object.keys(DEX_PROGRAMS)) {
        if (log.includes(programId)) return programId;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Yardımcı: Log'lardan hangi DEX platformu olduğunu tespit et
  // ═══════════════════════════════════════════════════════════════════════════
  private detectPlatformFromLogs(logs: string[]): string {
    for (const log of logs) {
      for (const [programId, name] of Object.entries(DEX_PROGRAMS)) {
        if (log.includes(programId)) return name;
      }
    }
    return "Bilinmeyen DEX";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TX'den token mint, LP mint ve likidite miktarını çıkar
  // - tokenMint:      WSOL olmayan, önceden var olan token (pool'un trade token'ı)
  // - lpMint:         WSOL ve token mint olmayan, YENİ oluşturulan mint (LP token)
  // - liquidityAmount: TX'teki net WSOL girişi → pool'a yatırılan SOL (gerçek likidite)
  // ═══════════════════════════════════════════════════════════════════════════
  private async extractMintsFromDexTx(
    signature: string
  ): Promise<{ tokenMint: string | null; lpMint: string | null; liquidityAmount?: number }> {
    try {
      // İşlem henüz indexlenmemiş olabilir — 3 deneme, 1.5s ara ile
      let meta: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getTransaction",
            params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
          }),
        });
        const data = await res.json();
        meta = data.result?.meta;
        if (meta) break;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!meta) {
        console.warn(`⚠️ [WS-2] TX indexlenemedi, atlanıyor: ${signature.slice(0, 8)}...`);
        return { tokenMint: null, lpMint: null };
      }

      const post: any[] = meta.postTokenBalances || [];
      const pre: any[] = meta.preTokenBalances || [];
      const preMints = new Set(pre.map((p: any) => p.mint));

      // LP mint = yeni oluşturulan, WSOL olmayan mint
      // Burned olanlar dahil (amount=0) — PumpSwap graduation LP'yi burn eder
      const newMints = post.filter(
        (p: any) => !preMints.has(p.mint) && p.mint !== WSOL
      );

      // Token mint = önceden var olan, WSOL olmayan mint (pool'un token'ı)
      const existingMints = post.filter(
        (p: any) => preMints.has(p.mint) && p.mint !== WSOL
      );

      // Amount > 0 olanı tercih et; yoksa burned mint al (PumpSwap graduation)
      const lpMint =
        newMints.find((p: any) => p.uiTokenAmount?.amount !== "0")?.mint ??
        newMints[0]?.mint ??
        null;

      const tokenMint = existingMints.length > 0
        ? existingMints[0].mint
        : (newMints.length > 1 ? newMints[1].mint : lpMint);

      // ── Likidite: TX'teki net WSOL girişi = pool'a yatırılan SOL ─────────────
      // Önce WSOL token hesaplarındaki net artışa bak (PumpSwap, bazı Meteora havuzları)
      let liquidityAmount: number | undefined;
      let totalWsolIn = BigInt(0);
      for (const wp of post.filter((p: any) => p.mint === WSOL)) {
        const prevEntry = pre.find((x: any) => x.accountIndex === wp.accountIndex);
        const postAmt = BigInt(wp.uiTokenAmount?.amount || "0");
        const preAmt  = BigInt(prevEntry?.uiTokenAmount?.amount || "0");
        const net = postAmt - preAmt;
        if (net > BigInt(0)) totalWsolIn += net;
      }
      if (totalWsolIn > BigInt(0)) {
        liquidityAmount = Number(totalWsolIn) / 1e9;
      }

      // Fallback: native SOL bakiye değişimleri (Raydium AMM, Meteora DLMM/DY2)
      // WSOL vault yerine native SOL kullanan havuzlar için bu gerekli
      if (!liquidityAmount) {
        const preBalances: number[] = meta.preBalances || [];
        const postBalances: number[] = meta.postBalances || [];
        let maxNativeSolIn = 0;
        for (let i = 0; i < postBalances.length; i++) {
          const diff = (postBalances[i] || 0) - (preBalances[i] || 0);
          // Sadece 0.01 SOL üzerindeki artışlar (fee/rent hesapları elensin)
          if (diff > 10_000_000) {
            maxNativeSolIn = Math.max(maxNativeSolIn, diff);
          }
        }
        if (maxNativeSolIn > 0) liquidityAmount = maxNativeSolIn / 1e9;
      }

      return { tokenMint, lpMint, liquidityAmount };
    } catch (err) {
      console.error("❌ extractMintsFromDexTx hatası:", err);
      return { tokenMint: null, lpMint: null };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WS-1 per-token LP izleme için: LP mint ve likidite miktarını bul
  // ═══════════════════════════════════════════════════════════════════════════
  private async getLPMintFromTx(
    signature: string,
    originalMint: string
  ): Promise<{ lpMint: string | null; liquidityAmount?: number }> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
        }),
      });
      const data = await res.json();
      const meta = data.result?.meta;
      if (!meta) return { lpMint: null };

      const post: any[] = meta.postTokenBalances || [];
      const pre: any[] = meta.preTokenBalances || [];
      const preMints = new Set(pre.map((p: any) => p.mint));

      // Yeni oluşturulan, WSOL olmayan, orijinal token olmayan → LP mint
      let lpMint: string | null = null;
      for (const p of post) {
        if (
          !preMints.has(p.mint) &&
          p.mint !== WSOL &&
          p.mint !== originalMint &&
          p.uiTokenAmount?.amount !== "0"
        ) {
          lpMint = p.mint;
          break;
        }
      }

      // Fallback: miktarı artan
      if (!lpMint) {
        for (const p of post) {
          const prev = pre.find((x: any) => x.accountIndex === p.accountIndex);
          if (
            p.mint !== WSOL && p.mint !== originalMint && prev &&
            BigInt(p.uiTokenAmount?.amount || "0") > BigInt(prev.uiTokenAmount?.amount || "0")
          ) {
            lpMint = p.mint;
            break;
          }
        }
      }

      // Önce WSOL token hesaplarındaki net artışa bak
      let totalWsolIn = BigInt(0);
      for (const wp of post.filter((p: any) => p.mint === WSOL)) {
        const prevEntry = pre.find((x: any) => x.accountIndex === wp.accountIndex);
        const postAmt = BigInt(wp.uiTokenAmount?.amount || "0");
        const preAmt  = BigInt(prevEntry?.uiTokenAmount?.amount || "0");
        const net = postAmt - preAmt;
        if (net > BigInt(0)) totalWsolIn += net;
      }
      let liquidityAmount: number | undefined =
        totalWsolIn > BigInt(0) ? Number(totalWsolIn) / 1e9 : undefined;

      // Fallback: native SOL bakiye değişimleri (Raydium AMM, Meteora DLMM/DY2)
      if (!liquidityAmount) {
        const preBalances: number[] = meta.preBalances || [];
        const postBalances: number[] = meta.postBalances || [];
        let maxNativeSolIn = 0;
        for (let i = 0; i < postBalances.length; i++) {
          const diff = (postBalances[i] || 0) - (preBalances[i] || 0);
          if (diff > 10_000_000) {
            maxNativeSolIn = Math.max(maxNativeSolIn, diff);
          }
        }
        if (maxNativeSolIn > 0) liquidityAmount = maxNativeSolIn / 1e9;
      }

      return { lpMint, liquidityAmount };
    } catch (err) {
      console.error("❌ getLPMintFromTx hatası:", err);
      return { lpMint: null };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LP kilit kontrolü: LP mint'in en büyük sahiplerinin owner programına bak
  // Gerçek kilit = LP tokenları BURN_ADDRESS'te veya Streamflow/Team Finance
  // gibi locker kontralarında. DEX programı sahibi = kilit değil.
  // ═══════════════════════════════════════════════════════════════════════════
  private async checkLiquidityLock(lpMint: string): Promise<LockResult> {
    try {
      const [largestData, mintInfoData] = await Promise.all([
        fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getTokenLargestAccounts",
            params: [lpMint],
          }),
        }).then((r) => r.json()),
        fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 2,
            method: "getAccountInfo",
            params: [lpMint, { encoding: "jsonParsed" }],
          }),
        }).then((r) => r.json()),
      ]);

      const holders: any[] = largestData.result?.value?.slice(0, 3) || [];

      // Mint bilgilerini erken çıkar
      const mintInfo = mintInfoData.result?.value?.data?.parsed?.info;
      const supply: string | null = mintInfo?.supply ?? null;
      const mintAuth: string | null = mintInfo?.mintAuthority ?? null;
      const freezeAuth: string | null = mintInfo?.freezeAuthority ?? null;

      if (holders.length === 0) {
        // Supply=0 ve mint yetkisi yoksa LP tamamen yakılmış demektir.
        // PumpSwap graduation bunu yapar: SPL burn ix → supply → 0, kalıcı kilit.
        if (supply === "0" && !mintAuth) {
          console.log(`🔥 [Lock] LP supply=0, mintAuth=null → Burned (PumpSwap graduation)`);
          return { isLocked: true, lockDuration: "🔒 Burned (Kalıcı)" };
        }
        return { isLocked: false, lockDuration: "Kilitsiz" };
      }

      // Tüm holder bilgileri paralel çekilir
      const holderInfos = await Promise.all(
        holders.map((h: any) =>
          fetch(HTTP_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1,
              method: "getAccountInfo",
              params: [h.address, { encoding: "jsonParsed" }],
            }),
          }).then((r) => r.json())
        )
      );

      // Owner'lar çıkarılır; parent program sorguları da paralel yapılır
      const ownerList = holderInfos.map((info) => {
        const owner: string | undefined = info.result?.value?.data?.parsed?.info?.owner;
        return owner ?? null;
      });

      const parentPrograms = await Promise.all(
        ownerList.map((owner) =>
          owner && owner !== BURN_ADDRESS && !LOCKER_MAP[owner]
            ? this.getAccountOwner(owner)
            : Promise.resolve(null)
        )
      );

      for (let i = 0; i < ownerList.length; i++) {
        const owner = ownerList[i];
        if (!owner) continue;

        if (owner === BURN_ADDRESS) {
          return { isLocked: true, lockDuration: "🔒 Burned (Kalıcı)" };
        }
        if (LOCKER_MAP[owner]) {
          return { isLocked: true, lockDuration: `🔒 ${LOCKER_MAP[owner]}` };
        }

        const parentProgram = parentPrograms[i];
        if (parentProgram && LOCKER_MAP[parentProgram]) {
          return { isLocked: true, lockDuration: `🔒 ${LOCKER_MAP[parentProgram]}` };
        }
      }

      // Mint / freeze authority uyarıları
      if (mintAuth && mintAuth !== BURN_ADDRESS)
        return { isLocked: false, lockDuration: "⚠️ Mint yetkisi aktif" };
      if (freezeAuth && freezeAuth !== BURN_ADDRESS)
        return { isLocked: false, lockDuration: "⚠️ Freeze yetkisi aktif" };

      return { isLocked: false, lockDuration: "Kilitsiz" };
    } catch (err) {
      console.error("❌ checkLiquidityLock hatası:", err);
      return { isLocked: false, lockDuration: "Kilitsiz" };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Diğer yardımcılar
  // ═══════════════════════════════════════════════════════════════════════════
  private async fetchMintAddress(signature: string): Promise<string | null> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
        }),
      });
      const data = await res.json();
      const message = data.result?.transaction?.message;
      const accountKeys = message?.accountKeys;
      const instructions = message?.instructions;
      if (!accountKeys || !instructions) return null;

      for (const ix of instructions) {
        if (
          ix.programIdIndex !== undefined &&
          accountKeys[ix.programIdIndex] === SPL_TOKEN_PROGRAM_ID &&
          ix.accounts?.length > 0
        ) {
          return accountKeys[ix.accounts[0]];
        }
      }
      return null;
    } catch { return null; }
  }

  // Pool'un gerçek WSOL likiditesini çek (WS-3 locker eventi için)
  // LP mint → en büyük LP token sahibi (pool hesabı) → o hesabın WSOL token bakiyesi
  private async fetchPoolLiquidity(lpMint: string): Promise<number | undefined> {
    try {
      // LP token'ın en büyük sahiplerini al
      const largestRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenLargestAccounts",
          params: [lpMint],
        }),
      });
      const largestData = await largestRes.json();
      const holders: any[] = largestData.result?.value || [];

      for (const holder of holders.slice(0, 3)) {
        // Hesabın ham sahibini (DEX programı mı?) kontrol et
        const infoRes = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getAccountInfo",
            params: [holder.address, { encoding: "base64" }],
          }),
        });
        const infoData = await infoRes.json();
        const rawOwner: string | undefined = infoData.result?.value?.owner;
        if (!rawOwner || !Object.keys(DEX_PROGRAMS).includes(rawOwner)) continue;

        // Pool hesabının sahip olduğu WSOL token hesaplarını getir
        const wsolRes = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getTokenAccountsByOwner",
            params: [holder.address, { mint: WSOL }, { encoding: "jsonParsed" }],
          }),
        });
        const wsolData = await wsolRes.json();
        const accounts: any[] = wsolData.result?.value || [];

        let totalSol = 0;
        for (const acc of accounts) {
          const amount: number = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
          totalSol += amount;
        }
        if (totalSol > 0) return totalSol;
      }
      return undefined;
    } catch { return undefined; }
  }

  private async fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getAsset",
          params: { id: mintAddress },
        }),
      });
      const data = await res.json();
      const result = data.result;
      if (!result) return null;
      const name = result.content?.metadata?.name || "Bilinmiyor";
      const symbol = result.content?.metadata?.symbol || "?";
      if (name === "Bilinmiyor" && symbol === "?") return null;
      return { name, symbol };
    } catch { return null; }
  }

  private async getAccountOwner(address: string): Promise<string | null> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getAccountInfo",
          params: [address, { encoding: "base64" }],
        }),
      });
      const data = await res.json();
      return data.result?.value?.owner ?? null;
    } catch { return null; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WS-3 — Locker programları: anlık kilit olaylarını yakala
  //         Token oluştuktan sonra ne zaman kilitlenirse kilitlensin tespit edilir
  //         Streamflow / Unicrypt / Raydium Lock / Meteora Lock / PinkSale vb.
  // ═══════════════════════════════════════════════════════════════════════════
  private connectLocker() {
    if (!HELIUS_API_KEY) return;

    this.lockerWebSocket = new WebSocket(WS_URL);

    this.lockerWebSocket.on("open", () => {
      console.log("✅ [WS-3] Locker WebSocket bağlandı (Streamflow + Unicrypt + Raydium Lock + ...)");
      Object.keys(LOCKER_MAP).forEach((lockerProgramId, index) => {
        this.lockerWebSocket?.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 200 + index,
          method: "logsSubscribe",
          params: [{ mentions: [lockerProgramId] }, { commitment: "confirmed" }],
        }));
      });
    });

    this.lockerWebSocket.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const logs: string[] | undefined = msg?.params?.result?.value?.logs;
        const signature: string | undefined = msg?.params?.result?.value?.signature;
        if (!logs || !signature) return;
        if (this.processedLockerSignatures.has(signature)) return;

        this.processedLockerSignatures.add(signature);
        if (this.processedLockerSignatures.size > 500) {
          const first = this.processedLockerSignatures.values().next().value;
          if (first) this.processedLockerSignatures.delete(first);
        }

        const lockerName = this.detectLockerFromLogs(logs);
        await this.handleLockerEvent(signature, lockerName);
      } catch (err) {
        console.error("❌ [WS-3] Mesaj hatası:", err);
      }
    });

    this.lockerWebSocket.on("error", (err) => {
      console.error("❌ [WS-3] Hata:", err);
    });

    this.lockerWebSocket.on("close", () => {
      console.log("🔌 [WS-3] Locker bağlantısı kapandı");
      if (this.isRunning) {
        this.reconnectTimeoutLocker = setTimeout(() => this.connectLocker(), 3000);
      }
    });
  }

  // Locker işlemini işle: kilitlenen mint'i bul → token bilgisi çek → bildir
  private async handleLockerEvent(signature: string, lockerName: string) {
    try {
      const lockedMint = await this.extractLockedMintFromTx(signature);
      if (!lockedMint) {
        return;
      }

      console.log(`🔗 [WS-3] ${lockerName} | Kilitlenen Mint: ${lockedMint}`);

      // Önce doğrudan metadata dene (Streamflow/PinkSale project token kilitleyebilir)
      // Eğer boş gelirse LP token'dır → pool'dan altta yatan token mint'i bul
      let tokenMint = lockedMint;
      let directMeta = await this.fetchTokenMetadata(lockedMint);

      if (!directMeta) {
        console.log(`🔍 [WS-3] ${lockedMint} LP token olabilir → pool token aranıyor...`);
        const underlying = await this.findTokenMintFromLP(lockedMint);
        if (underlying) {
          tokenMint = underlying;
          directMeta = await this.fetchTokenMetadata(underlying);
          console.log(`✅ [WS-3] Pool token bulundu: ${underlying}`);
        }
      }

      const name = directMeta?.name || "Bilinmiyor";
      const symbol = directMeta?.symbol || "?";
      const detectedAt = Date.now();
      const expiresAt = detectedAt + 5 * 60 * 1000;

      const [liquidityAmount] = await Promise.all([
        this.fetchPoolLiquidity(lockedMint),
      ]);

      const { usd: liquidityUsd, tvlUsd } = this.toUsd(liquidityAmount);

      const lpData = {
        id: `${lockedMint}-${detectedAt}`,
        mintAddress: tokenMint,
        lpMint: lockedMint,
        name, symbol,
        detectedAt, expiresAt,
        isLocked: true,
        lockDuration: `🔒 ${lockerName}`,
        liquidityAmount, liquidityUsd, tvlUsd,
        platform: lockerName,
        jupiterUrl: `https://jup.ag/swap/SOL-${tokenMint}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
      };

      this.eventEmitter("lp_detected", lpData);
      this.eventEmitter("mint_detected", {
        id: tokenMint,
        mintAddress: tokenMint,
        name, symbol,
        detectedAt, expiresAt,
        isLocked: true,
        lockDuration: `🔒 ${lockerName}`,
        platform: lockerName,
        lpMint: lockedMint,
        jupiterUrl: `https://jup.ag/swap/SOL-${tokenMint}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
      });

      const sol = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "Bilinmiyor";
      const usdLine = liquidityUsd ? `\n💵 <b>USD:</b> $${liquidityUsd.toFixed(2)}` : "";
      const tvlLine = tvlUsd ? `\n📊 <b>TVL (~×2):</b> $${tvlUsd.toFixed(2)}` : "";
      sendTelegramNotification(
        `🔒 <b>LP KİLİTLENDİ!</b>\n\n` +
        `🏦 <b>Locker:</b> ${lockerName}\n` +
        `🪙 <b>Token:</b> ${name} (${symbol})\n` +
        `💧 <b>Likidite:</b> ${sol}${usdLine}${tvlLine}\n` +
        `📋 <b>Token Mint:</b> <code>${tokenMint}</code>\n` +
        `🔗 <b>LP Mint:</b> <code>${lockedMint}</code>\n\n` +
        `🔍 <a href="https://dexscreener.com/solana/${tokenMint}">Dexscreener</a> | ` +
        `🪐 <a href="https://jup.ag/swap/SOL-${tokenMint}">Jupiter</a> | ` +
        `🤖 <a href="${trojanUrl(tokenMint)}">Trojan ile Aç</a>`
      );
    } catch (err) {
      console.error("❌ [WS-3] Locker event hatası:", err);
    }
  }

  // LP token mint'inden pool'un altta yatan token mint'ini bul
  // Raydium/Meteora/PumpSwap LP token → pool account → token mint
  private async findTokenMintFromLP(lpMint: string): Promise<string | null> {
    try {
      // LP token'ın en büyük sahiplerini getir (pool hesabı olmalı)
      const largestRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenLargestAccounts",
          params: [lpMint],
        }),
      });
      const largestData = await largestRes.json();
      const holders: any[] = largestData.result?.value || [];

      for (const holder of holders.slice(0, 3)) {
        // Hesap bilgisini al → sahibi DEX programı mı?
        const infoRes = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getAccountInfo",
            params: [holder.address, { encoding: "jsonParsed" }],
          }),
        });
        const infoData = await infoRes.json();
        const owner: string | undefined = infoData.result?.value?.owner;
        if (!owner || !Object.keys(DEX_PROGRAMS).includes(owner)) continue;

        // Pool hesabının sahip olduğu token hesaplarını tara
        const taRes = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getTokenAccountsByOwner",
            params: [holder.address, { programId: SPL_TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }],
          }),
        });
        const taData = await taRes.json();
        const accounts: any[] = taData.result?.value || [];

        for (const acc of accounts) {
          const mint: string | undefined = acc.account?.data?.parsed?.info?.mint;
          if (mint && mint !== WSOL && mint !== lpMint) {
            return mint;
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // Locker TX'inden kilitlenen LP mint'i çıkar
  // Sadece YENİ kilit: locker programı kontrolündeki hesaba token GİREN işlemler
  // Çekme (withdraw), claim, transfer gibi eski kilit işlemleri elenir
  private async extractLockedMintFromTx(signature: string): Promise<string | null> {
    try {
      let result: any = null;
      // 5 deneme, her biri 2 saniye arayla — transaction indexlenmesi zaman alabilir
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getTransaction",
            params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
          }),
        });
        const data = await res.json();
        result = data.result;
        if (result?.meta) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!result?.meta) {
        console.warn(`❌ [WS-3] TX meta alınamadı (5 deneme): ${signature.slice(0, 8)}...`);
        return null;
      }

      // ── Zaman filtresi: kilit TX'i 30 saniyeden eskiyse atla ──────────────
      const txTime = result.blockTime as number | null;
      if (txTime) {
        const ageSec = Math.floor(Date.now() / 1000) - txTime;
        if (ageSec > 30) {
            return null;
        }
      }

      const meta = result.meta;
      const post: any[] = meta.postTokenBalances || [];
      const pre: any[]  = meta.preTokenBalances  || [];

      // Kilitlenen escrow hesapları: token miktarı ARTAN non-WSOL hesaplar
      // Azalan hesaplar (withdrawal/release) ve yeni recipient hesaplar → elenir
      // Net artış = (post - pre) > 0 olan hesaplar → token GIREN hesaplar
      const netInflows: { mint: string; accountIndex: number; netAmount: bigint }[] = [];
      for (const p of post) {
        if (p.mint === WSOL) continue;
        const postAmt = BigInt(p.uiTokenAmount?.amount || "0");
        const prev = pre.find((x: any) => x.accountIndex === p.accountIndex);
        const preAmt = BigInt(prev?.uiTokenAmount?.amount || "0");
        const net = postAmt - preAmt;
        if (net > BigInt(0)) {
          netInflows.push({ mint: p.mint, accountIndex: p.accountIndex, net });
        }
      }

      // ── Adım 1: Token giren token hesabının kontrolcüsü locker programı mı? ──
      // SPL token hesabının value.owner = TokenkegQ... (her zaman Token Program)
      // Gerçek kontrolcü = data.parsed.info.owner → locker program mı kontrol et.
      // Withdrawal'da alıcı hesabın kontrolcüsü kullanıcı wallet'ıdır (locker değil).
      // Yeni kilit escrow'unda kontrolcü bir PDA olabilir (Streamflow vb.).
      // PDA ise: PDA'nın kendi parent programı = locker program ID'si olacaktır.
      const accountKeys: string[] = (result.transaction?.message?.accountKeys || [])
        .map((k: any) => (typeof k === "string" ? k : k.pubkey))
        .filter(Boolean);

      for (const inflow of netInflows) {
        const accountAddr = accountKeys[inflow.accountIndex];
        if (!accountAddr) continue;
        const ownerRes = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getAccountInfo",
            params: [accountAddr, { encoding: "jsonParsed" }],
          }),
        });
        const ownerData = await ownerRes.json();
        // parsed.info.owner = token hesabını kontrol eden program/cüzdan (veya PDA)
        const tokenAccountOwner: string | undefined =
          ownerData.result?.value?.data?.parsed?.info?.owner;
        if (!tokenAccountOwner) continue;

        // Doğrudan eşleşme: owner kendisi locker program mı?
        if (LOCKER_MAP[tokenAccountOwner]) {
          console.log(`✅ [WS-3] Adım1 — Locker escrow'a token girişi | locker: ${LOCKER_MAP[tokenAccountOwner]} | mint: ${inflow.mint}`);
          return inflow.mint;
        }

        // PDA kontrolü: owner bir PDA ise, PDA'nın parent programı locker mı?
        // Streamflow, Unicrypt gibi programlar escrow için PDA kullanır.
        const parentProgram = await this.getAccountOwner(tokenAccountOwner);
        if (parentProgram && LOCKER_MAP[parentProgram]) {
          console.log(`✅ [WS-3] Adım1(PDA) — PDA escrow'a token girişi | locker: ${LOCKER_MAP[parentProgram]} | mint: ${inflow.mint}`);
          return inflow.mint;
        }
      }

      // ── Adım 2: innerInstructions'da SADECE initializeAccount tipleri ────────
      // Yeni kilit = yeni escrow hesabı kurulumu → initializeAccount geçer.
      // transfer/transferChecked withdrawal'da da geçtiği için KABUL EDİLMEZ.
      const innerIxs: any[] = meta.innerInstructions || [];
      for (const inner of innerIxs) {
        for (const ix of (inner.instructions || [])) {
          const parsed = ix.parsed;
          if (!parsed) continue;
          const type: string = parsed.type || "";
          const mint: string | undefined = parsed.info?.mint;
          if (
            mint && mint !== WSOL &&
            (type === "initializeAccount" || type === "initializeAccount3")
          ) {
            const initOwner: string | undefined = parsed.info?.owner;
            if (!initOwner) continue;

            // Doğrudan eşleşme
            if (LOCKER_MAP[initOwner]) {
              console.log(`✅ [WS-3] Adım2 — initializeAccount locker escrow | mint: ${mint}`);
              return mint;
            }

            // PDA kontrolü: initOwner bir PDA ise, parent programı locker mı?
            const parentProgram = await this.getAccountOwner(initOwner);
            if (parentProgram && LOCKER_MAP[parentProgram]) {
              console.log(`✅ [WS-3] Adım2(PDA) — initializeAccount PDA escrow | locker: ${LOCKER_MAP[parentProgram]} | mint: ${mint}`);
              return mint;
            }

          }
        }
      }

      // Adım 1 ve 2 eşleşmedi = yeni kilit değil (withdrawal/claim/vesting release)
      return null;
    } catch (err) {
      console.error("❌ extractLockedMintFromTx hatası:", err);
      return null;
    }
  }

  // Log'lardan hangi locker olduğunu tespit et
  private detectLockerFromLogs(logs: string[]): string {
    for (const log of logs) {
      for (const [programId, name] of Object.entries(LOCKER_MAP)) {
        if (log.includes(programId)) return name;
      }
    }
    return "Bilinmeyen Locker";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stop
  // ═══════════════════════════════════════════════════════════════════════════
  stop() {
    if (!this.isRunning) { console.log("⚠️ Monitor zaten durdurulmuş"); return; }

    console.log("🛑 Helius Monitor durduruluyor...");
    this.isRunning = false;

    if (this.reconnectTimeoutMain)   { clearTimeout(this.reconnectTimeoutMain);   this.reconnectTimeoutMain = null;   }
    if (this.reconnectTimeoutDex)    { clearTimeout(this.reconnectTimeoutDex);    this.reconnectTimeoutDex = null;    }
    if (this.reconnectTimeoutLocker) { clearTimeout(this.reconnectTimeoutLocker); this.reconnectTimeoutLocker = null; }
    if (this.heartbeatInterval)      { clearInterval(this.heartbeatInterval);     this.heartbeatInterval = null;      }

    if (this.mainWebSocket)   { this.mainWebSocket.close();   this.mainWebSocket = null;   }
    if (this.dexWebSocket)    { this.dexWebSocket.close();    this.dexWebSocket = null;    }
    if (this.lockerWebSocket) { this.lockerWebSocket.close(); this.lockerWebSocket = null; }

    this.activeMints.forEach((m) => m.lpWebSocket?.close());
    this.activeMints.clear();
    this.processedDexSignatures.clear();
    this.processedLockerSignatures.clear();

    this.eventEmitter("monitoring_state", { isMonitoring: false });
    this.eventEmitter("connection_status", {
      connected: false,
      message: "Monitor durduruldu",
      isMonitoring: false,
    });
  }
}
