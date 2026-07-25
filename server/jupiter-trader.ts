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
const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP  = "https://api.jup.ag/swap/v1/swap";
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
const PUMP_TRADE_API = "https://pumpportal.fun/api/trade-local";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;

// Satış başarısız olduğunda maksimum tekrar sayısı (sonsuz döngüyü önler)
// 3 başarısız denemeden sonra rug pull olarak kapatılır (_retryCount >= 2 → 3. deneme)
const MAX_SELL_RETRIES = 2;
// Exponential backoff: delayMs * 2^deneme, bu değerin üstüne çıkmaz (ms)
const MAX_BACKOFF_MS = 4000;

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
  private balanceCheckIntervals: Map<string, NodeJS.Timeout> = new Map();
  // Token başına pool SOL miktarı (Helius monitor'dan güncellenir)
  private poolSolCache: Map<string, number> = new Map();

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

  // --- [DÜZELTİLDİ] AbortController ile gerçek HTTP iptali ---
  // Eski withTimeout Promise race yapıyordu ama HTTP isteği arka planda devam ediyordu.
  // AbortController fetch'i gerçekten iptal eder, kaynak sızdırmaz.
  private fetchWithTimeout(input: RequestInfo | URL, init: RequestInit & { timeoutMs: number }): Promise<Response> {
    const { timeoutMs, ...fetchInit } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(input, { ...fetchInit, signal: controller.signal })
      .finally(() => clearTimeout(timer))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Timeout — istek iptal edildi`);
        }
        throw err;
      });
  }

  // --- [DÜZELTİLDİ] Exponential backoff ile retry ---
  // delayMs * 2^i şeklinde artar, MAX_BACKOFF_MS'i aşmaz.
  // Satış retry'larında sabit 1s yerine 1s, 2s, 4s, 4s, 4s... şeklinde bekler.
  private async withRetry<T>(fn: () => Promise<T>, label: string, retries = 3, baseDelayMs = 500): Promise<T> {
    let lastErr: Error = new Error("Bilinmeyen hata");
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err as Error;
        if (lastErr.message.startsWith("FINAL:")) throw lastErr;
        if (i < retries - 1) {
          const delay = Math.min(baseDelayMs * Math.pow(2, i), MAX_BACKOFF_MS);
          console.warn(`⏳ [${label}] Deneme ${i + 1}/${retries} başarısız — ${delay}ms bekleniyor... (${lastErr.message})`);
          await new Promise((r) => setTimeout(r, delay));
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

  private async getSolBalance(): Promise<number> {
    if (!this.keypair || !this.connection) return 0;
    try {
      const lamports = await this.connection.getBalance(this.keypair.publicKey);
      return lamports / 1e9;
    } catch {
      return 0;
    }
  }

  // Jupiter Price API üzerinden token'ın SOL karşılığını tahmin eder
  // PumpSwap satışlarında gerçek fiyat bilinmediğinde PnL tahmini için kullanılır
  private async estimateSolValue(mint: string, tokenAmount: number): Promise<number> {
    if (tokenAmount <= 0) return 0;
    try {
      const url = new URL(JUP_PRICE);
      url.searchParams.set("ids", mint);
      url.searchParams.set("vsToken", SOL_MINT);
      const res = await this.fetchWithTimeout(url.toString(), { timeoutMs: 2000 });
      if (!res.ok) return 0;
      const json = await res.json();
      const price: number = json?.data?.[mint]?.price ?? 0;
      return price * tokenAmount;
    } catch {
      return 0;
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

    const res = await this.fetchWithTimeout(url.toString(), { timeoutMs: 3000 });
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${bodyText.slice(0, 200)}`);
    const json = JSON.parse(bodyText) as QuoteResponse;
    if (!json?.outAmount || BigInt(json.outAmount) === 0n) throw new Error("Jupiter quote: route bulunamadı");
    return json;
  }

  private async swap(quote: QuoteResponse, priorityFeeMicroLamports: number, confirmForeground = false): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");
    const swapBody = {
      quoteResponse: quote,
      userPublicKey: this.keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      skipUserAccountsRpcCalls: false,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: Math.max(priorityFeeMicroLamports, 1), priorityLevel: "veryHigh" },
      },
    };
    const swapRes = await this.fetchWithTimeout(JUP_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(swapBody),
      timeoutMs: 2500,
    });
    if (!swapRes.ok) throw new Error(`Jupiter swap ${swapRes.status}: ${(await swapRes.text()).slice(0, 200)}`);
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
    if (!swapTransaction) throw new Error("swapTransaction alınamadı");

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([this.keypair]);

    // Blockhash TX gönderiminden ÖNCE alınır — confirmation window daha uzun olur
    const latest = await this.connection.getLatestBlockhash("processed");

    // TX ağa gönderilir — bu noktadan sonra withRetry YENİ TX GÖNDERMEMELİ
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 1 });
      console.log(`✅ [Jupiter] TX ağa gönderildi: ${signature} | boyut: ${tx.serialize().length} byte`);
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      console.error(`❌ [Jupiter] TX GÖNDERME HATASI: ${errorMsg} | TX boyutu: ${tx.serialize().length} byte | RPC: ${RPC_URL.split('?')[0]}`);
      throw new Error(`Jupiter TX gönderme başarısız: ${errorMsg}`);
    }

    if (confirmForeground) {
      // Satış TX'leri için FOREGROUND confirm — onaylanmadan devam etme
      // TX başarısız veya timeout olursa throw eder, withRetry yeni TX gönderir
      // 30 saniyelik timeout — varsayılan ~60s yerine daha hızlı hata tespiti
      const confirmPromise = this.connection.confirmTransaction({ signature, ...latest }, "processed");
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Jupiter TX confirm timeout (30s): ${signature.slice(0, 16)}...`)), 30_000)
      );
      const conf = await Promise.race([confirmPromise, timeoutPromise]);
      if (conf.value.err) {
        throw new Error(`Jupiter TX başarısız: ${JSON.stringify(conf.value.err)} (sig: ${signature.slice(0, 16)}...)`);
      }
      console.log(`✅ [Jupiter] TX onaylandı: ${signature.slice(0, 16)}...`);
    } else {
      // Alım TX'leri için BACKGROUND confirm — bakiye polling zaten onayı bekler
      ;(async () => {
        try {
          const conf = await this.connection!.confirmTransaction({ signature, ...latest }, "processed");
          if (conf.value.err) {
            console.error(`❌ [Jupiter] TX hata (background): ${signature.slice(0, 16)}... — ${JSON.stringify(conf.value.err)}`);
          } else {
            console.log(`✅ [Jupiter] TX onaylandı (background): ${signature.slice(0, 16)}...`);
          }
        } catch (err) {
          console.error(`❌ [Jupiter] TX confirm timeout (background): ${(err as Error).message}`);
        }
      })();
    }

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
    confirmForeground?: boolean;
  }): Promise<string> {
    if (!this.keypair || !this.connection) throw new Error("Cüzdan/RPC hazır değil");

    const body = {
      publicKey: this.keypair.publicKey.toBase58(),
      action: opts.action,
      mint: opts.mint,
      denominatedInSol: opts.denominatedInSol,
      amount: opts.amount,
      slippage: opts.slippagePct,
      priorityFee: opts.priorityFeeSol,
      pool: "pumpswap",
    };

    console.log(`🔍 [PumpSwap] Request body:`, JSON.stringify({
      publicKey: body.publicKey,
      action: body.action,
      mint: body.mint,
      denominatedInSol: body.denominatedInSol,
      amount: body.amount,
      slippage: body.slippage,
      slippageType: typeof body.slippage,
      priorityFee: body.priorityFee,
      priorityFeeType: typeof body.priorityFee,
      pool: body.pool,
    }, null, 2));

    const res = await this.fetchWithTimeout(PUMP_TRADE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 3000,
    });

    if (!res.ok) throw new Error(`PumpPortal API ${res.status}: ${(await res.text()).slice(0, 200)}`);

    // [DÜZELTİLDİ] PumpPortal response validation:
    // Başarılı yanıt binary TX verisi olmalı (JSON hata mesajı değil).
    // content-type application/octet-stream veya binary olmalı; JSON gelirse hata demektir.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const errBody = await res.json();
      throw new Error(`PumpPortal JSON yanıtı (TX bekleniyor): ${JSON.stringify(errBody).slice(0, 200)}`);
    }

    const buf = await res.arrayBuffer();

    // Minimum boyut kontrolü: geçerli bir Solana TX en az 100 byte olmalı
    if (buf.byteLength < 100) {
      throw new Error(`PumpPortal geçersiz TX boyutu: ${buf.byteLength} byte (min 100 bekleniyor)`);
    }

    const tx = VersionedTransaction.deserialize(new Uint8Array(buf));
    tx.sign([this.keypair]);

    // Blockhash TX gönderiminden ÖNCE alınır — confirmation window daha uzun olur
    const latest = await this.connection.getLatestBlockhash("processed");

    // TX ağa gönderilir — bu noktadan sonra withRetry YENİ TX GÖNDERMEMELİ
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 1 });
      console.log(`✅ [PumpSwap] TX ağa gönderildi: ${signature} | boyut: ${tx.serialize().length} byte`);
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      console.error(`❌ [PumpSwap] TX GÖNDERME HATASI: ${errorMsg} | TX boyutu: ${tx.serialize().length} byte | RPC: ${RPC_URL.split('?')[0]}`);
      throw new Error(`PumpSwap TX gönderme başarısız: ${errorMsg}`);
    }

    if (opts.confirmForeground) {
      // Satış TX'leri için FOREGROUND confirm — onaylanmadan devam etme
      // TX başarısız veya timeout olursa throw eder, withRetry yeni TX gönderir
      const conf = await this.connection.confirmTransaction({ signature, ...latest }, "processed");
      if (conf.value.err) {
        throw new Error(`PumpSwap TX başarısız: ${JSON.stringify(conf.value.err)} (sig: ${signature.slice(0, 16)}...)`);
      }
      console.log(`✅ [PumpSwap] TX onaylandı: ${signature.slice(0, 16)}...`);
    } else {
      // Alım TX'leri için BACKGROUND confirm — bakiye polling zaten onayı bekler
      ;(async () => {
        try {
          const conf = await this.connection!.confirmTransaction({ signature, ...latest }, "processed");
          if (conf.value.err) {
            console.error(`❌ [PumpSwap] TX hata (background): ${signature.slice(0, 16)}... — ${JSON.stringify(conf.value.err)}`);
          } else {
            console.log(`✅ [PumpSwap] TX onaylandı (background): ${signature.slice(0, 16)}...`);
          }
        } catch (err) {
          console.error(`❌ [PumpSwap] TX confirm timeout (background): ${(err as Error).message}`);
        }
      })();
    }

    return signature;
  }

  private updateAndEmit(position: Position) {
    this.store.upsert(position);
    this.emit("position_update", position);
  }

  async buy(input: { mintAddress: string; name: string; symbol: string; solAmount?: number; isAuto?: boolean }): Promise<Position | null> {
    const { mintAddress, name, symbol, solAmount, isAuto = false } = input;
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
    // Manuel/otomatik alım için ayrı priority fee kullan
    const priorityFee = isAuto
      ? config.priorityFeeAutoMicroLamports
      : config.priorityFeeManualMicroLamports;
    const id = `pos-${mintAddress}-${Date.now()}`;
    let position: Position = {
      id, mintAddress, name, symbol, dex: "jupiter",
      status: "pending_buy", buyTimestamp: Date.now(), buySolAmount: actualSolAmount,
    };
    this.updateAndEmit(position);
    console.log(`🛒 [Jupiter] ALIM: ${symbol} — ${actualSolAmount} SOL (${isAuto ? "otomatik" : "manuel"}, fee: ${priorityFee})`);

    // 650ms bekle — LP indexer'ın yayılması için
    await new Promise((r) => setTimeout(r, 1650));

    try {
      let swapSignature: string | null = null;
      let swapPricePerToken = 0;

      // retries=2 → Deneme 1: Quote al → TX gönder → Bakiye polling
      //              Deneme 2: Önce mevcut bakiye kontrol (önceki TX başardıysa), yoksa yeni TX gönder
      const result = await this.withRetry(async () => {
        // [DÜZELTİLDİ] Retry'da çift TX'i önle: önceki deneme TX'i onaylanmış olabilir.
        // Yeni TX göndermeden önce cüzdanda bakiye var mı kontrol et.
        if (swapSignature !== null) {
          console.warn(`🔄 [Jupiter] Retry: önceki TX kontrol ediliyor (sig: ${swapSignature.slice(0, 16)}...) — yeni TX göndermeden önce bakiye sorgulanıyor`);
          const existing = await this.getTokenBalance(mintAddress);
          if (existing && existing.uiAmount > 0) {
            console.log(`✅ [Jupiter] Önceki TX onaylandı, yeni TX gönderilmiyor. Bakiye: ${existing.uiAmount}`);
            // Gerçek alınan token miktarından fiyatı yeniden hesapla
            swapPricePerToken = existing.uiAmount > 0 ? actualSolAmount / existing.uiAmount : swapPricePerToken;
            return { sig: swapSignature, tokensOut: existing.uiAmount, pricePerToken: swapPricePerToken };
          }
        }

        const quote = await this.getQuote({ inputMint: SOL_MINT, outputMint: mintAddress, amount: String(lamports), slippageBps: config.slippageBps });
        console.log(`📊 [Jupiter] Quote alındı: ${symbol} | slippage: ${(quote.slippageBps / 100).toFixed(1)}% (${quote.slippageBps} bps) | giriş: ${(Number(quote.inAmount) / 1e9).toFixed(6)} SOL | beklenen çıkış: ${Number(quote.outAmount).toLocaleString()} token | priceImpact: ${Number(quote.priceImpactPct).toFixed(4)}%`);

        swapSignature = await this.swap(quote, priorityFee);
        console.log(`📤 [Jupiter] TX gönderildi: ${swapSignature} | ${symbol} | ${actualSolAmount} SOL | slippage: ${(quote.slippageBps / 100).toFixed(1)}% | beklenen: ${Number(quote.outAmount).toLocaleString()} token`);
        // TX ağda yayılması için 750ms bekle
        await new Promise((r) => setTimeout(r, 750));

        // TX gönderildi — her 500ms'de bakiye kontrol (max 20 = 10s)
        // [DÜZELTİLDİ] 8→20: Mainnet'te yeni token hesabı oluşumu + RPC yayılımı 5-15s sürebilir
        for (let c = 0; c < 20; c++) {
          await new Promise((r) => setTimeout(r, 500));
          const bal = await this.getTokenBalance(mintAddress);
          if (bal && bal.uiAmount > 0) {
            // [DÜZELTİLDİ] Quote'tan değil, gerçek alınan token miktarından hesapla
            swapPricePerToken = actualSolAmount / bal.uiAmount;
            console.log(`💰 [Jupiter] Token alındı: ${bal.uiAmount.toLocaleString()} ${symbol} | fiyat: ${swapPricePerToken.toFixed(10)} SOL/token | slippage: ${(quote.slippageBps / 100).toFixed(1)}% | tx: ${swapSignature!.slice(0, 16)}...`);
            return { sig: swapSignature!, tokensOut: bal.uiAmount, pricePerToken: swapPricePerToken };
          }
          console.log(`⏳ [Jupiter] Token bekleniyor... (${c + 1}/20)`);
        }

        // Token gelmedi — retry izin ver
        throw new Error(`Token bakiyesi 0 (sig: ${swapSignature!.slice(0, 16)}...)`);
      }, `Jupiter Buy ${symbol}`, 2);

      position = { ...position, status: "open", buyTokenAmount: result.tokensOut, buyPriceSol: result.pricePerToken, buyTxSignature: result.sig };
      this.updateAndEmit(position);
      console.log(`✅ [Jupiter] ALIM tamam: ${symbol} | ${result.tokensOut.toFixed(4)} token | fiyat: ${result.pricePerToken.toFixed(10)} SOL/token | tx: ${result.sig.slice(0, 16)}...`);

      return position;

    } catch (err) {
      const message = (err as Error).message || String(err);
      position = { ...position, status: "failed", error: message };
      this.updateAndEmit(position);
      console.error(`❌ [Jupiter] ALIM hatası ${symbol}:`, message);

      return position;
    } finally {
      // [DÜZELTİLDİ] inFlight temizliği sadece finally'de — catch içinde tekrar silmeye gerek yok
      this.inFlight.delete(`buy:${mintAddress}`);
    }
  }

  // ========== PUMPSWAP ALIM ==========
  async buyPumpSwap(input: { mintAddress: string; name: string; symbol: string; solAmount?: number; isAuto?: boolean }): Promise<Position | null> {
    const { mintAddress, name, symbol, solAmount, isAuto = false } = input;
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
    console.log(`🛒 [PumpSwap] ALIM: ${symbol} — ${actualSolAmount} SOL (${isAuto ? "otomatik" : "manuel"}) | slippage: ${Math.floor(config.slippageBps / 100)}%`);

    // 650ms bekle — LP indexer'ın yayılması için
    await new Promise((r) => setTimeout(r, 650));

    const slippagePct = Math.floor(config.slippageBps / 100);
    // Manuel/otomatik alım için ayrı priority fee kullan
    // Birim dönüşümü: micro-lamport → SOL (1 SOL = 10^9 lamports, 1 lamport = 10^6 micro-lamports → 1 SOL = 10^15 micro-lamports, ama API SOL bekler: / 10^9)
    const rawFee = isAuto
      ? config.priorityFeeAutoMicroLamports
      : config.priorityFeeManualMicroLamports;
    const priorityFeeSol = rawFee / 1_000_000_000;

    try {
      let swapSignature: string | null = null;

      // retries=2 → Deneme 1: TX gönder → Bakiye polling
      //              Deneme 2: Önce mevcut bakiye kontrol (önceki TX başardıysa), yoksa yeni TX gönder
      const { sig, tokensReceived } = await this.withRetry(async () => {
        // [DÜZELTİLDİ] Retry'da çift TX'i önle: önceki deneme TX'i onaylanmış olabilir.
        if (swapSignature !== null) {
          console.warn(`🔄 [PumpSwap] Retry: önceki TX kontrol ediliyor (sig: ${swapSignature.slice(0, 16)}...) — yeni TX göndermeden önce bakiye sorgulanıyor`);
          const existing = await this.getTokenBalance(mintAddress);
          if (existing && existing.uiAmount > 0) {
            console.log(`✅ [PumpSwap] Önceki TX onaylandı, yeni TX gönderilmiyor. Bakiye: ${existing.uiAmount}`);
            return { sig: swapSignature, tokensReceived: existing.uiAmount };
          }
        }

        swapSignature = await this.pumpSwapTx({ action: "buy", mint: mintAddress, amount: actualSolAmount, denominatedInSol: true, slippagePct, priorityFeeSol });
        console.log(`📤 [PumpSwap] TX gönderildi: ${swapSignature} | ${symbol} | ${actualSolAmount} SOL | slippage: ${slippagePct}%`);

        // TX gönderildi — her 500ms'de bakiye kontrol (max 20 = 10s)
        // [DÜZELTİLDİ] 8→20: Mainnet'te yeni token hesabı oluşumu + RPC yayılımı 5-15s sürebilir
        let tokensReceived = 0;
        for (let c = 0; c < 20; c++) {
          await new Promise((r) => setTimeout(r, 500));
          const bal = await this.getTokenBalance(mintAddress);
          if (bal && bal.uiAmount > 0) {
            tokensReceived = bal.uiAmount;
            const pricePerToken = actualSolAmount / tokensReceived;
            console.log(`💰 [PumpSwap] Token alındı: ${tokensReceived.toLocaleString()} ${symbol} | fiyat: ${pricePerToken.toFixed(10)} SOL/token | slippage: ${slippagePct}% | tx: ${swapSignature!.slice(0, 16)}...`);
            break;
          }
          console.log(`⏳ [PumpSwap] Token bekleniyor... (${c + 1}/20)`);
        }

        // Token gelmedi — retry izin ver
        if (tokensReceived === 0) {
          throw new Error(`Token bakiyesi 0 (sig: ${swapSignature!.slice(0, 16)}...)`);
        }

        return { sig: swapSignature!, tokensReceived };
      }, `PumpSwap Buy ${symbol}`, 2);

      // [DÜZELTİLDİ] withRetry'dan dönen tokensReceived kullanılıyor — gereksiz tekrar sorgu kaldırıldı
      // [DÜZELTİLDİ] buyPriceSol: Quote'tan değil, gerçek alınan token miktarından hesapla
      const buyPriceSol = tokensReceived > 0 ? actualSolAmount / tokensReceived : 0;
      position = { ...position, status: "open", buyTxSignature: sig, buyTokenAmount: tokensReceived, buyPriceSol };
      this.updateAndEmit(position);
      console.log(`✅ [PumpSwap] ALIM tamam: ${symbol} | ${tokensReceived.toLocaleString()} token | fiyat: ${buyPriceSol.toFixed(10)} SOL/token | tx: ${sig.slice(0, 16)}...`);

      return position;
    } catch (err) {
      const message = (err as Error).message || String(err);
      position = { ...position, status: "failed", error: message };
      this.updateAndEmit(position);
      console.error(`❌ [PumpSwap] ALIM hatası ${symbol}:`, message);

      return position;
    } finally {
      // [DÜZELTİLDİ] inFlight temizliği sadece finally'de
      this.inFlight.delete(`buy:${mintAddress}`);
    }
  }

  // ========== EK ALIM (mevcut pozisyona ekleme) ==========
  // Mevcut açık pozisyon için ek SOL harcayarak token alır.
  // Yeni position oluşturmaz — mevcut position'ın buySolAmount ve buyTokenAmount'ını günceller.
  async additionalBuy(input: {
    positionId: string;
    mintAddress: string;
    symbol: string;
    dex: "jupiter" | "pumpswap";
    solAmount: number;
  }): Promise<{ tokensReceived: number; txSignature: string } | null> {
    const { positionId, mintAddress, symbol, dex, solAmount } = input;
    if (!this.isReady()) { console.error("❌ Cüzdan hazır değil — ek alım atlandı"); return null; }
    if (this.inFlight.has(`addl-buy:${positionId}`)) { console.warn(`⏳ ${symbol} ek alım zaten devam ediyor`); return null; }

    this.inFlight.add(`addl-buy:${positionId}`);
    const config = this.store.getConfig();
    const lamports = Math.floor(solAmount * 1e9);
    const priorityFee = config.priorityFeeManualMicroLamports;
    const slippagePct = Math.floor(config.slippageBps / 100);
    const priorityFeeSol = priorityFee / 1_000_000_000;

    console.log(`🛒 [AdditionalBuy] ${symbol} ek alım: ${solAmount} SOL | DEX: ${dex}`);

    try {
      let swapSignature: string | null = null;
      let tokensReceived = 0;

      if (dex === "pumpswap") {
        const result = await this.withRetry(async () => {
          if (swapSignature !== null) {
            const bal = await this.getTokenBalance(mintAddress);
            if (bal && bal.uiAmount > 0) {
              return { sig: swapSignature!, tokensReceived: bal.uiAmount };
            }
          }
          swapSignature = await this.pumpSwapTx({ action: "buy", mint: mintAddress, amount: solAmount, denominatedInSol: true, slippagePct, priorityFeeSol });
          console.log(`📤 [AdditionalBuy/PumpSwap] TX gönderildi: ${swapSignature}`);
          await new Promise((r) => setTimeout(r, 750));
          let received = 0;
          for (let c = 0; c < 20; c++) {
            await new Promise((r) => setTimeout(r, 500));
            const bal = await this.getTokenBalance(mintAddress);
            if (bal && bal.uiAmount > 0) { received = bal.uiAmount; break; }
          }
          if (received === 0) throw new Error(`Token bakiyesi 0 (sig: ${swapSignature!.slice(0, 16)}...)`);
          return { sig: swapSignature!, tokensReceived: received };
        }, `AdditionalBuy/PumpSwap ${symbol}`, 2);
        swapSignature = result.sig;
        tokensReceived = result.tokensReceived;
      } else {
        const result = await this.withRetry(async () => {
          if (swapSignature !== null) {
            const bal = await this.getTokenBalance(mintAddress);
            if (bal && bal.uiAmount > 0) {
              return { sig: swapSignature!, tokensReceived: bal.uiAmount };
            }
          }
          const balBefore = await this.getTokenBalance(mintAddress);
          const prevAmount = balBefore?.uiAmount ?? 0;
          const quote = await this.getQuote({ inputMint: SOL_MINT, outputMint: mintAddress, amount: String(lamports), slippageBps: config.slippageBps });
          swapSignature = await this.swap(quote, priorityFee);
          console.log(`📤 [AdditionalBuy/Jupiter] TX gönderildi: ${swapSignature}`);
          await new Promise((r) => setTimeout(r, 750));
          let received = 0;
          for (let c = 0; c < 20; c++) {
            await new Promise((r) => setTimeout(r, 500));
            const bal = await this.getTokenBalance(mintAddress);
            if (bal && bal.uiAmount > prevAmount) { received = bal.uiAmount - prevAmount; break; }
          }
          if (received === 0) throw new Error(`Token bakiyesi 0 (sig: ${swapSignature!.slice(0, 16)}...)`);
          return { sig: swapSignature!, tokensReceived: received };
        }, `AdditionalBuy/Jupiter ${symbol}`, 2);
        swapSignature = result.sig;
        tokensReceived = result.tokensReceived;
      }

      console.log(`✅ [AdditionalBuy] ${symbol} ek alım tamam: ${tokensReceived} token | tx: ${swapSignature!.slice(0, 16)}...`);
      return { tokensReceived, txSignature: swapSignature! };
    } catch (err) {
      console.error(`❌ [AdditionalBuy] ${symbol} ek alım hatası:`, (err as Error).message);
      return null;
    } finally {
      this.inFlight.delete(`addl-buy:${positionId}`);
    }
  }

  // ========== SATIŞ (Jupiter veya PumpSwap) ==========
  // Satış başarısız olursa status "open" kalır, exponential backoff ile tekrar denenir.
  // MAX_SELL_RETRIES aşılırsa "failed" olarak işaretlenir.
  // Bakiye sıfırsa (rug pull) → "closed" pnlPct:-100. Başarılıysa → "closed".
  async sell(positionId: string, _retryCount = 0): Promise<Position | null> {
    const pos = this.store.getById(positionId);
    if (!pos) { console.warn(`⚠️ Pozisyon bulunamadı: ${positionId}`); return null; }
    if (!["open", "pending_sell"].includes(pos.status)) { console.warn(`⚠️ Satışa uygun değil (${pos.status}): ${pos.symbol}`); return pos; }
    if (!this.isReady()) { console.error("❌ Cüzdan hazır değil — satış atlandı"); return null; }
    if (this.inFlight.has(`sell:${pos.id}`)) return pos;
    this.inFlight.add(`sell:${pos.id}`);

    // Bakiye izleme interval'ini durdur — satış başladı
    const existingInterval = this.balanceCheckIntervals.get(pos.id);
    if (existingInterval) {
      clearInterval(existingInterval);
      this.balanceCheckIntervals.delete(pos.id);
    }

    const config = this.store.getConfig();
    let updated: Position = { ...pos, status: "pending_sell", error: undefined };
    this.updateAndEmit(updated);
    const dexLabel = pos.dex === "pumpswap" ? "PumpSwap" : "Jupiter";
    console.log(`💸 [${dexLabel}] SATIŞ başlatılıyor: ${pos.symbol}`);

    const slippagePct = Math.floor(config.slippageBps / 100);
    // Birim dönüşümü: micro-lamport → SOL (1 SOL = 10^9 lamports, 1 lamport = 10^6 micro-lamports → 1 SOL = 10^15 micro-lamports, ama API SOL bekler: / 10^9)
    const priorityFeeSol = config.priorityFeeManualMicroLamports / 1_000_000_000;

    // Bakiye kontrolü — sıfırsa RUG_PULL fırlatır
    const fetchBalance = async (): Promise<{ uiAmount: number; raw: string; decimals: number }> => {
      const bal = await this.getTokenBalance(pos.mintAddress);
      if (bal && bal.uiAmount > 0) return bal;
      throw new Error(`RUG_PULL: Cüzdanda ${pos.symbol} bakiyesi bulunamadı`);
    };

    // Satış öncesi bakiye kontrolü — rug pull erken tespiti (3 retry)
    try {
      let preBal = await this.getTokenBalance(pos.mintAddress);
      if (!preBal || preBal.uiAmount <= 0) {
        // RPC timeout / network hatası olabilir — 3 kez daha dene
        let retryCount = 0;
        while (retryCount < 3 && (!preBal || preBal.uiAmount <= 0)) {
          await new Promise((r) => setTimeout(r, 500));
          preBal = await this.getTokenBalance(pos.mintAddress);
          retryCount++;
          console.warn(`⚠️ [Rug Pull Kontrol] ${pos.symbol} bakiye sıfır — yeniden deneniyor (${retryCount}/3)...`);
        }
        // 3 deneme sonrası hala bakiye yoksa rug pull olarak kapat
        if (!preBal || preBal.uiAmount <= 0) {
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
          console.error(`🚨 [Rug Pull] ${pos.symbol} — 3 denemede bakiye sıfır, -%100 zarar olarak kapatıldı`);
          return updated;
        }
      }
    } catch {
      // Bakiye okunamazsa satışa devam et
    }

    try {
      if (pos.dex === "pumpswap") {
        // PumpSwap satışı — 3 deneme, exponential backoff
        const result = await this.withRetry(async () => {
          const balance = await fetchBalance();
          console.log(`🔍 [PumpSwap] Satılacak: ${balance.uiAmount.toLocaleString()} ${pos.symbol}`);
          const sig = await this.pumpSwapTx({
            action: "sell",
            mint: pos.mintAddress,
            amount: balance.uiAmount,
            denominatedInSol: false,
            slippagePct,
            priorityFeeSol,
            confirmForeground: true,
          });
          return { sig, tokenAmount: balance.uiAmount };
        }, `PumpSwap Sell ${pos.symbol}`);

        // [YENİ] Satış TX sonrası token bakiyesi kontrol (2 deneme, 1 saniye ara)
        // TX gönderildi ama swap başarısız olmuş olabilir — bakiye hala varsa tekrar sat
        let tokenRemaining = 0;
        for (let c = 0; c < 2; c++) {
          await new Promise((r) => setTimeout(r, 1000));
          const bal = await this.getTokenBalance(pos.mintAddress);
          if (bal && bal.uiAmount > 0) {
            tokenRemaining = bal.uiAmount;
            break;
          }
        }
        if (tokenRemaining > 0) {
          if (_retryCount >= MAX_SELL_RETRIES) {
            throw new Error(`FINAL: ${MAX_SELL_RETRIES} deneme sonrası token hala var (${tokenRemaining.toLocaleString()})`);
          }
          // Position status'unu "open" olarak geri set et — satış tekrar çağrılmadan önce
          const reopened: Position = { ...updated, status: "open", error: undefined };
          this.updateAndEmit(reopened);
          console.warn(`⚠️ [PumpSwap] Token hala var (${tokenRemaining.toLocaleString()}), tekrar satış çağrılıyor... [${_retryCount + 1}/${MAX_SELL_RETRIES}]`);
          return this.sell(positionId, _retryCount + 1);
        }

        const estimatedSolOut = await this.estimateSolValue(pos.mintAddress, result.tokenAmount);
        const pnlSol = estimatedSolOut - (pos.buySolAmount ?? 0);
        const pnlPct = (pos.buySolAmount ?? 0) > 0 ? (pnlSol / pos.buySolAmount!) * 100 : 0;
        const sellPriceSol = result.tokenAmount > 0 ? estimatedSolOut / result.tokenAmount : 0;

        updated = {
          ...updated,
          status: "closed",
          sellTimestamp: Date.now(),
          sellSolAmount: estimatedSolOut,
          sellPriceSol,
          sellTxSignature: result.sig,
          pnlSol,
          pnlPct,
        };
        this.updateAndEmit(updated);
        console.log(`✅ [PumpSwap] SATIŞ tamam: ${pos.symbol} | ~${estimatedSolOut.toFixed(4)} SOL (tahmini) | PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) | tx ${result.sig.slice(0, 16)}...`);
      } else {
        // Jupiter satışı — başarısız olursa direkt hata fırlat (PumpSwap fallback yok)
        const result = await this.withRetry(async () => {
          const balance = await fetchBalance();
          if (BigInt(balance.raw) === 0n) throw new Error("Cüzdanda token bakiyesi yok");
          const quote = await this.getQuote({ inputMint: pos.mintAddress, outputMint: SOL_MINT, amount: balance.raw, slippageBps: config.slippageBps });
          const solOut = Number(quote.outAmount) / 1e9;
          const sellPriceSol = balance.uiAmount > 0 ? solOut / balance.uiAmount : 0;
          const sig = await this.swap(quote, config.priorityFeeManualMicroLamports, true);
          return { sig, solOut, sellPriceSol, tokenAmount: balance.uiAmount };
        }, `Jupiter Sell ${pos.symbol}`);

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

        // Satış TX sonrası token bakiyesi kontrol (2 deneme, 1 saniye ara)
        // TX gönderildi ama swap başarısız olmuş olabilir — bakiye hala varsa tekrar sat
        let tokenRemainingJup = 0;
        for (let c = 0; c < 2; c++) {
          await new Promise((r) => setTimeout(r, 1000));
          const bal = await this.getTokenBalance(pos.mintAddress);
          if (bal && bal.uiAmount > 0) {
            tokenRemainingJup = bal.uiAmount;
            break;
          }
        }
        if (tokenRemainingJup > 0) {
          if (_retryCount >= MAX_SELL_RETRIES) {
            throw new Error(`FINAL: ${MAX_SELL_RETRIES} deneme sonrası token hala var (${tokenRemainingJup.toLocaleString()})`);
          }
          // Position status'unu "open" olarak geri set et — satış tekrar çağrılmadan önce
          const reopened: Position = { ...updated, status: "open", error: undefined };
          this.updateAndEmit(reopened);
          console.warn(`⚠️ [Jupiter] Token hala var (${tokenRemainingJup.toLocaleString()}), tekrar satış çağrılıyor... [${_retryCount + 1}/${MAX_SELL_RETRIES}]`);
          return this.sell(positionId, _retryCount + 1);
        }
      }
      return updated;
    } catch (err) {
      const message = (err as Error).message || String(err);

      // Rug pull tespiti
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

      // 3 başarısız satış denemesinden sonra rug pull olarak kapat
      if (_retryCount >= MAX_SELL_RETRIES) {
        const rugPullLoss = -(pos.buySolAmount ?? 0);
        updated = {
          ...pos,
          status: "closed",
          sellTimestamp: Date.now(),
          sellSolAmount: 0,
          sellPriceSol: 0,
          pnlSol: rugPullLoss,
          pnlPct: -100,
          error: "Failed to sell after 3 attempts",
        };
        this.updateAndEmit(updated);
        console.error(`🚨 [${dexLabel}] SATIŞ 3 denemede başarısız — rug pull olarak kapatıldı: ${pos.symbol}`);
        this.emit("rug_pull_detected", {
          positionId: pos.id,
          mintAddress: pos.mintAddress,
          symbol: pos.symbol,
          reason: "Failed to sell after 3 attempts",
        });
        return updated;
      }

      // [DÜZELTİLDİ] Exponential backoff: 1s, 2s, 4s, 4s... (MAX_BACKOFF_MS'e kadar)
      const retryDelay = Math.min(1000 * Math.pow(2, _retryCount), MAX_BACKOFF_MS);
      updated = { ...pos, status: "open", error: message };
      this.updateAndEmit(updated);
      console.warn(`⚠️ [${dexLabel}] SATIŞ başarısız (${pos.symbol}) [${_retryCount + 1}/${MAX_SELL_RETRIES + 1}]: ${message} — ${retryDelay}ms sonra tekrar...`);
      setTimeout(() => this.sell(positionId, _retryCount + 1), retryDelay);
      return updated;
    } finally {
      // [DÜZELTİLDİ] inFlight temizliği sadece finally'de — catch içinde tekrar silmeye gerek yok
      this.inFlight.delete(`sell:${pos.id}`);
    }
  }

  // ========== YARI SATIŞ ==========
  // Pozisyonun token bakiyesinin yarısını satar. Kalan yarısı pozisyonda kalır (status "open").
  // MAX_SELL_RETRIES aşılırsa "failed" olarak işaretlenir.
  async sellHalf(positionId: string, _retryCount = 0): Promise<Position | null> {
    const pos = this.store.getById(positionId);
    if (!pos) { console.warn(`⚠️ Pozisyon bulunamadı: ${positionId}`); return null; }
    if (pos.status !== "open") { console.warn(`⚠️ Yarı satış için pozisyon açık olmalı (${pos.status}): ${pos.symbol}`); return pos; }
    if (!this.isReady()) { console.error("❌ Cüzdan hazır değil — yarı satış atlandı"); return null; }
    if (this.inFlight.has(`sell:${pos.id}`)) return pos;
    this.inFlight.add(`sell:${pos.id}`);

    // Bakiye izleme interval'ini geçici olarak durdur — yarı satış sırasında çakışma önlenir
    const existingHalfInterval = this.balanceCheckIntervals.get(pos.id);
    if (existingHalfInterval) {
      clearInterval(existingHalfInterval);
      this.balanceCheckIntervals.delete(pos.id);
    }

    const config = this.store.getConfig();
    const dexLabel = pos.dex === "pumpswap" ? "PumpSwap" : "Jupiter";
    console.log(`💸 [${dexLabel}] YARI SATIŞ başlatılıyor: ${pos.symbol}`);

    const slippagePct = Math.floor(config.slippageBps / 100);
    // Birim dönüşümü: micro-lamport → SOL (1 SOL = 10^9 lamports, 1 lamport = 10^6 micro-lamports → 1 SOL = 10^15 micro-lamports, ama API SOL bekler: / 10^9)
    const priorityFeeSol = config.priorityFeeManualMicroLamports / 1_000_000_000;

    // Bakiye kontrolü — sıfırsa RUG_PULL fırlatır
    const fetchBalance = async (): Promise<{ uiAmount: number; raw: string; decimals: number }> => {
      const bal = await this.getTokenBalance(pos.mintAddress);
      if (bal && bal.uiAmount > 0) return bal;
      throw new Error(`RUG_PULL: Cüzdanda ${pos.symbol} bakiyesi bulunamadı`);
    };

    // Satış öncesi bakiye kontrolü — rug pull erken tespiti (3 retry)
    try {
      let preBal = await this.getTokenBalance(pos.mintAddress);
      if (!preBal || preBal.uiAmount <= 0) {
        // RPC timeout / network hatası olabilir — 3 kez daha dene
        let retryCount = 0;
        while (retryCount < 3 && (!preBal || preBal.uiAmount <= 0)) {
          await new Promise((r) => setTimeout(r, 500));
          preBal = await this.getTokenBalance(pos.mintAddress);
          retryCount++;
          console.warn(`⚠️ [Rug Pull Kontrol] ${pos.symbol} bakiye sıfır — yeniden deneniyor (${retryCount}/3)...`);
        }
        // 3 deneme sonrası hala bakiye yoksa rug pull olarak kapat
        if (!preBal || preBal.uiAmount <= 0) {
          const rugPullLoss = -(pos.buySolAmount ?? 0);
          const updated: Position = {
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
          console.error(`🚨 [Rug Pull] ${pos.symbol} — 3 denemede bakiye sıfır, -%100 zarar olarak kapatıldı`);
          return updated;
        }
      }
    } catch {
      // Bakiye okunamazsa satışa devam et
    }

    try {
      let updated: Position;

      if (pos.dex === "pumpswap") {
        // PumpSwap yarı satışı — 3 deneme, exponential backoff
        const result = await this.withRetry(async () => {
          const balance = await fetchBalance();
          const halfAmount = balance.uiAmount / 2;
          console.log(`🔍 [PumpSwap] Yarısı satılacak: ${halfAmount.toLocaleString()} ${pos.symbol} (toplam: ${balance.uiAmount.toLocaleString()})`);
          const sig = await this.pumpSwapTx({
            action: "sell",
            mint: pos.mintAddress,
            amount: halfAmount,
            denominatedInSol: false,
            slippagePct,
            priorityFeeSol,
            confirmForeground: true,
          });
          return { sig, halfAmount };
        }, `PumpSwap HalfSell ${pos.symbol}`);

        const estimatedSolOut = await this.estimateSolValue(pos.mintAddress, result.halfAmount);
        const remainingAmount = (pos.buyTokenAmount ?? 0) / 2;
        const halfBuyCost = (pos.buySolAmount ?? 0) / 2;
        const pnlSol = estimatedSolOut - halfBuyCost;
        const pnlPct = halfBuyCost > 0 ? (pnlSol / halfBuyCost) * 100 : 0;
        updated = {
          ...pos,
          status: "open",
          buyTokenAmount: remainingAmount,
          sellTxSignature: result.sig,
          pnlSol,
          pnlPct,
        };
        this.updateAndEmit(updated);
        console.log(`✅ [PumpSwap] YARI SATIŞ tamam: ${pos.symbol} | ${result.halfAmount.toLocaleString()} token → ~${estimatedSolOut.toFixed(4)} SOL (tahmini) | PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) | tx ${result.sig.slice(0, 16)}...`);

        // [YENİ] Yarı satış TX sonrası token bakiyesi kontrol (2 deneme, 1 saniye ara)
        // Gerçek kalan bakiyeyi oku — TX başarısız olduysa hala yarıdan fazla token olabilir
        let halfTokenRemaining = 0;
        for (let c = 0; c < 2; c++) {
          await new Promise((r) => setTimeout(r, 1000));
          const bal = await this.getTokenBalance(pos.mintAddress);
          if (bal && bal.uiAmount > 0) {
            halfTokenRemaining = bal.uiAmount;
            break;
          }
        }
        // Beklenen kalan miktardan fazlası varsa TX başarısız olmuş demektir — tekrar sat
        const expectedRemaining = (pos.buyTokenAmount ?? 0) / 2;
        if (halfTokenRemaining > expectedRemaining * 1.05) {
          if (_retryCount >= MAX_SELL_RETRIES) {
            throw new Error(`FINAL: ${MAX_SELL_RETRIES} deneme sonrası token hala var (${halfTokenRemaining.toLocaleString()})`);
          }
          // Position status'unu "open" olarak geri set et — yarı satış tekrar çağrılmadan önce
          const reopened: Position = { ...updated, status: "open", error: undefined };
          this.updateAndEmit(reopened);
          console.warn(`⚠️ [PumpSwap] Yarı satış sonrası token fazla (${halfTokenRemaining.toLocaleString()} > beklenen ~${expectedRemaining.toLocaleString()}), tekrar çağrılıyor... [${_retryCount + 1}/${MAX_SELL_RETRIES}]`);
          return this.sellHalf(positionId, _retryCount + 1);
        }
      } else {
        // Jupiter yarı satışı — route yoksa PumpSwap'a fallback
        let jupiterOk = false;
        try {
          const result = await this.withRetry(async () => {
            const balance = await fetchBalance();
            const halfRaw = (BigInt(balance.raw) / 2n).toString();
            if (BigInt(halfRaw) === 0n) throw new Error("Yarı bakiye sıfır");
            const quote = await this.getQuote({ inputMint: pos.mintAddress, outputMint: SOL_MINT, amount: halfRaw, slippageBps: config.slippageBps });
            const solOut = Number(quote.outAmount) / 1e9;
            const halfUiAmount = balance.uiAmount / 2;
            const sellPriceSol = halfUiAmount > 0 ? solOut / halfUiAmount : 0;
            const sig = await this.swap(quote, config.priorityFeeManualMicroLamports, true);
            return { sig, solOut, sellPriceSol, halfUiAmount };
          }, `Jupiter HalfSell ${pos.symbol}`);

          jupiterOk = true;
          const remainingAmount = (pos.buyTokenAmount ?? 0) / 2;
          const halfBuyCost = (pos.buySolAmount ?? 0) / 2;
          const pnlSol = result.solOut - halfBuyCost;
          const pnlPct = halfBuyCost > 0 ? (pnlSol / halfBuyCost) * 100 : 0;
          updated = {
            ...pos,
            status: "open",
            buyTokenAmount: remainingAmount,
            sellTxSignature: result.sig,
            pnlSol,
            pnlPct,
          };
          this.updateAndEmit(updated);
          console.log(`✅ [Jupiter] YARI SATIŞ tamam: ${pos.symbol} | ${result.halfUiAmount.toFixed(4)} token → ${result.solOut.toFixed(4)} SOL | PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) | tx ${result.sig.slice(0, 16)}...`);

          // [YENİ] Yarı satış TX sonrası token bakiyesi kontrol (2 deneme, 1 saniye ara)
          // Gerçek kalan bakiyeyi oku — TX başarısız olduysa hala yarıdan fazla token olabilir
          let halfTokenRemainingJup = 0;
          for (let c = 0; c < 2; c++) {
            await new Promise((r) => setTimeout(r, 1000));
            const bal = await this.getTokenBalance(pos.mintAddress);
            if (bal && bal.uiAmount > 0) {
              halfTokenRemainingJup = bal.uiAmount;
              break;
            }
          }
          // Beklenen kalan miktardan fazlası varsa TX başarısız olmuş demektir — tekrar sat
          const expectedRemainingJup = (pos.buyTokenAmount ?? 0) / 2;
          if (halfTokenRemainingJup > expectedRemainingJup * 1.05) {
            if (_retryCount >= MAX_SELL_RETRIES) {
              throw new Error(`FINAL: ${MAX_SELL_RETRIES} deneme sonrası token hala var (${halfTokenRemainingJup.toLocaleString()})`);
            }
            // Position status'unu "open" olarak geri set et — yarı satış tekrar çağrılmadan önce
            const reopened: Position = { ...updated, status: "open", error: undefined };
            this.updateAndEmit(reopened);
            console.warn(`⚠️ [Jupiter] Yarı satış sonrası token fazla (${halfTokenRemainingJup.toLocaleString()} > beklenen ~${expectedRemainingJup.toLocaleString()}), tekrar çağrılıyor... [${_retryCount + 1}/${MAX_SELL_RETRIES}]`);
            return this.sellHalf(positionId, _retryCount + 1);
          }
        } catch (jupErr) {
          if (jupiterOk) throw jupErr;
          // Jupiter route yok → PumpSwap fallback dene
          console.warn(`⚠️ [Jupiter] YARI SATIŞ başarısız, PumpSwap'a geçiliyor: ${(jupErr as Error).message}`);
          const result = await this.withRetry(async () => {
            const balance = await fetchBalance();
            const halfAmount = balance.uiAmount / 2;
            console.log(`🔍 [PumpSwap Fallback] Yarısı satılacak: ${halfAmount.toLocaleString()} ${pos.symbol}`);
            const sig = await this.pumpSwapTx({ action: "sell", mint: pos.mintAddress, amount: halfAmount, denominatedInSol: false, slippagePct, priorityFeeSol, confirmForeground: true });
            return { sig, halfAmount };
          }, `PumpSwap Fallback HalfSell ${pos.symbol}`);

          const estimatedSolOut = await this.estimateSolValue(pos.mintAddress, result.halfAmount);
          const remainingAmount = (pos.buyTokenAmount ?? 0) / 2;
          const halfBuyCost = (pos.buySolAmount ?? 0) / 2;
          const pnlSol = estimatedSolOut - halfBuyCost;
          const pnlPct = halfBuyCost > 0 ? (pnlSol / halfBuyCost) * 100 : 0;
          updated = {
            ...pos,
            status: "open",
            buyTokenAmount: remainingAmount,
            sellTxSignature: result.sig,
            pnlSol,
            pnlPct,
          };
          this.updateAndEmit(updated);
          console.log(`✅ [PumpSwap Fallback] YARI SATIŞ tamam: ${pos.symbol} | ~${estimatedSolOut.toFixed(4)} SOL (tahmini) | PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) | tx ${result.sig.slice(0, 16)}...`);

          // [YENİ] Yarı satış TX sonrası token bakiyesi kontrol (2 deneme, 1 saniye ara)
          // Gerçek kalan bakiyeyi oku — TX başarısız olduysa hala yarıdan fazla token olabilir
          let halfTokenRemainingFallback = 0;
          for (let c = 0; c < 2; c++) {
            await new Promise((r) => setTimeout(r, 1000));
            const bal = await this.getTokenBalance(pos.mintAddress);
            if (bal && bal.uiAmount > 0) {
              halfTokenRemainingFallback = bal.uiAmount;
              break;
            }
          }
          // Beklenen kalan miktardan fazlası varsa TX başarısız olmuş demektir — tekrar sat
          const expectedRemainingFallback = (pos.buyTokenAmount ?? 0) / 2;
          if (halfTokenRemainingFallback > expectedRemainingFallback * 1.05) {
            if (_retryCount >= MAX_SELL_RETRIES) {
              throw new Error(`FINAL: ${MAX_SELL_RETRIES} deneme sonrası token hala var (${halfTokenRemainingFallback.toLocaleString()})`);
            }
            // Position status'unu "open" olarak geri set et — yarı satış tekrar çağrılmadan önce
            const reopened: Position = { ...updated, status: "open", error: undefined };
            this.updateAndEmit(reopened);
            console.warn(`⚠️ [PumpSwap Fallback] Yarı satış sonrası token fazla (${halfTokenRemainingFallback.toLocaleString()} > beklenen ~${expectedRemainingFallback.toLocaleString()}), tekrar çağrılıyor... [${_retryCount + 1}/${MAX_SELL_RETRIES}]`);
            return this.sellHalf(positionId, _retryCount + 1);
          }
        }
      }

      return updated!;
    } catch (err) {
      const message = (err as Error).message || String(err);

      // Rug pull tespiti
      if (message.includes("RUG_PULL")) {
        const rugPullLoss = -(pos.buySolAmount ?? 0);
        const updated: Position = {
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

      // Maksimum retry aşıldı
      if (_retryCount >= MAX_SELL_RETRIES) {
        const failedPos: Position = { ...pos, status: "failed", error: `${MAX_SELL_RETRIES} deneme sonrası yarı satış başarısız: ${message}` };
        this.updateAndEmit(failedPos);
        console.error(`❌ [${dexLabel}] YARI SATIŞ ${MAX_SELL_RETRIES} denemede başarısız, "failed": ${pos.symbol}`);
        return failedPos;
      }

      // [DÜZELTİLDİ] Exponential backoff: 1s, 2s, 4s, 4s... (MAX_BACKOFF_MS'e kadar)
      const retryDelay = Math.min(1000 * Math.pow(2, _retryCount), MAX_BACKOFF_MS);
      const failedPos: Position = { ...pos, status: "open", error: message };
      this.updateAndEmit(failedPos);
      console.warn(`⚠️ [${dexLabel}] YARI SATIŞ başarısız (${pos.symbol}) [${_retryCount + 1}/${MAX_SELL_RETRIES}]: ${message} — ${retryDelay}ms sonra tekrar...`);
      setTimeout(() => this.sellHalf(positionId, _retryCount + 1), retryDelay);
      return failedPos;
    } finally {
      // [DÜZELTİLDİ] inFlight temizliği sadece finally'de — catch içinde tekrar silmeye gerek yok
      this.inFlight.delete(`sell:${pos.id}`);
    }
  }

  updateConfig(partial: Partial<TradeConfig>): TradeConfig {
    const cfg = this.store.updateConfig(partial);
    this.emit("trade_config_update", cfg);
    return cfg;
  }

  /**
   * Helius monitor'dan gelen pool SOL miktarını günceller.
   * Rug check interval'inde pool liquidity kontrolü için kullanılır.
   */
  setPoolSol(mintAddress: string, poolSol: number) {
    this.poolSolCache.set(mintAddress, poolSol);
  }
}
