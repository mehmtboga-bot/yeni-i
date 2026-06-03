/**
 * SellScheduler — setInterval tabanlı satış yeniden deneme kuyruğu.
 *
 * Recursive setTimeout yerine merkezi bir kuyruk kullanır:
 * - Stack overflow riski yoktur
 * - Tüm bekleyen satışlar tek yerden izlenebilir
 * - Timing kontrolü daha güvenilirdir
 */

interface SellEntry {
  positionId: string;
  nextRetryTime: number;
}

type SellFn = (positionId: string) => Promise<{ status: string } | null>;

export class SellScheduler {
  private queue: SellEntry[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight: Set<string> = new Set();
  private readonly retryDelayMs: number;
  private readonly tickMs: number;
  private sell: SellFn;

  constructor(sell: SellFn, retryDelayMs = 1000, tickMs = 200) {
    this.sell = sell;
    this.retryDelayMs = retryDelayMs;
    this.tickMs = tickMs;
  }

  /** Satış kuyruğuna ekle. Aynı positionId zaten kuyruktaysa eklenmez. */
  enqueue(positionId: string, delayMs = 0): void {
    const alreadyQueued = this.queue.some((e) => e.positionId === positionId);
    if (alreadyQueued || this.inFlight.has(positionId)) return;
    this.queue.push({ positionId, nextRetryTime: Date.now() + delayMs });
    console.log(`📋 [SellScheduler] Kuyruğa eklendi: ${positionId} (${delayMs}ms sonra)`);
  }

  /** Pozisyonu kuyruktan ve uçuş listesinden çıkar (satış tamamlandı/iptal). */
  remove(positionId: string): void {
    this.queue = this.queue.filter((e) => e.positionId !== positionId);
    this.inFlight.delete(positionId);
  }

  /** Scheduler'ı başlat. */
  start(): void {
    if (this.intervalHandle) return;
    console.log(`⏱️ [SellScheduler] Başlatıldı (${this.tickMs}ms tick, ${this.retryDelayMs}ms retry)`);
    this.intervalHandle = setInterval(() => this.tick(), this.tickMs);
  }

  /** Scheduler'ı durdur ve kuyruğu temizle. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.queue = [];
    this.inFlight.clear();
    console.log("⏹️ [SellScheduler] Durduruldu");
  }

  /** Kuyruk boyutunu döndürür (izleme amaçlı). */
  get size(): number {
    return this.queue.length;
  }

  private tick(): void {
    const now = Date.now();

    for (const entry of this.queue) {
      if (entry.nextRetryTime > now) continue;
      if (this.inFlight.has(entry.positionId)) continue;

      this.inFlight.add(entry.positionId);
      // Kuyruktan çıkar — sonuç ne olursa olsun yeniden eklenecek veya bırakılacak
      this.queue = this.queue.filter((e) => e.positionId !== entry.positionId);

      this.sell(entry.positionId)
        .then((result) => {
          if (!result) {
            // Pozisyon bulunamadı veya cüzdan hazır değil — kuyruğa geri ekleme
            console.warn(`⚠️ [SellScheduler] ${entry.positionId} için sell() null döndü, kuyruktan çıkarıldı`);
            return;
          }

          if (result.status === "closed") {
            // Satış başarılı — kuyruktan çıkar (zaten çıkarıldı)
            console.log(`✅ [SellScheduler] ${entry.positionId} satışı tamamlandı`);
          } else if (result.status === "open" || result.status === "pending_sell") {
            // Satış başarısız — yeniden kuyruğa ekle
            console.warn(`🔄 [SellScheduler] ${entry.positionId} yeniden kuyruğa ekleniyor (${this.retryDelayMs}ms sonra)`);
            this.queue.push({ positionId: entry.positionId, nextRetryTime: Date.now() + this.retryDelayMs });
          }
          // Diğer durumlar (failed, pending_buy vb.) — kuyruğa geri ekleme
        })
        .catch((err) => {
          console.error(`❌ [SellScheduler] ${entry.positionId} sell() hatası: ${err?.message ?? err} — yeniden kuyruğa ekleniyor`);
          this.queue.push({ positionId: entry.positionId, nextRetryTime: Date.now() + this.retryDelayMs });
        })
        .finally(() => {
          this.inFlight.delete(entry.positionId);
        });
    }
  }
}
