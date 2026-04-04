import WebSocket from "ws";  

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;  
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;  
const HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;  
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";  

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;  
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;  

const DEBUG_MODE = process.env.DEBUG_MODE === "true" || false;

async function sendTelegramNotification(message: string): Promise<void> {  
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {  
    console.warn("⚠️ Telegram bilgileri eksik");  
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
      console.log("📲 Telegram gönderildi");  
    } else {  
      console.error("❌ Telegram hatası:", data.description);  
    }  
  } catch (err) {  
    console.error("❌ Telegram bildirim hatası:", err);  
  }  
}  

// ✅ Logger helper
const logger = {
  info: (msg: string, data?: any) => {
    if (DEBUG_MODE) console.log(`ℹ️ ${msg}`, data || "");
  },
  success: (msg: string) => console.log(`✅ ${msg}`),
  warn: (msg: string) => console.warn(`⚠️ ${msg}`),
  error: (msg: string, err?: any) => console.error(`❌ ${msg}`, err ? `: ${err.message}` : ""),
  debug: (msg: string, data?: any) => {
    if (DEBUG_MODE) console.log(`🔍 ${msg}`, data || "");
  },
};

const MAX_TRACKED = 7;  
const MAX_AGE_MS = 120000;  

const LP_KEYWORDS = [  
  "add_liquidity", "initialize_pool", "CreatePool", "initialize2",
  "addLiquidity", "InitPool", "initializePool", "init_pool",
  "addLiquidityToPool", "create_pool", "AddLiquidity", "createLiquidity",
  "mintToPool", "depositLiquidity", "deposit_liquidity", "pool_initialize",
  "PoolInit", "create_pool_account", "initialize_pool_account",
  "addLiquiditySOL", "addLiquidityToken", "addLiquiditySingle",
  "Instruction: InitializePool", "Instruction: AddLiquidity",
  "Instruction: CreatePool", "InitializeStateV2", "LiquidityAdded",
  "PoolInitialized",  
];  

interface TokenMetadata {  
  name: string;  
  symbol: string;  
  decimals?: number;  
}  

interface ActiveMint {  
  timestamp: number;  
  metadata: TokenMetadata;  
  lpWebSocket?: WebSocket;  
  lpLogged?: boolean;  
  lpMint?: string;  
}  

interface PoolInfo {
  lpMint: string;
  poolAddress: string;
  protocol: string;
  solLiquidity: number;
  lpTokenSupply: number;
}

const POOL_SIZE_RANGES = {
  RAYDIUM: { min: 1400, max: 1500, name: "Raydium" },
  ORCA: { min: 8100, max: 8400, name: "Orca" },
  MARINADE: { min: 4300, max: 5200, name: "Marinade" },
  METEORA: { min: 6200, max: 6600, name: "Meteora" },
};

export class HeliusMonitor {  
  private activeMints: Map<string, ActiveMint> = new Map();  
  private mainWebSocket: WebSocket | null = null;  
  private reconnectTimeout: NodeJS.Timeout | null = null;  
  private heartbeatInterval: NodeJS.Timeout | null = null;  
  private eventEmitter: (event: string, data: any) => void;  
  private isRunning: boolean = false;  

  private processedSignatures: Set<string> = new Set();
  private txCache: Map<string, any> = new Map();
  private poolCache: Map<string, PoolInfo> = new Map();

  constructor(eventEmitter: (event: string, data: any) => void) {  
    this.eventEmitter = eventEmitter;  
  }  

