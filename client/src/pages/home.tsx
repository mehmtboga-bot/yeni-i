import { useEffect, useRef, useState } from "react";
import { Coins, Droplet, Lock, Menu, Wallet } from "lucide-react";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { MintedTokenCard } from "@/components/MintedTokenCard";
import { LPLogTable } from "@/components/LPLogTable";
import { WalletBalance } from "@/components/WalletBalance";
import { LogPanel, type ServerLog } from "@/components/LogPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MintedToken, LPDetection, WSMessage } from "@shared/schema";

const MAX_MINTED_TOKENS = 7;
const MAX_LP_LOGS = 30;
const MINT_DISPLAY_DURATION = 3 * 60 * 1000;
const LP_LOG_DURATION = 5 * 60 * 1000;

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [mintedTokens, setMintedTokens] = useState<MintedToken[]>([]);
  const [lpLogs, setLpLogs] = useState<LPDetection[]>([]);
  const [newTokenId, setNewTokenId] = useState<string | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [lastPublicKey, setLastPublicKey] = useState<string | null>(null);
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [serverLogs, setServerLogs] = useState<ServerLog[]>([]);
  const logIdRef = useRef(0);

  const toggleMonitoring = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "toggle_monitoring", data: { enabled: !isMonitoring } }));
    }
  };

  const handleGetBalance = (publicKey: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "get_balance", data: { publicKey } }));
    }
  };

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "localhost:5000";
    const wsUrl = `${protocol}//${host}/ws`;
    let wsInstance: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;

    const connect = () => {
      wsInstance = new WebSocket(wsUrl);
      setWs(wsInstance);

      wsInstance.onopen = () => {
        setIsConnected(true);
        setConnectionMessage("");
      };

      wsInstance.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);

          if (message.type === "mint_detected") {
            const token = message.data;
            setMintedTokens((prev) => {
              const filtered = prev.filter((t) => t.id !== token.id);
              return [token, ...filtered].slice(0, MAX_MINTED_TOKENS);
            });
            setNewTokenId(token.id);
            setTimeout(() => setNewTokenId(null), 1000);
          } else if (message.type === "lp_detected") {
            const lpLog = message.data;
            setLpLogs((prev) => {
              const filtered = prev.filter((l) => l.id !== lpLog.id);
              return [lpLog, ...filtered].slice(0, MAX_LP_LOGS);
            });
          } else if (message.type === "connection_status") {
            setIsConnected(message.data.connected);
            setConnectionMessage(message.data.message || "");
            if (message.data.isMonitoring !== undefined) {
              setIsMonitoring(message.data.isMonitoring);
            }
          } else if (message.type === "monitoring_state") {
            setIsMonitoring(message.data.isMonitoring);
          } else if (message.type === "balance_update") {
            setWalletBalance(message.data.balance);
            setLastPublicKey(message.data.publicKey);
          } else if (message.type === "error") {
            setConnectionMessage(message.data.message);
          } else if (message.type === "server_log") {
            const entry: ServerLog = {
              id: ++logIdRef.current,
              level: message.data.level,
              message: message.data.message,
              timestamp: message.data.timestamp,
            };
            setServerLogs((prev) => [...prev, entry].slice(-300));
          }
        } catch { /* ignore parse errors */ }
      };

      wsInstance.onerror = () => {
        setIsConnected(false);
        setConnectionMessage("Bağlantı hatası");
      };

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

  const lockedLogs = lpLogs.filter((l) => l.isLocked);

  return (
    <div className="min-h-screen bg-background">
      {/* Log paneli */}
      <LogPanel
        open={logPanelOpen}
        logs={serverLogs}
        onClose={() => setLogPanelOpen(false)}
      />

      <header className="sticky top-0 z-50 bg-card border-b border-card-border backdrop-blur-sm bg-card/95">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              {/* Hamburger — log paneli aç/kapat */}
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setLogPanelOpen((v) => !v)}
                className="shrink-0"
                data-testid="button-toggle-log-panel"
                aria-label="Sunucu loglarını göster"
              >
                <Menu className="h-5 w-5" />
              </Button>

              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-primary to-chart-2 flex items-center justify-center shrink-0">
                <Coins className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h1
                  className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-primary to-chart-2 bg-clip-text text-transparent"
                  data-testid="text-title"
                >
                  Solana Token Monitor
                </h1>
                <p className="text-xs text-muted-foreground hidden sm:block">
                  Gerçek zamanlı mint ve LP tespiti
                </p>
              </div>
            </div>
            <ConnectionStatus
              isConnected={isConnected}
              message={connectionMessage}
              isMonitoring={isMonitoring}
              onToggleMonitoring={toggleMonitoring}
            />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Cüzdan */}
        <WalletBalance
          onGetBalance={handleGetBalance}
          balance={walletBalance}
          lastPublicKey={lastPublicKey}
          setWalletBalance={setWalletBalance}
        />

        {/* İstatistik kartları */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Aktif Mint" value={mintedTokens.length} color="text-primary" icon={<Coins className="h-4 w-4" />} />
          <StatCard label="Tüm LP" value={lpLogs.length} color="text-chart-4" icon={<Droplet className="h-4 w-4" />} />
          <StatCard label="Kilitli LP" value={lockedLogs.length} color="text-chart-2" icon={<Lock className="h-4 w-4" />} />
          <StatCard
            label="Toplam Likidite"
            value={`${lpLogs.reduce((s, l) => s + (l.liquidityAmount ?? 0), 0).toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} SOL`}
            color="text-chart-3"
            icon={<Wallet className="h-4 w-4" />}
          />
        </div>

        {/* Ana grid: sol 2/3, sağ 1/3 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Sol kolon: Tüm LP + Kilitli LP */}
          <div className="lg:col-span-2 space-y-6">

            {/* Tüm LP Tespitleri */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Droplet className="h-5 w-5 text-chart-4" />
                <h2 className="text-base font-semibold text-foreground">Tüm LP Tespitleri</h2>
                <Badge variant="secondary" data-testid="badge-lp-all-count">
                  {lpLogs.length}
                </Badge>
              </div>
              <LPLogTable
                logs={lpLogs}
                filter="all"
                emptyMessage="LP tespiti bekleniyor..."
              />
            </section>

            {/* Kilitli LP'ler */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Lock className="h-5 w-5 text-chart-2" />
                <h2 className="text-base font-semibold text-foreground">Kilitli LP'ler</h2>
                <Badge variant="secondary" className="bg-chart-2/10 text-chart-2 border-chart-2/20" data-testid="badge-lp-locked-count">
                  {lockedLogs.length}
                </Badge>
              </div>
              <LPLogTable
                logs={lpLogs}
                filter="locked"
                emptyMessage="Henüz kilitli LP tespit edilmedi..."
              />
            </section>
          </div>

          {/* Sağ kolon: Mintlenen Tokenler */}
          <div className="space-y-6">
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Coins className="h-5 w-5 text-primary" />
                <h2 className="text-base font-semibold text-foreground">Yeni Mintler</h2>
                <Badge variant="secondary" data-testid="badge-mint-count">
                  {mintedTokens.length}/{MAX_MINTED_TOKENS}
                </Badge>
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
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: string | number;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-3 space-y-1">
      <div className={`flex items-center gap-1.5 text-xs text-muted-foreground ${color}`}>
        {icon}
        <span>{label}</span>
      </div>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
