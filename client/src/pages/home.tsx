import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, BriefcaseBusiness, Bot, Wallet } from "lucide-react";
import { AutoTraderPanel } from "@/components/AutoTraderPanel";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { TradePanel } from "@/components/TradePanel";
import { WalletTrackingPanel } from "@/components/WalletTrackingPanel";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import type { AutoTraderConfig, Position, TradeConfig } from "@shared/schema";
import type { WalletMintEvent, WalletTrackingState } from "@shared/wallet-tracking";

const initialTradeConfig: TradeConfig = {
  solAmount: 0.01,
  slippageBps: 10_000,
  priorityFeeManualMicroLamports: 700_000,
  priorityFeeAutoMicroLamports: 1_000_000,
  takeProfitPct: 0,
};

const initialAutoTraderConfig: AutoTraderConfig = {
  enabled: false,
  solAmountPerTrade: 0.1,
  maxTokensHeld: 5,
  holdDurationMs: 60_000,
  profitTargetPct: 50,
  stopLossPct: 20,
  slippageBps: 5_000,
  priorityFeeMicroLamports: 1_000_000,
  minLiquidityUsd: 5_000,
  skipRecentlyTradedSymbols: true,
  halfSellTarget1: 0,
  halfSellTarget2: 0,
  halfSellTarget3: 0,
};

const initialWalletState: WalletTrackingState = {
  walletAddress: "",
  isWatching: false,
  autoBuyRunning: false,
  tokens: [],
};

function updatePosition(positions: Position[], position: Position) {
  const index = positions.findIndex((item) => item.id === position.id);
  if (index < 0) return [position, ...positions];
  return positions.map((item, itemIndex) => itemIndex === index ? position : item);
}

