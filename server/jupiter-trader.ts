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

export class JupiterTrader {
  private store: TradeStore;
  private emit: Emitter;
  private keypair: Keypair | null = null;
  private connection: Connection | null = null;
  private decimalsCache: Map<string, number> = new Map();
  private inFlight: Set<string> = new Set();
  private blockhashCache: { hash: string; timestamp: number } | null = null;
  private lastBlockhashTime = 0;

  constructor(store: TradeStore, emit: Emitter) {
    this.store = store;
    this.emit = emit;
    this.initWallet();
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

  private async withRetry<T>(fn: () => Promise<T>, label: string, retries = 2, delayMs = 300): Promise<T> {
    let lastErr: Error = new Error("Bilinmeyen hata");
    for (let i = 0; i <= retries; i++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err as Error;
        if (i < retries) {
          console.warn(`⏳ [${label}] Deneme ${i + 1}/${retries + 1} başarısız — ${delayMs}ms bekleniyor...`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastErr;
  }

  private async getLatestBlockhash() {
    const now = Date.now();
    if (this.blockhashCache && now - this.lastBlockhashTime < 5000) {
      return this.blockhashCache;
    }
    if (!this.connection) throw new Error("RPC bağlantısı yok");
    const bh = await this.connection.getLatestBlockhash("confirmed");
    this.blockhashCache = bh;
    this.lastBlockhashTime = now;
    return bh;
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

  private async getTokenBalance(mint: string): Promise<{ uiAmount: number; raw: string; decimals: number } | null> {
    if (!this.keypair || !this.connection) return null;
    try {
      const res = await this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new PublicKey(mint) });
      let totalRaw = 0n;
      let decimals = 6;
      for (const acc of res.value) {
        const info = (acc.account.data as any).parsed?.info?.tokenAmount;
        if (!info) continue;
        decimals = info.decimals ?? decimals;
        totalRaw += BigInt(info.amount);
      }
      const uiAmount = Number(totalRaw) / Math.pow(10, decimals);
      return { uiAmount, raw: totalRaw.toString(), decimals };
    } catch (err) {
      console.error("❌ Token bakiye okunamadı:", (err as Error).message);
      return null;
    }
  }

  private calculateDynamicSlippage(priceImpactPct: string): number {
    const impact = Math.abs(parseFloat(priceImpactPct));
    if (impact <= 1) return 200;
    if (impact <= 5) return 500;
    if (impact <= 10) return 1000;
    return 1500;
  }

  private async getQuote(params: {
    inputMint: string; outputMint: string; amount: string; slippageBps: number;
  }): Promise<QuoteResponse> {
    const url = new URL(JUP_QUOTE);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    const clampedSlippage = Math.min(params.slippageBps, 9900);
    url.searchParams.set("slippageBps", String(clampedSlippage));
    url.searchParams.set("onlyDirectRoutes", "false");
    url.searchParams.set("asLegacyTransaction", "false");
    url.searchParams.set("restrictIntermediateTokens", "true");

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
  }

  private async swap(quote: QuoteResponse, priorityFeeMicroLamports: number): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");

    const latestBlockhash = await this.getLatestBlockhash();

    const swapBody = {
      quoteResponse: quote,
      userPublicKey: this.keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: Math.max(priorityFeeMicroLamports, 1), priorityLevel: "veryHigh" },
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

    const timeoutPromise = new Promise<any>((_, reject) =>
      setTimeout(() => reject(new Error("TX confirmation timeout (120s)")), 120000)
    );

    try {
      const result = await Promise.race([confirmationPromise, timeoutPromise]);
      if (result.value?.err) {
        throw new Error(`TX hata: ${JSON.stringify(result.value.err)}`);
      }
      console.log(`✅ TX confirmed: ${signature.slice(0, 16)}...`);
    } catch (err) {
      console.error(`❌ TX confirmation hatası: ${(err as Error).message}`);
      throw err;
    }

    return signature;
  }

  // TX'i gönder, imzayı hemen döndür — confirmation bekleme (buy için)
  private async swapSend(quote: QuoteResponse, priorityFeeMicroLamports: number): Promise<{ signature: string; blockhash: { blockhash: string; lastValidBlockHeight: number } }> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");

    const latestBlockhash = await this.getLatestBlockhash();

    const swapBody = {
      quoteResponse: quote,
      userPublicKey: this.keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: Math.max(priorityFeeMicroLamports, 1), priorityLevel: "veryHigh" },
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

    console.log(`📡 TX gönderildi (confirmation beklenmedi): ${signature.slice(0, 16)}...`);
    return { signature, blockhash: latestBlockhash };
  }

  // Arka planda: TX'i onayla → bakiye kontrol → position güncelle
  private async confirmAndCheckBalance(opts: {
    signature: string;
    blockhash: { blockhash: string; lastValidBlockHeight: number };
    mintAddress: string;
    symbol: string;
    position: Position;
    buyPriceSol: number;
  }): Promise<void> {
    const { signature, blockhash, mintAddress, symbol, position, buyPriceSol } = opts;

    try {
      // TX confirmation (120s timeout)
      const confirmationPromise = this.connection!.confirmTransaction(
        { signature, ...blockhash },
        "confirmed"
      );
      const timeoutPromise = new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error("TX confirmation timeout (120s)")), 120000)
      );

