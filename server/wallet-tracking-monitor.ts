import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { secrets } from "./secrets-loader";
import type { WalletMintEvent } from "@shared/wallet-tracking";

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "wallet-tracking.json");
const RPC_URL = secrets.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${secrets.HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const POLL_MS = 3_000;

interface WalletState { walletAddress: string; running: boolean; startedAt: number | null; tokens: WalletMintEvent[] }

export class WalletTrackingMonitor {
  private state: WalletState = { walletAddress: "", running: false, startedAt: null, tokens: [] };
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private knownSignatures = new Set<string>();
  private processedMints = new Set<string>();

  constructor() {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (typeof saved.walletAddress === "string") this.state.walletAddress = saved.walletAddress;
    } catch { /* first run */ }
  }

  getState() { return { ...this.state, tokens: [...this.state.tokens] }; }

  saveWallet(address: string) {
    let normalized = "";
    try { normalized = new PublicKey(address.trim()).toBase58(); }
    catch { throw new Error("Geçerli bir Solana cüzdan adresi girin"); }
    if (this.state.running && normalized !== this.state.walletAddress) this.stop();
    this.state.walletAddress = normalized;
    this.persist();
    return this.getState();
  }

  async start() {
    if (!this.state.walletAddress) throw new Error("Önce cüzdan adresini kaydedin");
    if (this.state.running) return this.getState();
    this.knownSignatures.clear();
    const baseline = await this.signatures();
    baseline.forEach((item: any) => this.knownSignatures.add(item.signature));
    this.state.running = true;
    this.state.startedAt = Date.now();
    this.persist();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    console.log(`👛 [WalletTracking] İzleme başladı: ${this.state.walletAddress}`);
    return this.getState();
  }

  stop() {
    this.state.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persist();
    console.log("🛑 [WalletTracking] İzleme durduruldu");
    return this.getState();
  }

  private persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ walletAddress: this.state.walletAddress }, null, 2));
  }

  private async rpc(method: string, params: any[]) {
    const response = await fetch(RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    if (!response.ok) throw new Error(`Solana RPC ${response.status}`);
    const json: any = await response.json();
    if (json.error) throw new Error(json.error.message || "Solana RPC error");
    return json.result;
  }

  private signatures() {
    return this.rpc("getSignaturesForAddress", [this.state.walletAddress, { limit: 25, commitment: "confirmed" }]);
  }

  private async poll() {
    if (this.busy || !this.state.running) return;
    this.busy = true;
    try {
      const signatures: any[] = await this.signatures();
      const newItems = signatures.filter((item) => !this.knownSignatures.has(item.signature));
      // Record all observed signatures immediately to avoid duplicate work during slow indexing.
      signatures.forEach((item) => this.knownSignatures.add(item.signature));
      if (this.knownSignatures.size > 1_000) this.knownSignatures = new Set(signatures.map((item) => item.signature));
      for (const item of newItems.reverse()) {
        if (!this.state.running) break;
        if (item.err) continue;
        await this.inspectTransaction(item.signature);
      }
    } catch (error) {
      console.warn("⚠️ [WalletTracking] Poll hatası:", (error as Error).message);
    } finally { this.busy = false; }
  }

  private async inspectTransaction(signature: string) {
    const tx: any = await this.rpc("getTransaction", [signature, {
      encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed",
    }]);
    if (!tx || tx.meta?.err) return;
    const instructions = [
      ...(tx.transaction?.message?.instructions ?? []),
      ...(tx.meta?.innerInstructions ?? []).flatMap((item: any) => item.instructions ?? []),
    ];
    const wallet = this.state.walletAddress;
    const mints = new Set<string>();
    for (const ix of instructions) {
      const parsed = ix?.parsed;
      if (!["initializeMint", "initializeMint2"].includes(parsed?.type)) continue;
      const info = parsed.info ?? {};
      if (info.mintAuthority !== wallet) continue;
      const mint = info.mint;
      if (typeof mint === "string" && mint !== WSOL_MINT) mints.add(mint);
    }
    for (const mint of mints) {
      if (this.processedMints.has(mint)) continue;
      this.processedMints.add(mint);
      await this.addMint(mint, signature);
    }
  }

  private async addMint(mint: string, signature: string) {
    let name = "Bilinmiyor", symbol = "?";
    let liquidityUsd = 0;
    try {
      const response = await fetch(RPC_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "asset", method: "getAsset", params: { id: mint } }),
      });
      const asset: any = await response.json();
      name = asset.result?.content?.metadata?.name || name;
      symbol = asset.result?.content?.metadata?.symbol || symbol;
    } catch { /* metadata is optional */ }
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (response.ok) {
        const data: any = await response.json();
        const pairs: any[] = data.pairs ?? [];
        liquidityUsd = pairs.filter((pair) => pair.chainId === "solana")
          .reduce((max, pair) => Math.max(max, Number(pair.liquidity?.usd) || 0), 0);
      }
    } catch { /* liquidity may not be indexed yet */ }
    const detectedAt = Date.now();
    const event: WalletMintEvent = {
      id: `wallet-${mint}`, mintAddress: mint, name, symbol,
      creator: this.state.walletAddress, detectedAt, expiresAt: detectedAt + 24 * 60 * 60 * 1000,
      liquidityUsd, signature,
      jupiterUrl: `https://jup.ag/swap/SOL-${mint}`,
      dexscreenerUrl: `https://dexscreener.com/solana/${mint}`,
      pumpfunUrl: `https://pump.fun/${mint}`,
    } as WalletMintEvent;
    this.state.tokens = [event, ...this.state.tokens.filter((token) => token.mintAddress !== mint)].slice(0, 100);
    console.log(`👛 [WalletTracking] Yeni mint: ${symbol} (${name}) ${mint}`);
  }
}
