import { useEffect, useState } from "react";
import { Eye, Play, Square, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WatchedWalletConfig } from "@shared/wallet-tracking";

async function call(path: string, body?: unknown) {
  const res = await fetch(`/api/wallet-tracking${path}`, {
    method: body === undefined && path === "" ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as WatchedWalletConfig & { success: boolean; message?: string };
}

export function WalletTrackingPanel() {
  const [cfg, setCfg] = useState<WatchedWalletConfig>({ walletAddress: "", running: false });
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const apply = (r: Awaited<ReturnType<typeof call>>, syncInput = false) => {
    setCfg({ walletAddress: r.walletAddress, running: r.running });
    if (syncInput) setInput(r.walletAddress);
    setMsg(r.success ? null : r.message ?? "Hata");
  };

  useEffect(() => { call("").then((r) => apply(r, true)).catch(() => {}); }, []);

  const dirty = input.trim() !== cfg.walletAddress;

  return (
    <Card className="p-5 space-y-4" data-testid="panel-wallet-tracking">
      <div className="flex items-center gap-3 justify-between flex-wrap">
        <div className="flex items-center gap-2">
          <Eye className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Cüzdan Takibi</h2>
          <Badge className={cfg.running ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/40" : "bg-muted text-muted-foreground"}>
            {cfg.running ? "🟢 İzleniyor" : "⏸️ Durduruldu"}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={cfg.running || !cfg.walletAddress || dirty}
            onClick={() => call("/start", {}).then((r) => apply(r))} data-testid="button-wallet-start" className="gap-1.5">
            <Play className="h-4 w-4" /> Başlat
          </Button>
          <Button size="sm" variant="outline" disabled={!cfg.running}
            onClick={() => call("/stop", {}).then((r) => apply(r))} data-testid="button-wallet-stop" className="gap-1.5">
            <Square className="h-4 w-4" /> Durdur
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="watched-wallet">İzlenen cüzdan adresi</Label>
        <div className="flex gap-2">
          <Input id="watched-wallet" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Solana cüzdan adresi" className="font-mono text-xs" data-testid="input-watched-wallet" />
          <Button variant="outline" disabled={!dirty}
            onClick={() => call("/address", { walletAddress: input }).then((r) => apply(r, r.success))}
            data-testid="button-wallet-save" className="gap-1.5">
            <Save className="h-4 w-4" /> Kaydet
          </Button>
        </div>
        {msg && <p className="text-xs text-destructive" data-testid="text-wallet-error">{msg}</p>}
        <p className="text-xs text-muted-foreground">
          Başlat'a basınca yalnızca bu cüzdanın oluşturduğu yeni tokenler yakalanır (sonraki adım).
        </p>
      </div>
    </Card>
  );
}