      const result = await Promise.race([confirmationPromise, timeoutPromise]);
      if (result.value?.err) {
        throw new Error(`TX hata: ${JSON.stringify(result.value.err)}`);
      }
      console.log(`✅ [Arka Plan] TX confirmed: ${signature.slice(0, 16)}...`);

      // 1s bekle (bakiye sync)
      console.log(`⏳ [Arka Plan] Token bakiye kontrol için 1 saniye bekleniyor...`);
      await new Promise((r) => setTimeout(r, 1000));

      // Bakiye kontrol (2 deneme, 500ms ara)
      const BALANCE_CHECKS = 2;
      const BALANCE_DELAY = 500;
      let confirmedTokenAmount: number | null = null;

      for (let check = 1; check <= BALANCE_CHECKS; check++) {
        console.log(`📊 [Arka Plan Bakiye ${check}/${BALANCE_CHECKS}] Token kontrol ediliyor...`);
        try {
          const bal = await this.getTokenBalance(mintAddress);
          if (bal && bal.uiAmount > 0) {
            confirmedTokenAmount = bal.uiAmount;
            console.log(`✅ [Arka Plan Bakiye ${check}/${BALANCE_CHECKS}] Token bulundu: ${bal.uiAmount.toLocaleString()} ${symbol}`);
            break;
          }
          console.warn(`⚠️ [Arka Plan Bakiye ${check}/${BALANCE_CHECKS}] Token henüz yok`);
          if (check < BALANCE_CHECKS) {
            await new Promise((r) => setTimeout(r, BALANCE_DELAY));
          }
        } catch (err) {
          console.error(`❌ [Arka Plan Bakiye ${check}] Hata:`, (err as Error).message);
        }
      }

      if (confirmedTokenAmount === null) {
        console.warn(`⚠️ [Arka Plan] Token bakiyesi bulunamadı — position failed olarak işaretleniyor`);
        this.updateAndEmit({
          ...position,
          status: "failed",
          buyTxSignature: signature,
          buyPriceSol,
          error: `Alım yapılmadı — Token bakiyesi bulunamadı (TX: ${signature.slice(0, 16)}...)`,
        });
        return;
      }

