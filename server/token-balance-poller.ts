import { TradeStore } from "./trade-store";

export class TokenBalancePoller {
  private store: TradeStore;
  private emit: (event: string, data: any) => void;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private heliusApiKey: string;

  constructor(store: TradeStore, emit: (event: string, data: any) => void, heliusApiKey: string) {
    this.store = store;
    this.emit = emit;
    this.heliusApiKey = heliusApiKey;
  }

  start() {
    if (this.updateInterval) return;
    console.log("💰 [TokenBalancePoller] Başlatıldı (30s aralık)");
    this.updateInterval = setInterval(() => this.updateBalances(), 30000);
    this.updateBalances();
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      console.log("⏹️ [TokenBalancePoller] Durduruldu");
    }
  }

  private async updateBalances() {
    const positions = this.store.getAll();
    const openPositions = positions.filter((p) => p.status === "open");
    if (openPositions.length === 0) return;

    const traderPublicKey = process.env.TRADER_PUBLIC_KEY;
    if (!traderPublicKey) {
      console.warn("⚠️ [TokenBalancePoller] TRADER_PUBLIC_KEY tanımlı değil");
      return;
    }

    for (const pos of openPositions) {
      try {
        const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${this.heliusApiKey}`;

        const res = await fetch(heliusUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `balance-${pos.mintAddress}`,
            method: "getTokenAccountsByOwner",
            params: [
              traderPublicKey,
              { mint: pos.mintAddress },
              { encoding: "jsonParsed" },
            ],
          }),
        });

        const data = await res.json();
        const accounts = data.result?.value ?? [];

        if (accounts.length === 0) {
          console.warn(`⚠️ [TokenBalancePoller] ${pos.symbol} token account bulunamadı`);
          continue;
        }

        const tokenAmount = accounts[0].account.data.parsed.info.tokenAmount.uiAmount;

        if (tokenAmount !== pos.buyTokenAmount) {
          const updated = { ...pos, buyTokenAmount: tokenAmount };
          this.store.upsert(updated);
          this.emit("position_update", updated);
          console.log(`💰 [TokenBalancePoller] ${pos.symbol} bakiye güncellendi: ${pos.buyTokenAmount} → ${tokenAmount}`);
        }
      } catch (err) {
        console.warn(`⚠️ [TokenBalancePoller] ${pos.symbol} bakiye çekilemedi:`, err);
      }
    }
  }
}