  async start() {  
    if (this.isRunning) {  
      logger.warn("Monitor zaten çalışıyor");  
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
      `🔍 Yeni tokenlar ve kilitli LP'ler izleniyor`;  
    sendTelegramNotification(msg);  
  }  

  getState() {  
    return this.isRunning;  
  }  

  private connect() {  
    if (!HELIUS_API_KEY) {  
      logger.error("HELIUS_API_KEY ortam değişkeni bulunamadı");  
      this.eventEmitter("error", {  
        message: "HELIUS_API_KEY bulunamadı",  
        type: "config",  
      });  
      return;  
    }  

    this.mainWebSocket = new WebSocket(WS_URL);  

    this.mainWebSocket.on("open", () => {  
      logger.success("Helius WebSocket bağlantısı kuruldu");  
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

        for (const logMsg of logs) {  
          if (logMsg.includes("Program log: Instruction: InitializeMint")) {  
            await this.handleMintDetection(signature);  
          }  
        }  
      } catch (err) {  
        logger.error("Mesaj işleme hatası", err as Error);  
      }  
    });  

    this.mainWebSocket.on("error", (err: any) => {  
      const isAuthError = err.message && err.message.includes("401");  
      logger.error("WebSocket hatası", err);

      if (isAuthError) {  
        this.eventEmitter("error", {  
          message: "API anahtarı geçersiz",  
          type: "auth",  
        });  
      }  

      this.eventEmitter("connection_status", {   
        connected: false,   
        message: isAuthError ? "API hatası" : "Bağlantı hatası",  
        isMonitoring: this.isRunning  
      });  
    });  

    this.mainWebSocket.on("close", () => {  
      logger.warn("WebSocket bağlantısı kapandı");  
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

      logger.success(`Yeni Mint: ${metadata.name} (${metadata.symbol})`);  

      const detectedAt = Date.now();  
      const expiresAt = detectedAt + (3 * 60 * 1000);  

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
      });  

      this.monitorLP(mintAddress, metadata);  
    } catch (err) {  
      logger.error("Mint tespit hatası", err as Error);  
    }  
  }  

  private async fetchMintAddress(signature: string): Promise<string | null> {  
    try {  
      if (this.txCache.has(signature)) {
        return this.txCache.get(signature).mintAddress;
      }

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

      if (!data.result) return null;

      const result = data.result;  
      const message = result?.transaction?.message;  

      if (!message) return null;

      const accountKeys = message?.accountKeys;  
      const instructions = message?.instructions;  

      if (!Array.isArray(accountKeys) || !Array.isArray(instructions)) return null;

      let mintAddress: string | null = null;  

      for (const ix of instructions) {  
        const pid = ix?.programIdIndex;  

        if (pid === undefined || pid === null) continue;  
        if (pid < 0 || pid >= accountKeys.length) continue;

        if (accountKeys[pid] === SPL_TOKEN_PROGRAM_ID) {  
          const accounts = ix?.accounts;  
          if (Array.isArray(accounts) && accounts.length > 0) {  
            const accountIndex = accounts[0];  
            if (accountIndex >= 0 && accountIndex < accountKeys.length) {  
              mintAddress = accountKeys[accountIndex];  
              break;  
            }  
          }  
        }  
      }  

      if (mintAddress) {
        this.txCache.set(signature, { mintAddress });

        if (this.txCache.size > 5000) {
          const firstKey = Array.from(this.txCache.keys())[0];
          this.txCache.delete(firstKey);
        }
      }

      return mintAddress;  
    } catch (err) {  
      logger.error("Mint adresi fetch hatası");  
      return null;  
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
      const decimals = result.token_info?.decimals || 6;  

      if (name === "Bilinmiyor" && symbol === "Bilinmiyor") return null;  

      return { name, symbol, decimals };  
    } catch (err) {  
      logger.error("Token metadata hatası");  
      return null;  
    }  
  }  

  private async getLPMintFromTokenBalances(signature: string): Promise<string | null> {
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
      const postTokenBalances = data.result?.meta?.postTokenBalances || [];
      const preTokenBalances = data.result?.meta?.preTokenBalances || [];

      if (postTokenBalances.length === 0) return null;

      const newTokens = new Map<string, any>();

      for (const post of postTokenBalances) {
        const pre = preTokenBalances.find(p => p.mint === post.mint);
        if (!pre) {
          newTokens.set(post.mint, post);
        }
      }

      for (const [mint, tokenData] of newTokens) {
        const decimals = tokenData.uiTokenAmount?.decimals;

        if ((decimals === 6 || decimals === 8) && tokenData.uiTokenAmount?.uiAmount > 0) {
          const isValid = await this.verifyLPToken(mint);
          if (isValid) {
            return mint;
          }
        }
      }

      return null;
    } catch (err) {
      logger.error("Token balance LP mint hatası");
      return null;
    }
  }

  private async verifyLPToken(mint: string): Promise<boolean> {
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenSupply",
          params: [mint],
        }),
      });

      const data = await res.json();
      const supply = data.result?.value?.amount || "0";
      const supplyNumber = parseInt(supply);

      const infoRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [mint, { encoding: "jsonParsed" }],
        }),
      });

      const infoData = await infoRes.json();
      const info = infoData.result?.value?.data?.parsed?.info;

      if (!info) return false;

      const isValid =
        info.decimals >= 6 &&
        info.decimals <= 8 &&
        supplyNumber > 1000 &&
        info.isInitialized === true;

      return isValid;
    } catch (err) {
      logger.error("LP token doğrulama hatası");
      return false;
    }
  }

  private getProtocolByDataSize(dataSize: number): string {
    if (dataSize >= POOL_SIZE_RANGES.RAYDIUM.min && dataSize <= POOL_SIZE_RANGES.RAYDIUM.max) {
      return "Raydium";
    }
    if (dataSize >= POOL_SIZE_RANGES.ORCA.min && dataSize <= POOL_SIZE_RANGES.ORCA.max) {
      return "Orca";
    }
    if (dataSize >= POOL_SIZE_RANGES.MARINADE.min && dataSize <= POOL_SIZE_RANGES.MARINADE.max) {
      return "Marinade";
    }
    if (dataSize >= POOL_SIZE_RANGES.METEORA.min && dataSize <= POOL_SIZE_RANGES.METEORA.max) {
      return "Meteora";
    }
    return "Bilinmiyor";
  }

  private async verifyLPProtocol(lpMint: string): Promise<{ isValid: boolean; protocol: string; poolAddress: string | null }> {
    try {
      if (!lpMint || lpMint.length !== 44) {
        return { isValid: false, protocol: "Bilinmiyor", poolAddress: null };
      }

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
      const poolAddress = largestData.result?.value?.[0]?.address;

      if (!poolAddress) {
        return { isValid: false, protocol: "Pool bulunamadı", poolAddress: null };
      }

      const accountRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [poolAddress, { encoding: "base64" }],
        }),
      });

      const accountData = await accountRes.json();
      const account = accountData.result?.value;

      if (!account) {
        return { isValid: false, protocol: "Account alınamadı", poolAddress };
      }

      const dataSize = account.data?.[0]?.length || 0;
      const protocol = this.getProtocolByDataSize(dataSize);

      if (protocol === "Bilinmiyor") {
        logger.info(`Bilinmeyen pool size: ${dataSize}b`);
        return { isValid: true, protocol: `Bilinmeyen (${dataSize}b)`, poolAddress };
      }

      return { isValid: true, protocol, poolAddress };

    } catch (err) {
      logger.error("LP Protocol doğrulama hatası");
      return { isValid: false, protocol: "Hata", poolAddress: null };
    }
  }

  private async getPoolLiquidity(lpMint: string): Promise<{ solLiquidity: number; poolAddress: string | null }> {
    try {
      if (this.poolCache.has(lpMint)) {
        const cached = this.poolCache.get(lpMint);
        return { solLiquidity: cached?.solLiquidity || 0, poolAddress: cached?.poolAddress || null };
      }

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
      const poolAddress = largestData.result?.value?.[0]?.address;

      if (!poolAddress) {
        return { solLiquidity: 0, poolAddress: null };
      }

      const balanceRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBalance",
          params: [poolAddress],
        }),
      });

      const balanceData = await balanceRes.json();
      const solBalanceLamports = balanceData.result?.value || 0;
      const solBalance = solBalanceLamports / 1e9;

      const lpTokenSupplyRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenSupply",
          params: [lpMint],
        }),
      });

      const supplyData = await lpTokenSupplyRes.json();
      const lpTokenSupply = supplyData.result?.value?.uiAmount || 0;

      this.poolCache.set(lpMint, {
        lpMint,
        poolAddress,
        protocol: "Unknown",
        solLiquidity: solBalance,
        lpTokenSupply,
      });

      if (this.poolCache.size > 1000) {
        const firstKey = Array.from(this.poolCache.keys())[0];
        this.poolCache.delete(firstKey);
      }

      return { solLiquidity: solBalance, poolAddress };
    } catch (err) {
      logger.error("Pool likidite hatası");
      return { solLiquidity: 0, poolAddress: null };
    }
  }

  private async getLPMintFromTxLegacy(signature: string): Promise<string | null> {
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

      if (!transaction) return null;

      const instructions = transaction?.message?.instructions || [];

      for (const ix of instructions) {
        if (ix.programId === "675kPX9MHTjS2zt1qrXiE48DqBJ5R8k6rJsV5ln32Xw") {
          if (ix.parsed?.info?.poolMint) {
            return ix.parsed.info.poolMint;
          }
        }

        if (ix.programId === "9W959DqEETiGZocYWCQqvQsGoalQzX7zxoACW5SPqo1J") {
          if (ix.parsed?.info?.mint) {
            return ix.parsed.info.mint;
          }
        }
      }

      const postTokenBalances = data.result?.meta?.postTokenBalances || [];
      const lpMints = postTokenBalances
        .filter(balance => balance.uiTokenAmount?.decimals === 6 && balance.uiTokenAmount?.uiAmount > 0)
        .map(balance => balance.mint);

      return lpMints.length > 0 ? lpMints[0] : null;
    } catch (err) {
      logger.error("Legacy LP mint hatası");
      return null;
    }
  }

  private async getLPMintFromTx(signature: string): Promise<string | null> {
    try {
      let lpMint = await this.getLPMintFromTokenBalances(signature);
      if (lpMint) return lpMint;

      lpMint = await this.getLPMintFromTxLegacy(signature);
      if (lpMint) return lpMint;

      return null;
    } catch (err) {
      logger.error("LP mint çekme hatası");
      return null;
    }
  }

  private async checkLiquidityLock(
    lpMint: string,
    poolAddress: string | null
  ): Promise<{ isLocked: boolean; lockDuration?: string }> {
    try {
      if (!lpMint || lpMint.length !== 44) {
        return { isLocked: false, lockDuration: "Geçersiz mint" };
      }

      let actualPoolAddress = poolAddress;

      if (!actualPoolAddress) {
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

        if (!largestData.result?.value || largestData.result.value.length === 0) {
          return { isLocked: false, lockDuration: "Holder bulunamadı" };
        }

        actualPoolAddress = largestData.result.value[0]?.address;
      }

      if (!actualPoolAddress) {
        return { isLocked: false, lockDuration: "Pool bulunamadı" };
      }

      const ownerRes = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [actualPoolAddress, { encoding: "base64" }],
        }),
      });

      const ownerData = await ownerRes.json();
      const poolOwner = ownerData.result?.value?.owner;

      if (!poolOwner) {
        return { isLocked: false, lockDuration: "Owner alınamadı" };
      }

      const BURN_ADDRESS = "11111111111111111111111111111111";

      if (poolOwner === BURN_ADDRESS) {
        return { isLocked: true, lockDuration: "🔒 Burned" };
      }

      const lockerMap: Record<string, string> = {
        "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m": "Streamflow",
        "Lock7hkde9SshYpYm6QPY9B8p51T5T21yH5S93p57jS": "PinkSale",
        "TSLvdd1pWpHViyvS19BneW8S5Wv8V784L596Ym8p1S": "Team Finance",
        "LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw": "Sol Incinerator",
        "vBoQ89Z8AU3BjARzLA3LPNEjVFayWN7NRc7scPvxWGg": "Orca",
        "GDDMwNyySMS356HawxwotsQWjcdj5EUr5dCyuqMX9mC": "Magic Eden",
      };

      if (lockerMap[poolOwner]) {
        return { isLocked: true, lockDuration: `🔒 ${lockerMap[poolOwner]}` };
      }

      const parentProgram = await this.getAccountProgram(poolOwner);
      if (parentProgram === "6EF8rrecthR5Dkzon8Nwuxe8fuMDg6uG5TZAR4m226GG") {
        return { isLocked: true, lockDuration: "🔒 Pump.fun" };
      }

      return { isLocked: false, lockDuration: "✅ Güvenli" };

    } catch (err) {
      logger.error("LP kilit kontrolü hatası");
      return { isLocked: false, lockDuration: "Hata" };
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
      logger.error(`LP WebSocket hatası: ${mintAddress}`);  
    });  

    wsLP.on("message", async (data: Buffer) => {  
      try {  
        const msg = JSON.parse(data.toString());  
        const logs = msg?.params?.result?.value?.logs;  
        const txSignature: string | undefined = msg?.params?.result?.value?.signature;  

        if (!logs || !txSignature) return;

        if (this.processedSignatures.has(txSignature)) return;
        this.processedSignatures.add(txSignature);

        if (this.processedSignatures.size > 10000) {
          const firstSig = Array.from(this.processedSignatures)[0];
          this.processedSignatures.delete(firstSig);
        }

        const now = Date.now();  
        const mintData = this.activeMints.get(mintAddress);  
        if (!mintData || now - mintData.timestamp > MAX_AGE_MS) {  
          wsLP.close();  
          this.activeMints.delete(mintAddress);  
          return;  
        }  

        for (const logMsg of logs) {  
          if (LP_KEYWORDS.some((keyword) => logMsg.includes(keyword))) {  
            const detectedAt = Date.now();  

            // ✅ YENİ: LP Mint bulma durumunu kontrol et
            logger.info(`🔍 ${metadata.name} (${metadata.symbol}) - LP Mint arıyorum...`);
            const lpMint = await this.getLPMintFromTx(txSignature);  

            if (!lpMint) {
              // ✅ YENİ: LP Mint bulunamadı mesajı
              logger.warn(`❌ LP Mint BULUNAMADI: ${metadata.name} (${metadata.symbol})`);
              break;
            }

            // ✅ YENİ: LP Mint bulundu mesajı
            logger.success(`✅ LP Mint BULUNDU: ${metadata.name} (${metadata.symbol}) | LP: ${lpMint.slice(0, 8)}...`);
            mintData.lpMint = lpMint;

            const { isValid: isValidProtocol, protocol, poolAddress } = await this.verifyLPProtocol(lpMint);

            if (!isValidProtocol) {
              logger.warn(`Protocol doğrulaması başarısız`);
              break;
            }

            if (!mintData.lpLogged) {
              mintData.lpLogged = true;
            }

            const { solLiquidity: liquidityAmountSOL } = await this.getPoolLiquidity(lpMint);

            // ✅ YENİ: Kilit durumu kontrol ettikten sonra mesaj
            logger.info(`🔒 Kilit durumu kontrol ediliyor...`);
            const lockInfo = await this.checkLiquidityLock(lpMint, poolAddress);  

            // ✅ YENİ: Kilit durumu net şekilde yazsın
            if (lockInfo.isLocked) {
              logger.success(`🔒 KİLİTLİ: ${lockInfo.lockDuration}`);
              const solAmount = liquidityAmountSOL ? `${liquidityAmountSOL.toFixed(4)} SOL` : "Bilinmiyor";

              console.log(
                `\n${'='.repeat(70)}\n` +
                `🔒 KİLİTLİ LP BULUNDU!\n` +
                `${'='.repeat(70)}\n` +
                `🪙 Token: ${metadata.name} (${metadata.symbol})\n` +
                `📊 Protocol: ${protocol}\n` +
                `🏦 Kilit Tipi: ${lockInfo.lockDuration}\n` +
                `💧 Likidite: ${solAmount}\n` +
                `🔗 LP Mint: ${lpMint}\n` +
                `${'='.repeat(70)}\n`
              );
            } else {
              logger.warn(`⚠️ KİLİTSİZ: ${lockInfo.lockDuration}`);
              const solAmount = liquidityAmountSOL ? `${liquidityAmountSOL.toFixed(4)} SOL` : "Bilinmiyor";

              console.log(
                `\n${'='.repeat(70)}\n` +
                `⚠️ KİLİTSİZ LP BULUNDU!\n` +
                `${'='.repeat(70)}\n` +
                `🪙 Token: ${metadata.name} (${metadata.symbol})\n` +
                `📊 Protocol: ${protocol}\n` +
                `🏦 Durum: ${lockInfo.lockDuration}\n` +
                `💧 Likidite: ${solAmount}\n` +
                `🔗 LP Mint: ${lpMint}\n` +
                `${'='.repeat(70)}\n`
              );
            }

            const expiresAt = detectedAt + (2 * 60 * 1000);

            const lpData = {  
              id: `${mintAddress}-${detectedAt}`,  
              mintAddress,  
              lpMint,  
              name: metadata.name,  
              symbol: metadata.symbol,  
              protocol,
              detectedAt,  
              expiresAt,  
              isLocked: lockInfo.isLocked,  
              lockDuration: lockInfo.lockDuration,  
              liquidityAmountSOL,  
              raydiumUrl: `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${mintAddress}`,  
              jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,  
              dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,  
            };  

            this.eventEmitter("lp_detected", lpData);  

            if (lockInfo.isLocked) {  
              const solAmount = liquidityAmountSOL ? `${liquidityAmountSOL.toFixed(4)} SOL` : "Bilinmiyor";  

              const msg =  
                `🔒 <b>KİLİTLİ LP!</b>\n\n` +  
                `🪙 <b>${metadata.name} (${metadata.symbol})</b>\n` +  
                `📊 ${protocol}\n` +
                `🏦 ${lockInfo.lockDuration}\n` +  
                `💧 ${solAmount}\n` +  
                `🔗 <code>${lpMint}</code>\n\n` +  
                `<a href="https://dexscreener.com/solana/${lpMint}">Dexscreener</a>`;  

              sendTelegramNotification(msg);  
            }

            wsLP.close();  
            this.activeMints.delete(mintAddress);  
            break;  
          }  
        }  
      } catch (err) {  
        logger.error("LP mesaj işleme hatası", err as Error);  
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
      logger.warn("Monitor zaten durdurulmuş");  
      return;  
    }  

    console.log("🛑 Monitor durduruluyor...");  
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
    this.processedSignatures.clear();
    this.txCache.clear();
    this.poolCache.clear();
    this.eventEmitter("monitoring_state", { isMonitoring: false });  
    this.eventEmitter("connection_status", {   
      connected: false,   
      message: "Monitor durduruldu",  
      isMonitoring: false  
    });  
  }  
}