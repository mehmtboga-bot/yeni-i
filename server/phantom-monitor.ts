/**
 * PhantomMonitor
 *
 * Phantom cüzdanındaki token bakiyelerini Jupiter Token API üzerinden
 * her 5 saniyede bir polling yaparak takip eder.
 *
 * Yeni bir token tespit edildiğinde:
 *   - EventStore'a "mint_detected" olarak eklenir
 *   - Frontend'e broadcast edilir (token kartında gösterilir)
 *   - Otomatik satış YAPILMAZ — tamamen manuel kontrol
 */

import { secrets } from "./secrets-loader";

// Solana RPC — cüzdan token hesaplarını çekmek için
const HELIUS_API_KEY = secrets.HELIUS_API_KEY;
const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";

// Jupiter Token Search API — token metadata için
const JUP_TOKEN_SEARCH = "https://api.jup.ag/tokens/v1/token";

// Phantom cüzdan token'larının gösterim süresi (5 dakika)
const DISPLAY_DURATION_MS = 5 * 60 * 1000;

// Polling aralığı (5 saniye)
const POLL_INTERVAL_MS = 5_000;

// SOL native mint — token listesinden hariç tutulur
const WSOL_MINT = "So11111111111111111111111111111111111111112";

interface TokenMetadata {
  name: string;
  symbol: string;
}

type BroadcastFn = (message: { type: string; data: any }) => void;

export class PhantomMonitor {
  private walletAddress: string;
  private broadcast: BroadcastFn;
  private knownMints: Map<string, { detectedAt: number }> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(walletAddress: string, broadcast: BroadcastFn) {
    this.walletAddress = walletAddress;
    this.broadcast = broadcast;
  }

  start() {
    if (this.isRunning) return;
    if (!this.walletAddress) {
      console.warn("⚠️ [PhantomMonitor] PHANTOM_WALLET_ADDRESS tanımlı değil, monitor başlatılmıyor.");
      return;
    }
    this.isRunning = true;
    console.log(`👻 [PhantomMonitor] Başlatıldı — cüzdan: ${this.walletAddress.slice(0, 8)}...`);
    // İlk poll'u hemen yap, sonra interval kur
    this.poll().catch((err) =>
      console.error("❌ [PhantomMonitor] İlk poll hatası:", err)
    );
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        console.error("❌ [PhantomMonitor] Poll hatası:", err)
      );
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("🛑 [PhantomMonitor] Durduruldu.");
  }

  // ─── Ana polling döngüsü ───────────────────────────────────────────────────
  private async poll() {
    const mints = await this.fetchWalletTokenMints();
    if (!mints || mints.length === 0) return;

    for (const mint of mints) {
      if (this.knownMints.has(mint)) continue; // Zaten bilinen token

      // Yeni token tespit edildi
      const metadata = await this.fetchTokenMetadata(mint);
      const name = metadata?.name || "Bilinmiyor";
      const symbol = metadata?.symbol || "?";

      const detectedAt = Date.now();
      const expiresAt = detectedAt + DISPLAY_DURATION_MS;
      const id = `phantom-${mint}-${detectedAt}`;

      this.knownMints.set(mint, { detectedAt });

      console.log(
        `👻 [PhantomMonitor] Yeni token tespit edildi: ${name} (${symbol}) — ${mint.slice(0, 8)}...`
      );

      const tokenData = {
        id,
        mintAddress: mint,
        name,
        symbol,
        detectedAt,
        expiresAt,
        source: "phantom",
        jupiterUrl: `https://jup.ag/swap/SOL-${mint}`,
        dexscreenerUrl: `https://dexscreener.com/solana/${mint}`,
        pumpfunUrl: `https://pump.fun/${mint}`,
      };

      // EventStore'a ekle ve frontend'e broadcast et
      this.broadcast({ type: "mint_detected", data: tokenData });
    }
  }

  // ─── Cüzdandaki SPL token mint adreslerini çek ────────────────────────────
  private async fetchWalletTokenMints(): Promise<string[]> {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [
            this.walletAddress,
            { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ],
        }),
      });

      if (!res.ok) {
        console.warn(`⚠️ [PhantomMonitor] RPC yanıt hatası: ${res.status}`);
        return [];
      }

      const data = await res.json();
      if (data.error) {
        console.warn("⚠️ [PhantomMonitor] RPC hatası:", data.error.message);
        return [];
      }

      const accounts: any[] = data.result?.value || [];
      const mints: string[] = [];

      for (const account of accounts) {
        const parsed = account.account?.data?.parsed?.info;
        if (!parsed) continue;

        const mint: string = parsed.mint;
        const amount: string = parsed.tokenAmount?.amount || "0";

        // Sıfır bakiyeli ve WSOL hesaplarını atla
        if (!mint || mint === WSOL_MINT || amount === "0") continue;

        mints.push(mint);
      }

      return mints;
    } catch (err) {
      console.error("❌ [PhantomMonitor] fetchWalletTokenMints hatası:", err);
      return [];
    }
  }

  // ─── Jupiter Token API'den metadata çek ──────────────────────────────────
  private async fetchTokenMetadata(mint: string): Promise<TokenMetadata | null> {
    try {
      const res = await fetch(`${JUP_TOKEN_SEARCH}/${mint}`, {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) return null;

      const data = await res.json();
      const name = data?.name || "Bilinmiyor";
      const symbol = data?.symbol || "?";

      if (name === "Bilinmiyor" && symbol === "?") return null;
      return { name, symbol };
    } catch {
      return null;
    }
  }
}