      // Başarılı
      this.updateAndEmit({
        ...position,
        status: "open",
        buyTokenAmount: confirmedTokenAmount,
        buyPriceSol,
        buyTxSignature: signature,
      });
      console.log(`✅ [Arka Plan] ALIM BAŞARILI: ${symbol} | ${confirmedTokenAmount.toLocaleString()} token | tx ${signature.slice(0, 16)}...`);

    } catch (err) {
      const message = (err as Error).message || String(err);
      console.error(`❌ [Arka Plan] TX confirmation/bakiye hatası ${symbol}:`, message);
      this.updateAndEmit({
        ...position,
        status: "failed",
        buyTxSignature: signature,
        error: message,
      });
    }
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

    const timeoutPromise = new Promise<any>((_, reject) =>
      setTimeout(() => reject(new Error("PumpSwap TX confirmation timeout (120s)")), 120000)
    );

    try {
      const result = await Promise.race([confirmationPromise, timeoutPromise]);
      if (result.value?.err) {
        throw new Error(`PumpSwap TX hata: ${JSON.stringify(result.value.err)}`);
      }
      console.log(`✅ PumpSwap TX confirmed: ${signature.slice(0, 16)}...`);
    } catch (err) {
      console.error(`❌ PumpSwap TX confirmation hatası: ${(err as Error).message}`);
      throw err;
    }

    return signature;
  }

  private updateAndEmit(position: Position) {
    this.store.upsert(position);
    this.emit("position_update", position);
  }

  // ========== JUPITER ALIM ==========
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

      // ✅ 3 DENEME (750ms ara) — sadece TX gönderme, confirmation bekleme
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 750;
      let lastError = "";
      let sentSignature: string | null = null;
      let sentBlockhash: { blockhash: string; lastValidBlockHeight: number } | null = null;
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

          // ✅ TX'i hemen gönder, confirmation bekleme
          const { signature, blockhash } = await this.swapSend(quote, config.priorityFeeMicroLamports);
          sentSignature = signature;
          sentBlockhash = blockhash;
          buyPriceSol = pricePerToken;

          console.log(`🚀 [Deneme ${attempt}/${MAX_RETRIES}] TX gönderildi: ${signature.slice(0, 16)}...`);
          break; // ✅ TX gönderildi — retry yapma

        } catch (err) {
          lastError = (err as Error).message;
          console.error(`❌ [Deneme ${attempt}/${MAX_RETRIES}] Hata: ${lastError}`);

          if (attempt < MAX_RETRIES) {
            console.log(`⏳ 750ms bekleniyor — sonraki denemeye geçiliyor...`);
            await new Promise((r) => setTimeout(r, RETRY_DELAY));
          }
        }
      }

      // ✅ 3 DENEME FAIL → HATA KAPAT
      if (!sentSignature || !sentBlockhash) {
        console.error(`🚨 [Jupiter] 3 deneme fail — Alım başarısız`);
        position = { 
          ...position, 
          status: "failed", 
          error: `3 deneme başarısız: ${lastError}` 
        };
        this.updateAndEmit(position);
        return position;
      }

      // ✅ TX gönderildi — confirmation + bakiye kontrolü arka planda yap
      console.log(`⚡ [Jupiter] TX gönderildi, arka planda confirmation bekleniyor: ${sentSignature.slice(0, 16)}...`);

      // Position'ı buyTxSignature ile güncelle (hâlâ pending_buy)
      position = { ...position, buyTxSignature: sentSignature };
      this.updateAndEmit(position);

      // Arka planda: confirm + bakiye kontrol + position güncelle
      this.confirmAndCheckBalance({
        signature: sentSignature,
        blockhash: sentBlockhash,
        mintAddress,
        symbol,
        position,
        buyPriceSol,
      }).finally(() => {
        this.inFlight.delete(`buy:${mintAddress}`);
      });

      // TX imzasıyla hemen dön — caller beklemez
      return position;

    } catch (err) {
      const message = (err as Error).message || String(err);
      position = { ...position, status: "failed", error: message };
      this.updateAndEmit(position);
      console.error(`❌ [Jupiter] Alım kritik hatası ${symbol}:`, message);
      this.inFlight.delete(`buy:${mintAddress}`);
      return position;
    }
    // Not: inFlight.delete artık finally bloğunda değil — arka plan task tamamlandığında siliniyor
  }

  // ========== PUMPSWAP ALIM ==========
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
    const priorityFeeSol = config.priorityFeeMicroLamports / 1_000_000_000;

    try {
      // ✅ OTOMATİK: 650ms bekle
      if (isAuto) {
        console.log(`⏳ [Otomatik] 650ms bekleniyor...`);
        await new Promise((r) => setTimeout(r, 650));
      }

      // ✅ 3 DENEME (750ms ara)
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 750;
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
            console.log(`⏳ 750ms bekleniyor — sonraki denemeye geçiliyor...`);
            await new Promise((r) => setTimeout(r, RETRY_DELAY));
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

      // ✅ TOKEN BAKIYE KONTROL (2 deneme, 500ms ara)
      const BALANCE_CHECKS = 2;
      const BALANCE_DELAY = 500;
      let confirmedTokenAmount: number | null = null;

      for (let check = 1; check <= BALANCE_CHECKS; check++) {
        console.log(`📊 [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token kontrol ediliyor...`);

        try {
          const bal = await this.getTokenBalance(mintAddress);
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

  // ========== SATIŞ ==========
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
    const priorityFeeSol = config.priorityFeeMicroLamports / 1_000_000_000;

    try {
      // ✅ 3 DENEME (750ms ara)
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 750;
      let lastError = "";
      let sellTxSignature: string | null = null;
      let solOut = 0;
      let pricePerTokenSol = 0;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`📤 [Deneme ${attempt}/${MAX_RETRIES}] Satış TX gönderiliyor...`);

        try {
          // ✅ HER DENEMEDE GÜNCEL BAKIYE AL
          const balance = await this.getTokenBalance(pos.mintAddress);
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
            console.log(`⏳ 750ms bekleniyor — sonraki denemeye geçiliyor...`);
            await new Promise((r) => setTimeout(r, RETRY_DELAY));
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

      // ✅ TOKEN BAKIYE KONTROL (2 deneme, 500ms ara) — FAKE SATIŞ CHECK
      const BALANCE_CHECKS = 2;
      const BALANCE_DELAY = 500;
      let tokenGone = false;

      for (let check = 1; check <= BALANCE_CHECKS; check++) {
        console.log(`📊 [Bakiye Kontrol ${check}/${BALANCE_CHECKS}] Token=0 kontrol...`);

        try {
          const bal = await this.getTokenBalance(pos.mintAddress);
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
