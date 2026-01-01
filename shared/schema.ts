import { z } from "zod";

export const mintedTokenSchema = z.object({
  id: z.string(),
  mintAddress: z.string(),
  name: z.string(),
  symbol: z.string(),
  detectedAt: z.number(),
  expiresAt: z.number(),
  isLocked: z.boolean().optional(),
});

export type MintedToken = z.infer<typeof mintedTokenSchema>;

export const lpDetectionSchema = z.object({
  id: z.string(),
  mintAddress: z.string(),
  name: z.string(),
  symbol: z.string(),
  detectedAt: z.number(),
  expiresAt: z.number(),
  raydiumUrl: z.string(),
  jupiterUrl: z.string(),
  dexscreenerUrl: z.string(),
  isLocked: z.boolean().optional(),
});

export type LPDetection = z.infer<typeof lpDetectionSchema>;

export const wsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mint_detected"),
    data: mintedTokenSchema,
  }),
  z.object({
    type: z.literal("lp_detected"),
    data: lpDetectionSchema,
  }),
  z.object({
    type: z.literal("connection_status"),
    data: z.object({
      connected: z.boolean(),
      message: z.string().optional(),
      isMonitoring: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("monitoring_state"),
    data: z.object({
      isMonitoring: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal("error"),
    data: z.object({
      message: z.string(),
      type: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("balance_update"),
    data: z.object({
      balance: z.number(),
      publicKey: z.string(),
    }),
  }),
]);

export type WSMessage = z.infer<typeof wsMessageSchema>;
