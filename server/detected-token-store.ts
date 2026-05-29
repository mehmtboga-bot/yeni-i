/**
 * Helius'tan gelen LP detected token'leri saklar.
 * Son 12 saatte gelen token'leri tutar.
 */

export interface DetectedToken {
  id: string;
  mintAddress: string;
  name: string;
  symbol: string;
  detectedAt: number;
  liquidityAmount?: number;
  liquidityUsd?: number;
  tvlUsd?: number;
  platform: string;
}

export class DetectedTokenStore {
  private tokens: Map<string, DetectedToken> = new Map();
  private readonly MAX_TOKENS = 1000;
  private readonly RETENTION_MS = 12 * 60 * 60 * 1000; // 12 saat

  /**
   * Token ekle
   */
  add(token: DetectedToken): void {
    this.tokens.set(token.mintAddress, token);

    // Eski token'leri temizle
    this.cleanup();

    // Limit aşarsa en eski'yi sil
    if (this.tokens.size > this.MAX_TOKENS) {
      const oldest = Array.from(this.tokens.values()).sort(
        (a, b) => a.detectedAt - b.detectedAt
      )[0];
      if (oldest) {
        this.tokens.delete(oldest.mintAddress);
      }
    }
  }

  /**
   * Tüm token'leri al
   */
  getAll(): DetectedToken[] {
    this.cleanup();
    return Array.from(this.tokens.values());
  }

  /**
   * Eski token'leri temizle (12 saatten eski)
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.RETENTION_MS;
    for (const [mint, token] of this.tokens.entries()) {
      if (token.detectedAt < cutoff) {
        this.tokens.delete(mint);
      }
    }
  }

  /**
   * Toplam token sayısı
   */
  count(): number {
    this.cleanup();
    return this.tokens.size;
  }
}
