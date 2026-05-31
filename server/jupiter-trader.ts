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

  // --- Retry yardımcısı: 1 deneme, 500ms aralık ---
  private async withRetry<T>(fn: () => Promise<T>, label: string, retries = 1, delayMs = 500): Promise<T> {
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

  private async getQuote(params: {
    inputMint: string; outputMint: string; amount: string; slippageBps: number;
  }): Promise<QuoteResponse> {
    const url = new URL(JUP_QUOTE);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    // Jupiter max %99 slippage kabul eder (10000 bps üzeri negatif threshold üretir → hata)
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
    return json;
  }

  private async swap(quote: QuoteResponse, priorityFeeMicroLamports: number): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");
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
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 1 });
    // "processed" commitment en hızlı onay (~400ms) — confirmed (~1.5s) beklemeye gerek yok
    const latest = await this.connection.getLatestBlockhash("processed");
    const conf = await this.connection.confirmTransaction({ signature, ...latest }, "processed");
    if (conf.value.err) throw new Error(`TX hata: ${JSON.stringify(conf.value.err)}`);
    return signature;
  }

  // PumpSwap (pumpportal.fun) TX oluştur ve gönder
  // denominatedInSol=true → amount SOL cinsindendir (alım için)
  // denominatedInSol=false → amount token cinsindendir (satım için)
  private async pumpSwapTx(opts: {
    action: "buy" | "sell";
    mint: string;
    amount: number;
    denominatedInSol: boolean;
    slippagePct: number;
    priorityFeeSol: number;
  }): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");

    const body = {
      publicKey: this.keypair.publicKey.toBase58(),
      action: opts.action,
      mint: opts.mint,
      denominatedInSol: opts.denominatedInSol ? "true" : "false",
      amount: opts.amount,
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

    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 1 });
    const latest = await this.connection.getLatestBlockhash("processed");
    const conf = await this.connection.confirmTransaction({ signature, ...latest }, "processed");
    if (conf.value.err) throw new Error(`PumpSwap TX hata: ${JSON.stringify(conf.value.err)}`);
    return signature;
  }

  private updateAndEmit(position: Position) {
    this.store.upsert(position);
    this.emit("position_update", position);
  }

  // ========== JUPITER ALIM ==========
  async buy(input: { mintAddress: string; name: string; symbol: string; solAmount?: number }): Promise<Position | null> {
    const { mintAddress, name, symbol, solAmount } = input;
    if (!this.isReady()) { console.error("❌ Cüzdan hazır değil — alım atlandı"); return null; }
    if (this.inFlight.has(`buy:${mintAddress}`)) { console.warn(`⏳ ${symbol} alım zaten devam ediyor`); return null; }
    const existing = this.store.getByMint(mintAddress);
    if (existing && ["open", "pending_buy", "pending_sell"].includes(existing.status)) {
      console.warn(`⚠️ ${symbol} zaten portföyde (${existing.status})`);
      return existing;
    }

    this.inFlight.add(`buy:${mintAddress}`);
    const config = this.store.getConfig();
    const actualSolAmount = solAmount ?? config.solAmount;
    const lamports = Math.floor(actualSolAmount * 1e9);
    const id = `pos-${mintAddress}-${Date.now()}`;
    let position: Position = {
      id, mintAddress, name, symbol, dex: "jupiter",
      status: "pending_buy", buyTimestamp: Date.now(), buySolAmount: actualSolAmount,
    };
    this.updateAndEmit(position);
    console.log(`🛒 [Jupiter] ALIM: ${symbol} — ${actualSolAmount} SOL`);

    try {
      const quote = await this.getQuote({ inputMint: SOL_MINT, outputMint: mintAddress, amount: String(lamports), slippageBps: config.slippageBps });
      const decimals = await this.fetchDecimals(mintAddress);
      const tokensOut = Number(quote.outAmount) / Math.pow(10, decimals);
      const pricePerToken = tokensOut > 0 ? actualSolAmount / tokensOut : 0;
      const sig = await this.swap(quote, config.priorityFeeMicroLamports);
      const result = { sig, tokensOut, pricePerToken };

      position = { ...position, status: "open", buyTokenAmount: result.tokensOut, buyPriceSol: result.pricePerToken, buyTxSignature: result.sig };
      this.updateAndEmit(position);
      console.log(`✅ [Jupiter] ALIM tamam: ${symbol} | ${result.tokensOut.toFixed(4)} token | tx ${result.sig.slice(0, 16)}...`);
      return position;
    } catch (err) {
      const message = (err as Error).message || String(err);
      position = { ...position, status: "failed", error: message };
      this.updateAndEmit(position);
      console.error(`❌ [Jupiter] ALIM hatası ${symbol}:`, message);
      return position;
    } finally {
      this.inFlight.delete(`buy:${mintAddress}`);
    }
  }

  // ========== PUMPSWAP ALIM ==========
  async buyPumpSwap(input: { mintAddress: string; name: string; symbol: string; solAmount?: number }): Promise<Position | null> {
    const { mintAddress, name, symbol, solAmount } = input;
    if (!this.isReady()) { console.error("❌ Cüzdan hazır değil — PumpSwap alım atlandı"); return null; }
    if (this.inFlight.has(`buy:${mintAddress}`)) { console.warn(`⏳ ${symbol} alım zaten devam ediyor`); return null; }
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
      id, mintAddress, name, symbol, dex: "pumpswap",
      status: "pending_buy", buyTimestamp: Date.now(), buySolAmount: actualSolAmount,
    };
    this.updateAndEmit(position);
    console.log(`🛒 [PumpSwap] ALIM: ${symbol} — ${actualSolAmount} SOL`);

    const slippagePct = Math.floor(config.slippageBps / 100);
    const priorityFeeSol = config.priorityFeeMicroLamports / 1_000_000_000;

    try {
      const sig = await this.pumpSwapTx({ action: "buy", mint: mintAddress, amount: actualSolAmount, denominatedInSol: true, slippagePct, priorityFeeSol });

      // Pozisyonu hemen "open" olarak işaretle — bakiye arka planda çekilir
      position = { ...position, status: "open", buyTxSignature: sig };
      this.updateAndEmit(position);
      console.log(`✅ [PumpSwap] ALIM tamam: ${symbol} | tx ${sig.slice(0, 16)}...`);

      // TX indexer'a yansısın diye arka planda bekle, pozisyonu güncelle (bloklamıyor)
      (async () => {
        for (const delay of [2000, 3000, 5000]) {
          await new Promise((r) => setTimeout(r, delay));
          try {
            const bal = await this.getTokenBalance(mintAddress);
            if (bal && bal.uiAmount > 0) {
              const updated = { ...this.store.getById(position.id)!, buyTokenAmount: bal.uiAmount };
              this.updateAndEmit(updated);
              console.log(`🪙 [PumpSwap] Token bakiyesi güncellendi: ${bal.uiAmount.toLocaleString()} ${symbol}`);
              return;
            }
          } catch { /* sessizce devam et */ }
        }
      })();

      return position;
    } catch (err) {
      const message = (err as Error).message || String(err);
      position = { ...position, status: "failed", error: message };
      this.updateAndEmit(position);
      console.error(`❌ [PumpSwap] ALIM hatası ${symbol}:`, message);
      return position;
    } finally {
      this.inFlight.delete(`buy:${mintAddress}`);
    }
  }

  // ========== SATIŞ (Jupiter veya PumpSwap) ==========
  async sell(positionId: string): Promise<Position | null> {
    const pos = this.store.getById(positionId);
    if (!pos) { console.warn(`⚠️ Pozisyon bulunamadı: ${positionId}`); return null; }
    if (!["open", "failed"].includes(pos.status)) { console.warn(`⚠️ Satışa uygun değil (${pos.status}): ${pos.symbol}`); return pos; }
    if (!this.isReady()) { console.error("❌ Cüzdan hazır değil — satış atlandı"); return null; }
    if (this.inFlight.has(`sell:${pos.id}`)) return pos;
    this.inFlight.add(`sell:${pos.id}`);

    const config = this.store.getConfig();
    // failed → pending_sell (retry)
    let updated: Position = { ...pos, status: "pending_sell", error: undefined };
    this.updateAndEmit(updated);
    const dexLabel = pos.dex === "pumpswap" ? "PumpSwap" : "Jupiter";
    console.log(`💸 [${dexLabel}] SATIŞ: ${pos.symbol}`);

    const slippagePct = Math.floor(config.slippageBps / 100);
    const priorityFeeSol = config.priorityFeeMicroLamports / 1_000_000_000;

    // Token bakiyesini 2 defa deneyin
    const fetchBalanceWithRetry = async (): Promise<{ uiAmount: number; raw: string; decimals: number }> => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const bal = await this.getTokenBalance(pos.mintAddress);
          if (bal && bal.uiAmount > 0) {
            console.log(`🔍 [Satış] Deneme ${attempt}: ${bal.uiAmount.toLocaleString()} ${pos.symbol} bulundu`);
            return bal;
          }
          console.warn(`⚠️ [Satış] Deneme ${attempt}: Token bakiyesi bulunamadı`);
          if (attempt < 2) {
            console.log(`⏳ [Satış] 2 saniye bekleniyor...`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (err) {
          console.error(`❌ [Satış] Deneme ${attempt} hatası:`, (err as Error).message);
          if (attempt < 2) {
            console.log(`⏳ [Satış] 2 saniye bekleniyor...`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
      // 2 deneme de başarısız → Rug pull
      throw new Error(`RUG_PULL: 2 deneme sonrası ${pos.symbol} bakiyesi bulunamadı`);
    };

    try {
      if (pos.dex === "pumpswap") {
        // PumpSwap satışı
        const result = await this.withRetry(async () => {
          const balance = await fetchBalanceWithRetry();
          console.log(`🔍 [PumpSwap] Satılacak: ${balance.uiAmount.toLocaleString()} ${pos.symbol}`);
          const sig = await this.pumpSwapTx({
            action: "sell",
            mint: pos.mintAddress,
            amount: balance.uiAmount,
            denominatedInSol: false,
            slippagePct,
            priorityFeeSol,
          });
          return { sig, tokenAmount: balance.uiAmount };
        }, `PumpSwap Sell ${pos.symbol}`, 1);

        updated = { ...updated, status: "closed", sellTimestamp: Date.now(), sellTxSignature: result.sig };
        this.updateAndEmit(updated);
        console.log(`✅ [PumpSwap] SATIŞ tamam: ${pos.symbol} | ${result.tokenAmount.toLocaleString()} token | tx ${result.sig.slice(0, 16)}...`);
      } else {
        // Jupiter satışı — route yoksa PumpSwap'a fallback
        let jupiterOk = false;
        try {
          const result = await this.withRetry(async () => {
            const balance = await fetchBalanceWithRetry();
            if (BigInt(balance.raw) === 0n) throw new Error("Cüzdanda token bakiyesi yok");
            const quote = await this.getQuote({ inputMint: pos.mintAddress, outputMint: SOL_MINT, amount: balance.raw, slippageBps: config.slippageBps });
            const solOut = Number(quote.outAmount) / 1e9;
            const sellPriceSol = balance.uiAmount > 0 ? solOut / balance.uiAmount : 0;
            const sig = await this.swap(quote, config.priorityFeeMicroLamports);
            return { sig, solOut, sellPriceSol, tokenAmount: balance.uiAmount };
          }, `Jupiter Sell ${pos.symbol}`, 1);

          jupiterOk = true;
          const pnlSol = result.solOut - (pos.buySolAmount ?? 0);
          const pnlPct = (pos.buySolAmount ?? 0) > 0 ? (pnlSol / pos.buySolAmount!) * 100 : 0;
          updated = {
            ...updated,
            status: "closed",
            sellTimestamp: Date.now(),
            sellSolAmount: result.solOut,
            sellPriceSol: result.sellPriceSol,
            sellTxSignature: result.sig,
            pnlSol,
            pnlPct,
          };
          this.updateAndEmit(updated);
          console.log(`✅ [Jupiter] SATIŞ tamam: ${pos.symbol} | ${result.solOut.toFixed(4)} SOL | PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`);
        } catch (jupErr) {
          if (jupiterOk) throw jupErr;
          // Jupiter route yok → PumpSwap fallback dene
          console.warn(`⚠️ [Jupiter] SATIŞ başarısız, PumpSwap'a geçiliyor: ${(jupErr as Error).message}`);
          const result = await this.withRetry(async () => {
            const balance = await fetchBalanceWithRetry();
            console.log(`🔍 [PumpSwap Fallback] Satılacak: ${balance.uiAmount.toLocaleString()} ${pos.symbol}`);
            const sig = await this.pumpSwapTx({ action: "sell", mint: pos.mintAddress, amount: balance.uiAmount, denominatedInSol: false, slippagePct, priorityFeeSol });
            return { sig, tokenAmount: balance.uiAmount };
          }, `PumpSwap Fallback Sell ${pos.symbol}`, 1);
          updated = { ...updated, status: "closed", sellTimestamp: Date.now(), sellTxSignature: result.sig };
          this.updateAndEmit(updated);
          console.log(`✅ [PumpSwap Fallback] SATIŞ tamam: ${pos.symbol} | tx ${result.sig.slice(0, 16)}...`);
        }
      }
      return updated;
    } catch (err) {
      const message = (err as Error).message || String(err);

      // Rug pull tespiti — token bakiyesi bulunamadı, pozisyonu -%100 zararla kapat
      if (message.includes("RUG_PULL")) {
        const rugPullLoss = -(pos.buySolAmount ?? 0);
        updated = {
          ...pos,
          status: "closed",
          sellTimestamp: Date.now(),
          sellSolAmount: 0,
          sellPriceSol: 0,
          pnlSol: rugPullLoss,
          pnlPct: -100,
          error: "Rug Pull Detected",
        };
        this.updateAndEmit(updated);
        console.error(`🚨 [Rug Pull] ${pos.symbol} — -%100 zarar olarak kapatıldı`);
        return updated;
      }

      // Normal hata işleme
      updated = { ...pos, status: "open", error: message };
      this.updateAndEmit(updated);
      console.error(`❌ [${dexLabel}] SATIŞ hatası ${pos.symbol}:`, message);
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
