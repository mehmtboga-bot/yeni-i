import WebSocket from 'ws';

interface LiquidityDetection {
  mintAddress: string;
  poolAddress: string;
  signature: string;
  timestamp: Date;
  detectionType: 'pool_creation' | 'swap_activity';
}

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || process.env.HELIUS_RPC_API_KEY || "b5e35ddc-dd6b-4d58-897a-8a6b491d1caa";
const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Raydium AMM Program IDs
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_AMM_V3 = "27haf8L6oxUeXrHrgEgsexjSY5hbVUWEmvv9Nyxg8vQv";

export class LiquidityDetector {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private onLiquidityDetected: ((detection: LiquidityDetection) => void) | null = null;
  private monitoredTokens: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(onLiquidityDetected?: (detection: LiquidityDetection) => void) {
    this.onLiquidityDetected = onLiquidityDetected || null;
  }

  async start(): Promise<void> {
    try {
      console.log("🔄 Helius WebSocket likidite detector başlatılıyor...");
      await this.connectWebSocket();
    } catch (error) {
      console.error("❌ Likidite detector başlatılamadı:", error);
      throw error;
    }
  }

  addTokenToMonitor(mintAddress: string): void {
    this.monitoredTokens.add(mintAddress);
    console.log(`📊 Token izlemeye alındı: ${mintAddress.slice(0, 8)}... (Toplam: ${this.monitoredTokens.size})`);
  }

  removeTokenFromMonitor(mintAddress: string): void {
    this.monitoredTokens.delete(mintAddress);
    console.log(`🗑️ Token izlemeden çıkarıldı: ${mintAddress.slice(0, 8)}...`);
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', async () => {
        console.log("✅ Helius WebSocket bağlantısı kuruldu (Raydium pool monitoring)");
        this.reconnectAttempts = 0;

        // Subscribe to Raydium transactions
        const subscription = {
          jsonrpc: "2.0",
          id: 1,
          method: "transactionSubscribe",
          params: [
            {
              accountInclude: [RAYDIUM_AMM_V4],
              accountRequire: [],
            },
            {
              commitment: "confirmed",
              encoding: "jsonParsed",
              transactionDetails: "full",
              showRewards: false,
              maxSupportedTransactionVersion: 0
            }
          ]
        };

        this.ws!.send(JSON.stringify(subscription));
        console.log("📡 Raydium pool işlemleri dinleniyor...");

        // Keep alive ping
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 30000);

