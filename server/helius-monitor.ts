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

// Raydium, Orca, ve diğer DEX'ler için program ID'leri
const RAYDIUM_STABLE = "675kPX9MHTjS2zt1qrXiE48DqBJ5R8k6rJsV5ln32Xw";
const RAYDIUM_AMM = "9W959DqEETiGZocYWCQqvQsGoalQzX7zxoACW5SPqo1J";
const RAYDIUM_AMM_V3 = "27hprDkFZivojj63agoGGvs54V4xWPgisQatjCvDVWVt";
const ORCA = "whirLbMiicVdio4KfUadKBLw2KdroiL2M7WB2Wsp2K";

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
  lpLogged?: boolean;
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

    this.sendHeartbeat();

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
        isMonitoring: this.isRunning,
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
          message:
            "Helius API anahtarı geçersiz. Lütfen HELIUS_API_KEY environment variable'ını kontrol edin.",
          type: "auth",
        });
      }

      this.eventEmitter("connection_status", {
        connected: false,
        message: isAuthError ? "API anahtarı hatası" : "Bağlantı hatası",
        isMonitoring: this.isRunning,
      });
    });

    this.mainWebSocket.on("close", () => {
      console.log("🔌 Bağlantı kapandı");
      this.eventEmitter("connection_status", {
        connected: false,
        message: this.isRunning ? "Yeniden bağlanıyor..." : "Monitor durduruldu",
        isMonitoring: this.isRunning,
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
      const expiresAt = detectedAt + 3 * 60 * 1000;

      // FIX: LP mint henüz bilinmediği için burada kilit ve likidite kontrolü yapılmıyor.
      // Gerçek kilit durumu LP tespit edildiğinde (monitorLP içinde) kontrol edilecek.

      this.activeMints.set(mintAddress, {
        timestamp: detectedAt,
        metadata,
        lpLogged: false,
      });

      this.eventEmitter("mint_detected", {
        id: mintAddress,
        mintAddress,
        name: metadata.name,
        symbol: metadata.symbol,
        detectedAt,
        expiresAt,
        isLocked: false,
        lockDuration: undefined,
        liquidityAmount: undefined,
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

  // FIX: liquidityAmount için LP mint adresi kullanılıyor; token mint SOL bakiyesi
  // gerçek pool likiditesini yansıtmaz (sadece rent-exempt miktarıdır).
  // Doğru likidite için pool vault hesabının adresine ihtiyaç var.
  private async fetchPoolLiquidity(lpMint: string): Promise<number | undefined> {
    try {
      // LP token'ın en büyük sahibinin (pool vault) SOL bakiyesini alıyoruz
      const largestRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [lpMint],
        }),
      });
      const largestData = await largestRes.json();
      const topHolder = largestData.result?.value?.[0]?.address;
      if (!topHolder) return undefined;

      const balance = await this.getWalletBalance(topHolder);
      return balance > 0 ? balance : undefined;
    } catch (err) {
      console.error("❌ Likidite sorgu hatası:", err);
      return undefined;
    }
  }

  // FIX: private yapıldı (sadece sınıf içinde kullanılıyor)
  private async getWalletBalance(publicKey: string): Promise<number> {
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

      const balance = data.result?.value || 0;
      const solBalance = balance / 1e9;

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

  private async getAccountProgram(address: string): Promise<string | null> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [address, { encoding: "base64" }],
        }),
      });
      const data = await res.json();
      return data.result?.value?.owner ?? null;
    } catch {
      return null;
    }
  }

  // FIX: getTopTokenOwner kaldırıldı — hiçbir yerde kullanılmıyordu.

  private async getLPMintFromTx(signature: string): Promise<string | null> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });

      const data = await res.json();
      const transaction = data.result?.transaction;
      const meta = data.result?.meta;

      if (!transaction || !meta) {
        console.warn("⚠️ Transaction veya metadata boş");
        return null;
      }

      const instructions = transaction?.message?.instructions || [];
      const postTokenBalances = meta?.postTokenBalances || [];
      const preTokenBalances = meta?.preTokenBalances || [];
      const accountKeys = transaction?.message?.accountKeys || [];

      console.log(`🔍 LP Mint araması başlıyor (${instructions.length} instruction, ${postTokenBalances.length} token balance)`);

      // 🎯 1. RAYDIUM initializePool çağrısından direkt çek
      for (let i = 0; i < instructions.length; i++) {
        const ix = instructions[i];

        if (ix.programId === RAYDIUM_AMM) {
          if (ix.parsed?.type === "initializePool") {
            const lpMint = ix.parsed?.info?.lpMint;
            if (lpMint) {
              console.log(
                `✅ DOĞRU LP MINT [${i}] (Raydium AMM initializePool): ${lpMint}`
              );
              return lpMint;
            }
          }
        }

        if (ix.programId === RAYDIUM_STABLE) {
          if (ix.parsed?.type === "initializePool") {
            const poolMint = ix.parsed?.info?.poolMint;
            if (poolMint) {
              console.log(
                `✅ DOĞRU LP MINT [${i}] (Raydium Stable initializePool): ${poolMint}`
              );
              return poolMint;
            }
          }
        }

        if (ix.programId === RAYDIUM_AMM_V3) {
          if (ix.parsed?.type === "initializePool") {
            const lpMint = ix.parsed?.info?.poolMint || ix.parsed?.info?.lpMint;
            if (lpMint) {
              console.log(
                `✅ DOĞRU LP MINT [${i}] (Raydium AMM V3 initializePool): ${lpMint}`
              );
              return lpMint;
            }
          }
        }

        if (ix.programId === ORCA) {
          if (ix.parsed?.type === "initializePool") {
            const lpMint = ix.parsed?.info?.lpMint || ix.parsed?.info?.poolMint;
            if (lpMint) {
              console.log(`✅ DOĞRU LP MINT [${i}] (Orca initializePool): ${lpMint}`);
              return lpMint;
            }
          }
        }
      }

      // 🎯 2. FALLBACK: Tüm parsed instruction'ları kontrol et
      console.log("🔍 Tüm instruction'ları kontrol ediyorum...");
      for (let i = 0; i < instructions.length; i++) {
        const ix = instructions[i];

        if (ix.parsed?.info) {
          if (ix.parsed.info.lpMint) {
            console.log(`  ✅ [${i}] lpMint bulundu: ${ix.parsed.info.lpMint}`);
            return ix.parsed.info.lpMint;
          }
          if (ix.parsed.info.poolMint) {
            console.log(`  ✅ [${i}] poolMint bulundu: ${ix.parsed.info.poolMint}`);
            return ix.parsed.info.poolMint;
          }
          if (ix.parsed.info.mint && ix.parsed.type?.toLowerCase().includes("pool")) {
            console.log(`  ✅ [${i}] pool mint bulundu: ${ix.parsed.info.mint}`);
            return ix.parsed.info.mint;
          }
        }
      }

      // 🎯 3. Token Balance Analizi — yeni oluşturulan mint'leri bul
      console.log("📊 Token balance değişikliklerini analiz ediyorum...");
      const newTokens: string[] = [];

      for (const post of postTokenBalances) {
        const pre = preTokenBalances.find((p: any) => p.accountIndex === post.accountIndex);

        // Yeni account oluşturuldu ve balance var
        if (!pre && post.uiTokenAmount?.amount !== "0") {
          newTokens.push(post.mint);
          console.log(
            `  📝 Yeni token: ${post.mint} (decimals: ${post.uiTokenAmount?.decimals}, amount: ${post.uiTokenAmount?.amount})`
          );
        }
      }

      // FIX: LP token'ları decimal=0 ile filtrelenmiyordu çünkü LP token'ları
      // genellikle 6-9 decimalli olur. decimal=0 olan token'lar NFT veya farklı
      // token türleridir. Yeni token varsa ilkini döndürüyoruz.
      if (newTokens.length > 0) {
        console.log(`⚠️ LP TOKEN (yeni hesap oluşturma): ${newTokens[0]}`);
        return newTokens[0];
      }

      // 🎯 4. Account keys'i kontrol et (debug)
      console.log(`🔑 Account keys (ilk 10):`);
      for (let i = 0; i < Math.min(accountKeys.length, 10); i++) {
        console.log(`  [${i}] ${accountKeys[i]}`);
      }

      console.log("❌ LP Mint bulunamadı");
      return null;
    } catch (err) {
      console.error("❌ LP mint çekme hatası:", err);
      return null;
    }
  }

  private async checkLiquidityLock(
    lpMint: string
  ): Promise<{ isLocked: boolean; lockDuration?: string }> {
    try {
      // LP token'ın en büyük sahibini bul
      const largestRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [lpMint],
        }),
      });
      const largestData = await largestRes.json();
      const lpTokenHolders = largestData.result?.value || [];

      if (lpTokenHolders.length === 0) {
        return { isLocked: false, lockDuration: "Kilitsiz" };
      }

      const lpContractRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [lpTokenHolders[0]?.address, { encoding: "jsonParsed" }],
        }),
      });
      const lpContractData = await lpContractRes.json();
      const lpOwner = lpContractData.result?.value?.data?.parsed?.info?.owner;

      if (!lpOwner) {
        return { isLocked: false, lockDuration: "Kilitsiz" };
      }

      const BURN_ADDRESS = "11111111111111111111111111111111";
      if (lpOwner === BURN_ADDRESS) {
        return { isLocked: true, lockDuration: "🔒 Kilitli (Burned)" };
      }

      const lockerMap: Record<string, string> = {
        "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m": "Streamflow",
        "Lock7hkde9SshYpYm6QPY9B8p51T5T21yH5S93p57jS": "PinkSale",
        "TSLvdd1pWpHViyvS19BneW8S5Wv8V784L596Ym8p1S": "Team Finance",
        "LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw": "Sol Incinerator",
        "vBoQ89Z8AU3BjARzLA3LPNEjVFayWN7NRc7scPvxWGg": "Orca",
        "GDDMwNyySMS356HawxwotsQWjcdj5EUr5dCyuqMX9mC": "Magic Eden",
      };

      if (lockerMap[lpOwner]) {
        return { isLocked: true, lockDuration: `🔒 Kilitli (${lockerMap[lpOwner]})` };
      }

      const parentProgram = await this.getAccountProgram(lpOwner);
      if (parentProgram === "6EF8rrecthR5Dkzon8Nwuxe8fuMDg6uG5TZAR4m226GG") {
        return { isLocked: true, lockDuration: "🔒 Kilitli (Pump.fun)" };
      }

      // FIX: Aşağıdaki kontroller LP mint'e özgü — token mint authority/freeze authority
      // LP kilidini değil, token'ın kendisini etkiler. Bu bilgiler ek uyarı olarak
      // döndürülüyor; "kilitli" olarak işaretlenmiyor.
      const mintInfoRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [lpMint, { encoding: "jsonParsed" }],
        }),
      });
      const mintInfo = await mintInfoRes.json();
      const mintAuthority = mintInfo.result?.value?.data?.parsed?.info?.mintAuthority;
      const freezeAuthority = mintInfo.result?.value?.data?.parsed?.info?.freezeAuthority;

      if (mintAuthority && mintAuthority !== BURN_ADDRESS) {
        return { isLocked: false, lockDuration: "⚠️ Kilitsiz (Mint yetkisi aktif)" };
      }

      if (freezeAuthority && freezeAuthority !== BURN_ADDRESS) {
        return { isLocked: false, lockDuration: "⚠️ Kilitsiz (Freeze yetkisi aktif)" };
      }

      return { isLocked: false, lockDuration: "Kilitsiz" };
    } catch (err) {
      console.error("❌ Kilit kontrolü hatası:", err);
      return { isLocked: false, lockDuration: "Kilitsiz" };
    }
  }

  private monitorLP(mintAddress: string, metadata: TokenMetadata) {
    const wsLP = new WebSocket(WS_URL);

    wsLP.on("open", () => {
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
          wsLP.close();
          this.activeMints.delete(mintAddress);
          return;
        }

        for (const log of logs) {
          if (LP_KEYWORDS.some((keyword) => log.includes(keyword))) {
            const detectedAt = Date.now();
            const expiresAt = detectedAt + 2 * 60 * 1000;

            if (!txSignature) {
              return;
            }

            const lpMint = await this.getLPMintFromTx(txSignature);
            const checkMint = lpMint || mintAddress;

            // ✅ LP Mint log'u yaz (sadece 1 kere)
            if (!mintData.lpLogged) {
              if (lpMint) {
                console.log(
                  `💧 LP tespit edildi: ${metadata.name} (${metadata.symbol}) | LP Mint: ${lpMint}`
                );
              } else {
                console.log(
                  `⚠️ LP tespit edildi: ${metadata.name} (${metadata.symbol}) | LP Mint: Bulunamadı`
                );
              }
              mintData.lpLogged = true;
            }

            // FIX: Race condition düzeltildi — wsLP.close() ve activeMints.delete()
            // artık Promise.all tamamlandıktan sonra çağrılıyor.
            Promise.all([
              this.checkLiquidityLock(checkMint),
              this.fetchPoolLiquidity(checkMint),
            ])
              .then(([{ isLocked, lockDuration }, liquidityAmount]) => {
                const lpData = {
                  id: `${mintAddress}-${detectedAt}`,
                  mintAddress,
                  lpMint: lpMint || "Bulunamadı",
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
                this.eventEmitter("lp_detected", lpData);

                if (isLocked) {
                  const solAmount = liquidityAmount ? `${liquidityAmount.toFixed(4)} SOL` : "Bilinmiyor";
                  const msgText =
                    `🔒 <b>KİLİTLİ LP TESPİT EDİLDİ!</b>\n\n` +
                    `🪙 <b>Token:</b> ${metadata.name} (${metadata.symbol})\n` +
                    `🏦 <b>Kilit Türü:</b> ${lockDuration}\n` +
                    `💧 <b>Likidite:</b> ${solAmount}\n` +
                    `📋 <b>Token Adres:</b> <code>${mintAddress}</code>\n` +
                    `🔗 <b>LP Mint:</b> <code>${checkMint}</code>\n\n` +
                    `🔍 <a href="https://dexscreener.com/solana/${mintAddress}">Dexscreener</a> | ` +
                    `🪐 <a href="https://jup.ag/swap/SOL-${mintAddress}">Jupiter</a> | ` +
                    `⚡ <a href="https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${mintAddress}">Raydium</a>`;
                  sendTelegramNotification(msgText);
                }
              })
              .catch((err) => {
                console.error("❌ LP veri çekme hatası:", err);
                this.eventEmitter("lp_detected", {
                  id: `${mintAddress}-${detectedAt}`,
                  mintAddress,
                  lpMint: lpMint || "Bulunamadı",
                  name: metadata.name,
                  symbol: metadata.symbol,
                  detectedAt,
                  expiresAt,
                  isLocked: false,
                  raydiumUrl: `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${mintAddress}`,
                  jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
                  dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
                });
              })
              .finally(() => {
                // FIX: WebSocket ve activeMints temizliği Promise tamamlandıktan sonra yapılıyor
                wsLP.close();
                this.activeMints.delete(mintAddress);
              });

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
      isMonitoring: false,
    });
  }
}
