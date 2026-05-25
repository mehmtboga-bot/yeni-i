/**
 * Auto Trader API Routes
 */

import type { Express } from "express";
import { getAutoTrader } from "./auto-trader-config";

export function setupAutoTraderRoutes(app: Express) {
  // Get current config
  app.get("/api/auto-trader/config", (req, res) => {
    const engine = getAutoTrader();
    res.json(engine.getConfig());
  });

  // Update config
  app.post("/api/auto-trader/config", (req, res) => {
    const engine = getAutoTrader();
    engine.updateConfig(req.body);
    res.json({ success: true, config: engine.getConfig() });
  });

  // Get trade records
  app.get("/api/auto-trader/records", (req, res) => {
    const engine = getAutoTrader();
    res.json(engine.getTradeRecords());
  });

  // Get stats
  app.get("/api/auto-trader/stats", (req, res) => {
    const engine = getAutoTrader();
    const records = engine.getTradeRecords();
    
    const buys = records.filter(r => r.type === "BUY").length;
    const sells = records.filter(r => r.type === "SELL").length;
    const totalBought = records
      .filter(r => r.type === "BUY")
      .reduce((sum, r) => sum + r.total, 0);
    const totalSold = records
      .filter(r => r.type === "SELL")
      .reduce((sum, r) => sum + r.total, 0);

    res.json({
      enabled: engine.getConfig().enabled,
      totalBuys: buys,
      totalSells: sells,
      totalBoughtSOL: totalBought,
      totalSoldSOL: totalSold,
      activePositions: engine.getActivePositionCount(),
      pnl: totalSold - totalBought,
    });
  });
}
