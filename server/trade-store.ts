import fs from "fs";
import path from "path";
import type { Position, TradeConfig } from "@shared/schema";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "trades.json");

const DEFAULT_CONFIG: TradeConfig = {
  solAmount: 0.01,
  slippageBps: 10000, // 100% kayma (fiyat ne olursa olsun al/sat)
  priorityFeeMicroLamports: 20_000_000,
  takeProfitPct: 0,
};

interface StoreData {
  positions: Position[];
  config: TradeConfig;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(): StoreData {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_PATH)) return { positions: [], config: { ...DEFAULT_CONFIG } };
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
    };
  } catch (err) {
    console.error("⚠️ trades.json okunamadı, sıfırlanıyor:", (err as Error).message);
    return { positions: [], config: { ...DEFAULT_CONFIG } };
  }
}

function save(data: StoreData) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export class TradeStore {
  private data: StoreData;

  constructor() { this.data = load(); }

  getAll(): Position[] { return [...this.data.positions]; }
  getOpen(): Position[] { return this.data.positions.filter((p) => p.status === "open" || p.status === "pending_sell"); }

  getByMint(mintAddress: string): Position | undefined {
    return this.data.positions.find(
      (p) => p.mintAddress === mintAddress && (p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell"),
    );
  }

  getById(id: string): Position | undefined { return this.data.positions.find((p) => p.id === id); }

  /** Soft-delete: status'u "deleted" olarak işaretle, fiziksel silme yapma */
  delete(id: string): Position | undefined {
    const idx = this.data.positions.findIndex((p) => p.id === id);
    if (idx < 0) return undefined;
    const updated: Position = {
      ...this.data.positions[idx],
      status: "deleted",
      deletedAt: Date.now(),
    };
    this.data.positions[idx] = updated;
    save(this.data);
    return updated;
  }

  /** Soft-delete'i geri al: önceki status'a döndür */
  restore(id: string): Position | undefined {
    const idx = this.data.positions.findIndex((p) => p.id === id);
    if (idx < 0) return undefined;
    const pos = this.data.positions[idx];
    if (pos.status !== "deleted") return pos;
    // pnlSol varsa closed, yoksa failed veya closed olarak geri getir
    const restoredStatus: Position["status"] =
      pos.pnlSol !== undefined ? "closed" : pos.buyTxSignature ? "failed" : "closed";
    const restored: Position = {
      ...pos,
      status: restoredStatus,
      deletedAt: undefined,
    };
    this.data.positions[idx] = restored;
    save(this.data);
    return restored;
  }

  /** Pozisyonu kalıcı olarak sil (sadece gerektiğinde) */
  hardDelete(id: string): void {
    this.data.positions = this.data.positions.filter((p) => p.id !== id);
    save(this.data);
  }

  upsert(position: Position): Position {
    const idx = this.data.positions.findIndex((p) => p.id === position.id);
    if (idx >= 0) this.data.positions[idx] = position;
    else this.data.positions.unshift(position);
    this.pruneClosed();
    save(this.data);
    return position;
  }

  private static MAX_CLOSED_HISTORY = 4;
  private pruneClosed() {
    const isClosed = (p: Position) => p.status === "closed" || p.status === "failed";
    const closed = this.data.positions
      .filter(isClosed)
      .sort((a, b) => (b.buyTimestamp ?? 0) - (a.buyTimestamp ?? 0));
    const toKeep = new Set(closed.slice(0, TradeStore.MAX_CLOSED_HISTORY).map((p) => p.id));
    this.data.positions = this.data.positions.filter((p) => !isClosed(p) || toKeep.has(p.id));
  }

  getConfig(): TradeConfig { return { ...this.data.config }; }

  updateConfig(partial: Partial<TradeConfig>): TradeConfig {
    this.data.config = { ...this.data.config, ...partial };
    save(this.data);
    return { ...this.data.config };
  }
}
