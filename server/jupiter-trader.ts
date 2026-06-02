import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import { TradeStore } from "./trade-store";
import { secrets } from "./secrets-loader";
import type { Position, TradeConfig } from "@shared/schema";

const HELIUS_API_KEY = secrets.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SWAP  = "https://lite-api.jup.ag/swap/v1/swap";
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
const PUMP_TRADE_API = "https://pumpportal.fun/api/trade-local";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;

// Cache TTL sabitleri
const BLOCKHASH_CACHE_TTL_MS = 5_000;  // 5 saniye
const BALANCE_CACHE_TTL_MS   = 2_000;  // 2 saniye

// TX onay zaman aşımı
const TX_CONFIRM_TIMEOUT_MS  = 30_000; // 30 saniye

// Fiyat monitörü güncelleme aralığı
const PRICE_MONITOR_INTERVAL_MS = 500; // 500ms

// Öncelik ücreti çarpanı
const PRIORITY_FEE_MULTIPLIER = 2;

type Emitter = (event: string, data: any) => void;

interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot?: number;
}

interface RetryOptions {
  retries: number;
  delayMs: number;
}

export class JupiterTrader {
  private store: TradeStore;
  private emit: Emitter;
  private keypair: Keypair | null = null;
  private connection: Connection | null = null;
  private decimalsCache: Map<string, number> = new Map();
  private inFlight: Set<string> = new Set();

  // Blockhash cache — 5s TTL
  private blockhashCache: { hash: string; lastValidBlockHeight: number; timestamp: number } | null = null;

  // Token balance cache — 2s TTL per mint
  private balanceCache: Map<string, { value: { uiAmount: number; raw: string; decimals: number } | null; timestamp: number }> = new Map();

  // Price monitor interval handle
  private priceMonitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(store: TradeStore, emit: Emitter) {
    this.store = store;
    this.emit = emit;
    this.initWallet();
    this.startPriceMonitor();
  }

  private initWallet() {
    const pk = secrets.TRADER_PRIVATE_KEY;
    if (!pk) {
      console.warn("⚠️ TRADER_PRIVATE_KEY tanımlı değil. Otomatik alım/satım devre dışı.");
      return;
    }
    try {
      const secret = bs58.decode(pk.trim());
      if (secret.length !== 64) throw new Error(`Beklenmeyen anahtar uzunluğu: ${secret.length} (64 olmalı)`);
      this.keypair = Keypair.fromSecretKey(secret);
      this.connection = new Connection(RPC_URL, "confirmed");
      console.log(`💼 Trader cüzdanı yüklendi: ${this.keypair.publicKey.toBase58()}`);
    } catch (err) {
      console.error("❌ TRADER_PRIVATE_KEY çözümlenemedi:", (err as Error).message);
    }
  }

  isReady(): boolean { return !!(this.keypair && this.connection); }

  cancel(positionId: string): boolean {
    const pos = this.store.getById(positionId);
    if (!pos) return false;
    if (pos.status === "pending_buy") { this.inFlight.delete(`buy:${pos.mintAddress}`); return true; }
    if (pos.status === "pending_sell") { this.inFlight.delete(`sell:${pos.id}`); return true; }
    return false;
  }

  getPublicKey(): string | undefined { return this.keypair?.publicKey.toBase58(); }

  /** Kaynakları temizle (interval'ları durdur) */
  destroy() {
    this.stopPriceMonitor();
    console.log("🛑 [JupiterTrader] Kaynaklar temizlendi");
  }

  // ─────────────────────────────────────────────
  //  BLOCKHASH CACHE (5s TTL)
  // ─────────────────────────────────────────────

  private async getLatestBlockhash() {
    const now = Date.now();
    if (this.blockhashCache && now - this.blockhashCache.timestamp < BLOCKHASH_CACHE_TTL_MS) {
      return this.blockhashCache;
    }
    if (!this.connection) throw new Error("RPC bağlantısı yok");
    const bh = await this.connection.getLatestBlockhash("confirmed");
    this.blockhashCache = { ...bh, timestamp: now };
    return this.blockhashCache;
  }

  // ─────────────────────────────────────────────
  //  TOKEN BALANCE CACHE (2s TTL)
  // ─────────────────────────────────────────────

