import { Activity, WifiOff } from "lucide-react";

interface ConnectionStatusProps {
  isConnected: boolean;
  message?: string;
}

export function ConnectionStatus({ isConnected, message }: ConnectionStatusProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        {isConnected ? (
          <>
            <div className="relative">
              <Activity className="h-4 w-4 text-chart-4" data-testid="icon-connected" />
              <div className="absolute inset-0 bg-chart-4 rounded-full blur-sm opacity-50 animate-pulse" />
            </div>
            <span className="text-sm font-medium text-foreground" data-testid="text-status">
              Bağlı
            </span>
          </>
        ) : (
          <>
            <WifiOff className="h-4 w-4 text-destructive" data-testid="icon-disconnected" />
            <span className="text-sm font-medium text-muted-foreground" data-testid="text-status">
              {message || "Bağlantı Kesildi"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
