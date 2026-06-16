import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { HeliusMonitor } from "./helius-monitor";
import { JupiterTrader } from "./jupiter-trader";
import { TradeStore } from "./trade-store";
import { PositionPricer } from "./position-pricer";
import { AutoTraderConfigStore } from "./auto-trader-config";
import { AutoTraderEngine } from "./auto-trader-engine";
import { saveSecrets } from "./secrets-loader";
import { WhitelistManager } from "./whitelist-manager";
import fs from "fs";
import path from "path";
import { EventStore } from "./event-store";
import { LiquidityMonitor } from "./liquidity-monitor";

const ROOT = process.cwd();

const ALLOWED_FILES = [
  "data/whitelist.txt",
];

function safeResolvePath(filePath: string): string | null {
  const resolved = path.resolve(ROOT, filePath);
  if (!resolved.startsWith(ROOT)) return null;
  const rel = path.relative(ROOT, resolved).replace(/\\/g, "/");
  if (!ALLOWED_FILES.includes(rel)) return null;
  return resolved;
}


// ---- Console log yakalayıcı ----
// Tüm console çıktılarını hem terminale hem istemcilere iletir.
// _broadcasting flag döngüyü önler.
let _broadcasting = false;
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);

let _broadcast: ((level: "info" | "warn" | "error", msg: string) => void) | null = null;

const capture = (level: "info" | "warn" | "error", orig: (...a: any[]) => void, args: any[]) => {
  orig(...args);
  if (_broadcasting || !_broadcast) return;
  const msg = args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ");
  // Çok gürültülü client connect/disconnect satırlarını filtrele
  if (msg.includes("Yeni client") || msg.includes("Client bağlantısı")) return;
  _broadcasting = true;
  _broadcast(level, msg);
  _broadcasting = false;
};