  private async getTokenBalance(
    mint: string,
    opts: { bypassCache?: boolean } = {}
  ): Promise<{ uiAmount: number; raw: string; decimals: number } | null> {
    if (!this.keypair || !this.connection) return null;

    const now = Date.now();
    const cached = this.balanceCache.get(mint);
    if (!opts.bypassCache && cached && now - cached.timestamp < BALANCE_CACHE_TTL_MS) {
      return cached.value;
    }

    try {
      const res = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: new PublicKey(mint) }
      );
      let totalRaw = 0n;
      let decimals = 6;
      for (const acc of res.value) {
        const info = (acc.account.data as any).parsed?.info?.tokenAmount;
        if (!info) continue;
        decimals = info.decimals ?? decimals;
        totalRaw += BigInt(info.amount);
      }
      const uiAmount = Number(totalRaw) / Math.pow(10, decimals);
      const value = { uiAmount, raw: totalRaw.toString(), decimals };
      this.balanceCache.set(mint, { value, timestamp: now });
      return value;
    } catch (err) {
      console.error("❌ Token bakiye okunamadı:", (err as Error).message);
      this.balanceCache.set(mint, { value: null, timestamp: now });
      return null;
    }
  }

  private async fetchDecimals(mint: string): Promise<number> {
    if (mint === SOL_MINT) return SOL_DECIMALS;
    const cached = this.decimalsCache.get(mint);
    if (cached !== undefined) return cached;
    if (!this.connection) throw new Error("RPC bağlantısı yok");
    const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
    const dec = (info.value?.data as any)?.parsed?.info?.decimals ?? 6;
    this.decimalsCache.set(mint, dec);
    return dec;
  }

  private calculateDynamicSlippage(priceImpactPct: string): number {
    const impact = Math.abs(parseFloat(priceImpactPct));
    if (impact <= 1) return 200;
    if (impact <= 5) return 500;
    if (impact <= 10) return 1000;
    return 1500;
  }

  // ─────────────────────────────────────────────
  //  QUOTE (parametrize retry options)
  // ─────────────────────────────────────────────

  private async getQuote(
    params: { inputMint: string; outputMint: string; amount: string; slippageBps: number },
    retryOpts: RetryOptions = { retries: 3, delayMs: 500 }
  ): Promise<QuoteResponse> {
    const url = new URL(JUP_QUOTE);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    const clampedSlippage = Math.min(params.slippageBps, 9900);
    url.searchParams.set("slippageBps", String(clampedSlippage));
    url.searchParams.set("onlyDirectRoutes", "false");
    url.searchParams.set("asLegacyTransaction", "false");
    url.searchParams.set("restrictIntermediateTokens", "true");

    let lastErr: Error = new Error("Quote alınamadı");
    for (let attempt = 1; attempt <= retryOpts.retries; attempt++) {
      try {
        const res = await fetch(url.toString());
        const bodyText = await res.text();
        if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${bodyText.slice(0, 200)}`);
        const json = JSON.parse(bodyText) as QuoteResponse;
        if (!json?.outAmount || BigInt(json.outAmount) === 0n) throw new Error("Jupiter quote: route bulunamadı");

        const dynamicSlippage = this.calculateDynamicSlippage(json.priceImpactPct);
        if (dynamicSlippage > params.slippageBps) {
          console.log(`📊 [Dynamic Slippage] Impact: ${json.priceImpactPct}% → Slippage: ${(dynamicSlippage / 100).toFixed(1)}%`);
          url.searchParams.set("slippageBps", String(Math.min(dynamicSlippage, 9900)));
          const retryRes = await fetch(url.toString());
          if (retryRes.ok) {
            const retryJson = JSON.parse(await retryRes.text()) as QuoteResponse;
            if (retryJson?.outAmount && BigInt(retryJson.outAmount) !== 0n) {
              return retryJson;
            }
          }
        }

        return json;
      } catch (err) {
        lastErr = err as Error;
        if (attempt < retryOpts.retries) {
          const delay = retryOpts.delayMs * attempt;
          console.warn(`⏳ [Quote] Deneme ${attempt}/${retryOpts.retries} başarısız — ${delay}ms bekleniyor...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  // ─────────────────────────────────────────────
  //  SWAP (30s TX confirmation timeout)
  // ─────────────────────────────────────────────

  private async swap(quote: QuoteResponse, priorityFeeMicroLamports: number): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");

    const latestBlockhash = await this.getLatestBlockhash();

    // 2x priority fee multiplier for better landing rate
    const effectiveFee = Math.max(priorityFeeMicroLamports * PRIORITY_FEE_MULTIPLIER * 50, 50000);

    const swapBody = {
      quoteResponse: quote,
      userPublicKey: this.keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: effectiveFee, priorityLevel: "veryHigh" },
      },
    };
    const swapRes = await fetch(JUP_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(swapBody),
    });
    if (!swapRes.ok) throw new Error(`Jupiter swap ${swapRes.status}: ${(await swapRes.text()).slice(0, 200)}`);
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
    if (!swapTransaction) throw new Error("swapTransaction alınamadı");

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([this.keypair]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });

    const confirmationPromise = this.connection.confirmTransaction(
      { signature, ...latestBlockhash },
      "confirmed"
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TX confirmation timeout (${TX_CONFIRM_TIMEOUT_MS / 1000}s)`)), TX_CONFIRM_TIMEOUT_MS)
    );

    const result = await Promise.race([confirmationPromise, timeoutPromise]);
    if (result.value?.err) {
      throw new Error(`TX hata: ${JSON.stringify(result.value.err)}`);
    }
    console.log(`✅ TX confirmed: ${signature.slice(0, 16)}...`);

    return signature;
  }

  private async pumpSwapTx(opts: {
    action: "buy" | "sell";
    mint: string;
    amount: number;
    denominatedInSol: boolean;
    slippagePct: number;
    priorityFeeSol: number;
  }): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");

    const latestBlockhash = await this.getLatestBlockhash();

    const safeAmount = opts.denominatedInSol
      ? opts.amount
      : parseFloat(opts.amount.toFixed(6));

    const body = {
      publicKey: this.keypair.publicKey.toBase58(),
      action: opts.action,
      mint: opts.mint,
      denominatedInSol: opts.denominatedInSol ? "true" : "false",
      amount: safeAmount,
      slippage: opts.slippagePct,
      priorityFee: opts.priorityFeeSol,
      pool: "pumpswap",
    };

    const res = await fetch(PUMP_TRADE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PumpPortal API ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const buf = await res.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(buf));
    tx.sign([this.keypair]);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });

    const confirmationPromise = this.connection.confirmTransaction(
      { signature, ...latestBlockhash },
      "confirmed"
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`PumpSwap TX confirmation timeout (${TX_CONFIRM_TIMEOUT_MS / 1000}s)`)), TX_CONFIRM_TIMEOUT_MS)
    );

    const result = await Promise.race([confirmationPromise, timeoutPromise]);
    if (result.value?.err) {
      throw new Error(`PumpSwap TX hata: ${JSON.stringify(result.value.err)}`);
    }
    console.log(`✅ PumpSwap TX confirmed: ${signature.slice(0, 16)}...`);

    return signature;
  }

  private updateAndEmit(position: Position) {
    this.store.upsert(position);
    this.emit("position_update", position);
  }

  // ─────────────────────────────────────────────
  //  PRICE MONITOR (real-time P&L, 500ms interval)
  // ─────────────────────────────────────────────

  private startPriceMonitor() {
    if (this.priceMonitorInterval) return;
    this.priceMonitorInterval = setInterval(() => {
      this.updateOpenPositionsPrices().catch((err) => {
        // Sessizce devam et — fiyat güncellemesi kritik değil
      });
    }, PRICE_MONITOR_INTERVAL_MS);
    console.log(`📡 [PriceMonitor] Başlatıldı (${PRICE_MONITOR_INTERVAL_MS}ms aralık)`);
  }

  private stopPriceMonitor() {
    if (this.priceMonitorInterval) {
      clearInterval(this.priceMonitorInterval);
      this.priceMonitorInterval = null;
      console.log("⏹️ [PriceMonitor] Durduruldu");
    }
  }

  /** Açık pozisyonların fiyatlarını toplu olarak günceller (batch fetch) */
  async updateOpenPositionsPrices(): Promise<void> {
    const openPositions = this.store.getAll().filter((p) => p.status === "open");
    if (openPositions.length === 0) return;

    // Batch price fetch — tek API çağrısıyla tüm mintleri sorgula
    const mints = openPositions.map((p) => p.mintAddress).join(",");
    let priceData: Record<string, { usdPrice?: number; price?: number }> | null = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${JUP_PRICE}?ids=${mints}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return;
      priceData = await res.json();
    } catch {
      return;
    }

    if (!priceData || Object.keys(priceData).length === 0) return;

    for (const pos of openPositions) {
      const entry = priceData[pos.mintAddress];
      const currentPriceUsd = entry?.usdPrice ?? entry?.price ?? 0;
      if (!currentPriceUsd || currentPriceUsd <= 0) continue;

      const updated: Position = { ...pos, currentPriceUsd };
      this.store.upsert(updated);
      this.emit("position_update", updated);
    }
  }

  // ─────────────────────────────────────────────
  //  JUPITER ALIM
  // ─────────────────────────────────────────────

  async buy(input: { 
    mintAddress: string; 
    name: string; 
    symbol: string; 
    solAmount?: number;
    isAuto?: boolean; // TRUE = otomatik (650ms bekle), FALSE = manuel
  }): Promise<Position | null> {
    const { mintAddress, name, symbol, solAmount, isAuto = false } = input;

    if (!this.isReady()) { 
      console.error("❌ Cüzdan hazır değil — alım atlandı"); 
      return null; 
    }
    if (this.inFlight.has(`buy:${mintAddress}`)) { 
      console.warn(`⏳ ${symbol} alım zaten devam ediyor`); 
      return null; 
    }
    const existing = this.store.getByMint(mintAddress);
    if (existing && ["open", "pending_buy", "pending_sell"].includes(existing.status)) {
      console.warn(`⚠️ ${symbol} zaten portföyde (${existing.status})`);
      return existing;
    }

    this.inFlight.add(`buy:${mintAddress}`);
    const config = this.store.getConfig();
    const actualSolAmount = solAmount ?? config.solAmount;
    const id = `pos-${mintAddress}-${Date.now()}`;

    let position: Position = {
      id, 
      mintAddress, 
      name, 
      symbol, 
      dex: "jupiter",
      status: "pending_buy", 
      buyTimestamp: Date.now(), 
      buySolAmount: actualSolAmount,
    };
    this.updateAndEmit(position);
    console.log(`🛒 [Jupiter] ALIM: ${symbol} — ${actualSolAmount} SOL (${isAuto ? "AUTO" : "MANUAL"})`);

    try {
      // ✅ OTOMATİK: 650ms bekle
      if (isAuto) {
        console.log(`⏳ [Otomatik] 650ms bekleniyor...`);
        await new Promise((r) => setTimeout(r, 650));
      }

      // ✅ 3 DENEME — artan gecikmeler (500ms, 1s, 2s)
      const MAX_RETRIES = 3;
      const RETRY_DELAYS = [500, 1000, 2000];
      let lastError = "";
      let buyTxSignature: string | null = null;
      let buyPriceSol = 0;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`📤 [Deneme ${attempt}/${MAX_RETRIES}] TX gönderiliyor...`);

        try {
          const lamports = Math.floor(actualSolAmount * 1e9);

          // ✅ HER DENEMEDE GÜNCEL QUOTE AL
          const quote = await this.getQuote({
            inputMint: SOL_MINT,
            outputMint: mintAddress,
            amount: String(lamports),
            slippageBps: config.slippageBps,
          });

          const decimals = await this.fetchDecimals(mintAddress);
          const tokensOut = Number(quote.outAmount) / Math.pow(10, decimals);
          const pricePerToken = tokensOut > 0 ? actualSolAmount / tokensOut : 0;

          console.log(`📊 [Deneme ${attempt}] Quote: ${tokensOut.toLocaleString()} token @ ${pricePerToken.toFixed(6)}`);

          // ✅ HER DENEMEDE YENİ TX GÖNDER
          const sig = await this.swap(quote, config.priorityFeeMicroLamports);
          buyTxSignature = sig;
          buyPriceSol = pricePerToken;

          console.log(`✅ [Deneme ${attempt}/${MAX_RETRIES}] TX başarılı: ${sig.slice(0, 16)}...`);
          break; // ✅ BAŞARILI - RETRY YAPMA

        } catch (err) {
          lastError = (err as Error).message;
          console.error(`❌ [Deneme ${attempt}/${MAX_RETRIES}] Hata: ${lastError}`);

          if (attempt < MAX_RETRIES) {
            const delay = RETRY_DELAYS[attempt - 1];
            console.log(`⏳ ${delay}ms bekleniyor — sonraki denemeye geçiliyor...`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      // ✅ 3 DENEME FAIL → HATA KAPAT
      if (!buyTxSignature) {
        console.error(`🚨 [Jupiter] 3 deneme fail — Alım başarısız`);
        position = { 
          ...position, 
          status: "failed", 
          error: `3 deneme başarısız: ${lastError}` 
        };
        this.updateAndEmit(position);
        return position;
      }

      // ✅ ALIM BAŞARILI: 1 SANIYE BEKLE (bakiye sync için)
      console.log(`⏳ Token bakiye kontrol için 1 saniye bekleniyor...`);
      await new Promise((r) => setTimeout(r, 1000));

      // ✅ TOKEN BAKIYE KONTROL (2 deneme, 500ms ara) — cache bypass
      const BALANCE_CHECKS = 2;
      const BALANCE_DELAY = 500;
      let confirmedTokenAmount: number | null = null;

      for (let check = 1; check <= BALANCE_CHECKS; check++) {
        console.log(`📊 [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token kontrol ediliyor...`);

        try {
          const bal = await this.getTokenBalance(mintAddress, { bypassCache: true });
          if (bal && bal.uiAmount > 0) {
            confirmedTokenAmount = bal.uiAmount;
            console.log(`✅ [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token bulundu: ${bal.uiAmount.toLocaleString()} ${symbol}`);
            break;
          }
          console.warn(`⚠️ [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token henüz yok`);

          if (check < BALANCE_CHECKS) {
            await new Promise((r) => setTimeout(r, BALANCE_DELAY));
          }
        } catch (err) {
          console.error(`❌ [Bakiye Kontrol ${check}] Hata:`, (err as Error).message);
        }
      }

      // ✅ TOKEN BULUNAMADI → BAŞARISIZ
      if (confirmedTokenAmount === null) {
        console.warn(`⚠️ [Jupiter] Alım yapılmadı — Token 1 saniye + 2 kontrol (500ms ara) sonrası bulunamadı`);
        position = {
          ...position,
          status: "failed",
          buyTxSignature,
          buyPriceSol,
          error: `Alım yapılmadı — Token bakiyesi bulunamadı (TX: ${buyTxSignature.slice(0, 16)}...)`,
        };
        this.updateAndEmit(position);
        return position;
      }

      // ✅ BAŞARILI
      position = {
        ...position,
        status: "open",
        buyTokenAmount: confirmedTokenAmount,
        buyPriceSol,
        buyTxSignature,
      };
      this.updateAndEmit(position);
      console.log(`✅ [Jupiter] ALIM BAŞARILI: ${symbol} | ${confirmedTokenAmount.toLocaleString()} token | tx ${buyTxSignature.slice(0, 16)}...`);
      return position;

    } catch (err) {
      const message = (err as Error).message || String(err);
      position = { ...position, status: "failed", error: message };
      this.updateAndEmit(position);
      console.error(`❌ [Jupiter] Alım kritik hatası ${symbol}:`, message);
      return position;
    } finally {
      this.inFlight.delete(`buy:${mintAddress}`);
    }
  }

  // ─────────────────────────────────────────────
  //  PUMPSWAP ALIM
  // ─────────────────────────────────────────────

  async buyPumpSwap(input: { 
    mintAddress: string; 
    name: string; 
    symbol: string; 
    solAmount?: number;
    isAuto?: boolean;
  }): Promise<Position | null> {
    const { mintAddress, name, symbol, solAmount, isAuto = false } = input;

    if (!this.isReady()) { 
      console.error("❌ Cüzdan hazır değil — PumpSwap alım atlandı"); 
      return null; 
    }
    if (this.inFlight.has(`buy:${mintAddress}`)) { 
      console.warn(`⏳ ${symbol} alım zaten devam ediyor`); 
      return null; 
    }
    const existing = this.store.getByMint(mintAddress);
    if (existing && ["open", "pending_buy", "pending_sell"].includes(existing.status)) {
      console.warn(`⚠️ ${symbol} zaten portföyde (${existing.status})`);
      return existing;
    }

    this.inFlight.add(`buy:${mintAddress}`);
    const config = this.store.getConfig();
    const actualSolAmount = solAmount ?? config.solAmount;
    const id = `pos-${mintAddress}-${Date.now()}`;

    let position: Position = {
      id,
      mintAddress,
      name,
      symbol,
      dex: "pumpswap",
      status: "pending_buy",
      buyTimestamp: Date.now(),
      buySolAmount: actualSolAmount,
    };
    this.updateAndEmit(position);
    console.log(`🛒 [PumpSwap] ALIM: ${symbol} — ${actualSolAmount} SOL (${isAuto ? "AUTO" : "MANUAL"})`);

    const slippagePct = Math.floor(config.slippageBps / 100);
    const priorityFeeSol = Math.max(config.priorityFeeMicroLamports * PRIORITY_FEE_MULTIPLIER * 50, 50000) / 1_000_000_000;

    try {
      // ✅ OTOMATİK: 650ms bekle
      if (isAuto) {
        console.log(`⏳ [Otomatik] 650ms bekleniyor...`);
        await new Promise((r) => setTimeout(r, 650));
      }

      // ✅ 3 DENEME — artan gecikmeler (500ms, 1s, 2s)
      const MAX_RETRIES = 3;
      const RETRY_DELAYS = [500, 1000, 2000];
      let lastError = "";
      let buyTxSignature: string | null = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`📤 [Deneme ${attempt}/${MAX_RETRIES}] PumpSwap TX gönderiliyor...`);

        try {
          // ✅ HER DENEMEDE YENİ TX GÖNDER
          const sig = await this.pumpSwapTx({
            action: "buy",
            mint: mintAddress,
            amount: actualSolAmount,
            denominatedInSol: true,
            slippagePct,
            priorityFeeSol,
          });
          buyTxSignature = sig;

          console.log(`✅ [Deneme ${attempt}/${MAX_RETRIES}] TX başarılı: ${sig.slice(0, 16)}...`);
          break; // ✅ BAŞARILI - RETRY YAPMA

        } catch (err) {
          lastError = (err as Error).message;
          console.error(`❌ [Deneme ${attempt}/${MAX_RETRIES}] Hata: ${lastError}`);

          if (attempt < MAX_RETRIES) {
            const delay = RETRY_DELAYS[attempt - 1];
            console.log(`⏳ ${delay}ms bekleniyor — sonraki denemeye geçiliyor...`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      // ✅ 3 DENEME FAIL
      if (!buyTxSignature) {
        console.error(`🚨 [PumpSwap] 3 deneme fail — Alım başarısız`);
        position = {
          ...position,
          status: "failed",
          error: `3 deneme başarısız: ${lastError}`,
        };
        this.updateAndEmit(position);
        return position;
      }

      // ✅ ALIM BAŞARILI: 1 SANIYE BEKLE
      console.log(`⏳ Token bakiye kontrol için 1 saniye bekleniyor...`);
      await new Promise((r) => setTimeout(r, 1000));

      // ✅ TOKEN BAKIYE KONTROL (2 deneme, 500ms ara) — cache bypass
      const BALANCE_CHECKS = 2;
      const BALANCE_DELAY = 500;
      let confirmedTokenAmount: number | null = null;

      for (let check = 1; check <= BALANCE_CHECKS; check++) {
        console.log(`📊 [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token kontrol ediliyor...`);

        try {
          const bal = await this.getTokenBalance(mintAddress, { bypassCache: true });
          if (bal && bal.uiAmount > 0) {
            confirmedTokenAmount = bal.uiAmount;
            console.log(`✅ [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token bulundu: ${bal.uiAmount.toLocaleString()} ${symbol}`);
            break;
          }
          console.warn(`⚠️ [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token henüz yok`);

          if (check < BALANCE_CHECKS) {
            await new Promise((r) => setTimeout(r, BALANCE_DELAY));
          }
        } catch (err) {
          console.error(`❌ [Bakiye Kontrol ${check}] Hata:`, (err as Error).message);
        }
      }

      // ✅ TOKEN BULUNAMADI
      if (confirmedTokenAmount === null) {
        console.warn(`⚠️ [PumpSwap] Alım yapılmadı — Token bulunamadı`);
        position = {
          ...position,
          status: "failed",
          buyTxSignature,
          error: `Alım yapılmadı — Token bakiyesi bulunamadı (TX: ${buyTxSignature.slice(0, 16)}...)`,
        };
        this.updateAndEmit(position);
        return position;
      }

      // ✅ BAŞARILI
      position = {
        ...position,
        status: "open",
        buyTokenAmount: confirmedTokenAmount,
        buyTxSignature,
      };
      this.updateAndEmit(position);
      console.log(`✅ [PumpSwap] ALIM BAŞARILI: ${symbol} | ${confirmedTokenAmount.toLocaleString()} token | tx ${buyTxSignature.slice(0, 16)}...`);
      return position;

    } catch (err) {
      const message = (err as Error).message || String(err);
      position = { ...position, status: "failed", error: message };
      this.updateAndEmit(position);
      console.error(`❌ [PumpSwap] Alım kritik hatası ${symbol}:`, message);
      return position;
    } finally {
      this.inFlight.delete(`buy:${mintAddress}`);
    }
  }

  // ─────────────────────────────────────────────
  //  SATIŞ
  // ─────────────────────────────────────────────

  async sell(positionId: string): Promise<Position | null> {
    const pos = this.store.getById(positionId);
    if (!pos) { 
      console.warn(`⚠️ Pozisyon bulunamadı: ${positionId}`); 
      return null; 
    }
    if (!["open", "failed", "pending_sell"].includes(pos.status)) {
      console.warn(`⚠️ Satışa uygun değil (${pos.status}): ${pos.symbol}`);
      return pos;
    }
    if (!this.isReady()) { 
      console.error("❌ Cüzdan hazır değil — satış atlandı"); 
      return null; 
    }
    if (this.inFlight.has(`sell:${pos.id}`)) return pos;

    this.inFlight.add(`sell:${pos.id}`);
    const config = this.store.getConfig();

    let updated: Position = { ...pos, status: "pending_sell", error: undefined };
    this.updateAndEmit(updated);
    const dexLabel = pos.dex === "pumpswap" ? "PumpSwap" : "Jupiter";
    console.log(`💸 [${dexLabel}] SATIŞ BAŞLADI: ${pos.symbol}`);

    const slippagePct = Math.floor(config.slippageBps / 100);
    const priorityFeeSol = Math.max(config.priorityFeeMicroLamports * PRIORITY_FEE_MULTIPLIER * 50, 50000) / 1_000_000_000;

    try {
      // ✅ 3 DENEME — artan gecikmeler (500ms, 1s, 2s)
      const MAX_RETRIES = 3;
      const RETRY_DELAYS = [500, 1000, 2000];
      let lastError = "";
      let sellTxSignature: string | null = null;
      let solOut = 0;
      let pricePerTokenSol = 0;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`📤 [Deneme ${attempt}/${MAX_RETRIES}] Satış TX gönderiliyor...`);

        try {
          // ✅ HER DENEMEDE GÜNCEL BAKIYE AL (cache bypass)
          const balance = await this.getTokenBalance(pos.mintAddress, { bypassCache: true });
          if (!balance || balance.uiAmount <= 0) {
            throw new Error(`Token bakiyesi yok: ${balance?.uiAmount ?? 0}`);
          }

          console.log(`📊 [Deneme ${attempt}] Satılacak: ${balance.uiAmount.toLocaleString()} ${pos.symbol}`);

          // ✅ HER DENEMEDE GÜNCEL QUOTE AL
          if (pos.dex === "pumpswap") {
            const sig = await this.pumpSwapTx({
              action: "sell",
              mint: pos.mintAddress,
              amount: balance.uiAmount,
              denominatedInSol: false,
              slippagePct,
              priorityFeeSol,
            });
            sellTxSignature = sig;
          } else {
            const quote = await this.getQuote({
              inputMint: pos.mintAddress,
              outputMint: SOL_MINT,
              amount: balance.raw,
              slippageBps: config.slippageBps,
            });
            solOut = Number(quote.outAmount) / 1e9;
            pricePerTokenSol = balance.uiAmount > 0 ? solOut / balance.uiAmount : 0;

            const sig = await this.swap(quote, config.priorityFeeMicroLamports);
            sellTxSignature = sig;
          }

          console.log(`✅ [Deneme ${attempt}/${MAX_RETRIES}] TX başarılı: ${sellTxSignature.slice(0, 16)}...`);
          break; // ✅ BAŞARILI - RETRY YAPMA

        } catch (err) {
          lastError = (err as Error).message;
          console.error(`❌ [Deneme ${attempt}/${MAX_RETRIES}] Hata: ${lastError}`);

          if (attempt < MAX_RETRIES) {
            const delay = RETRY_DELAYS[attempt - 1];
            console.log(`⏳ ${delay}ms bekleniyor — sonraki denemeye geçiliyor...`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      // ✅ 3 DENEME FAIL
      if (!sellTxSignature) {
        console.error(`🚨 [${dexLabel}] 3 deneme fail — Satış başarısız`);
        updated = {
          ...updated,
          status: "open",
          error: `3 deneme başarısız: ${lastError}`,
        };
        this.updateAndEmit(updated);
        return updated;
      }

      // ✅ SATIŞ SONRASI: 500ms BEKLE (fake satış check)
      console.log(`⏳ Token bakiye kontrol için 500ms bekleniyor...`);
      await new Promise((r) => setTimeout(r, 500));

      // ✅ TOKEN BAKIYE KONTROL (2 deneme, 500ms ara) — FAKE SATIŞ CHECK (cache bypass)
      const BALANCE_CHECKS = 2;
      const BALANCE_DELAY = 500;
      let tokenGone = false;

      for (let check = 1; check <= BALANCE_CHECKS; check++) {
        console.log(`📊 [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token=0 kontrol...`);

        try {
          const bal = await this.getTokenBalance(pos.mintAddress, { bypassCache: true });
          if (!bal || bal.uiAmount === 0) {
            tokenGone = true;
            console.log(`✅ [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token sıfırlandı — Satış başarılı`);
            break;
          }
          console.warn(`⚠️ [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token hala var: ${bal.uiAmount.toLocaleString()}`);

          if (check < BALANCE_CHECKS) {
            await new Promise((r) => setTimeout(r, BALANCE_DELAY));
          }
        } catch (err) {
          console.error(`❌ [Bakiye Kontrol ${check}] Hata:`, (err as Error).message);
        }
      }

      // ✅ TOKEN HALA VAR → BAŞARISIZ
      if (!tokenGone) {
        console.warn(`⚠️ [${dexLabel}] Satış yapılmadı — Token hala mevcut (2 kontrol sonrası)`);
        updated = {
          ...updated,
          status: "pending_sell",
          sellTxSignature,
          error: `Satış yapılmadı — Token hala mevcut (TX: ${sellTxSignature.slice(0, 16)}...)`,
        };
        this.updateAndEmit(updated);
        return updated;
      }

      // ✅ BAŞARILI → KAPATMA
      let pnlSol = 0;
      let pnlPct = 0;

      if (pos.dex !== "pumpswap") {
        pnlSol = solOut - (pos.buySolAmount ?? 0);
        pnlPct = (pos.buySolAmount ?? 0) > 0 ? (pnlSol / pos.buySolAmount!) * 100 : 0;
        updated = {
          ...updated,
          sellSolAmount: solOut,
          sellPriceSol: pricePerTokenSol,
          pnlSol,
          pnlPct,
        };
      }

      updated = {
        ...updated,
        status: "closed",
        sellTimestamp: Date.now(),
        sellTxSignature,
      };
      this.updateAndEmit(updated);

      if (pos.dex === "pumpswap") {
        console.log(`✅ [${dexLabel}] SATIŞ BAŞARILI: ${pos.symbol} | tx ${sellTxSignature.slice(0, 16)}...`);
      } else {
        console.log(`✅ [${dexLabel}] SATIŞ BAŞARILI: ${pos.symbol} | ${solOut.toFixed(4)} SOL | PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} (${pnlPct.toFixed(1)}%)`);
      }

      return updated;

    } catch (err) {
      const message = (err as Error).message || String(err);
      updated = { ...updated, status: "pending_sell", error: message };
      this.updateAndEmit(updated);
      console.error(`❌ [${dexLabel}] Satış kritik hatası ${pos.symbol}:`, message);
      return updated;
    } finally {
      this.inFlight.delete(`sell:${pos.id}`);
    }
  }

  updateConfig(partial: Partial<TradeConfig>): TradeConfig {
    const cfg = this.store.updateConfig(partial);
    this.emit("trade_config_update", cfg);
    return cfg;
  }
}
