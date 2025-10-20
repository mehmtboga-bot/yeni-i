import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { HeliusMonitor } from "./helius-monitor";

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

  const monitor = new HeliusMonitor((event: string, data: any) => {
    if (event === "mint_detected") {
      broadcastToClients({ type: "mint_detected", data });
    } else if (event === "lp_detected") {
      broadcastToClients({ type: "lp_detected", data });
    } else if (event === "connection_status") {
      broadcastToClients({ type: "connection_status", data });
    }
  });

  monitor.start();

  wss.on("connection", (ws: WebSocket) => {
    console.log("👤 Yeni client bağlandı");
    clients.add(ws);

    ws.send(
      JSON.stringify({
        type: "connection_status",
        data: { connected: true, message: "Bağlantı kuruldu" },
      })
    );

    ws.on("close", () => {
      console.log("👋 Client bağlantısı kesildi");
      clients.delete(ws);
    });

    ws.on("error", (error) => {
      console.error("❌ Client WebSocket hatası:", error);
      clients.delete(ws);
    });
  });

  wss.on("error", (error) => {
    console.error("❌ WebSocket Server hatası:", error);
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM alındı, kapatılıyor...");
    monitor.stop();
    wss.close();
  });

  process.on("SIGINT", () => {
    console.log("SIGINT alındı, kapatılıyor...");
    monitor.stop();
    wss.close();
  });

  return httpServer;
}
