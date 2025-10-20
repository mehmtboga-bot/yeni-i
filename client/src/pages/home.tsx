import { useEffect, useState } from "react";
import { Coins, Droplet } from "lucide-react";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { MintedTokenCard } from "@/components/MintedTokenCard";
import { LPLogTable } from "@/components/LPLogTable";
import { Badge } from "@/components/ui/badge";
import type { MintedToken, LPDetection, WSMessage } from "@shared/schema";

const MAX_MINTED_TOKENS = 7;
const MAX_LP_LOGS = 10;
const MINT_DISPLAY_DURATION = 3 * 60 * 1000;
const LP_LOG_DURATION = 2 * 60 * 1000;

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [mintedTokens, setMintedTokens] = useState<MintedToken[]>([]);
  const [lpLogs, setLpLogs] = useState<LPDetection[]>([]);
  const [newTokenId, setNewTokenId] = useState<string | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setIsConnected(true);
        setConnectionMessage("");
      };

      ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);

          if (message.type === "mint_detected") {
            const token = message.data;
            setMintedTokens((prev) => {
              const filtered = prev.filter((t) => t.id !== token.id);
              const updated = [token, ...filtered].slice(0, MAX_MINTED_TOKENS);
              return updated;
            });
            setNewTokenId(token.id);
            setTimeout(() => setNewTokenId(null), 1000);
          } else if (message.type === "lp_detected") {
            const lpLog = message.data;
            setLpLogs((prev) => {
              const filtered = prev.filter((l) => l.id !== lpLog.id);
              const updated = [lpLog, ...filtered].slice(0, MAX_LP_LOGS);
              return updated;
            });
          } else if (message.type === "connection_status") {
            setIsConnected(message.data.connected);
            setConnectionMessage(message.data.message || "");
          }
        } catch (error) {
          console.error("WebSocket mesaj hatası:", error);
        }
      };

      ws.onerror = () => {
        setIsConnected(false);
        setConnectionMessage("Bağlantı hatası");
      };

      ws.onclose = () => {
        setIsConnected(false);
        setConnectionMessage("Yeniden bağlanıyor...");
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
      if (ws) {
        ws.close();
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-card border-b border-card-border backdrop-blur-sm bg-card/95">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-primary to-chart-2 flex items-center justify-center">
                <Coins className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-primary to-chart-2 bg-clip-text text-transparent" data-testid="text-title">
                  Solana Token Monitor
                </h1>
                <p className="text-xs text-muted-foreground hidden sm:block">
                  Gerçek zamanlı mint ve LP tespiti
                </p>
              </div>
            </div>
            <ConnectionStatus isConnected={isConnected} message={connectionMessage} />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Coins className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">Mintlenen Tokenler</h2>
              <Badge variant="secondary" className="ml-2" data-testid="badge-mint-count">
                {mintedTokens.length}/{MAX_MINTED_TOKENS}
              </Badge>
            </div>
          </div>

          {mintedTokens.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground" data-testid="text-mint-empty">
              <Coins className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="text-sm">Yeni token mint'leri bekleniyor...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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

        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Droplet className="h-5 w-5 text-chart-4" />
              <h2 className="text-lg font-semibold text-foreground">LP Tespitleri</h2>
              <Badge variant="secondary" className="ml-2" data-testid="badge-lp-count">
                {lpLogs.length}/{MAX_LP_LOGS}
              </Badge>
            </div>
          </div>

          <LPLogTable logs={lpLogs} />
        </section>
      </main>
    </div>
  );
}
