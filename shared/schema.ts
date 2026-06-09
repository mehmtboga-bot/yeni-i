import { z } from "zod";

export const mintedTokenSchema = z.object({
  id: z.string(),
  mintAddress: z.string(),
  name: z.string(),
  symbol: z.string(),
  detectedAt: z.number(),
  expiresAt: z.number(),
  isLocked: z.boolean().optional(),
  lockDuration: z.string().optional(),
  liquidityAmount: z.number().optional(),
});

export type MintedToken = z.infer<typeof mintedTokenSchema>;

export const lpDetectionSchema = z.object({
  id: z.string(),
  mintAddress: z.string(),
  name: z.string(),
  symbol: z.string(),
  detectedAt: z.number(),
  expiresAt: z.number(),
  raydiumUrl: z.string().optional(),
  jupiterUrl: z.string().optional(),
  dexscreenerUrl: z.string().optional(),
  pumpfunUrl: z.string().optional(),
  isLocked: z.boolean().optional(),
  lockDuration: z.string().optional(),
  liquidityAmount: z.number().optional(),
  platform: z.string().optional(),
  lpMint: z.string().optional(),
  isSkipped: z.boolean().optional(),
});

export type LPDetection = z.infer<typeof lpDetectionSchema>;

export const positionSchema = z.object({
  id: z.string(),
  mintAddress: z.string(),
  name: z.string(),
  symbol: z.string(),
  status: z.enum(["pending_buy", "open", "pending_sell", "closed", "failed"]),
  dex: z.enum(["jupiter", "pumpswap"]).optional(),
  buyTimestamp: z.number(),
  buySolAmount: z.number(),
  buyTokenAmount: z.number().optional(),
  buyPriceSol: z.number().optional(),
  buyTxSignature: z.string().optional(),
  sellTimestamp: z.number().optional(),
  sellSolAmount: z.number().optional(),
  sellPriceSol: z.number().optional(),
  sellTxSignature: z.string().optional(),
  pnlSol: z.number().optional(),
  pnlPct: z.number().optional(),
  currentPriceUsd: z.number().optional(),
  unrealizedPnlSol: z.number().optional(),
  unrealizedPnlPct: z.number().optional(),
  error: z.string().optional(),
  autoSellAt: z.number().optional(),  // Auto-trader satış zamanı (timestamp)
  customHoldDurationMs: z.number().optional(),  // Token başına özel tutma süresi (ms)
});

export type Position = z.infer<typeof positionSchema>;

export const tradeConfigSchema = z.object({
  solAmount: z.number().min(0.0001),
  slippageBps: z.number().min(50).max(1_000_000),
  priorityFeeManualMicroLamports: z.number().min(0).max(100_000_000), // Manuel alım
  priorityFeeAutoMicroLamports: z.number().min(0).max(100_000_000),   // Otomatik alım
  takeProfitPct: z.number().min(0).max(10000).optional().default(0),
});

export type TradeConfig = z.infer<typeof tradeConfigSchema>;

export const autoTraderConfigSchema = z.object({
  enabled: z.boolean(),
  solAmountPerTrade: z.number(),
  maxTokensHeld: z.number(),
  holdDurationMs: z.number(),
  profitTargetPct: z.number(),
  stopLossPct: z.number(),
  slippageBps: z.number(),
  priorityFeeMicroLamports: z.number(),
  minLiquidityUsd: z.number(),
});

export type AutoTraderConfig = z.infer<typeof autoTraderConfigSchema>;

export const skippedTokenSchema = z.object({
  symbol: z.string(),
  skippedAt: z.number(),
  count: z.number(),
});

export type SkippedToken = z.infer<typeof skippedTokenSchema>;

export const wsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mint_detected"), data: mintedTokenSchema }),
  z.object({ type: z.literal("lp_detected"), data: lpDetectionSchema }),
  z.object({
    type: z.literal("connection_status"),
    data: z.object({
      connected: z.boolean(),
      message: z.string().optional(),
      isMonitoring: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal("monitoring_state"), data: z.object({ isMonitoring: z.boolean() }) }),
  z.object({ type: z.literal("error"), data: z.object({ message: z.string(), type: z.string().optional() }) }),
  z.object({ type: z.literal("balance_update"), data: z.object({ balance: z.number(), publicKey: z.string() }) }),
  z.object({
    type: z.literal("server_log"),
    data: z.object({ level: z.enum(["info", "warn", "error"]), message: z.string(), timestamp: z.number() }),
  }),
  z.object({
    type: z.literal("positions_snapshot"),
    data: z.object({
      positions: z.array(positionSchema),
      config: tradeConfigSchema,
      traderPublicKey: z.string().optional(),
      traderReady: z.boolean(),
      solPriceUsd: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal("position_update"), data: positionSchema }),
  z.object({ type: z.literal("trade_config_update"), data: tradeConfigSchema }),
  z.object({
    type: z.literal("update_position_hold_duration"),
    data: z.object({ positionId: z.string(), holdDurationMs: z.number() }),
  }),
]);

export type WSMessage = z.infer<typeof wsMessageSchema>;
