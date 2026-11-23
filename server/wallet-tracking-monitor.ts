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
const POLL_INTERVAL_MS = 3_000;
const TOKEN_TTL_MS = 4 * 60 * 1_000;
const TOKEN_EXPIRY_CHECK_MS = 1_000;
const MAX_TOKENS = 5;

export class WalletTrackingMonitor {
  private readonly emit: EventEmitter;
  private readonly configPath: string;
  private walletAddress = "";
  private isWatching = false;
  private autoBuyRunning = false;
  private autoBuyGeneration = 0;
  private lastSeenSignature: string | undefined;
  private pollTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout;
  private polling = false;
  private tokens: WalletMintEvent[] = [];

  constructor(emit: EventEmitter, slot = 0) {
    this.emit = emit;
    this.configPath = path.join(DATA_DIR, slot === 0 ? "wallet-tracking.json" : `wallet-tracking-${slot + 1}.json`);
    this.loadConfig();
    this.expiryTimer = setInterval(() => this.pruneExpiredTokens(), TOKEN_EXPIRY_CHECK_MS);
    this.expiryTimer.unref?.();
  }

  stop() {
    this.stopWatching();
    clearInterval(this.expiryTimer);
  }

  private pruneExpiredTokens() {
    const now = Date.now();
    const retainedTokens = this.tokens.filter((token) => token.expiresAt > now);
    if (retainedTokens.length === this.tokens.length) return;
    this.tokens = retainedTokens;
    this.emitState();
  }

  private loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) return;
      const saved = JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as { walletAddress?: unknown };
      if (typeof saved.walletAddress === "string") {
        this.walletAddress = new PublicKey(saved.walletAddress).toBase58();
      }
    } catch (error) {
      console.error("Cüzdan takibi ayarları yüklenemedi:", error);
    }
  }

  private saveConfig() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify({ walletAddress: this.walletAddress }, null, 2), "utf-8");
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

  removeToken(mintAddress: string) {
    const tokenIndex = this.tokens.findIndex((token) => token.mintAddress === mintAddress);
    if (tokenIndex < 0) return;
    this.tokens.splice(tokenIndex, 1);
    this.emitState();
  }

  clearTokens() {
    if (this.tokens.length === 0) return;
    this.tokens = [];
    this.emitState();
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

  private async verifySolscanMint(
    mintAddress: string,
    signature: string,
  ): Promise<{ verified: boolean; name?: string; symbol?: string; message: string }> {
    if (!secrets.SOLSCAN_API_KEY) {
      return { verified: false, message: "SOLSCAN_API_KEY yapılandırılmamış." };
    }

    const url = new URL("https://pro-api.solscan.io/v2.0/token/meta");
    url.searchParams.set("address", mintAddress);
    let failureMessage = "Solscan minti doğrulayamadı.";

    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(url, {
          headers: { token: secrets.SOLSCAN_API_KEY },
          signal: controller.signal,
        });
        if (!response.ok) {
          failureMessage = `Solscan yanıtı: ${response.status}`;
          if (response.status === 400 || response.status === 401 || response.status === 403) break;
        } else {
          const result = await response.json() as {
            success?: boolean;
            data?: {
              address?: string;
              create_tx?: string;
              creator?: string;
              mint_authority?: string | null;
              name?: string;
              symbol?: string;
            };
          };
          const tokenData = result.data;
          if (!result.success || !tokenData || tokenData.address !== mintAddress) {
            failureMessage = "Solscan mint adresini doğrulayamadı.";
            break;
          }
          if (tokenData.create_tx !== signature) {
            failureMessage = "Solscan oluşturma işlemi Helius işlemiyle eşleşmedi.";
          } else if (tokenData.creator !== this.walletAddress && tokenData.mint_authority !== this.walletAddress) {
            failureMessage = "Solscan token yaratıcısını izlenen cüzdanla eşleştiremedi.";
          } else {
            return {
              verified: true,
              name: tokenData.name,
              symbol: tokenData.symbol,
              message: "Mint adresi ve oluşturma işlemi Solscan ile doğrulandı.",
            };
          }
        }
      } catch (error) {
        failureMessage = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    console.warn(`Solscan mint doğrulaması başarısız (${mintAddress}):`, failureMessage);
    return { verified: false, message: failureMessage };
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
    if (transaction.meta?.err) return;
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
      const [metadata, solscan] = await Promise.all([
        this.getMetadata(mintAddress),
        this.verifySolscanMint(mintAddress, signature),
      ]);
      const name = solscan.name || metadata.name;
      const symbol = solscan.symbol || metadata.symbol;
      const unknownName = !name || /^(unknown|bilinmeyen token)$/i.test(name.trim());
      const unknownSymbol = !symbol || symbol.trim() === "?" || /^unknown$/i.test(symbol.trim());
      if (unknownName || unknownSymbol) {
        console.warn(`Bilinmeyen token atlandı (${mintAddress}).`);
        return;
      }
      const detectedAt = transaction.blockTime ? transaction.blockTime * 1000 : Date.now();
      const token: WalletMintEvent = {
        id: `${signature}-${mintAddress}`,
        mintAddress,
        name,
        symbol,
        creator: this.walletAddress,
        detectedAt,
        expiresAt: Date.now() + TOKEN_TTL_MS,
        jupiterUrl: `https://jup.ag/swap/SOL-${mintAddress}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${mintAddress}`,
        pumpfunUrl: `https://pump.fun/${mintAddress}`,
        solscanVerified: solscan.verified,
        solscanMessage: solscan.message,
        autoBuyStatus: this.autoBuyRunning
          ? solscan.verified ? "waiting" : "skipped"
          : "watch_only",
        autoBuyMessage: this.autoBuyRunning && !solscan.verified
          ? `Solscan doğrulaması başarısız: ${solscan.message}`
          : undefined,
      };
      this.tokens.unshift(token);
      if (this.tokens.length > MAX_TOKENS) this.tokens.length = MAX_TOKENS;
      try {
        token.liquidityUsd = await this.refreshLiquidity(mintAddress);
      } catch (error) {
        console.warn(`Likidite bilgisi alınamadı (${mintAddress}):`, error);
      }
      this.emit("wallet_mint_detected", { ...token });
      this.emitState();
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
