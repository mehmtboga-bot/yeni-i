import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const MAX_TRACKED = 7;
const MAX_AGE_MS = 120000;
const INITIAL_BACKOFF = 1000;
const MAX_BACKOFF = 30000;

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
];

interface TokenMetadata {
  name: string;
  symbol: string;
}

interface ActiveMint {
  timestamp: number;
  metadata: TokenMetadata;
}

export class HeliusMonitor {
  private activeMints: Map<string, ActiveMint> = new Map();
  private mainWebSocket: WebSocket | null = null;
  private lpWebSocket: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private lpReconnectTimeout: NodeJS.Timeout | null = null;
  private eventEmitter: (event: string, data: any) => void;
  private isRunning: boolean = false;
  private reconnectAttempts: number = 0;
  private lpReconnectAttempts: number = 0;
  private mintQueue: Set<string> = new Set();
  private isProcessingQueue: boolean = false;

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
    this.reconnectAttempts = 0;
    this.connect();
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
      this.reconnectAttempts = 0;
      
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
            this.mintQueue.add(signature);
            this.processQueue();
          }
        }
      } catch (err) {
        console.error("❌ Mesaj işleme hatası:", err);
      }
    });

    this.mainWebSocket.on("error", (err: any) => {
      console.error("❌ WebSocket hatası:", err);
      
      const isAuthError = err.message && err.message.includes("401");
      const isRateLimit = err.message && err.message.includes("429");
      
      if (isAuthError) {
        this.eventEmitter("error", {
          message: "Helius API anahtarı geçersiz. Lütfen HELIUS_API_KEY environment variable'ını kontrol edin.",
          type: "auth",
        });
      } else if (isRateLimit) {
        console.warn("⚠️ Rate limit reached. Backing off...");
        this.reconnectAttempts = Math.min(this.reconnectAttempts + 3, 10);
      }
      
      this.eventEmitter("connection_status", { 
        connected: false, 
        message: isAuthError ? "API anahtarı hatası" : isRateLimit ? "API sınırlaması - bekleniliyor..." : "Bağlantı hatası",
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
        const backoff = Math.min(
          INITIAL_BACKOFF * Math.pow(2, this.reconnectAttempts),
          MAX_BACKOFF
        ) + Math.random() * 1000;
        this.reconnectAttempts++;
        this.reconnectTimeout = setTimeout(() => this.connect(), backoff);
      }
    });
  }

  private async processQueue() {
    if (this.isProcessingQueue || this.mintQueue.size === 0) return;
    
    this.isProcessingQueue = true;
    
    while (this.mintQueue.size > 0) {
      const signature = Array.from(this.mintQueue)[0];
      this.mintQueue.delete(signature);
      
      try {
        await this.handleMintDetection(signature);
      } catch (err) {
        console.error("❌ Mint işleme hatası:", err);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.isProcessingQueue = false;
  }

  private async handleMintDetection(signature: string) {
    try {
      const mintAddress = await this.fetchMintAddress(signature);
      if (!mintAddress) return;

      if (this.activeMints.size >= MAX_TRACKED) {
        const oldestKey = Array.from(this.activeMints.keys())[0];
        this.activeMints.delete(oldestKey);
      }

      if (this.activeMints.has(mintAddress)) return;

      const metadata = await this.fetchTokenMetadata(mintAddress);
      if (!metadata) return;

      console.log(`🪙 Yeni mint tespit edildi: ${metadata.name} (${metadata.symbol})`);

      const detectedAt = Date.now();
      const expiresAt = detectedAt + (3 * 60 * 1000);

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

  private monitorLP(mintAddress: string, metadata: TokenMetadata) {
    if (!this.lpWebSocket || this.lpWebSocket.readyState !== WebSocket.OPEN) {
      this.createLPWebSocket();
    }

    const checkInterval = setInterval(() => {
      const now = Date.now();
      const mintData = this.activeMints.get(mintAddress);
      
      if (!mintData || now - mintData.timestamp > MAX_AGE_MS) {
        console.log(`⏳ LP izleme süresi doldu: ${mintAddress}`);
        clearInterval(checkInterval);
        this.activeMints.delete(mintAddress);
      }
    }, 1000);
  }

  private createLPWebSocket() {
    if (this.lpWebSocket && this.lpWebSocket.readyState === WebSocket.OPEN) {
      return;
    }

    this.lpWebSocket = new WebSocket(WS_URL);
    this.lpReconnectAttempts = 0;

    this.lpWebSocket.on("open", () => {
      console.log("✅ LP İzleme WebSocket bağlantısı kuruldu");
      this.lpReconnectAttempts = 0;
      
      const mentions: string[] = Array.from(this.activeMints.keys());
      if (mentions.length > 0) {
        const sub = {
          jsonrpc: "2.0",
          id: 2,
          method: "logsSubscribe",
          params: [{ mentions }, { commitment: "finalized" }],
        };
        this.lpWebSocket?.send(JSON.stringify(sub));
      }
    });

    this.lpWebSocket.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const logs = msg?.params?.result?.value?.logs;
        const signature = msg?.params?.result?.value?.signature;
        
        if (!logs || !signature) return;

        for (const [mintAddress, mintData] of this.activeMints.entries()) {
          for (const log of logs) {
            if (LP_KEYWORDS.some((keyword) => log.includes(keyword))) {
              console.log(`💧 LP tespit edildi: ${mintData.metadata.name} (${mintData.metadata.symbol})`);

              const detectedAt = Date.now();
              const expiresAt = detectedAt + (2 * 60 * 1000);

              this.eventEmitter("lp_detected", {
                id: `${mintAddress}-${detectedAt}`,
                mintAddress,
                name: mintData.metadata.name,
                symbol: mintData.metadata.symbol,
                detectedAt,
                expiresAt,
                raydiumUrl: `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${mintAddress}`,
                jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
                dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
              });

              this.activeMints.delete(mintAddress);
              break;
            }
          }
        }
      } catch (err) {
        console.error("❌ LP mesaj işleme hatası:", err);
      }
    });

    this.lpWebSocket.on("error", (err: any) => {
      console.error("❌ LP WebSocket hatası:", err);
    });

    this.lpWebSocket.on("close", () => {
      console.log("🔌 LP izleme bağlantısı kapandı");
      
      if (this.isRunning && this.activeMints.size > 0) {
        const backoff = Math.min(
          INITIAL_BACKOFF * Math.pow(2, this.lpReconnectAttempts),
          MAX_BACKOFF
        ) + Math.random() * 1000;
        this.lpReconnectAttempts++;
        this.lpReconnectTimeout = setTimeout(() => this.createLPWebSocket(), backoff);
      }
    });
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

    if (this.lpReconnectTimeout) {
      clearTimeout(this.lpReconnectTimeout);
      this.lpReconnectTimeout = null;
    }

    if (this.mainWebSocket) {
      this.mainWebSocket.close();
      this.mainWebSocket = null;
    }

    if (this.lpWebSocket) {
      this.lpWebSocket.close();
      this.lpWebSocket = null;
    }

    this.activeMints.clear();
    this.mintQueue.clear();
    this.eventEmitter("monitoring_state", { isMonitoring: false });
    this.eventEmitter("connection_status", { 
      connected: false, 
      message: "Monitor durduruldu",
      isMonitoring: false
    });
  }
}
