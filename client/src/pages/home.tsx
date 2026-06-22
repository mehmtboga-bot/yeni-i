import { useEffect, useRef, useState } from "react";
import { Bot, Coins, Droplet, Lock } from "lucide-react";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { MintedTokenCard } from "@/components/MintedTokenCard";
import { LPLogTable } from "@/components/LPLogTable";
import { WalletBalance } from "@/components/WalletBalance";
import { FileEditor } from "@/components/FileEditor";
import { TradePanel } from "@/components/TradePanel";
import { AutoTraderPanel } from "@/components/AutoTraderPanel";
import { TokenComparisonPanel } from "@/components/TokenComparisonPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MintedToken, LPDetection, WSMessage, Position, TradeConfig, AutoTraderConfig } from "@shared/schema";
import type { ServerLog } from "@/components/LogPanel";

const MAX_MINTED_TOKENS = 7;
const MAX_LP_LOGS = 30;
const MINT_DISPLAY_DURATION = 3 * 60 * 1000;
const LP_LOG_DURATION = 5 * 60 * 1000;

type Tab = "console" | "dashboard" | "trade" | "files";

const DEFAULT_CONFIG: TradeConfig = {
  solAmount: 0.01,
  slippageBps: 5000,
  priorityFeeManualMicroLamports: 700_000,
  priorityFeeAutoMicroLamports: 1_000_000,
  takeProfitPct: 0,
};

const DEFAULT_AUTO_TRADER_CONFIG: AutoTraderConfig = {
  enabled: false,
  solAmountPerTrade: 0.1,
  maxTokensHeld: 5,
  holdDurationMs: 60000,
  profitTargetPct: 50,
  stopLossPct: 20,
  slippageBps: 5000,
  priorityFeeMicroLamports: 1000000,
  minLiquidityUsd: 5000,
  halfSellTarget1: 0,
  halfSellTarget2: 0,
  halfSellTarget3: 0,
};

type StoredEvent = { id: number; type: string; data: any; timestamp: number };

function TriangleIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
      <polygon
        points="12,4 22,20 2,20"
        fill={active ? "hsl(var(--primary))" : "none"}
        stroke={active ? "hsl(var(--primary))" : "currentColor"}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function SquareIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
      <rect
        x="4" y="4" width="16" height="16" rx="1"
        fill={active ? "hsl(var(--primary))" : "none"}
        stroke={active ? "hsl(var(--primary))" : "currentColor"}
        strokeWidth="1.8"
      />
    </svg>
  );
}
function CircleIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
      <circle
        cx="12" cy="12" r="9"
        fill={active ? "hsl(var(--primary))" : "none"}
        stroke={active ? "hsl(var(--primary))" : "currentColor"}
        strokeWidth="1.8"
      />
    </svg>
  );
}
function PlusIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
      <path
        d="M12 4v16M4 12h16"
        stroke={active ? "hsl(var(--primary))" : "currentColor"}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
const levelStyle: Record<ServerLog["level"], string> = {
  info:  "text-emerald-400",
  warn:  "text-yellow-400",
  error: "text-red-400",
};
const levelPrefix: Record<ServerLog["level"], string> = {
  info:  "",
  warn:  "[WARN] ",
  error: "[ERR]  ",
};
function formatTime(ts: number) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}

function loadMintedTokens(): MintedToken[] {
  // localStorage fallback kaldırıldı — sunucu tek kaynak
  return [];
}

function loadLpLogs(): LPDetection[] {
  // localStorage fallback kaldırıldı — sunucu tek kaynak
  return [];
}

function loadPositions(): Position[] {
  try {
    const raw = localStorage.getItem("positions");
    if (!raw) return [];
    return (JSON.parse(raw) as Position[]);
  } catch {
    return [];
  }
}

function loadServerLogs(): ServerLog[] {
  try {
    const raw = localStorage.getItem("serverLogs");
    if (!raw) return [];
    return (JSON.parse(raw) as ServerLog[]);
  } catch {
    return [];
  }
}

