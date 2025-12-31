import { useState, useEffect } from "react";
import { Wallet, Check, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface WalletBalanceProps {
  onGetBalance: (publicKey: string) => void;
  balance: number | null;
  lastPublicKey: string | null;
}

export function WalletBalance({ onGetBalance, balance, lastPublicKey }: WalletBalanceProps) {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (balance !== null) {
      setLoading(false);
    }
  }, [balance]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;
    setLoading(true);
    onGetBalance(address.trim());
  };

  return (
    <Card className="bg-card/50 border-card-border backdrop-blur-sm">
      <CardContent className="p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Cüzdan Bakiyesi</span>
          </div>
          
          <div className="flex gap-2">
            <Input
              placeholder="Solana cüzdan adresi..."
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="h-9 text-xs bg-background/50"
              data-testid="input-wallet-address"
            />
            <Button 
              type="submit" 
              size="icon" 
              disabled={loading}
              className="h-9 w-9 shrink-0"
              data-testid="button-get-balance"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </Button>
          </div>

          {balance !== null && lastPublicKey === address && (
            <div className="pt-2 border-t border-card-border/50 animate-in fade-in slide-in-from-top-1">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Bakiye:</span>
                <span className="text-sm font-bold text-primary" data-testid="text-wallet-balance">
                  {balance.toLocaleString(undefined, { minimumFractionDigits: 4 })} SOL
                </span>
              </div>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
