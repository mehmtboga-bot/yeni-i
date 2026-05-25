import { useEffect, useRef, useCallback } from "react";
import type { AutoTraderConfig, AutoTradeRecord, WSMessage } from "@shared/schema";

interface UseAutoTraderOptions {
  onConfigUpdate?: (config: AutoTraderConfig) => void;
  onRecordsUpdate?: (records: AutoTradeRecord[]) => void;
  onStatusUpdate?: (isRunning: boolean) => void;
}

export function useAutoTrader(
  ws: WebSocket | null,
  options: UseAutoTraderOptions = {}
) {
  const { onConfigUpdate, onRecordsUpdate, onStatusUpdate } = options;
  const handlerRef = useRef<(msg: WSMessage) => void>();

  // Handler tanımı
  useEffect(() => {
    handlerRef.current = (msg: WSMessage) => {
      if (msg.type === "auto_trader_config_update") {
        onConfigUpdate?.(msg.data);
      } else if (msg.type === "auto_trade_record_update") {
        onRecordsUpdate?.([msg.data]);
      } else if (msg.type === "auto_trader_status") {
        onConfigUpdate?.(msg.data.config);
        onRecordsUpdate?.(msg.data.records);
        onStatusUpdate?.(msg.data.isRunning);
      }
    };
  }, [onConfigUpdate, onRecordsUpdate, onStatusUpdate]);

  // WebSocket listener
  useEffect(() => {
    if (!ws) return;

    const listener = (event: Event) => {
      if (!(event instanceof MessageEvent)) return;
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        handlerRef.current?.(msg);
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    };

    ws.addEventListener("message", listener);
    return () => ws.removeEventListener("message", listener);
  }, [ws]);

  // Config güncelle
  const updateConfig = useCallback(
    (config: Partial<AutoTraderConfig>) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error("WebSocket not connected");
        return;
      }
      ws.send(
        JSON.stringify({
          type: "update_auto_trader_config",
          data: config,
        })
      );
    },
    [ws]
  );

  // Otomatik traderi başlat/durdur
  const toggleAutoTrader = useCallback(
    (enabled: boolean) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error("WebSocket not connected");
        return;
      }
      ws.send(
        JSON.stringify({
          type: "toggle_auto_trader",
          data: { enabled },
        })
      );
    },
    [ws]
  );

  return { updateConfig, toggleAutoTrader };
}
