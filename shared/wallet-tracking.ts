export interface WatchedWalletConfig {
  walletAddress: string;
}

export type WalletMintBuyStatus =
  | "watch_only"
  | "waiting"
  | "bought"
  | "skipped"
  | "failed";

export interface WalletMintEvent {
  id: string;
  mintAddress: string;
  name: string;
  symbol: string;
  creator: string;
  detectedAt: number;
  expiresAt: number;
  jupiterUrl: string;
  dexscreenerUrl: string;
  pumpfunUrl: string;
  liquidityUsd?: number;
  solscanVerified: boolean;
  solscanMessage?: string;
  autoBuyStatus: WalletMintBuyStatus;
  autoBuyMessage?: string;
}

export interface WalletTrackingState {
  walletAddress: string;
  isWatching: boolean;
  autoBuyRunning: boolean;
  tokens: WalletMintEvent[];
}
