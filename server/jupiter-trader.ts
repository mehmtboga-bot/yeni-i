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

  // --- Retry yardımcısı: 2 deneme, 300ms aralık ---
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
    // Price impact'e göre dynamic slippage hesapla
    const impact = Math.abs(parseFloat(priceImpactPct));
    if (impact <= 1) return 200;  // 2%
    if (impact <= 5) return 500;  // 5%
    if (impact <= 10) return 1000; // 10%
    return 1500; // 15%
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

    // Dynamic slippage: price impact'e göre ayarla
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

    // FIX: Blockhash'i TX gönderilmeden ÖNCE al (sonradan almak expiry sorununa yol açar)
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");

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
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });

    // Confirm'i background'da yap — önceden alınan blockhash kullanılıyor
    (async () => {
      try {
        const conf = await this.connection!.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
        if (conf.value.err) {
          console.error(`❌ TX hata (background confirm): ${signature} — ${JSON.stringify(conf.value.err)}`);
        } else {
          console.log(`✅ TX confirmed (background): ${signature.slice(0, 16)}...`);
        }
      } catch (err) {
        console.error(`❌ Background confirm hatası: ${(err as Error).message}`);
      }
    })();

    return signature;
  }

  // PumpSwap (pumpportal.fun) TX oluştur ve gönder
  private async pumpSwapTx(opts: {
    action: "buy" | "sell";
    mint: string;
    amount: number;
    denominatedInSol: boolean;
    slippagePct: number;
    priorityFeeSol: number;
  }): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");

    // FIX: Blockhash'i TX gönderilmeden ÖNCE al
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");

    // denominatedInSol=true  → amount SOL cinsindendir (alım), olduğu gibi gönder
    // denominatedInSol=false → amount token UI miktarıdır (satış)
    //   uiAmount float gelir (örn. 1234567.891234), PumpPortal max 6 ondalık kabul eder
    //   Fazla ondalık API hatasına veya işlem reddine yol açar → 6 basamakla sınırla
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

    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 1 });

    // Confirm'i background'da yap — önceden alınan blockhash kullanılıyor
    (async () => {
      try {
        const conf = await this.connection!.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
        if (conf.value.err) {
          console.error(`❌ PumpSwap TX hata (background confirm): ${signature} — ${JSON.stringify(conf.value.err)}`);
        } else {
          console.log(`✅ PumpSwap TX confirmed (background): ${signature.slice(0, 16)}...`);
        }
      } catch (err) {
        console.error(`❌ PumpSwap background confirm hatası: ${(err as Error).message}`);
      }
    })();

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
      const [quote, decimals] = await Promise.all([
        this.getQuote({ inputMint: SOL_MINT, outputMint: mintAddress, amount: String(lamports), slippageBps: config.slippageBps }),
        this.fetchDecimals(mintAddress),
      ]);

      await new Promise((r) => setTimeout(r, 100));

      const tokensOut = Number(quote.outAmount) / Math.pow(10, decimals);
      const pricePerToken = tokensOut > 0 ? actualSolAmount / tokensOut : 0;
      const sig = await this.swap(quote, config.priorityFeeMicroLamports);

      // İlk kontrol hızlı (1.5s) — TX hemen onaylandıysa anında yakalar
      // Sonraki denemeler daha uzun — yavaş blok doğrulaması için
      const BALANCE_POLL_TIMES = [1500, 3000, 5000];
      const MAX_BALANCE_ATTEMPTS = BALANCE_POLL_TIMES.length;
      let confirmedTokenAmount: number | null = null;

      for (let attempt = 1; attempt <= MAX_BALANCE_ATTEMPTS; attempt++) {
        const waitMs = BALANCE_POLL_TIMES[attempt - 1];
        console.log(`⏳ [Jupiter] Bakiye bekleniyor (${attempt}/${MAX_BALANCE_ATTEMPTS}): ${symbol} — ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));

        try {
          const bal = await this.getTokenBalance(mintAddress);
          if (bal && bal.uiAmount > 0) {
            confirmedTokenAmount = bal.uiAmount;
            console.log(`🪙 [Jupiter] Token cüzdana geldi (Deneme ${attempt}): ${bal.uiAmount.toLocaleString()} ${symbol}`);
            break;
          }
          console.warn(`⚠️ [Jupiter] Deneme ${attempt}/${MAX_BALANCE_ATTEMPTS}: ${symbol} bakiyesi henüz yok`);
        } catch (balErr) {
          console.error(`❌ [Jupiter] Bakiye sorgu hatası (Deneme ${attempt}):`, (balErr as Error).message);
        }
      }

      if (confirmedTokenAmount === null) {
        // Bakiye 3 denemede bulunamadı → Rug pull olarak kapat (SOL gönderildi, token gelmedi)
        const totalWaitMs = BALANCE_POLL_TIMES.reduce((a, b) => a + b, 0);
        const rugLoss = -actualSolAmount;
        position = {
          ...position,
          status: "closed",
          sellTimestamp: Date.now(),
          sellSolAmount: 0,
          sellPriceSol: 0,
          pnlSol: rugLoss,
          pnlPct: -100,
          error: `Rug Pull — TX: ${sig.slice(0, 16)}... Token ${(totalWaitMs / 1000).toFixed(1)}s içinde gelmedi`,
        };

        this.updateAndEmit(position);

        console.error(
          `🚨 [Jupiter] ${symbol} bakiye ${MAX_BALANCE_ATTEMPTS} denemede bulunamadı`
        );

        return position;
      }

      position = { ...position, status: "open", buyTokenAmount: confirmedTokenAmount, buyPriceSol: pricePerToken, buyTxSignature: sig };
      this.updateAndEmit(position);
      console.log(`✅ [Jupiter] ALIM tamam: ${symbol} | ${confirmedTokenAmount.toLocaleString()} token | tx ${sig.slice(0, 16)}...`);
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

      // FIX: TX gönderildi, şimdi "open" olarak işaretle
      position = { ...position, status: "open", buyTxSignature: sig };
      this.updateAndEmit(position);
      console.log(`✅ [PumpSwap] ALIM tamam: ${symbol} | tx ${sig.slice(0, 16)}...`);

      // Arka planda bakiyeyi doğrula
      (async () => {
        let foundBalance = false;

        // Önce TX'in başarılı olup olmadığını kontrol et (fake buy tespiti)
        // 1.5s — TX genellikle bu süre içinde onaylanır, 3s'den daha hızlı tespit
        try {
          await new Promise((r) => setTimeout(r, 1500));
          const statusResult = await this.connection!.getSignatureStatus(sig);
          const txErr = statusResult.value?.err;
          if (txErr) {
            // TX blockchain'de başarısız — fake buy değil, gerçek hata
            const pos = this.store.getById(position.id);
            if (pos && pos.status === "open") {
              const failed = { ...pos, status: "failed" as const, error: `TX başarısız: ${JSON.stringify(txErr)}` };
              this.updateAndEmit(failed);
              console.error(`❌ [PumpSwap] ${symbol} TX blockchain'de başarısız — hata olarak işaretlendi`);
            }
            return;
          }
        } catch (statusErr) {
          // TX durum kontrolü başarısız — bakiye kontrolüne devam et
          console.warn(`⚠️ [PumpSwap] ${symbol} TX durum kontrolü yapılamadı, bakiye kontrolüne devam`);
        }

        // Bakiye kontrol döngüsü
        for (const delay of [2000, 3000, 5000]) {
          await new Promise((r) => setTimeout(r, delay));

          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const bal = await this.getTokenBalance(mintAddress);
              if (bal && bal.uiAmount > 0) {
                const updated = { ...this.store.getById(position.id)!, buyTokenAmount: bal.uiAmount };
                this.updateAndEmit(updated);
                console.log(`🪙 [PumpSwap] Token bakiyesi güncellendi (Deneme ${attempt}): ${bal.uiAmount.toLocaleString()} ${symbol}`);
                foundBalance = true;
                return;
              }
              console.warn(`⚠️ [PumpSwap] Deneme ${attempt}: Token bakiyesi bulunamadı`);
            } catch (err) {
              console.error(`❌ [PumpSwap] Deneme ${attempt} hatası:`, (err as Error).message);
            }

            if (attempt === 1) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }

        // Tüm denemeler başarısız → Rug pull olarak kapat
        if (!foundBalance) {
          const pos = this.store.getById(position.id);
          if (pos && pos.status === "open") {
            const rugPullLoss = -(pos.buySolAmount ?? 0);
            const closed = {
              ...pos,
              status: "closed" as const,
              sellTimestamp: Date.now(),
              sellSolAmount: 0,
              sellPriceSol: 0,
              pnlSol: rugPullLoss,
              pnlPct: -100,
              error: "Rug Pull - Token Bakiyesi Bulunamadı",
            };
            this.updateAndEmit(closed);
            console.error(`🚨 [PumpSwap] ${symbol} token bakiyesi bulunamadı — rug pull olarak kapatıldı (-100%)`);
          }
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
    // FIX: "pending_sell" de kabul et — SELL_NOT_CONFIRMED sonrası "open"'a döndürülmüş olabilir
    // ya da manuel retry durumunda pending_sell'den devam edilebilir
    if (!["open", "failed", "pending_sell"].includes(pos.status)) { console.warn(`⚠️ Satışa uygun değil (${pos.status}): ${pos.symbol}`); return pos; }
    if (!this.isReady()) { console.error("❌ Cüzdan hazır değil — satış atlandı"); return null; }
    if (this.inFlight.has(`sell:${pos.id}`)) return pos;
    this.inFlight.add(`sell:${pos.id}`);

    const config = this.store.getConfig();
    let updated: Position = { ...pos, status: "pending_sell", error: undefined };
    this.updateAndEmit(updated);
    const dexLabel = pos.dex === "pumpswap" ? "PumpSwap" : "Jupiter";
    console.log(`💸 [${dexLabel}] SATIŞ: ${pos.symbol}`);

    const slippagePct = Math.floor(config.slippageBps / 100);
    const priorityFeeSol = config.priorityFeeMicroLamports / 1_000_000_000;

    const fetchBalanceWithRetry = async (): Promise<{ uiAmount: number; raw: string; decimals: number }> => {
      const bal = await this.getTokenBalance(pos.mintAddress);
      if (bal && bal.uiAmount > 0) return bal;
      throw new Error(`RUG_PULL: Cüzdanda ${pos.symbol} bakiyesi bulunamadı`);
    };

    try {
      // Satış doğrulama + aktif retry mekanizması
      // Her kontrolde bakiye > 0 görülürse → anında yeni TX gönderir (beklemez)
      // RPC hatası (null) → o denemeyi atlar, 0 gibi saymaz
      // Onaylanan TX imzasını döner (retry sırasında değişmiş olabilir)
      const verifySellBalance = async (
        initialSig: string,
        label: string,
        doSell: () => Promise<string>,
      ): Promise<string> => {
        let currentSig = initialSig;
        const waitTimes = [3000, 5000, 7000, 7000, 7000];
        for (let attempt = 1; attempt <= waitTimes.length; attempt++) {
          console.log(`⏳ [${label}] Satış doğrulama ${attempt}/${waitTimes.length}: ${waitTimes[attempt - 1] / 1000}s bekleniyor...`);
          await new Promise((r) => setTimeout(r, waitTimes[attempt - 1]));

          const bal = await this.getTokenBalance(pos.mintAddress);

          // RPC hatası → null: bu denemeyi atla, bakiye 0 gibi sayma
          if (bal === null) {
            console.warn(`⚠️ [${label}] Deneme ${attempt}/${waitTimes.length}: RPC bakiye okunamadı — atlanıyor`);
            continue;
          }

          const remaining = bal.uiAmount;
          console.log(`🔍 [${label}] Deneme ${attempt}/${waitTimes.length}: bakiye = ${remaining.toLocaleString()} ${pos.symbol}`);

          if (remaining === 0) {
            console.log(`✅ [${label}] Token bakiyesi sıfırlandı — satış doğrulandı (tx ${currentSig.slice(0, 16)}...)`);
            return currentSig;
          }

          // Bakiye hala var → son deneme değilse hemen yeni TX gönder
          if (attempt < waitTimes.length) {
            console.log(`🔄 [${label}] Bakiye ${remaining.toLocaleString()} ${pos.symbol} hala mevcut — yeni satış TX gönderiliyor`);
            try {
              const newSig = await doSell();
              currentSig = newSig;
              updated = { ...updated, sellTxSignature: currentSig };
              console.log(`📤 [${label}] Yeni satış TX: ${newSig.slice(0, 16)}...`);
            } catch (retryErr) {
              const retryMsg = (retryErr as Error).message;
              // doSell içinde fetchBalanceWithRetry bakiye 0 döndürdü → önceki TX zaten çalışmış
              if (retryMsg.includes("RUG_PULL")) {
                console.log(`✅ [${label}] Yeniden satış sırasında bakiye sıfırlandı — önceki TX geçerli (${currentSig.slice(0, 16)}...)`);
                return currentSig;
              }
              console.warn(`⚠️ [${label}] Yeniden TX hatası: ${retryMsg} — sonraki kontrole devam`);
            }
          }
        }
        throw new Error(`SELL_NOT_CONFIRMED: TX (${currentSig.slice(0, 16)}...) ancak ${pos.symbol} bakiyesi hala > 0 — satış gerçekleşmedi`);
      };

      if (pos.dex === "pumpswap") {
        // doSell: güncel bakiyeyi çek → yeni TX gönder
        const doSell = async (): Promise<string> => {
          const balance = await fetchBalanceWithRetry();
          console.log(`🔍 [PumpSwap] Satılacak: ${balance.uiAmount.toLocaleString()} ${pos.symbol}`);
          return this.pumpSwapTx({ action: "sell", mint: pos.mintAddress, amount: balance.uiAmount, denominatedInSol: false, slippagePct, priorityFeeSol });
        };

        const initialSig = await doSell();
        updated = { ...updated, sellTxSignature: initialSig };
        const confirmedSig = await verifySellBalance(initialSig, "PumpSwap", doSell);

        updated = { ...updated, status: "closed", sellTimestamp: Date.now(), sellTxSignature: confirmedSig };
        this.updateAndEmit(updated);
        console.log(`✅ [PumpSwap] SATIŞ tamam: ${pos.symbol} | tx ${confirmedSig.slice(0, 16)}...`);
      } else {
        // Jupiter satışı — route yoksa PumpSwap'a fallback
        let jupiterOk = false;
        try {
          // Jupiter doSell — quote verilerini dışarıya yazmak için ref kullan
          let lastSolOut = 0;
          let lastSellPriceSol = 0;
          const doJupiterSell = async (): Promise<string> => {
            const balance = await fetchBalanceWithRetry();
            const quote = await this.getQuote({ inputMint: pos.mintAddress, outputMint: SOL_MINT, amount: balance.raw, slippageBps: config.slippageBps });
            lastSolOut = Number(quote.outAmount) / 1e9;
            lastSellPriceSol = balance.uiAmount > 0 ? lastSolOut / balance.uiAmount : 0;
            return this.swap(quote, config.priorityFeeMicroLamports);
          };

          const initialSig = await doJupiterSell();
          updated = { ...updated, sellTxSignature: initialSig };
          const confirmedSig = await verifySellBalance(initialSig, "Jupiter", doJupiterSell);

          jupiterOk = true;
          const pnlSol = lastSolOut - (pos.buySolAmount ?? 0);
          const pnlPct = (pos.buySolAmount ?? 0) > 0 ? (pnlSol / pos.buySolAmount!) * 100 : 0;
          updated = {
            ...updated,
            status: "closed",
            sellTimestamp: Date.now(),
            sellSolAmount: lastSolOut,
            sellPriceSol: lastSellPriceSol,
            sellTxSignature: confirmedSig,
            pnlSol,
            pnlPct,
          };
          this.updateAndEmit(updated);
          console.log(`✅ [Jupiter] SATIŞ tamam: ${pos.symbol} | ${lastSolOut.toFixed(4)} SOL | PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`);
        } catch (jupErr) {
          if (jupiterOk) throw jupErr;
          // Jupiter route yok → PumpSwap fallback dene
          console.warn(`⚠️ [Jupiter] SATIŞ başarısız, PumpSwap'a geçiliyor: ${(jupErr as Error).message}`);

          const doFallbackSell = async (): Promise<string> => {
            const balance = await fetchBalanceWithRetry();
            console.log(`🔍 [PumpSwap Fallback] Satılacak: ${balance.uiAmount.toLocaleString()} ${pos.symbol}`);
            return this.pumpSwapTx({ action: "sell", mint: pos.mintAddress, amount: balance.uiAmount, denominatedInSol: false, slippagePct, priorityFeeSol });
          };

          const initialSig = await doFallbackSell();
          updated = { ...updated, sellTxSignature: initialSig };
          const confirmedSig = await verifySellBalance(initialSig, "PumpSwap Fallback", doFallbackSell);

          updated = { ...updated, status: "closed", sellTimestamp: Date.now(), sellTxSignature: confirmedSig };
          this.updateAndEmit(updated);
          console.log(`✅ [PumpSwap Fallback] SATIŞ tamam: ${pos.symbol} | tx ${confirmedSig.slice(0, 16)}...`);
        }
      }
      return updated;
    } catch (err) {
      const message = (err as Error).message || String(err);

      // Rug pull tespiti — token bakiyesi bulunamadı
      if (message.includes("RUG_PULL")) {
        // BUG FIX: Yanlış rug pull önlemi
        // Senaryo: İlk satış TX gönderildi → verifySellBalance zaman aşımı (SELL_NOT_CONFIRMED)
        //   → pozisyon "open"a döndü + sellTxSignature kaydedildi
        //   → retry tetiklendi → fetchBalanceWithRetry token bulamadı (TX aslında çalışmıştı!)
        //   → Eski kod: "RUG PULL -100%" yazıyordu (YANLIŞ)
        //   → Yeni kod: sellTxSignature varsa = satış TX'i daha önce gönderilmiş, token yok = satış çalışmış
        const existingSellSig = updated.sellTxSignature ?? pos.sellTxSignature;
        if (existingSellSig) {
          updated = {
            ...pos,
            status: "closed",
            sellTimestamp: Date.now(),
            sellTxSignature: existingSellSig,
            sellSolAmount: pos.sellSolAmount ?? 0,
            sellPriceSol: pos.sellPriceSol ?? 0,
            pnlSol: pos.pnlSol ?? 0,
            pnlPct: pos.pnlPct ?? 0,
            error: undefined,
          };
          this.updateAndEmit(updated);
          console.log(`✅ [${dexLabel}] ${pos.symbol} — token yok + önceki satış TX mevcut → satış başarılı olarak kapatıldı (${existingSellSig.slice(0, 16)}...)`);
          return updated;
        }

        // Gerçek rug pull — hiç satış TX gönderilmedi, token hiç gelmedi
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

      // SELL_NOT_CONFIRMED → "open" yap, sellTxSignature'ı koru
      // updated içinde sellTxSignature artık kaydedilmiş durumda (verifySellBalance öncesi set edildi)
      // Bir sonraki retry'da RUG_PULL gelirse existingSellSig kontrolü doğru çalışır
      if (message.includes("SELL_NOT_CONFIRMED")) {
        updated = { ...updated, status: "open", error: message };
        this.updateAndEmit(updated);
        console.error(`❌ [${dexLabel}] SATIŞ DOĞRULANAMADI — pozisyon "open" yapıldı, TX imzası saklandı, yeniden deneme aktif: ${pos.symbol}`);
        return updated;
      }

      // Normal hata işleme
      updated = { ...updated, status: "open", error: message };
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
