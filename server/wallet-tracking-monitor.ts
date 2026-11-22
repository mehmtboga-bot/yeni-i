import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { secrets } from "./secrets-loader";
import type {
  WalletMintBuyStatus,
  WalletMintEvent,
  WalletTrackingState,
} from "@shared/wallet-tracking";

type EventEmitter = (event: string, data: unknown) => void;

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "wallet-tracking.json");
const POLL_INTERVAL_MS = 3_000;
const MAX_TOKENS = 100;

export class WalletTrackingMonitor {
  private readonly emit: EventEmitter;
  private walletAddress = "";
  private isWatching = false;
  private autoBuyRunning = false;
  private autoBuyGeneration = 0;
  private lastSeenSignature: string | undefined;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private tokens: WalletMintEvent[] = [];

  constructor(emit: EventEmitter) {
    this.emit = emit;
    this.loadConfig();
  }

  private loadConfig() {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return;
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as { walletAddress?: unknown };
      if (typeof saved.walletAddress === "string") {
        this.walletAddress = new PublicKey(saved.walletAddress).toBase58();
      }
    } catch (error) {
      console.error("Cüzdan takibi ayarları yüklenemedi:", error);
    }
  }

  private saveConfig() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ walletAddress: this.walletAddress }, null, 2), "utf-8");
  }

  getState(): WalletTrackingState {
    return {
      walletAddress: this.walletAddress,
      isWatching: this.isWatching,
      autoBuyRunning: this.autoBuyRunning,
      tokens: this.tokens.map((token) => ({ ...token })),
    };
  }

  getAutoBuyGeneration() {
    return this.autoBuyGeneration;
  }

  isAutoBuyGenerationActive(generation: number) {
    return this.autoBuyRunning && generation === this.autoBuyGeneration;
  }

  private emitState() {
    this.emit("wallet_tracking_state", this.getState());
  }

  saveWalletAddress(address: string) {
    if (this.isWatching) throw new Error("Cüzdan adresini değiştirmek için önce izlemeyi durdurun.");
    const trimmed = address.trim();
    if (!trimmed) throw new Error("Cüzdan adresi gerekli.");
    this.walletAddress = new PublicKey(trimmed).toBase58();
    this.saveConfig();
    this.emitState();
    return this.getState();
  }

  async startWatching() {
    if (!this.walletAddress) throw new Error("Önce bir cüzdan adresi kaydedin.");
    if (this.isWatching) return this.getState();

    const signatures = await this.rpc<Array<{ signature: string }>>("getSignaturesForAddress", [
      this.walletAddress,
      { limit: 1, commitment: "confirmed" },
    ]);
    this.lastSeenSignature = signatures[0]?.signature;
    this.isWatching = true;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    this.emitState();
    return this.getState();
  }

  stopWatching() {
    this.isWatching = false;
    this.setAutoBuyRunning(false);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.emitState();
    return this.getState();
  }

  setAutoBuyRunning(enabled: boolean) {
    if (enabled && !this.isWatching) {
      throw new Error("Otomatik alımı başlatmak için önce cüzdanı izlemeye başlayın.");
    }
    this.autoBuyGeneration++;
    this.autoBuyRunning = enabled;
    if (!enabled) {
      for (const token of this.tokens) {
        if (token.autoBuyStatus === "waiting") {
          token.autoBuyStatus = "watch_only";
          token.autoBuyMessage = "Otomatik alım durduruldu.";
          this.emit("wallet_mint_updated", { ...token });
        }
      }
    }
    this.emitState();
    return this.getState();
  }

  updateAutoBuyStatus(
    mintAddress: string,
    status: WalletMintBuyStatus,
    message?: string,
  ) {
    const token = this.tokens.find((item) => item.mintAddress === mintAddress);
    if (!token) return;
    token.autoBuyStatus = status;
    token.autoBuyMessage = message;
    this.emit("wallet_mint_updated", { ...token });
  }

  async refreshLiquidity(mintAddress: string): Promise<number | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mintAddress)}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`DexScreener yanıtı: ${response.status}`);
      const result = await response.json() as { pairs?: Array<{ chainId?: string; liquidity?: { usd?: number } }> };
      const liquidity = result.pairs
        ?.filter((pair) => pair.chainId === "solana")
        .reduce((max, pair) => Math.max(max, pair.liquidity?.usd ?? 0), 0);
      const token = this.tokens.find((item) => item.mintAddress === mintAddress);
      if (token && liquidity && liquidity > 0) {
        token.liquidityUsd = liquidity;
        this.emit("wallet_mint_updated", { ...token });
      }
      return liquidity && liquidity > 0 ? liquidity : undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const url = `https://mainnet.helius-rpc.com/?api-key=${secrets.HELIUS_API_KEY}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    if (!response.ok) throw new Error(`Helius RPC ${method} yanıtı: ${response.status}`);
    const body = await response.json() as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`Helius RPC ${method}: ${body.error.message ?? "Bilinmeyen hata"}`);
    return body.result as T;
  }

  private async poll() {
    if (!this.isWatching || this.polling || !this.walletAddress) return;
    this.polling = true;
    try {
      const signatures = await this.rpc<Array<{ signature: string }>>("getSignaturesForAddress", [
        this.walletAddress,
        { limit: 25, until: this.lastSeenSignature, commitment: "confirmed" },
      ]);
      if (signatures.length === 0) return;

      let allTransactionsLoaded = true;
      for (const { signature } of signatures.slice().reverse()) {
        if (!this.isWatching) return;
        const transaction = await this.rpc<any>("getTransaction", [
          signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ]);
        if (!transaction) {
          allTransactionsLoaded = false;
          continue;
        }
        await this.processTransaction(signature, transaction);
      }

      if (allTransactionsLoaded) this.lastSeenSignature = signatures[0].signature;
    } catch (error) {
      console.error("İzlenen cüzdan işlemleri alınamadı:", error);
    } finally {
      this.polling = false;
    }
  }

  private async processTransaction(signature: string, transaction: any) {
    const message = transaction.transaction?.message;
    const instructions = [
      ...(message?.instructions ?? []),
      ...(transaction.meta?.innerInstructions ?? []).flatMap((item: any) => item.instructions ?? []),
    ];
    const accountKeys = message?.accountKeys ?? [];
    const walletSigned = accountKeys.some((key: any) =>
      (key.pubkey?.toString?.() ?? String(key.pubkey ?? key)) === this.walletAddress && key.signer === true,
    );
    const mintInstructions = instructions.filter((instruction: any) => {
      const type = instruction.parsed?.type;
      const info = instruction.parsed?.info;
      return (
        (instruction.program === "spl-token" || instruction.program === "spl-token-2022") &&
        (type === "initializeMint" || type === "initializeMint2") &&
        typeof info?.mint === "string" &&
        (info.mintAuthority === this.walletAddress || walletSigned)
      );
    });

    for (const instruction of mintInstructions) {
      const mintAddress = instruction.parsed.info.mint as string;
      if (this.tokens.some((token) => token.mintAddress === mintAddress)) continue;
      const metadata = await this.getMetadata(mintAddress);
      const detectedAt = transaction.blockTime ? transaction.blockTime * 1000 : Date.now();
      const token: WalletMintEvent = {
        id: `${signature}-${mintAddress}`,
        mintAddress,
        name: metadata.name,
        symbol: metadata.symbol,
        creator: this.walletAddress,
        detectedAt,
        jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
        pumpfunUrl: `https://pump.fun/${mintAddress}`,
        autoBuyStatus: this.autoBuyRunning ? "waiting" : "watch_only",
      };
      this.tokens.unshift(token);
      if (this.tokens.length > MAX_TOKENS) this.tokens.length = MAX_TOKENS;
      try {
        token.liquidityUsd = await this.refreshLiquidity(mintAddress);
      } catch (error) {
        console.warn(`Likidite bilgisi alınamadı (${mintAddress}):`, error);
      }
      this.emit("wallet_mint_detected", { ...token });
    }
  }

  private async getMetadata(mintAddress: string): Promise<{ name: string; symbol: string }> {
    try {
      const asset = await this.rpc<any>("getAsset", { id: mintAddress });
      return {
        name: asset?.content?.metadata?.name || "Bilinmeyen Token",
        symbol: asset?.content?.metadata?.symbol || "?",
      };
    } catch (error) {
      console.warn(`Token bilgisi alınamadı (${mintAddress}):`, error);
      return { name: "Bilinmeyen Token", symbol: "?" };
    }
  }
}
