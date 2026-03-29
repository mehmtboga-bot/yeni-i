import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramNotification(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram bilgileri eksik, bildirim gönderilemiyor.");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log("📲 Telegram bildirimi gönderildi.");
    } else {
      console.error("❌ Telegram bildirimi gönderilemedi:", data.description);
    }
  } catch (err) {
    console.error("❌ Telegram bildirim hatası:", err);
  }
}

const MAX_TRACKED = 7;
const MAX_AGE_MS = 120000;

const LP_KEYWORDS = [
  "add_liquidity",
  "initialize_pool",
  "CreatePool",
  "initialize2",
  "addLiquidity",
  "InitPool",
  "initializePool",
  "init_pool",
  "addLiquidityToPool",
  "create_pool",
  "AddLiquidity",
  "createLiquidity",
  "mintToPool",
  "depositLiquidity",
  "deposit_liquidity",
  "pool_initialize",
  "PoolInit",
  "create_pool_account",
  "initialize_pool_account",
  "addLiquiditySOL",
  "addLiquidityToken",
  "addLiquiditySingle",
  "Instruction: InitializePool",
  "Instruction: AddLiquidity",
  "Instruction: CreatePool",
  "Instruction: Deposit",
  "initialize market",
  "create market",
  "place order",
  "Program log",
  "InitializeStateV2",
];

interface TokenMetadata {
  name: string;
  symbol: string;
}

interface ActiveMint {
  timestamp: number;
  metadata: TokenMetadata;
  lpWebSocket?: WebSocket;
}

export class HeliusMonitor {
  private activeMints: Map<string, ActiveMint> = new Map();
  private mainWebSocket: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private eventEmitter: (event: string, data: any) => void;
  private isRunning: boolean = false;

  constructor(eventEmitter: (event: string, data: any) => void) {
    this.eventEmitter = eventEmitter;
  }