function updateWalletToken(tokens: WalletMintEvent[], token: WalletMintEvent) {
  const index = tokens.findIndex((item) => item.mintAddress === token.mintAddress);
  if (index < 0) return [token, ...tokens];
  return tokens.map((item, itemIndex) =>
    itemIndex === index ? { ...item, ...token } : item,
  );
}

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [positions, setPositions] = useState<Position[]>([]);
  const [tradeConfig, setTradeConfig] = useState<TradeConfig>(initialTradeConfig);
  const [autoTraderConfig, setAutoTraderConfig] = useState<AutoTraderConfig>(initialAutoTraderConfig);
  const [autoTraderRunning, setAutoTraderRunning] = useState(false);
  const [traderReady, setTraderReady] = useState(false);
  const [traderPublicKey, setTraderPublicKey] = useState<string>();
  const [solPriceUsd, setSolPriceUsd] = useState(0);
  const [walletState, setWalletState] = useState<WalletTrackingState>(initialWalletState);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socketRef.current = ws;
    setSocket(ws);

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "request_positions" }));
      ws.send(JSON.stringify({ type: "request_auto_trader_status" }));
      ws.send(JSON.stringify({ type: "request_wallet_tracking_state" }));
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type: string; data: any };
      switch (message.type) {
        case "positions_snapshot":
          setPositions(message.data.positions ?? []);
          if (message.data.config) setTradeConfig(message.data.config);
          if (message.data.autoTraderConfig) setAutoTraderConfig(message.data.autoTraderConfig);
          if (typeof message.data.autoTraderRunning === "boolean") {
            setAutoTraderRunning(message.data.autoTraderRunning);
          }
          setTraderReady(Boolean(message.data.traderReady));
          setTraderPublicKey(message.data.traderPublicKey);
          if (typeof message.data.solPriceUsd === "number") setSolPriceUsd(message.data.solPriceUsd);
          break;
        case "position_update":
          setPositions((current) => updatePosition(current, message.data as Position));
          break;
        case "trade_config_update":
          if (message.data.config) setTradeConfig(message.data.config);
          break;
        case "auto_trader_config_snapshot":
        case "auto_trader_config_updated":
          if (message.data.config) setAutoTraderConfig(message.data.config);
          if (Array.isArray(message.data.records)) setAutoTraderRunning(true);
          break;
        case "auto_trader_state":
          setAutoTraderRunning(Boolean(message.data.running));
          break;
        case "wallet_tracking_state":
          setWalletState(message.data as WalletTrackingState);
          break;
        case "wallet_mint_detected":
          setWalletState((current) => ({
            ...current,
            tokens: updateWalletToken(current.tokens, message.data as WalletMintEvent).slice(0, 100),
          }));
          break;
        case "wallet_mint_updated":
          setWalletState((current) => ({
            ...current,
            tokens: updateWalletToken(current.tokens, message.data as WalletMintEvent).slice(0, 100),
          }));
          break;
        case "wallet_tracking_error":
          toast({
            title: "Cüzdan takibi hatası",
            description: message.data.message,
            variant: "destructive",
          });
          break;
        case "error":
          toast({
            title: "İşlem hatası",
            description: message.data.message,
            variant: "destructive",
          });
          break;
      }
    };

    return () => {
      socketRef.current = null;
      ws.close();
    };
  }, []);

  const send = (type: string, data?: unknown) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast({
        title: "Sunucu bağlantısı yok",
        description: "İşlem için WebSocket bağlantısının kurulmasını bekleyin.",
        variant: "destructive",
      });
      return;
    }
    ws.send(JSON.stringify({ type, data }));
  };

  const openMints = useMemo(
    () => new Set(positions
      .filter((position) => ["open", "pending_buy", "pending_sell"].includes(position.status))
      .map((position) => position.mintAddress)),
    [positions],
  );

  const buyWalletToken = (token: WalletMintEvent) => {
    send("buy_token", {
      mintAddress: token.mintAddress,
      name: token.name,
      symbol: token.symbol,
      dex: "jupiter",
    });
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Solana Token Monitor</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tokenleri takip edin, filtreleyin ve işlemlerinizi yönetin.
          </p>
        </div>
        <ConnectionStatus isConnected={connected} />
      </header>

      <Tabs defaultValue="wallet-tracking" className="space-y-4">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="wallet-tracking" data-testid="tab-wallet-tracking">
            <Wallet className="mr-2 h-4 w-4" />
            Cüzdan Takibi
          </TabsTrigger>
          <TabsTrigger value="auto-trader" data-testid="tab-auto-trader">
            <Bot className="mr-2 h-4 w-4" />
            Otomatik Ticaret
          </TabsTrigger>
          <TabsTrigger value="positions" data-testid="tab-positions">
            <BriefcaseBusiness className="mr-2 h-4 w-4" />
            Pozisyonlar
          </TabsTrigger>
        </TabsList>

        <TabsContent value="wallet-tracking">
          <WalletTrackingPanel
            state={walletState}
            traderReady={traderReady}
            openMints={openMints}
            onSaveAddress={(walletAddress) => send("wallet_tracking_save", { walletAddress })}
            onToggleWatching={(enabled) => send("wallet_tracking_toggle", { enabled })}
            onToggleAutoBuy={(enabled) => send("wallet_auto_buy_toggle", { enabled })}
            onBuy={buyWalletToken}
          />
        </TabsContent>

        <TabsContent value="auto-trader">
          <AutoTraderPanel
            config={autoTraderConfig}
            isRunning={autoTraderRunning}
            onConfigUpdate={(config) => send("auto_trader_config_update", config)}
            onToggle={(enabled) => send("toggle_auto_trader", { enabled })}
          />
        </TabsContent>

        <TabsContent value="positions">
          {connected ? (
            <TradePanel
              positions={positions}
              config={tradeConfig}
              traderPublicKey={traderPublicKey}
              traderReady={traderReady}
              solPriceUsd={solPriceUsd}
              globalHoldDurationMs={autoTraderConfig.holdDurationMs}
              ws={socket}
              onBuy={(mintAddress, name, symbol, dex, solAmount) =>
                send("buy_token", { mintAddress, name, symbol, dex, solAmount })
              }
              onSell={(positionId, percentage) => send("sell_token", { positionId, percentage })}
              onSellHalf={(positionId) => send("sell_token", { positionId, percentage: 50 })}
              onDelete={(positionId) => send("delete_position", { positionId })}
              onMarkRugPull={(positionId) => send("mark_rug_pull", { positionId })}
              onUpdateConfig={(config) => send("trade_config_update", config)}
              onUpdateHoldDuration={(positionId, holdDurationMs) =>
                send("update_position_hold_duration", { positionId, holdDurationMs })
              }
            />
          ) : (
            <Card className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
              <Activity className="h-4 w-4" />
              Pozisyonlar sunucuya bağlanınca yüklenecek.
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </main>
  );
}