console.log   = (...a) => capture("info",  _origLog,   a);
console.warn  = (...a) => capture("warn",  _origWarn,  a);
console.error = (...a) => capture("error", _origError, a);
// --------------------------------

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  const whitelistManager = new WhitelistManager();

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const clients = new Set<WebSocket>();

  // Persistent event store (server-side)
  const eventStore = new EventStore();

  const broadcastToClients = (message: any) => {
    // message expected: { type: string, data: any }
    try {
      const stored = eventStore.append(message.type || "unknown", message.data ?? null);
      const payload = JSON.stringify(stored);
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    } catch (err) {
      _origError("❌ broadcastToClients error:", err);
    }
  };

  // Console yakalayıcıya broadcast fonksiyonunu bağla
  _broadcast = (level, message) => {
    broadcastToClients({
      type: "server_log",
      data: { level, message, timestamp: Date.now() },
    });
  };

  // ---- Dosya Editörü API ----
  app.get("/api/files/list", (_req, res) => {
    res.json({ files: ALLOWED_FILES });
  });

  app.get("/api/files/read", (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path gerekli" });
    const resolved = safeResolvePath(filePath);
    if (!resolved) return res.status(403).json({ error: "İzin verilmeyen dosya" });
    try {
      const content = fs.readFileSync(resolved, "utf-8");
      res.json({ content });
    } catch {
      res.status(404).json({ error: "Dosya bulunamadı" });
    }
  });

  app.post("/api/files/write", (req, res) => {
    const { path: filePath, content } = req.body as { path: string; content: string };
    if (!filePath || content === undefined) return res.status(400).json({ error: "path ve content gerekli" });
    const resolved = safeResolvePath(filePath);
    if (!resolved) return res.status(403).json({ error: "İzin verilmeyen dosya" });
    try {
      fs.writeFileSync(resolved, content, "utf-8");
      _origLog(`📝 Dosya güncellendi: ${filePath}`);

      // Whitelist dosyası güncellenirse, whitelist manager'ı yenile
      // Dosya zaten yazıldı — sadece bellekteki listeyi yenile (iki bölümlü format korunur)
      if (filePath === "data/whitelist.txt") {
        whitelistManager.reloadFromFile();
      }

      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Yeni endpoint: kaçırılan (persisted) eventleri al
  app.get("/api/events", (req, res) => {
    const afterId = Number(req.query.afterId || 0) || 0;
    try {
      const events = eventStore.getAfter(afterId);
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Yeni endpoint: son 100 mint detected event'i al
  app.get("/api/recent-mints", (req, res) => {
    try {
      const allEvents = eventStore.getLast(100);
      const mints = allEvents
        .filter((e) => e.type === "mint_detected")
        .reverse(); // en yeni ilk
      res.json({ mints });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/update-secrets", (req, res) => {
    const { HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TRADER_PRIVATE_KEY } = req.body || {};
    try {
      if (HELIUS_API_KEY !== undefined || TELEGRAM_BOT_TOKEN !== undefined || TELEGRAM_CHAT_ID !== undefined || TRADER_PRIVATE_KEY !== undefined) {
        const updates: Record<string, string> = {};
        if (typeof HELIUS_API_KEY === "string") updates.HELIUS_API_KEY = HELIUS_API_KEY;
        if (typeof TELEGRAM_BOT_TOKEN === "string") updates.TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKEN;
        if (typeof TELEGRAM_CHAT_ID === "string") updates.TELEGRAM_CHAT_ID = TELEGRAM_CHAT_ID;
        if (typeof TRADER_PRIVATE_KEY === "string") updates.TRADER_PRIVATE_KEY = TRADER_PRIVATE_KEY;
        if (Object.keys(updates).length > 0) {
          saveSecrets(updates);
          _origLog("🔐 Secrets güncellendu (⚠️ Restart gerekli)");
          res.json({ ok: true, message: "Secrets güncellendi. Değişikliklerin etkili olması için uygulamayı yeniden başlatın." });
        } else {
          res.status(400).json({ error: "Güncellenecek alan bulunamadı" });
        }
      } else {
        res.status(400).json({ error: "En az bir secret alanı gerekli" });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  // --------------------------

  // ---- Trade store + Jupiter ----
  const tradeStore = new TradeStore();

  // Active liquidity monitors keyed by positionId
  const liquidityMonitors = new Map<string, LiquidityMonitor>();

  const trader = new JupiterTrader(tradeStore, (event, data) => {
    if (event === "position_update") {
      broadcastToClients({ type: "position_update", data });
      
      // Auto-trader'a pozisyon güncellemesini bildir
      if (data.status === "open" && data.buyTxSignature) {
        autoTraderEngine.updateRecordAfterBuy(
          data.mintAddress,
          data.buyTxSignature,
          data.buyPriceSol,
          data.buyTokenAmount
        );

        // Start liquidity monitoring for this position
        if (!liquidityMonitors.has(data.id)) {
          const monitor = new LiquidityMonitor(
            data.id,
            data.mintAddress,
            data.symbol,
            (positionId: string) => {
              // Rug pull detected by liquidity drop — close the position
              const pos = tradeStore.getById(positionId);
              if (pos && (pos.status === "open" || pos.status === "pending_buy" || pos.status === "pending_sell")) {
                const rugLoss = -(pos.buySolAmount ?? 0);
                const closed = {
                  ...pos,
                  status: "closed" as const,
                  sellTimestamp: Date.now(),
                  sellSolAmount: 0,
                  sellPriceSol: 0,
                  pnlSol: rugLoss,
                  pnlPct: -100,
                  error: "Rug Pull",
                };
                tradeStore.upsert(closed);
                autoTraderEngine.markRecordClosed(pos.mintAddress);
                broadcastToClients({ type: "position_update", data: closed });
                console.log(`🚨 [LiquidityMonitor] ${pos.symbol} likidite düşüşü nedeniyle rug pull olarak kapatıldı (-%100)`);
              }
              liquidityMonitors.delete(positionId);
            },
          );
          liquidityMonitors.set(data.id, monitor);
        }
      }
      if (data.status === "closed" && data.sellTxSignature) {
        autoTraderEngine.updateRecordAfterSell(
          data.mintAddress,
          data.sellTxSignature,
          data.sellPriceSol,
          data.pnlSol,
          data.pnlPct
        );
      }
      // Manuel satış veya rug pull tespiti — auto-trader record'unu kapat
      if (data.status === "closed") {
        autoTraderEngine.markRecordClosed(data.mintAddress);
        // Stop liquidity monitoring when position closes
        const lm = liquidityMonitors.get(data.id);
        if (lm) {
          lm.stop();
          liquidityMonitors.delete(data.id);
        }
      }
    } else if (event === "trade_config_update") {
      broadcastToClients({ type: "trade_config_update", data });
    } else if (event === "rug_pull_detected") {
      // Satış 3 denemede başarısız — rug pull olarak işaretle
      const { positionId, mintAddress, symbol, reason } = data as {
        positionId: string;
        mintAddress: string;
        symbol: string;
        reason: string;
      };
      autoTraderEngine.markRecordRugDetected(mintAddress, reason);
      // Stop liquidity monitoring if still running
      const lmFailed = liquidityMonitors.get(positionId);
      if (lmFailed) {
        lmFailed.stop();
        liquidityMonitors.delete(positionId);
      }
      broadcastToClients({ type: "rug_pull_detected", data: { positionId, mintAddress, symbol, reason } });
      console.error(`🚨 [Routes] ${symbol} — satış 3 denemede başarısız, rug pull olarak işaretlendi`);
    }
  });

  const sendPositionsSnapshot = (ws: WebSocket) => {
    ws.send(
      JSON.stringify({
        type: "positions_snapshot",
        data: {
          positions: tradeStore.getAll(),
          config: tradeStore.getConfig(),
          autoTraderConfig: autoTraderConfigStore.getConfig(),
          autoTraderRunning: autoTraderEngine.getIsRunning(),
          traderPublicKey: trader.getPublicKey(),
          traderReady: trader.isReady(),
          solPriceUsd: monitor.getSolPriceUsd(),
        },
      }),
    );
  };
  // -------------------------------

  // ---- Auto Trader Kurulum ----
  const autoTraderConfigStore = new AutoTraderConfigStore();
  const autoTraderEngine = new AutoTraderEngine(
    autoTraderConfigStore,
    tradeStore,
    (event: string, data: any) => {
      if (event === "auto_trade_record_updated") {
        broadcastToClients({ type: "auto_trade_record_updated", data });
      } else if (event === "auto_buy_ready") {
        // Otomatik alım — LP tespit edildi, token satın al
        const { mintAddress, name, symbol, dex } = data;
        const nm = name || "Bilinmiyor";
        const sym = symbol || "?";
        const autoConfig = autoTraderConfigStore.getConfig();
        const solAmount = autoConfig.solAmountPerTrade;
        console.log(`⏳ [Auto-Trader] ${sym} 750ms bekleniyor... (${mintAddress}) | DEX: ${dex || "jupiter"} | SOL: ${solAmount}`);
        setTimeout(() => {
          console.log(`🤖 [Auto-Trader] Alım başlatılıyor: ${sym} (${mintAddress}) | DEX: ${dex || "jupiter"} | SOL: ${solAmount}`);
          if (dex === "pumpswap") {
            trader.buyPumpSwap({ mintAddress, name: nm, symbol: sym, solAmount, isAuto: true })
              .catch((err) => {
                console.error("Auto-buy (PumpSwap) hatası:", err);
                autoTraderEngine.markRecordFailed(mintAddress, String(err));
              });
          } else {
            trader.buy({ mintAddress, name: nm, symbol: sym, solAmount, isAuto: true })
              .catch((err) => {
                console.error("Auto-buy hatası:", err);
                autoTraderEngine.markRecordFailed(mintAddress, String(err));
              });
          }
        }, 750);

      } else if (event === "auto_sell_ready") {
        // Otomatik satış yapılacak pozisyon
        trader.sell(data.positionId).catch((err) => console.error("Auto-sell hatası:", err));
      } else if (event === "auto_sell_at_updated") {
        // Position'a autoSellAt bilgisini ekle ve yayınla
        const { mintAddress, autoSellAt } = data as { mintAddress: string; autoSellAt: number };
        const pos = tradeStore.getByMint(mintAddress);
        if (pos) {
          const updated = { ...pos, autoSellAt };
          tradeStore.upsert(updated);
          broadcastToClients({ type: "position_update", data: updated });
        }
      }
    },
    trader  // Direkt satış için trader referansı
  );


  // Otomatik trader enabled ise başlat
  if (autoTraderConfigStore.getConfig().enabled) {
    autoTraderEngine.start();
  }
  // ----------------------------

  const monitor = new HeliusMonitor((event: string, data: any) => {
    if (event === "mint_detected") {
      broadcastToClients({ type: "mint_detected", data });
    } else if (event === "lp_detected") {
      broadcastToClients({ type: "lp_detected", data });

      // Otomatik trader enabled ise direkt alım yap (hızlı)
      const autoConfig = autoTraderConfigStore.getConfig();
      if (autoConfig.enabled) {
        const { mintAddress, name, symbol, dex, tvlUsd } = data;
        const nm = name || "Bilinmiyor";
        const sym = symbol || "?";
        const solAmount = autoConfig.solAmountPerTrade;

        // Whitelist kontrol et
        if (!whitelistManager.isWhitelisted(sym)) {
          console.log(`⏭️ [Fast-Buy] ${sym} whitelist'te yok, atlanıyor`);
          return;
        }

        // Whitelist'teki token'ler likidite eşiğini geçmese bile alınsın
        const MIN_TVL_FOR_WHITELIST = 0; // Whitelist'teki token'ler için likidite eşiği yok
        if ((tvlUsd ?? 0) < MIN_TVL_FOR_WHITELIST) {
          console.log(`⏭️ [Fast-Buy] ${sym} likidite eşiğini geçmedi (TVL=${tvlUsd?.toFixed(0) ?? "?"}), atlanıyor`);
          return;
        }

        // Whitelist Bölüm 2: token için özel tutma süresi var mı?
        const customHoldDurationMs = whitelistManager.getCustomHoldDurationMs(sym);
        if (customHoldDurationMs !== undefined) {
          console.log(`⏱️ [Fast-Buy] ${sym} özel tutma süresi: ${(customHoldDurationMs / 1000).toFixed(0)}s (whitelist Bölüm 2)`);
        }

        // Auto-trader'a bildir (record tutması için) — özel süreyi data'ya ekle
        autoTraderEngine.onLPDetected({ ...data, customHoldDurationMs }).catch((err) => console.error("Auto-trader LP hatası:", err));

        // Eğer token son 15 dakikada görüldüyse, manuel alım için arayüzde göster ama otomatik alım yapma
        const isRecentlySkipped = monitor.isTokenRecentlySkipped(sym);
        if (isRecentlySkipped) {
          console.log(`⏭️ [Fast-Buy] ${sym} son 15 dakikada görüldü, manuel alım için arayüzde gösteriliyor`);
          // Otomatik alım yapma, sadece arayüzde göster (zaten token_skipped event'i yayınlanıyor)
          return;
        }

        // Yeni token ise 300ms bekle ve sonra direkt alım yap
        console.log(`⏳ [Fast-Buy] ${sym} 300ms bekleniyor... (${mintAddress})`);

        setTimeout(() => {
          console.log(`⚡ [Fast-Buy] Direkt alım başlatılıyor: ${sym} | TVL=${tvlUsd?.toFixed(0) ?? "?"} | SOL: ${solAmount}${customHoldDurationMs !== undefined ? ` | Özel süre: ${(customHoldDurationMs / 1000).toFixed(0)}s` : ""}`);

          const buyOpts = { mintAddress, name: nm, symbol: sym, solAmount, customHoldDurationMs, isAuto: true };
          if (dex === "pumpswap") {
            trader.buyPumpSwap(buyOpts)
              .then((pos: any) => {
                if (pos && customHoldDurationMs !== undefined) {
                  const updated = { ...pos, customHoldDurationMs };
                  tradeStore.upsert(updated);
                  broadcastToClients({ type: "position_update", data: updated });
                }
              })
              .catch((err: any) => {
                console.error("Fast-buy (PumpSwap) hatası:", err);
              });
          } else {
            trader.buy(buyOpts)
              .then((pos: any) => {
                if (pos && customHoldDurationMs !== undefined) {
                  const updated = { ...pos, customHoldDurationMs };
                  tradeStore.upsert(updated);
                  broadcastToClients({ type: "position_update", data: updated });
                }
              })
              .catch((err: any) => {
                console.error("Fast-buy hatası:", err);
              });
          }
        }, 300);
      }
    } else if (event === "connection_status") {
      broadcastToClients({ type: "connection_status", data });
    } else if (event === "monitoring_state") {
      broadcastToClients({ type: "monitoring_state", data });
    } else if (event === "error") {
      broadcastToClients({ type: "error", data });
    } else if (event === "token_skipped") {
      broadcastToClients({ type: "token_skipped", data });
    }

  });

  monitor.start();

  // Canlı fiyat güncelleme (açık pozisyonlar için)
  const pricer = new PositionPricer(
    tradeStore,
    monitor.getSolPriceUsd(),
    (event: string, data: any) => {
      if (event === "position_update") broadcastToClients({ type: "position_update", data });
    },
    (positionId: string) => {
      trader.sell(positionId).catch((err) => console.error("auto-sell hatası:", err));
    },
    (positionId: string) => {
      trader.sellHalf(positionId).catch((err) => console.error("half-sell hatası:", err));
    },
    autoTraderConfigStore,
  );
  pricer.start();

  wss.on("connection", (ws: WebSocket) => {
    _origLog("👤 Yeni client bağlandı");
    clients.add(ws);

    ws.send(
      JSON.stringify({
        type: "monitoring_state",
        data: { isMonitoring: monitor.getState() },
      })
    );
    sendPositionsSnapshot(ws);

    // Auto-trader config'i gönder
    ws.send(
      JSON.stringify({
        type: "auto_trader_config_snapshot",
        data: {
          config: autoTraderConfigStore.getConfig(),
          records: autoTraderEngine.getRecords(),
        },
      })
    );

    // Tüm persisted event'leri gönder (eski işlemler için)
    try {
      const allEvents = eventStore.getAfter(0);
      if (allEvents.length > 0) {
        _origLog(`📨 Client'e ${allEvents.length} eski event gönderiliyor...`);
        allEvents.forEach((event) => {
          ws.send(JSON.stringify(event));
        });
      }
    } catch (err) {
      _origError("❌ Eski event'ler gönderilirken hata:", err);
    }

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "get_balance") {
          const publicKey = message.data.publicKey;
          try {
            const balance = await monitor.getWalletBalance(publicKey);
            ws.send(JSON.stringify({ type: "balance_update", data: { balance, publicKey } }));
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.error("get_balance hatası:", reason);
            // İstemcinin yükleme durumunu temizleyebilmesi için balance:null dönüyoruz
            ws.send(JSON.stringify({ type: "balance_update", data: { balance: null, publicKey, error: reason } }));
            ws.send(JSON.stringify({
              type: "error",
              data: { message: `Bakiye çekilemedi: ${reason}` },
            }));
          }
        } else if (message.type === "buy_token") {
          const { mintAddress, name, symbol, dex } = message.data || {};
          if (mintAddress) {
            const nm = name || "Bilinmiyor";
            const sym = symbol || "?";
            const config = tradeStore.getConfig();
            const solAmount = config.solAmount;
            if (dex === "pumpswap") {
              trader.buyPumpSwap({ mintAddress, name: nm, symbol: sym, solAmount })
                .catch((err) => console.error("buyPumpSwap hatası:", err));
            } else {
              trader.buy({ mintAddress, name: nm, symbol: sym, solAmount })
                .catch((err) => console.error("buy_token hatası:", err));
            }
          }
        } else if (message.type === "sell_token") {
          const { positionId } = message.data || {};
          if (positionId) {
            trader.sell(positionId).then((result) => {
              if (result && result.status === "closed") {
                // Satış başarılı → auto-trader record'unu kapat
                const pos = tradeStore.getById(positionId);
                if (pos) {
                  autoTraderEngine.markRecordClosed(pos.mintAddress);
                }
              }
            }).catch((err) => console.error("sell_token hatası:", err));
          }
        } else if (message.type === "trade_config_update") {
          const { solAmount, slippageBps, priorityFeeManualMicroLamports, priorityFeeAutoMicroLamports, takeProfitPct } = message.data || {};
          const partial: Record<string, number> = {};
          if (typeof solAmount === "number" && solAmount > 0) partial.solAmount = solAmount;
          if (typeof slippageBps === "number" && slippageBps >= 50) partial.slippageBps = slippageBps;
          if (typeof priorityFeeManualMicroLamports === "number" && priorityFeeManualMicroLamports >= 0) partial.priorityFeeManualMicroLamports = priorityFeeManualMicroLamports;
          if (typeof priorityFeeAutoMicroLamports === "number" && priorityFeeAutoMicroLamports >= 0) partial.priorityFeeAutoMicroLamports = priorityFeeAutoMicroLamports;
          if (typeof takeProfitPct === "number" && takeProfitPct >= 0) partial.takeProfitPct = takeProfitPct;
          if (Object.keys(partial).length) {
            const updatedConfig = tradeStore.updateConfig(partial as any);
            broadcastToClients({
              type: "trade_config_update",
              data: { config: updatedConfig },
            });
          }

        } else if (message.type === "auto_trader_config_update") {
          // Otomatik trader konfigürasyonu güncelle
          const { solAmountPerTrade, maxTokensHeld, holdDurationMs, profitTargetPct, stopLossPct, slippageBps, priorityFeeMicroLamports, minLiquidityUsd, enabled, halfSellTarget1, halfSellTarget2, halfSellTarget3 } = message.data || {};
          const partial: Record<string, any> = {};
          if (typeof solAmountPerTrade === "number" && solAmountPerTrade > 0) partial.solAmountPerTrade = solAmountPerTrade;
          if (typeof maxTokensHeld === "number" && maxTokensHeld > 0) partial.maxTokensHeld = maxTokensHeld;
          if (typeof holdDurationMs === "number" && holdDurationMs > 0) partial.holdDurationMs = holdDurationMs;
          if (typeof profitTargetPct === "number" && profitTargetPct >= 0) partial.profitTargetPct = profitTargetPct;
          if (typeof stopLossPct === "number" && stopLossPct >= 0) partial.stopLossPct = stopLossPct;
          if (typeof slippageBps === "number" && slippageBps >= 50) partial.slippageBps = slippageBps;
          if (typeof priorityFeeMicroLamports === "number" && priorityFeeMicroLamports >= 0) partial.priorityFeeMicroLamports = priorityFeeMicroLamports;
          if (typeof minLiquidityUsd === "number" && minLiquidityUsd >= 0) partial.minLiquidityUsd = minLiquidityUsd;
          if (typeof halfSellTarget1 === "number" && halfSellTarget1 >= 0) partial.halfSellTarget1 = halfSellTarget1;
          if (typeof halfSellTarget2 === "number" && halfSellTarget2 >= 0) partial.halfSellTarget2 = halfSellTarget2;
          if (typeof halfSellTarget3 === "number" && halfSellTarget3 >= 0) partial.halfSellTarget3 = halfSellTarget3;
          if (typeof enabled === "boolean") {
            if (enabled) {
              autoTraderEngine.start();
            } else {
              autoTraderEngine.stop();
            }
            partial.enabled = enabled;
          }
          
          const updatedConfig = autoTraderConfigStore.updateConfig(partial);
          broadcastToClients({
            type: "auto_trader_config_updated",
            data: { config: updatedConfig },
          });
        } else if (message.type === "toggle_auto_trader") {
          // Otomatik trader'i aç/kapat
          const { enabled } = message.data || {};
          if (typeof enabled === "boolean") {
            autoTraderConfigStore.updateConfig({ enabled });
            if (enabled) {
              autoTraderEngine.start();
            } else {
              autoTraderEngine.stop();
            }
            broadcastToClients({
              type: "auto_trader_config_updated",
              data: { config: autoTraderConfigStore.getConfig() },
            });
            broadcastToClients({
              type: "auto_trader_state",
              data: { running: autoTraderEngine.getIsRunning() },
            });
          }
        } else if (message.type === "mark_rug_pull") {
          // Rug Pull: pozisyonu "closed" olarak işaretle, pnlPct=-100, silme
          const { positionId } = message.data || {};
          if (positionId) {
            const pos = tradeStore.getById(positionId);
            if (pos && (pos.status === "open" || pos.status === "pending_buy" || pos.status === "pending_sell")) {
              const rugLoss = -(pos.buySolAmount ?? 0);
              const closed = {
                ...pos,
                status: "closed" as const,
                sellTimestamp: Date.now(),
                sellSolAmount: 0,
                sellPriceSol: 0,
                pnlSol: rugLoss,
                pnlPct: -100,
                error: "Rug Pull",
              };
              tradeStore.upsert(closed);
              autoTraderEngine.markRecordClosed(pos.mintAddress);
              // Stop liquidity monitor if running
              const lmRug = liquidityMonitors.get(positionId);
              if (lmRug) { lmRug.stop(); liquidityMonitors.delete(positionId); }
              broadcastToClients({ type: "position_update", data: closed });
              console.log(`🚨 [Rug Pull] ${pos.symbol} manuel rug pull olarak kapatıldı (-%100)`);
            }
          }
        } else if (message.type === "delete_position") {
          const { positionId } = message.data || {};
          if (positionId) {
            const pos = tradeStore.getById(positionId);
            if (pos && (pos.status === "pending_buy" || pos.status === "pending_sell")) {
              trader.cancel(positionId);
            }
            tradeStore.delete(positionId);
            broadcastToClients({
              type: "positions_snapshot",
              data: {
                positions: tradeStore.getAll(),
                config: tradeStore.getConfig(),
                autoTraderConfig: autoTraderConfigStore.getConfig(),
                autoTraderRunning: autoTraderEngine.getIsRunning(),
                traderPublicKey: trader.getPublicKey(),
                traderReady: trader.isReady(),
                solPriceUsd: monitor.getSolPriceUsd(),
              },
            });
          }
        } else if (message.type === "update_position_hold_duration") {
          // Token başına özel tutma süresi güncelle
          const { positionId, holdDurationMs } = message.data || {};
          if (positionId && typeof holdDurationMs === "number" && holdDurationMs > 0) {
            const pos = tradeStore.getById(positionId);
            if (pos && (pos.status === "open" || pos.status === "pending_buy")) {
              const updated = { ...pos, customHoldDurationMs: holdDurationMs };
              tradeStore.upsert(updated);
              broadcastToClients({ type: "position_update", data: updated });
              // Auto-trader engine'de de güncelle (autoSellAt yeniden hesapla)
              autoTraderEngine.updatePositionHoldDuration(pos.mintAddress, holdDurationMs);
              console.log(`⏱️ [Routes] ${pos.symbol} özel tutma süresi: ${(holdDurationMs / 1000).toFixed(0)}s`);
            }
          }
        } else if (message.type === "request_positions") {
          sendPositionsSnapshot(ws);
        } else if (message.type === "request_auto_trader_status") {
          ws.send(
            JSON.stringify({
              type: "auto_trader_config_snapshot",
              data: {
                config: autoTraderConfigStore.getConfig(),
                records: autoTraderEngine.getRecords(),
              },
            })
          );
        } else if (message.type === "request_recent_mints") {
          const allEvents = eventStore.getLast(100);
          const mints = allEvents
            .filter((e) => e.type === "mint_detected")
            .reverse() // en yeni ilk
            .map((e) => e.data);
          ws.send(
            JSON.stringify({
              type: "recent_mints_snapshot",
              data: { mints },
            })
          );
        }
      } catch {
        // ignore
      }
    });

    ws.on("close", () => {
      _origLog("👋 Client bağlantısı kesildi");
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  wss.on("error", (error) => {
    _origError("❌ WebSocket Server hatası:", error);
  });

  // ---- Yarı Satış API ----
  app.post("/api/sell-half", async (req, res) => {
    const { positionId } = req.body || {};
    if (!positionId || typeof positionId !== "string") {
      return res.status(400).json({ error: "positionId gerekli" });
    }
    const pos = tradeStore.getById(positionId);
    if (!pos) {
      return res.status(404).json({ error: "Pozisyon bulunamadı" });
    }
    try {
      const result = await trader.sellHalf(positionId);
      if (!result) {
        return res.status(500).json({ error: "Yarı satış başlatılamadı" });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  // ------------------------

  process.on("SIGTERM", () => { monitor.stop(); autoTraderEngine.stop(); wss.close(); });
  process.on("SIGINT",  () => { monitor.stop(); autoTraderEngine.stop(); wss.close(); });

  return httpServer;
}
