import { z } from "zod";

export const mintedTokenSchema = z.object({
  id: z.string(),
  mintAddress: z.string(),
  name: z.string(),
  symbol: z.string(),
  detectedAt: z.number(),
  expiresAt: z.number(),
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
    }),
  }),
]);

export type WSMessage = z.infer<typeof wsMessageSchema>;
