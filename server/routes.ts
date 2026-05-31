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
      if (filePath === "data/whitelist.txt") {
        whitelistManager.updateWhitelist(
          content
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        );
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
      }
    } else if (event === "trade_config_update") {
      broadcastToClients({ type: "trade_config_update", data });
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
        console.log(`🤖 [Auto-Trader] Alım başlatılıyor: ${sym} (${mintAddress}) | DEX: ${dex || "jupiter"} | SOL: ${solAmount}`);
        if (dex === "pumpswap") {
          trader.buyPumpSwap({ mintAddress, name: nm, symbol: sym, solAmount })
            .catch((err) => {
              console.error("Auto-buy (PumpSwap) hatası:", err);
              autoTraderEngine.markRecordFailed(mintAddress, String(err));
            });
        } else {
          trader.buy({ mintAddress, name: nm, symbol: sym, solAmount })
            .catch((err) => {
              console.error("Auto-buy hatası:", err);
              autoTraderEngine.markRecordFailed(mintAddress, String(err));
            });
        }
      } else if (event === "auto_sell_ready") {
        if (data.forceClose) {
          // Likidite düşüşü — token satılmadan zarar olarak kapat (rug pull)
          const pos = tradeStore.getById(data.positionId);
          if (pos && pos.status === "open") {
            const rugLoss = -(pos.buySolAmount ?? 0);
            const closed = {
              ...pos,
              status: "closed" as const,
              sellTimestamp: Date.now(),
              sellSolAmount: 0,
              sellPriceSol: 0,
              pnlSol: rugLoss,
              pnlPct: -100,
              error: data.reason === "liquidity_drop"
                ? "Likidite %80 Düştü — Rug Pull"
                : "Force Closed",
            };
            tradeStore.upsert(closed);
            broadcastToClients({ type: "position_update", data: closed });
            autoTraderEngine.updateRecordAfterSell(
              pos.mintAddress,
              "",
              0,
              rugLoss,
              -100
            );
            console.log(`🚨 [Auto-Trader] ${pos.symbol} likidite düşüşü nedeniyle -%100 zararla kapatıldı`);
          }
        } else {
          // Otomatik satış yapılacak pozisyon
          trader.sell(data.positionId).catch((err) => console.error("Auto-sell hatası:", err));
        }
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

        // Auto-trader'a bildir (record tutması için)
        autoTraderEngine.onLPDetected(data).catch((err) => console.error("Auto-trader LP hatası:", err));

        // Eğer token son 15 dakikada görüldüyse, manuel alım için arayüzde göster ama otomatik alım yapma
        const isRecentlySkipped = monitor.isTokenRecentlySkipped(sym);
        if (isRecentlySkipped) {
          console.log(`⏭️ [Fast-Buy] ${sym} son 15 dakikada görüldü, manuel alım için arayüzde gösteriliyor`);
          // Otomatik alım yapma, sadece arayüzde göster (zaten token_skipped event'i yayınlanıyor)
          return;
        }

        // Yeni token ise direkt alım yap
        console.log(`⚡ [Fast-Buy] Direkt alım başlatılıyor: ${sym} (${mintAddress}) | TVL=${tvlUsd?.toFixed(0) ?? "?"} | SOL: ${solAmount}`);

        if (dex === "pumpswap") {
          trader.buyPumpSwap({ mintAddress, name: nm, symbol: sym, solAmount })
            .catch((err) => {
              console.error("Fast-buy (PumpSwap) hatası:", err);
            });
        } else {
          trader.buy({ mintAddress, name: nm, symbol: sym, solAmount })
            .catch((err) => {
              console.error("Fast-buy hatası:", err);
            });
        }
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



    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "toggle_monitoring") {
          const enabled = message.data.enabled;
          console.log(`🔄 Monitor ${enabled ? "başlatılıyor" : "durduruluyor"}...`);
          monitor.setMonitoringEnabled(enabled);
          broadcastToClients({
            type: "monitoring_state",
            data: { isMonitoring: enabled },
          });
        } else if (message.type === "get_balance") {
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
            if (dex === "pumpswap") {
              trader.buyPumpSwap({ mintAddress, name: nm, symbol: sym })
                .catch((err) => console.error("buyPumpSwap hatası:", err));
            } else {
              trader.buy({ mintAddress, name: nm, symbol: sym })
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
          const { solAmount, slippageBps, priorityFeeMicroLamports, takeProfitPct } = message.data || {};
          const partial: Record<string, number> = {};
          if (typeof solAmount === "number" && solAmount > 0) partial.solAmount = solAmount;
          if (typeof slippageBps === "number" && slippageBps >= 50) partial.slippageBps = slippageBps;
          if (typeof priorityFeeMicroLamports === "number" && priorityFeeMicroLamports >= 0) partial.priorityFeeMicroLamports = priorityFeeMicroLamports;
          if (typeof takeProfitPct === "number" && takeProfitPct >= 0) partial.takeProfitPct = takeProfitPct;
          if (Object.keys(partial).length) trader.updateConfig(partial as any);
        } else if (message.type === "auto_trader_config_update") {
          // Otomatik trader konfigürasyonu güncelle
          const { solAmountPerTrade, maxTokensHeld, holdDurationMs, profitTargetPct, stopLossPct, slippageBps, priorityFeeMicroLamports, minLiquidityUsd, enabled } = message.data || {};
          const partial: Record<string, any> = {};
          if (typeof solAmountPerTrade === "number" && solAmountPerTrade > 0) partial.solAmountPerTrade = solAmountPerTrade;
          if (typeof maxTokensHeld === "number" && maxTokensHeld > 0) partial.maxTokensHeld = maxTokensHeld;
          if (typeof holdDurationMs === "number" && holdDurationMs > 0) partial.holdDurationMs = holdDurationMs;
          if (typeof profitTargetPct === "number" && profitTargetPct >= 0) partial.profitTargetPct = profitTargetPct;
          if (typeof stopLossPct === "number" && stopLossPct >= 0) partial.stopLossPct = stopLossPct;
          if (typeof slippageBps === "number" && slippageBps >= 50) partial.slippageBps = slippageBps;
          if (typeof priorityFeeMicroLamports === "number" && priorityFeeMicroLamports >= 0) partial.priorityFeeMicroLamports = priorityFeeMicroLamports;
          if (typeof minLiquidityUsd === "number" && minLiquidityUsd >= 0) partial.minLiquidityUsd = minLiquidityUsd;
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

  process.on("SIGTERM", () => { monitor.stop(); autoTraderEngine.stop(); wss.close(); });
  process.on("SIGINT",  () => { monitor.stop(); autoTraderEngine.stop(); wss.close(); });

  return httpServer;
}
