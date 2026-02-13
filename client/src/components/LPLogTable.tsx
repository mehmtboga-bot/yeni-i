import { useState } from "react";
import { ExternalLink, Copy, Check, Lock, Unlock, Droplet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CountdownTimer } from "./CountdownTimer";
import type { LPDetection } from "@shared/schema";

interface LPLogTableProps {
  logs: LPDetection[];
}

export function LPLogTable({ logs }: LPLogTableProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyAddress = async (address: string, id: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const truncateAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
  };

  const getRelativeTime = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s önce`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}dk önce`;
  };

  const filteredLogs = logs.filter(log => log.isLocked);

  if (filteredLogs.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground" data-testid="text-empty-state">
        <p className="text-sm">{logs.length > 0 ? "Kilitli LP tespiti bekleniyor... (Sadece kilitli olanlar gösterilir)" : "LP tespiti bekleniyor..."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filteredLogs.map((log, index) => (
        <div
          key={log.id}
          className={`bg-card border border-card-border rounded-lg p-4 hover-elevate transition-all ${
            index === 0 ? "animate-in slide-in-from-top-1 border-chart-4" : ""
          }`}
          data-testid={`row-lp-${log.id}`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-foreground" data-testid="text-lp-name">
                  {log.name}
                </span>
                <span className="text-sm font-medium text-primary" data-testid="text-lp-symbol">
                  ({log.symbol})
                </span>
                {log.isLocked ? (
                  <Badge variant="outline" className="gap-1 border-chart-2 text-chart-2 bg-chart-2/10" data-testid="badge-lp-locked">
                    <Lock className="h-3 w-3" />
                    Kilitli {log.lockDuration && `(${log.lockDuration})`}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 border-destructive text-destructive bg-destructive/10" data-testid="badge-lp-unlocked">
                    <Unlock className="h-3 w-3" />
                    Kilit Açık
                  </Badge>
                )}
                {log.liquidityAmount !== undefined && (
                  <Badge variant="secondary" className="bg-chart-4/10 text-chart-4 border-chart-4/20" data-testid="badge-lp-liquidity">
                    <Droplet className="h-3 w-3 mr-1" />
                    {log.liquidityAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground" data-testid="text-lp-time">
                  {getRelativeTime(log.detectedAt)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <code
                  className="text-xs font-mono text-muted-foreground bg-muted px-2 py-1 rounded"
                  data-testid="text-lp-address"
                >
                  {truncateAddress(log.mintAddress)}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => copyAddress(log.mintAddress, log.id)}
                  className="h-7 w-7"
                  data-testid="button-copy-lp-address"
                >
                  {copiedId === log.id ? (
                    <Check className="h-3 w-3 text-chart-4" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                  className="h-7 px-2 text-xs"
                  data-testid="button-lp-raydium"
                >
                  <a href={log.raydiumUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Raydium
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                  className="h-7 px-2 text-xs"
                  data-testid="button-lp-jupiter"
                >
                  <a href={log.jupiterUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Jupiter
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                  className="h-7 px-2 text-xs"
                  data-testid="button-lp-dexscreener"
                >
                  <a href={log.dexscreenerUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Dexscreener
                  </a>
                </Button>
              </div>
            </div>

            <div className="sm:ml-auto">
              <CountdownTimer detectedAt={log.detectedAt} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