function loadTradeConfig(): TradeConfig {
  try {
    const raw = localStorage.getItem("tradeConfig");
    if (!raw) return DEFAULT_CONFIG;
    return JSON.parse(raw) as TradeConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

function loadAutoTraderConfig(): AutoTraderConfig {
  try {
    const raw = localStorage.getItem("autoTraderConfig");
    if (!raw) return DEFAULT_AUTO_TRADER_CONFIG;
    return JSON.parse(raw) as AutoTraderConfig;
  } catch {
    return DEFAULT_AUTO_TRADER_CONFIG;
  }
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [autoTraderOpen, setAutoTraderOpen] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [mintedTokens, setMintedTokens] = useState<MintedToken[]>(loadMintedTokens);
  const [lpLogs, setLpLogs] = useState<LPDetection[]>(loadLpLogs);
  const [newTokenId, setNewTokenId] = useState<string | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [lastPublicKey, setLastPublicKey] = useState<string | null>(null);
  const [serverLogs, setServerLogs] = useState<ServerLog[]>(loadServerLogs);
  const [positions, setPositions] = useState<Position[]>(loadPositions);
  const [tradeConfig, setTradeConfig] = useState<TradeConfig>(loadTradeConfig);
  const [autoTraderConfig, setAutoTraderConfig] = useState<AutoTraderConfig>(loadAutoTraderConfig);
  const [autoTraderRunning, setAutoTraderRunning] = useState(false);
  const [traderPublicKey, setTraderPublicKey] = useState<string | undefined>();
  const [traderReady, setTraderReady] = useState(false);
  const [solPriceUsd, setSolPriceUsd] = useState<number>(0);
  const [tokenComparison, setTokenComparison] = useState<any[]>([]);
  // logIdRef'i localStorage'dan yüklenen logların max id'sinden başlat
  // böylece sayfa yenilenince yeni loglar çakışan key almaz
  const logIdRef = useRef(
    serverLogs.length > 0 ? Math.max(...serverLogs.map((l) => l.id)) : 0
  );
  const logBottomRef = useRef<HTMLDivElement>(null);

  const handleGetBalance = (publicKey: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "get_balance", data: { publicKey } }));
    }
  };

  const handleBuy = (mintAddress: string, name: string, symbol: string, dex: "jupiter" | "pumpswap" = "jupiter", solAmount?: number) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload: Record<string, any> = { 
        mintAddress, 
        name, 
        symbol, 
        dex: dex || "jupiter"  // Undefined ise default "jupiter" kullan
      };
      if (typeof solAmount === "number" && solAmount > 0) payload.solAmount = solAmount;
      ws.send(JSON.stringify({ type: "buy_token", data: payload }));
    }
  };

  const handleSell = (positionId: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "sell_token", data: { positionId } }));
    }
  };

  const handleSellHalf = async (positionId: string) => {
    try {
      const res = await fetch("/api/sell-half", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Bilinmeyen hata" }));
        console.error("Yarı satış hatası:", err.error);
        return;
      }
      const updated = await res.json();
      setPositions((prev) => {
        const idx = prev.findIndex((p) => p.id === updated.id);
        const next = idx >= 0 ? [...prev] : [updated, ...prev];
        if (idx >= 0) next[idx] = updated;
        try { localStorage.setItem("positions", JSON.stringify(next)); } catch {}
        return next;
      });
    } catch (err) {
      console.error("Yarı satış isteği başarısız:", err);
    }
  };

  const handleDeletePosition = (positionId: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "delete_position", data: { positionId } }));
    }
  };

  const handleMarkRugPull = (positionId: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "mark_rug_pull", data: { positionId } }));
    }
  };

  const handleConfigUpdate = (cfg: Partial<TradeConfig>) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "trade_config_update", data: cfg }));
    }
  };

  const handleAutoTraderConfigUpdate = (cfg: Partial<AutoTraderConfig>) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "auto_trader_config_update", data: cfg }));
    }
  };

  const handleAutoTraderToggle = (enabled: boolean) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "toggle_auto_trader", data: { enabled } }));
    }
  };

  const handleUpdateHoldDuration = (positionId: string, holdDurationMs: number) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "update_position_hold_duration", data: { positionId, holdDurationMs } }));
    }
  };

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "localhost:5000";
    const wsUrl = `${protocol}//${host}/ws`;
    let wsInstance: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;

    const handleIncomingMessage = (msg: StoredEvent) => {
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "mint_detected") {
        const token = msg.data;
        setMintedTokens((prev) => {
          return [token, ...prev.filter((t) => t.id !== token.id)].slice(0, MAX_MINTED_TOKENS);
        });
        setNewTokenId(token.id);
        setTimeout(() => setNewTokenId(null), 1000);
      } else if (msg.type === "lp_detected") {
        const lpLog = msg.data;
        setLpLogs((prev) => {
          return [lpLog, ...prev.filter((l) => l.id !== lpLog.id)].slice(0, MAX_LP_LOGS);
        });
      } else if (msg.type === "connection_status") {
        setIsConnected(msg.data.connected);
        setConnectionMessage(msg.data.message || "");
      } else if (msg.type === "balance_update") {
        setWalletBalance(msg.data.balance);
        setLastPublicKey(msg.data.publicKey);
      } else if (msg.type === "error") {
        setConnectionMessage(msg.data.message);
      } else if (msg.type === "server_log") {
        setServerLogs((prev) => {
          const next = [
            ...prev,
            {
              id: ++logIdRef.current,
              level: msg.data.level,
              message: msg.data.message,
              timestamp: msg.data.timestamp,
            },
          ].slice(-50);
          try { localStorage.setItem("serverLogs", JSON.stringify(next)); } catch {}
          return next;
        });
      } else if (msg.type === "positions_snapshot") {
        // Sunucudan gelen pozisyonları localStorage'dakilerle birleştir:
        // Sunucu verisi her zaman önceliklidir, ama localStorage'da olup
        // sunucuda olmayan açık pozisyonlar (geçici ağ kesintisi vb.) korunur.
        const serverPositions: Position[] = Array.isArray(msg.data.positions) ? msg.data.positions : [];
        setPositions((prev) => {
          if (serverPositions.length === 0) {
            // Sunucu boş liste döndürdüyse localStorage'daki veriyi koru
            return prev;
          }
          // Sunucu pozisyonlarını önce al, sonra localStorage'da olup
          // sunucuda olmayan açık pozisyonları ekle (orphan guard)
          const serverIds = new Set(serverPositions.map((p) => p.id));
          const localOnly = prev.filter(
            (p) => !serverIds.has(p.id) && (p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell")
          );
          const merged = [...serverPositions, ...localOnly];
          try { localStorage.setItem("positions", JSON.stringify(merged)); } catch {}
          return merged;
        });
        if (msg.data.config) {
          setTradeConfig(msg.data.config);
          try { localStorage.setItem("tradeConfig", JSON.stringify(msg.data.config)); } catch {}
        }
        const atCfg = msg.data.autoTraderConfig || DEFAULT_AUTO_TRADER_CONFIG;
        setAutoTraderConfig(atCfg);
        try { localStorage.setItem("autoTraderConfig", JSON.stringify(atCfg)); } catch {}
        setAutoTraderRunning(msg.data.autoTraderRunning || false);
        setTraderPublicKey(msg.data.traderPublicKey);
        setTraderReady(msg.data.traderReady);
        if (typeof msg.data.solPriceUsd === "number" && msg.data.solPriceUsd > 0) {
          setSolPriceUsd(msg.data.solPriceUsd);
        }
      } else if (msg.type === "position_update") {
        const updated = msg.data;
        setPositions((prev) => {
          const idx = prev.findIndex((p) => p.id === updated.id);
          const next = idx >= 0 ? [...prev] : [updated, ...prev];
          if (idx >= 0) next[idx] = updated;
          try { localStorage.setItem("positions", JSON.stringify(next)); } catch {}
          return next;
        });
      } else if (msg.type === "trade_config_update") {
        setTradeConfig(msg.data);
        try { localStorage.setItem("tradeConfig", JSON.stringify(msg.data)); } catch {}
      } else if (msg.type === "auto_trader_config_update" || msg.type === "auto_trader_config_updated") {
        // Sunucu "auto_trader_config_updated" (geçmiş zaman) gönderir;
        // her iki varyantı da destekle.
        const cfgData = msg.data?.config ?? msg.data;
        setAutoTraderConfig(cfgData);
        try { localStorage.setItem("autoTraderConfig", JSON.stringify(cfgData)); } catch {}
      } else if (msg.type === "auto_trader_state") {
        setAutoTraderRunning(msg.data.running);
      } else if (msg.type === "token_comparison_snapshot") {
        setTokenComparison(msg.data);
      } else if (msg.type === "recent_mints_snapshot") {
        // recent_mints_snapshot artık kullanılmıyor — active_tokens_snapshot tercih edilir
      } else if (msg.type === "active_tokens_snapshot") {
        // Sunucu tek kaynak: gelen tokenlar direkt replace eder (merge değil)
        const now = Date.now();
        const incomingTokens: any[] = (msg.data.tokens || []).filter((t: any) => t.expiresAt > now);
        const incomingLpLogs: any[] = (msg.data.lpLogs || []).filter((l: any) => l.expiresAt > now);

        setMintedTokens(incomingTokens.slice(0, MAX_MINTED_TOKENS));
        setLpLogs(incomingLpLogs.slice(0, MAX_LP_LOGS));
      }
    };

    const connect = () => {
      wsInstance = new WebSocket(wsUrl);
      setWs(wsInstance);

      wsInstance.onopen = () => {
        setIsConnected(true);
        setConnectionMessage("");
        // Token karşılaştırma iste
        wsInstance?.send(JSON.stringify({ type: "request_token_comparison" }));
        // Sunucudan tüm aktif tokenları çek — localStorage değil, sunucu tek kaynak
        wsInstance?.send(JSON.stringify({ type: "request_active_tokens" }));
      };

      wsInstance.onmessage = (event) => {
        try {
          const message: StoredEvent = JSON.parse(event.data);
          handleIncomingMessage(message);
        } catch { }
      };

      wsInstance.onerror = () => { setIsConnected(false); setConnectionMessage("Bağlantı hatası"); };
      wsInstance.onclose = () => {
        setIsConnected(false);
        setConnectionMessage("Yeniden bağlanıyor...");
        setWs(null);
        reconnectTimeout = setTimeout(connect, 3000);
      };
    };

    connect();

    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      setMintedTokens((prev) => prev.filter((t) => t.expiresAt > now));
      setLpLogs((prev) => prev.filter((l) => l.expiresAt > now));
    }, 1000);

    return () => {
      clearInterval(cleanupInterval);
      clearTimeout(reconnectTimeout);
      if (wsInstance) wsInstance.close();
    };
  }, []);

  useEffect(() => {
    if (activeTab === "console") {
      setTimeout(() => logBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }, [activeTab, serverLogs]);

  const lockedLogs = lpLogs.filter((l) => l.isLocked);
  const displayPrice = solPriceUsd > 0 ? solPriceUsd : 87;
  const openPositionCount = positions.filter((p) => p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell").length;

  const activeBuyMints = new Set(
    positions
      .filter((p) => p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell")
      .map((p) => p.mintAddress),
  );

  const TABS: { id: Tab; label: string; icon: (a: boolean) => JSX.Element }[] = [
    { id: "console",   label: "Konsol",   icon: (a) => <TriangleIcon active={a} /> },
    { id: "dashboard", label: "Dashboard", icon: (a) => <SquareIcon  active={a} /> },
    { id: "trade",     label: "Trade",    icon: (a) => <PlusIcon    active={a} /> },
    { id: "files",     label: "Dosyalar", icon: (a) => <CircleIcon   active={a} /> },
  ];

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <header className="sticky top-0 z-50 bg-card border-b border-card-border backdrop-blur-sm bg-card/95 shrink-0">
        <div className="px-4 sm:px-6 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary to-chart-2 flex items-center justify-center shrink-0">
                <Coins className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h1
                  className="text-lg sm:text-xl font-bold bg-gradient-to-r from-primary to-chart-2 bg-clip-text text-transparent"
                  data-testid="text-title"
                >
                  MEMO s KİNGDOM
                </h1>
                <p className="text-[10px] text-muted-foreground hidden sm:block">
                  Gerçek zamanlı mint ve LP tespiti
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-1">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    data-testid={`button-tab-${tab.id}`}
                    title={tab.label}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
                      isActive
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab.icon(isActive)}
                    <span className="hidden sm:inline">{tab.label}</span>
                    {tab.id === "trade" && openPositionCount > 0 && (
                      <Badge className="ml-1 px-1.5 py-0 text-[10px] bg-primary/20 text-primary border-0">
                        {openPositionCount}
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAutoTraderOpen(true)}
                data-testid="button-open-auto-trader"
                className={`gap-1.5 text-xs font-medium transition-colors ${
                  autoTraderConfig.enabled
                    ? "border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Bot className="h-4 w-4" />
                <span className="hidden sm:inline">Auto Trader</span>
                {autoTraderConfig.enabled && (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                )}
              </Button>
              <ConnectionStatus
                isConnected={isConnected}
                message={connectionMessage}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className={`h-full flex-col bg-zinc-950 ${activeTab === "console" ? "flex" : "hidden"}`}>
          <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900 shrink-0">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-mono font-semibold text-zinc-200">Sunucu Logları</span>
            <span className="text-xs text-zinc-500 font-mono">({serverLogs.length} satır)</span>
            <button
              onClick={() => {
                setServerLogs([]);
                try { localStorage.removeItem("serverLogs"); } catch {}
              }}
              className="ml-auto text-xs hover:text-zinc-300 text-zinc-500 transition-colors"
              title="Logları temizle"
            >
              ✕ Temizle
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5 space-y-0.5">
            {serverLogs.length === 0 ? (
              <p className="text-zinc-600 pt-8 text-center">Sunucu logları bekleniyor...</p>
            ) : (
              serverLogs.map((log) => (
                <div key={log.id} className="flex gap-2 items-start">
                  <span className="text-zinc-600 shrink-0 select-none">{formatTime(log.timestamp)}</span>
                  <span className={`${levelStyle[log.level]} break-all whitespace-pre-wrap`}>
                    {levelPrefix[log.level]}{log.message}
                  </span>
                </div>
              ))
            )}
            <div ref={logBottomRef} />
          </div>
        </div>

        <div className={`h-full overflow-y-auto ${activeTab === "dashboard" ? "block" : "hidden"}`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
            <WalletBalance
              onGetBalance={handleGetBalance}
              balance={walletBalance}
              lastPublicKey={lastPublicKey}
              setWalletBalance={setWalletBalance}
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <Droplet className="h-5 w-5 text-chart-4" />
                  <h2 className="text-base font-semibold text-foreground">LP Tespitleri</h2>
                  <Badge variant="secondary" data-testid="badge-lp-all-count">{lpLogs.length}</Badge>
                  {lockedLogs.length > 0 && (
                    <Badge className="bg-chart-2/15 text-chart-2 border border-chart-2/30 text-xs" data-testid="badge-lp-locked-count">
                      <Lock className="h-3 w-3 mr-1" />{lockedLogs.length} kilitli
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">1 SOL = ${displayPrice.toFixed(2)} · TVL = 2×SOL×${displayPrice.toFixed(2)}</span>
                </div>
                <LPLogTable
                  logs={lpLogs}
                  filter="all"
                  solPrice={displayPrice}
                  emptyMessage="LP tespiti bekleniyor..."
                  traderReady={traderReady}
                  activeBuyMints={activeBuyMints}
                  onBuy={handleBuy}
                />
              </div>

              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Coins className="h-5 w-5 text-primary" />
                    <h2 className="text-base font-semibold text-foreground">Yeni Mintler</h2>
                    <Badge variant="secondary" data-testid="badge-mint-count">{mintedTokens.length}/{MAX_MINTED_TOKENS}</Badge>
                  </div>
                  {mintedTokens.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground" data-testid="text-mint-empty">
                      <Coins className="h-10 w-10 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">Yeni mint bekleniyor...</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {mintedTokens.map((token) => (
                        <MintedTokenCard
                          key={token.id}
                          token={token}
                          isNew={token.id === newTokenId}
                          traderReady={traderReady}
                          hasOpenPosition={activeBuyMints.has(token.mintAddress)}
                          onBuy={handleBuy}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Token Karşılaştırma Paneli */}
                <TokenComparisonPanel
                  data={tokenComparison}
                  onRefresh={() => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: "request_token_comparison" }));
                    }
                  }}
                />

              </div>
            </div>

          </div>
        </div>

        <div className={`h-full overflow-y-auto ${activeTab === "trade" ? "block" : "hidden"}`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
            <TradePanel
              positions={positions}
              config={tradeConfig}
              traderPublicKey={traderPublicKey}
              traderReady={traderReady}
              solPriceUsd={solPriceUsd}
              globalHoldDurationMs={autoTraderConfig.holdDurationMs}
              onBuy={handleBuy}
              onSell={handleSell}
              onSellHalf={handleSellHalf}
              onDelete={handleDeletePosition}
              onMarkRugPull={handleMarkRugPull}
              onUpdateConfig={handleConfigUpdate}
              onUpdateHoldDuration={handleUpdateHoldDuration}
            />
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => setAutoTraderOpen(true)}
                data-testid="button-open-auto-trader-trade-tab"
                className={`gap-2 px-6 py-5 text-sm font-medium transition-colors ${
                  autoTraderConfig.enabled
                    ? "border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Bot className="h-5 w-5" />
                🤖 Otomatik Trading Panelini Aç
                {autoTraderConfig.enabled && (
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                )}
              </Button>
            </div>
          </div>
        </div>

        <div className={`h-full ${activeTab === "files" ? "block" : "hidden"}`}>
          <FileEditor />
        </div>

      </div>

      <Dialog open={autoTraderOpen} onOpenChange={setAutoTraderOpen}>
        <DialogContent
          className="max-w-2xl w-full max-h-[90vh] overflow-y-auto"
          data-testid="dialog-auto-trader"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Bot className="h-5 w-5 text-chart-3" />
              Otomatik Trading
              {autoTraderConfig.enabled ? (
                <Badge className="ml-1 bg-emerald-500/15 text-emerald-400 border border-emerald-500/40 text-xs">
                  {autoTraderRunning ? "🟢 Çalışıyor" : "⏸️ Durduruldu"}
                </Badge>
              ) : (
                <Badge className="ml-1 bg-muted text-muted-foreground border border-muted-foreground/30 text-xs">
                  ⚪ Devre Dışı
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          <AutoTraderPanel
            config={autoTraderConfig}
            isRunning={autoTraderRunning}
            onConfigUpdate={handleAutoTraderConfigUpdate}
            onToggle={handleAutoTraderToggle}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