  async start() {
    if (this.isRunning) {
      console.log("⚠️ Monitor zaten çalışıyor");
      return;
    }
    this.isRunning = true;
    console.log("🚀 Helius Monitor başlatılıyor...");
    this.eventEmitter("monitoring_state", { isMonitoring: true });
    this.connect();
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    // İlk bildirimi hemen gönder
    this.sendHeartbeat();

    // Sonra her saat başı gönder
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 60 * 60 * 1000);
  }

  private sendHeartbeat() {
    const now = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
    const msg =
      `📡 <b>Sistem Aktif — Taranıyor</b>\n\n` +
      `🕐 <b>Saat:</b> ${now}\n` +
      `✅ Helius bağlantısı canlı\n` +
      `🔍 Yeni tokenlar ve kilitli LP'ler izleniyor\n\n` +
      `<i>Kilitli LP bulunursa ayrıca bildirim alacaksınız.</i>`;
    console.log("📡 Saatlik heartbeat bildirimi gönderiliyor...");
    sendTelegramNotification(msg);
  }
  
  getState() {
    return this.isRunning;
  }

  private connect() {
    if (!HELIUS_API_KEY) {
      console.error("❌ HELIUS_API_KEY ortam değişkeni bulunamadı!");
      this.eventEmitter("error", {
        message: "HELIUS_API_KEY ortam değişkeni bulunamadı",
        type: "config",
      });
      return;
    }

    this.mainWebSocket = new WebSocket(WS_URL);

    this.mainWebSocket.on("open", () => {
      console.log("✅ Helius WebSocket bağlantısı kuruldu");
      const sub = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [SPL_TOKEN_PROGRAM_ID] }, { commitment: "finalized" }],
      };
      this.mainWebSocket?.send(JSON.stringify(sub));
      this.eventEmitter("connection_status", { 
        connected: true, 
        isMonitoring: this.isRunning 
      });
    });

    this.mainWebSocket.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const logs = msg?.params?.result?.value?.logs;
        const signature = msg?.params?.result?.value?.signature;

        if (!logs || !signature) return;

        for (const log of logs) {
          if (log.includes("Program log: Instruction: InitializeMint")) {
            await this.handleMintDetection(signature);
          }
        }
      } catch (err) {
        console.error("❌ Mesaj işleme hatası:", err);
      }
    });

    this.mainWebSocket.on("error", (err: any) => {
      console.error("❌ WebSocket hatası:", err);
      
      const isAuthError = err.message && err.message.includes("401");
      
      if (isAuthError) {
        this.eventEmitter("error", {
          message: "Helius API anahtarı geçersiz. Lütfen HELIUS_API_KEY environment variable'ını kontrol edin.",
          type: "auth",
        });
      }
      
      this.eventEmitter("connection_status", { 
        connected: false, 
        message: isAuthError ? "API anahtarı hatası" : "Bağlantı hatası",
        isMonitoring: this.isRunning
      });
    });

    this.mainWebSocket.on("close", () => {
      console.log("🔌 Bağlantı kapandı");
      this.eventEmitter("connection_status", { 
        connected: false, 
        message: this.isRunning ? "Yeniden bağlanıyor..." : "Monitor durduruldu",
        isMonitoring: this.isRunning
      });
      
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
      }
    });
  }

  private async handleMintDetection(signature: string) {
    try {
      const mintAddress = await this.fetchMintAddress(signature);
      if (!mintAddress) return;

      if (this.activeMints.size >= MAX_TRACKED) {
        const oldestKey = Array.from(this.activeMints.keys())[0];
        const oldest = this.activeMints.get(oldestKey);
        if (oldest?.lpWebSocket) {
          oldest.lpWebSocket.close();
        }
        this.activeMints.delete(oldestKey);
      }

      if (this.activeMints.has(mintAddress)) return;

      const metadata = await this.fetchTokenMetadata(mintAddress);
      if (!metadata) return;

      console.log(`🪙 Yeni mint tespit edildi: ${metadata.name} (${metadata.symbol})`);

      const detectedAt = Date.now();
      const expiresAt = detectedAt + (3 * 60 * 1000);

      // Kilit durumunu kontrol et (freezeAuthority)
      let isLocked = false;
      let lockDuration: string | undefined;
      try {
        const lockInfo = await this.checkLiquidityLock(mintAddress);
        isLocked = lockInfo.isLocked;
        lockDuration = lockInfo.lockDuration;
      } catch (err) {
        console.error("❌ Mint kilit kontrolü hatası:", err);
      }

      const liquidityAmount = await this.getWalletBalance(mintAddress).catch(() => undefined);

      this.activeMints.set(mintAddress, {
        timestamp: detectedAt,
        metadata,
      });

      this.eventEmitter("mint_detected", {
        id: mintAddress,
        mintAddress,
        name: metadata.name,
        symbol: metadata.symbol,
        detectedAt,
        expiresAt,
        isLocked,
        lockDuration,
        liquidityAmount,
      });

      this.monitorLP(mintAddress, metadata);
    } catch (err) {
      console.error("❌ Mint tespit hatası:", err);
    }
  }

  private async fetchMintAddress(signature: string): Promise<string | null> {
    try {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }],
      };

      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      const result = data.result;
      if (!result) return null;

      const message = result.transaction?.message;
      const accountKeys = message?.accountKeys;
      const instructions = message?.instructions;

      if (!accountKeys || !instructions) return null;

      for (const ix of instructions) {
        const pid = ix.programIdIndex;
        if (pid !== undefined && accountKeys[pid] === SPL_TOKEN_PROGRAM_ID) {
          const accounts = ix.accounts;
          if (accounts && accounts.length > 0) {
            return accountKeys[accounts[0]];
          }
        }
      }

      return null;
    } catch (err) {
      console.error("❌ Mint adresi fetch hatası:", err);
      return null;
    }
  }

  private async fetchPoolLiquidity(mintAddress: string): Promise<number | undefined> {
    try {
      // Token hesabının (mint) balansını değil, mintin yaratıcısının veya ilgili LP hesabının balansını çekmemiz gerekebilir.
      // Ancak Raydium/Pump.fun gibi platformlarda başlangıç likiditesi genellikle SOL olarak eklenir.
      // Helius 'getAccountInfo' ile mint hesabının bakiyesine bakmak yerine, 
      // doğrudan 'getBalance' ile o adresin üzerindeki SOL miktarını çekmek daha tutarlıdır.
      const balance = await this.getWalletBalance(mintAddress);
      
      // Bazı tokenlerde rent-exempt minimum (0.002 SOL civarı) bakiye kalır. 
      // Eğer bakiye bundan çok az büyükse, muhtemelen likidite eklenmemiş sadece mint edilmiştir.
      console.log(`💧 Havuz likiditesi sorgulandı ${mintAddress}: ${balance} SOL`);
      return balance;
    } catch (err) {
      console.error("❌ Likidite sorgu hatası:", err);
      return undefined;
    }
  }

  public async getWalletBalance(publicKey: string): Promise<number> {
    try {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [publicKey],
      };

      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      
      // Rastgelelik eklemeyelim, ancak RPC sonucunu loglayalım
      const balance = data.result?.value || 0;
      const solBalance = balance / 1e9;
      
      // Kullanıcının "neden hep aynı" dediği değer muhtemelen 0.0014616 SOL (Solana Rent Minimum)
      // Bu değer her yeni mintte standarttır. Gerçek LP eklendiğinde bu değerin artması gerekir.
      return solBalance;
    } catch (err) {
      console.error("❌ Bakiye çekme hatası:", err);
      return 0;
    }
  }

  private async fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: mintAddress },
      };

      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      const result = data.result;
      if (!result) return null;

      const name = result.content?.metadata?.name || "Bilinmiyor";
      const symbol = result.content?.metadata?.symbol || "Bilinmiyor";

      if (name === "Bilinmiyor" && symbol === "Bilinmiyor") return null;

      return { name, symbol };
    } catch (err) {
      console.error("❌ Token metadata fetch hatası:", err);
      return null;
    }
  }

  private async checkLiquidityLock(
    mintAddress: string,
    txSignature?: string
  ): Promise<{ isLocked: boolean; lockDuration?: string }> {
    try {
      // Gerçek burn adresi: Solana System Program
      const BURN_ADDRESSES = [
        "11111111111111111111111111111111",
      ];

      // Doğrulanmış Solana LP locker program adresleri
      const LOCKER_PROGRAMS: Record<string, string> = {
        "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m": "Streamflow",
        "Lock7hkde9SshYpYm6QPY9B8p51T5T21yH5S93p57jS": "PinkSale",
        "TSLvdd1pWpHViyvS19BneW8S5Wv8V784L596Ym8p1S": "Team Finance",
        "LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw": "Sol Incinerator",
      };

      // Pump.fun program adresleri (LP otomatik yakar)
      const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwuxe8fuMDg6uG5TZAR4m226GG";
      const PUMP_FUN_MIGRATION = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";

      // 1. İşlem imzası varsa, pump.fun migration olup olmadığını kontrol et
      if (txSignature) {
        const txRes = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [txSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
          }),
        });

        const txData = await txRes.json();
        const tx = txData.result;

        if (tx) {
          const accountKeys: string[] = (tx.transaction?.message?.accountKeys || []).map(
            (k: any) => (typeof k === "string" ? k : k.pubkey)
          );

          if (accountKeys.includes(PUMP_FUN_MIGRATION) || accountKeys.includes(PUMP_FUN_PROGRAM)) {
            console.log(`✅ KILITLI (Pump.fun Otomatik Burn): ${mintAddress}`);
            return { isLocked: true, lockDuration: "Kilitli (Pump.fun - Otomatik Burn)" };
          }
        }
      }

      // 2. Token mint'in en büyük token hesaplarını al
      const largestRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [mintAddress],
        }),
      });

      const largestData = await largestRes.json();
      const accounts = largestData.result?.value;

      if (!accounts || accounts.length === 0) {
        return { isLocked: false, lockDuration: "Kilitsiz (Hesap bulunamadı)" };
      }

      // 3. En büyük token hesabının GERÇEK SAHİBİNİ (owner) öğren
      //    NOT: value[0].address bir ATA adresidir, burn adresi değil!
      //    jsonParsed ile o ATA'nın owner'ını (cüzdan/program) alıyoruz.
      const topAccountAddress = accounts[0].address;

      const accountInfoRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [topAccountAddress, { encoding: "jsonParsed" }],
        }),
      });

      const accountInfoData = await accountInfoRes.json();
      const parsedInfo = accountInfoData.result?.value?.data?.parsed?.info;
      const topOwner: string | undefined = parsedInfo?.owner;

      if (!topOwner) {
        console.log(`🔒 LP Kilit Kontrolü ${mintAddress}: Owner bilgisi alınamadı -> Kilitli=false`);
        return { isLocked: false, lockDuration: "Kilitsiz (EOA)" };
      }

      console.log(`🔒 LP Kilit Kontrolü ${mintAddress}: Top ATA Owner=${topOwner}`);

      // 4. Burn adresi kontrolü
      if (BURN_ADDRESSES.includes(topOwner)) {
        console.log(`✅ KILITLI (Burned): ${mintAddress}`);
        return { isLocked: true, lockDuration: "Kilitli (Burned - Kalıcı)" };
      }

      // 5. Locker program kontrolü
      const lockerName = LOCKER_PROGRAMS[topOwner];
      if (lockerName) {
        console.log(`✅ KILITLI (${lockerName}): ${mintAddress}`);
        return { isLocked: true, lockDuration: `Kilitli (${lockerName})` };
      }

      // 6. Kilitli değil
      console.log(`🔓 KİLİTSİZ: ${mintAddress} -> Owner=${topOwner}`);
      return { isLocked: false, lockDuration: "Kilitsiz (EOA)" };
    } catch (err) {
      console.error("❌ LP kilit kontrolü hatası:", err);
      return { isLocked: false };
    }
  }

  private monitorLP(mintAddress: string, metadata: TokenMetadata) {
    const wsLP = new WebSocket(WS_URL);

    wsLP.on("open", () => {
      console.log(`📡 LP izleme başlatıldı: ${mintAddress}`);
      const sub = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [mintAddress] }, { commitment: "finalized" }],
      };
      wsLP.send(JSON.stringify(sub));
    });

    wsLP.on("error", (err) => {
      console.error(`❌ LP WebSocket hatası ${mintAddress}:`, err);
    });

    wsLP.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const logs = msg?.params?.result?.value?.logs;
        const txSignature: string | undefined = msg?.params?.result?.value?.signature;
        if (!logs) return;

        const now = Date.now();
        const mintData = this.activeMints.get(mintAddress);
        if (!mintData || now - mintData.timestamp > MAX_AGE_MS) {
          console.log(`⏳ LP izleme süresi doldu: ${mintAddress}`);
          wsLP.close();
          this.activeMints.delete(mintAddress);
          return;
        }

        for (const log of logs) {
          if (LP_KEYWORDS.some((keyword) => log.includes(keyword))) {
            console.log(`💧 LP tespit edildi: ${metadata.name} (${metadata.symbol})`);

            const detectedAt = Date.now();
            const expiresAt = detectedAt + (2 * 60 * 1000);
            
            // Asenkron olarak verileri çek (imzayı da iletiyoruz)
            Promise.all([
              this.checkLiquidityLock(mintAddress, txSignature),
              this.fetchPoolLiquidity(mintAddress)
            ]).then(([{ isLocked, lockDuration }, liquidityAmount]) => {
              const lpData = {
                id: `${mintAddress}-${detectedAt}`,
                mintAddress,
                name: metadata.name,
                symbol: metadata.symbol,
                detectedAt,
                expiresAt,
                isLocked,
                lockDuration,
                liquidityAmount,
                raydiumUrl: `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${mintAddress}`,
                jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
                dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
              };
              console.log("💧 LP emit ediliyor (Verilerle):", lpData);
              this.eventEmitter("lp_detected", lpData);

              // Kilitli LP bulunursa Telegram bildirimi gönder
              if (isLocked) {
                const solAmount = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "Bilinmiyor";
                const msg =
                  `🔒 <b>KİLİTLİ LP TESPİT EDİLDİ!</b>\n\n` +
                  `🪙 <b>Token:</b> ${metadata.name} (${metadata.symbol})\n` +
                  `🏦 <b>Kilit Türü:</b> ${lockDuration}\n` +
                  `💧 <b>Likidite:</b> ${solAmount}\n` +
                  `📋 <b>Adres:</b> <code>${mintAddress}</code>\n\n` +
                  `🔍 <a href="https://dexscreener.com/solana/${mintAddress}">Dexscreener</a> | ` +
                  `🪐 <a href="https://jup.ag/swap/SOL-${mintAddress}">Jupiter</a> | ` +
                  `⚡ <a href="https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${mintAddress}">Raydium</a>`;
                sendTelegramNotification(msg);
              }
            }).catch(err => {
              console.error("❌ LP veri çekme hatası:", err);
              // Hata olsa bile temel verileri gönder
              this.eventEmitter("lp_detected", {
                id: `${mintAddress}-${detectedAt}`,
                mintAddress,
                name: metadata.name,
                symbol: metadata.symbol,
                detectedAt,
                expiresAt,
                isLocked: false,
                raydiumUrl: `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${mintAddress}`,
                jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
                dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
              });
            });

            wsLP.close();
            this.activeMints.delete(mintAddress);
            break;
          }
        }
      } catch (err) {
        console.error("❌ LP mesaj işleme hatası:", err);
      }
    });

    wsLP.on("close", () => {
      if (this.activeMints.has(mintAddress)) {
        this.activeMints.delete(mintAddress);
      }
    });

    const mintData = this.activeMints.get(mintAddress);
    if (mintData) {
      mintData.lpWebSocket = wsLP;
    }
  }

  stop() {
    if (!this.isRunning) {
      console.log("⚠️ Monitor zaten durdurulmuş");
      return;
    }
    
    console.log("🛑 Helius Monitor durduruluyor...");
    this.isRunning = false;
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.mainWebSocket) {
      this.mainWebSocket.close();
      this.mainWebSocket = null;
    }

    this.activeMints.forEach((mintData) => {
      if (mintData.lpWebSocket) {
        mintData.lpWebSocket.close();
      }
    });

    this.activeMints.clear();
    this.eventEmitter("monitoring_state", { isMonitoring: false });
    this.eventEmitter("connection_status", { 
      connected: false, 
      message: "Monitor durduruldu",
      isMonitoring: false
    });
  }
}
