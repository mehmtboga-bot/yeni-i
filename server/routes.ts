import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { HeliusMonitor } from "./helius-monitor";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const ALLOWED_FILES = [
  "server/helius-monitor.ts",
  "server/routes.ts",
  "server/index.ts",
  "server/storage.ts",
  "shared/schema.ts",
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
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
  // --------------------------

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
