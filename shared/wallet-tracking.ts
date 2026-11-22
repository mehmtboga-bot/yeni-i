export interface WatchedWalletConfig {
  walletAddress: string;
  running: boolean;
}

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
}