        resolve();
      });

      this.ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          await this.processTransaction(message);
        } catch (error) {
          console.error("❌ Transaction işleme hatası:", error);
        }
      });

      this.ws.on('error', (error) => {
        console.error("❌ WebSocket hatası:", error);
        reject(error);
      });

      this.ws.on('close', () => {
        console.log("🔌 Helius WebSocket bağlantısı kapandı");
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        this.handleReconnect();
      });

      this.ws.on('pong', () => {
        // Connection is alive
      });
    });
  }

  private async processTransaction(message: any): Promise<void> {
    try {
      if (!message.params?.result) return;

      const result = message.params.result;
      const transaction = result.transaction;
      const signature = transaction?.transaction?.signatures?.[0];
      
      if (!transaction?.meta?.logMessages || !signature) return;

      const logs = transaction.meta.logMessages;
      const accountKeys = transaction.transaction?.message?.accountKeys;

      if (!accountKeys) return;

      // Detect pool creation
      const isNewPool = logs.some((log: string) => 
        log.includes("initialize2: InitializeInstruction2") ||
        log.includes("Program log: initialize2")
      );

      // Detect swap activity
      const isSwap = logs.some((log: string) => 
        log.includes("Program log: swap") ||
        log.includes("Program log: swapBaseIn") ||
        log.includes("Program log: swapBaseOut")
      );

      if (isNewPool) {
        await this.handlePoolCreation(signature, accountKeys, logs);
      } else if (isSwap) {
        await this.handleSwapActivity(signature, accountKeys, transaction);
      }

    } catch (error) {
      console.error("❌ Transaction processing error:", error);
    }
  }

  private async handlePoolCreation(
    signature: string, 
    accountKeys: any[], 
    logs: string[]
  ): Promise<void> {
    try {
      // Extract token mints from pool creation
      // In Raydium, token mints are typically at specific positions
      const tokenMints = await this.extractTokenMintsFromAccounts(accountKeys);
      
      for (const mintAddress of tokenMints) {
        if (this.monitoredTokens.has(mintAddress)) {
          console.log(`🚀 LİKİDİTE POOL OLUŞTURULDU! Token: ${mintAddress.slice(0, 8)}...`);
          console.log(`📝 Signature: ${signature}`);

          const detection: LiquidityDetection = {
            mintAddress,
            poolAddress: accountKeys[4] || 'unknown', // Pool address usually at index 4
            signature,
            timestamp: new Date(),
            detectionType: 'pool_creation'
          };

          if (this.onLiquidityDetected) {
            this.onLiquidityDetected(detection);
          }
        }
      }
    } catch (error) {
      console.error("❌ Pool creation handling error:", error);
    }
  }

  private async handleSwapActivity(
    signature: string,
    accountKeys: any[],
    transaction: any
  ): Promise<void> {
    try {
      // Extract token mints from swap transaction
      const preTokenBalances = transaction.meta?.preTokenBalances || [];
      const postTokenBalances = transaction.meta?.postTokenBalances || [];

      const involvedMints = new Set<string>();
      
      [...preTokenBalances, ...postTokenBalances].forEach((balance: any) => {
        if (balance.mint) {
          involvedMints.add(balance.mint);
        }
      });

      for (const mintAddress of involvedMints) {
        if (this.monitoredTokens.has(mintAddress)) {
          console.log(`💧 LİKİDİTE AKTİVİTESİ TESPİT EDİLDİ (SWAP)! Token: ${mintAddress.slice(0, 8)}...`);
          console.log(`📝 Signature: ${signature}`);

          const detection: LiquidityDetection = {
            mintAddress,
            poolAddress: accountKeys[4] || 'unknown',
            signature,
            timestamp: new Date(),
            detectionType: 'swap_activity'
          };

          if (this.onLiquidityDetected) {
            this.onLiquidityDetected(detection);
          }

          // Remove from monitoring after detection
          this.removeTokenFromMonitor(mintAddress);
        }
      }
    } catch (error) {
      console.error("❌ Swap activity handling error:", error);
    }
  }

  private async extractTokenMintsFromAccounts(accountKeys: any[]): Promise<string[]> {
    const mints: string[] = [];
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    
    // Filter out system accounts and programs
    const systemAccounts = [
      "11111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      RAYDIUM_AMM_V4,
      RAYDIUM_AMM_V3,
      "SysvarRent111111111111111111111111111111111",
      SOL_MINT
    ];

    for (const key of accountKeys) {
      const address = typeof key === 'string' ? key : key.pubkey;
      
      if (address && 
          !systemAccounts.includes(address) && 
          address.length === 43 || address.length === 44) {
        // Verify if it's a token mint by checking its structure
        const isMint = await this.verifyTokenMint(address);
        if (isMint) {
          mints.push(address);
        }
      }
    }

    return mints;
  }

  private async verifyTokenMint(address: string): Promise<boolean> {
    try {
      const response = await fetch(HTTP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [address, { encoding: "jsonParsed" }]
        })
      });

      const data = await response.json();
      const accountInfo = data.result?.value;
      
      if (!accountInfo) return false;

      // Check if it's a token mint (owner is Token Program)
      return accountInfo.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
             accountInfo.data?.program === "spl-token" &&
             accountInfo.data?.parsed?.type === "mint";
    } catch (error) {
      return false;
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      
      console.log(`🔄 Yeniden bağlanma denemesi ${this.reconnectAttempts}/${this.maxReconnectAttempts} - ${delay}ms sonra`);
      
      setTimeout(() => {
        this.connectWebSocket().catch(console.error);
      }, delay);
    } else {
      console.error("❌ Maksimum yeniden bağlanma denemesi aşıldı");
    }
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.monitoredTokens.clear();
  }

  setOnLiquidityDetected(callback: (detection: LiquidityDetection) => void): void {
    this.onLiquidityDetected = callback;
  }

  getMonitoredTokensCount(): number {
    return this.monitoredTokens.size;
  }
}

export const liquidityDetector = new LiquidityDetector();
