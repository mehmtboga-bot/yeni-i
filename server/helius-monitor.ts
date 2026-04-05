import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
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
const DEX_PROGRAMS: Record<string, string> = {
  [PUMPSWAP]:        "PumpSwap",
  [PUMPFUN]:         "Pump.fun",
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

// Pool OLUŞTURMA keyword'leri — swap keyword'leri dahil değil
// "Instruction: Create" ve "Instruction: Initialize" gibi genel olanlar çıkarıldı
// çünkü bunlar swap işlemlerinde de geçiyor ve spam'e neden oluyor
const LP_KEYWORDS = [
  "initialize_pool",
  "InitializePool",
  "initializePool",
  "init_pool",
  "CreatePool",
  "create_pool",
  "create_pool_account",
  "initialize_pool_account",
  "pool_initialize",
  "PoolInit",
  "InitPool",
  "initialize market",
  "create market",
  "InitializeStateV2",
  "Instruction: InitializePool",
  "Instruction: CreatePool",
  "Instruction: InitializeLiquidity",
];

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

  private activeMints: Map<string, ActiveMint> = new Map();
  private processedDexSignatures: Set<string> = new Set();

  private reconnectTimeoutMain: NodeJS.Timeout | null = null;
  private reconnectTimeoutDex: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private eventEmitter: (event: string, data: any) => void;
  private isRunning = false;

  constructor(eventEmitter: (event: string, data: any) => void) {
    this.eventEmitter = eventEmitter;
  }

  async start() {
    if (this.isRunning) { console.log("⚠️ Monitor zaten çalışıyor"); return; }
    this.isRunning = true;
    console.log("🚀 Helius Monitor başlatılıyor (Çift WebSocket)...");
    this.eventEmitter("monitoring_state", { isMonitoring: true });
    this.connectMain();
    this.connectDex();
    this.startHeartbeat();
  }

  getState() { return this.isRunning; }

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
      `🔍 PumpSwap + Raydium AMM/CLMM + Meteora DLMM/DY2 LP'leri izleniyor\n\n` +
      `<i>Kilitli LP bulunursa bildirim alacaksınız.</i>`
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

        if (!mintData.lpLogged) {
          // Hangi DEX'te LP oluştu?
          const platform = this.detectPlatformFromLogs(logs);
          console.log(`💧 [WS-1] LP tespit edildi: ${metadata.name} | Platform: ${platform}`);
          mintData.lpLogged = true;
        }

        const lpMint = await this.getLPMintFromTx(txSignature, mintAddress);
        const checkMint = lpMint || mintAddress;

        try {
          const [lockResult, liquidityAmount] = await Promise.all([
            this.checkLiquidityLock(checkMint),
            this.fetchPoolLiquidity(checkMint),
          ]);

          const platform = this.detectPlatformFromLogs(logs);
          const lpData = {
            id: `${mintAddress}-${Date.now()}`,
            mintAddress,
            lpMint: lpMint || "Bulunamadı",
            name: metadata.name, symbol: metadata.symbol,
            detectedAt: Date.now(),
            expiresAt: Date.now() + 2 * 60 * 1000,
            isLocked: lockResult.isLocked,
            lockDuration: lockResult.lockDuration,
            liquidityAmount, platform,
            jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
            dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
          };
          this.eventEmitter("lp_detected", lpData);

          if (lockResult.isLocked) {
            const sol = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "Bilinmiyor";
            sendTelegramNotification(
              `🔒 <b>KİLİTLİ LP!</b>\n\n` +
              `🏊 <b>Platform:</b> ${platform}\n` +
              `🪙 <b>Token:</b> ${metadata.name} (${metadata.symbol})\n` +
              `🏦 <b>Kilit:</b> ${lockResult.lockDuration}\n` +
              `💧 <b>Likidite:</b> ${sol}\n` +
              `📋 <b>Mint:</b> <code>${mintAddress}</code>\n` +
              `🔗 <b>LP Mint:</b> <code>${checkMint}</code>\n\n` +
              `🔍 <a href="https://dexscreener.com/solana/${mintAddress}">Dexscreener</a> | ` +
              `🪐 <a href="https://jup.ag/swap/SOL-${mintAddress}">Jupiter</a>`
            );
          } else {
            console.log(`ℹ️ [WS-1] ${metadata.name} LP kilitli değil.`);
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

        const isLPEvent = logs.some((log) => LP_KEYWORDS.some((kw) => log.includes(kw)));
        if (!isLPEvent) return;

        this.processedDexSignatures.add(signature);
        if (this.processedDexSignatures.size > 500) {
          const first = this.processedDexSignatures.values().next().value;
          if (first) this.processedDexSignatures.delete(first);
        }

        const platform = this.detectPlatformFromLogs(logs);
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
      console.log(`\n💧 [WS-2] ${platform} LP tespit edildi: ${signature}`);

      // İşlemden token mint ve LP mint adreslerini çıkar
      const { tokenMint, lpMint } = await this.extractMintsFromDexTx(signature);

      // tokenMint yoksa işlenecek bir şey yok — atla
      if (!tokenMint) {
        return;
      }

      // lpMint yoksa CLMM/DLMM pozisyon bazlı pool olabilir — kilit kontrolünü atla ama eventi yayınla
      const isPositionBased = !lpMint;
      const checkMint = lpMint || tokenMint;

      console.log(
        `🪙 [WS-2] ${platform} | Token: ${tokenMint} | LP Mint: ${lpMint ?? "yok (CLMM/DLMM)"}` 
      );

      const [metadata, lockResult, liquidityAmount] = await Promise.all([
        this.fetchTokenMetadata(tokenMint),
        isPositionBased
          ? Promise.resolve({ isLocked: false, lockDuration: "CLMM/DLMM — LP mint yok" })
          : this.checkLiquidityLock(lpMint!),
        this.fetchPoolLiquidity(checkMint),
      ]);

      const name = metadata?.name || "Bilinmiyor";
      const symbol = metadata?.symbol || "?";
      const detectedAt = Date.now();
      const expiresAt = detectedAt + 5 * 60 * 1000;

      // Tüm WS-2 tokenları arayüzde "mintlenenler" bölümünde de göster
      this.eventEmitter("mint_detected", {
        id: tokenMint,
        mintAddress: tokenMint,
        name, symbol,
        detectedAt, expiresAt,
        isLocked: lockResult.isLocked,
        lockDuration: lockResult.lockDuration,
        platform,
        lpMint,
        jupiterUrl: `https://jup.ag/swap/SOL-${tokenMint}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
      });

      const lpData = {
        id: `${tokenMint}-${detectedAt}`,
        mintAddress: tokenMint,
        lpMint,
        name, symbol,
        detectedAt, expiresAt,
        isLocked: lockResult.isLocked,
        lockDuration: lockResult.lockDuration,
        liquidityAmount, platform,
        jupiterUrl: `https://jup.ag/swap/SOL-${tokenMint}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
        pumpfunUrl: platform === "PumpSwap" ? `https://pump.fun/${tokenMint}` : undefined,
      };

      this.eventEmitter("lp_detected", lpData);

      if (lockResult.isLocked) {
        const sol = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "Bilinmiyor";
        sendTelegramNotification(
          `🔒 <b>KİLİTLİ LP TESPİT EDİLDİ!</b>\n\n` +
          `🏊 <b>Platform:</b> ${platform}\n` +
          `🪙 <b>Token:</b> ${name} (${symbol})\n` +
          `🏦 <b>Kilit Türü:</b> ${lockResult.lockDuration}\n` +
          `💧 <b>Likidite:</b> ${sol}\n` +
          `📋 <b>Token Mint:</b> <code>${tokenMint}</code>\n` +
          `🔗 <b>LP Mint:</b> <code>${lpMint ?? "Yok (CLMM/DLMM)"}</code>\n\n` +
          `🔍 <a href="https://dexscreener.com/solana/${tokenMint}">Dexscreener</a> | ` +
          `🪐 <a href="https://jup.ag/swap/SOL-${tokenMint}">Jupiter</a>` +
          (platform === "PumpSwap"
            ? ` | 🌊 <a href="https://pump.fun/${tokenMint}">Pump.fun</a>`
            : "")
        );
      } else {
        console.log(`ℹ️ [WS-2] ${name} — LP kilitli değil.`);
      }
    } catch (err) {
      console.error("❌ [WS-2] DEX LP hatası:", err);
    }
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
  // TX'den token mint ve LP mint adreslerini çıkar
  // - tokenMint: WSOL olmayan, önceden var olan token (pool'un trade token'ı)
  // - lpMint:    WSOL ve token mint olmayan, YENİ oluşturulan mint (LP token)
  // ═══════════════════════════════════════════════════════════════════════════
  private async extractMintsFromDexTx(
    signature: string
  ): Promise<{ tokenMint: string | null; lpMint: string | null }> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      const data = await res.json();
      const meta = data.result?.meta;
      if (!meta) return { tokenMint: null, lpMint: null };

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

      return { tokenMint, lpMint };
    } catch (err) {
      console.error("❌ extractMintsFromDexTx hatası:", err);
      return { tokenMint: null, lpMint: null };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WS-1 per-token LP izleme için: LP mint'ini bul
  // ═══════════════════════════════════════════════════════════════════════════
  private async getLPMintFromTx(signature: string, originalMint: string): Promise<string | null> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      const data = await res.json();
      const meta = data.result?.meta;
      if (!meta) return null;

      const post: any[] = meta.postTokenBalances || [];
      const pre: any[] = meta.preTokenBalances || [];
      const preMints = new Set(pre.map((p: any) => p.mint));

      // Yeni oluşturulan, WSOL olmayan, orijinal token olmayan → LP mint
      for (const p of post) {
        if (
          !preMints.has(p.mint) &&
          p.mint !== WSOL &&
          p.mint !== originalMint &&
          p.uiTokenAmount?.amount !== "0"
        ) {
          return p.mint;
        }
      }

      // Fallback: miktarı artan
      for (const p of post) {
        const prev = pre.find((x: any) => x.accountIndex === p.accountIndex);
        if (
          p.mint !== WSOL && p.mint !== originalMint && prev &&
          BigInt(p.uiTokenAmount?.amount || "0") > BigInt(prev.uiTokenAmount?.amount || "0")
        ) {
          return p.mint;
        }
      }

      return null;
    } catch (err) {
      console.error("❌ getLPMintFromTx hatası:", err);
      return null;
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

      for (const info of holderInfos) {
        const owner: string | undefined = info.result?.value?.data?.parsed?.info?.owner;
        if (!owner) continue;

        if (owner === BURN_ADDRESS) {
          return { isLocked: true, lockDuration: "🔒 Burned (Kalıcı)" };
        }
        if (LOCKER_MAP[owner]) {
          return { isLocked: true, lockDuration: `🔒 ${LOCKER_MAP[owner]}` };
        }

        // Owner'ın parent programı locker mı?
        const parentProgram = await this.getAccountOwner(owner);
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
          params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }],
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

  private async fetchPoolLiquidity(lpMint: string): Promise<number | undefined> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenLargestAccounts",
          params: [lpMint],
        }),
      });
      const data = await res.json();
      const topHolder = data.result?.value?.[0]?.address;
      if (!topHolder) return undefined;

      const balRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getBalance",
          params: [topHolder],
        }),
      });
      const balData = await balRes.json();
      const sol = (balData.result?.value || 0) / 1e9;
      return sol > 0 ? sol : undefined;
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
  // Stop
  // ═══════════════════════════════════════════════════════════════════════════
  stop() {
    if (!this.isRunning) { console.log("⚠️ Monitor zaten durdurulmuş"); return; }

    console.log("🛑 Helius Monitor durduruluyor...");
    this.isRunning = false;

    if (this.reconnectTimeoutMain) { clearTimeout(this.reconnectTimeoutMain); this.reconnectTimeoutMain = null; }
    if (this.reconnectTimeoutDex)  { clearTimeout(this.reconnectTimeoutDex);  this.reconnectTimeoutDex = null;  }
    if (this.heartbeatInterval)    { clearInterval(this.heartbeatInterval);    this.heartbeatInterval = null;    }

    if (this.mainWebSocket) { this.mainWebSocket.close(); this.mainWebSocket = null; }
    if (this.dexWebSocket)  { this.dexWebSocket.close();  this.dexWebSocket = null;  }

    this.activeMints.forEach((m) => m.lpWebSocket?.close());
    this.activeMints.clear();
    this.processedDexSignatures.clear();

    this.eventEmitter("monitoring_state", { isMonitoring: false });
    this.eventEmitter("connection_status", {
      connected: false,
      message: "Monitor durduruldu",
      isMonitoring: false,
    });
  }
}
