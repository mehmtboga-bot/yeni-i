import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { HeliusMonitor } from "./helius-monitor";

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

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const clients = new Set<WebSocket>();

  const broadcastToClients = (message: any) => {
    const data = JSON.stringify(message);
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  };

  // Console yakalayıcıya broadcast fonksiyonunu bağla
  _broadcast = (level, message) => {
    broadcastToClients({
      type: "server_log",
      data: { level, message, timestamp: Date.now() },
    });
  };

  const monitor = new HeliusMonitor((event: string, data: any) => {
    if (event === "mint_detected") {
      broadcastToClients({ type: "mint_detected", data });
    } else if (event === "lp_detected") {
      broadcastToClients({ type: "lp_detected", data });
    } else if (event === "connection_status") {
      broadcastToClients({ type: "connection_status", data });
    } else if (event === "monitoring_state") {
      broadcastToClients({ type: "monitoring_state", data });
    } else if (event === "error") {
      broadcastToClients({ type: "error", data });
    }
  });

  monitor.start();

  wss.on("connection", (ws: WebSocket) => {
    _origLog("👤 Yeni client bağlandı");
    clients.add(ws);

    ws.send(
      JSON.stringify({
        type: "monitoring_state",
        data: { isMonitoring: monitor.getState() },
      })
    );

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "toggle_monitoring") {
          if (message.data.enabled) {
            monitor.start();
          } else {
            monitor.stop();
          }
        } else if (message.type === "get_balance") {
          const publicKey = message.data.publicKey;
          try {
            const balance = await monitor.getWalletBalance(publicKey);
            ws.send(JSON.stringify({ type: "balance_update", data: { balance, publicKey } }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: "error",
              data: { message: "Bakiye çekilemedi. Lütfen adresi kontrol edin." },
            }));
          }
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

  process.on("SIGTERM", () => { monitor.stop(); wss.close(); });
  process.on("SIGINT",  () => { monitor.stop(); wss.close(); });

  return httpServer;
}
