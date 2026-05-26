import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Clock, CheckCircle2, XCircle } from "lucide-react";
import type { AutoTradeRecord } from "@shared/schema";

interface AutoTraderRecordsTableProps {
  records: AutoTradeRecord[];
  solPriceUsd: number;
}

export function AutoTraderRecordsTable({ records, solPriceUsd }: AutoTraderRecordsTableProps) {
  return (
    <Card className="p-6">
      <h3 className="text-lg font-bold mb-4">📊 İşlem Geçmişi</h3>

      {records.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Clock className="h-10 w-10 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Henüz otomatik işlem yapılmadı</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-2 font-semibold">Token</th>
                <th className="text-left py-3 px-2 font-semibold">Durum</th>
                <th className="text-right py-3 px-2 font-semibold">Alış Fiyatı</th>
                <th className="text-right py-3 px-2 font-semibold">Satış Fiyatı</th>
                <th className="text-right py-3 px-2 font-semibold">PnL</th>
                <th className="text-right py-3 px-2 font-semibold">%</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-3 px-2">
                    <div>
                      <p className="font-semibold">{record.tokenSymbol}</p>
                      <code className="text-xs text-muted-foreground">
                        {record.mintAddress.slice(0, 8)}...
                      </code>
                    </div>
                  </td>
                  <td className="py-3 px-2">
                    <StatusBadge status={record.status} />
                  </td>
                  <td className="py-3 px-2 text-right text-xs font-mono">
                    {record.buyPrice
                      ? `${record.buyPrice.toFixed(6)} SOL`
                      : "—"}
                  </td>
                  <td className="py-3 px-2 text-right text-xs font-mono">
                    {record.sellPrice
                      ? `${record.sellPrice.toFixed(6)} SOL`
                      : "—"}
                  </td>
                  <td className="py-3 px-2 text-right text-xs font-mono">
                    {record.pnl !== undefined ? (
                      <span
                        className={
                          record.pnl >= 0
                            ? "text-emerald-400"
                            : "text-destructive"
                        }
                      >
                        {record.pnl >= 0 ? "+" : ""}
                        {record.pnl.toFixed(4)} SOL
                        {solPriceUsd > 0 && (
                          <span className="text-muted-foreground ml-1">
                            (${(record.pnl * solPriceUsd).toFixed(2)})
                          </span>
                        )}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-3 px-2 text-right text-xs font-mono">
                    {record.pnlPct !== undefined ? (
                      <span
                        className={
                          record.pnlPct >= 0
                            ? "text-emerald-400 font-bold"
                            : "text-destructive font-bold"
                        }
                      >
                        {record.pnlPct >= 0 ? "+" : ""}
                        {record.pnlPct.toFixed(2)}%
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: AutoTradeRecord["status"] }) {
  const statusMap = {
    pending: { label: "Beklemede", color: "bg-amber-500/15 text-amber-400", icon: Clock },
    bought: { label: "Satın Alındı", color: "bg-primary/15 text-primary", icon: CheckCircle2 },
    sold: { label: "Satıldı", color: "bg-emerald-500/15 text-emerald-400", icon: TrendingUp },
    cancelled: { label: "İptal", color: "bg-muted text-muted-foreground", icon: XCircle },
    failed: { label: "Başarısız", color: "bg-destructive/15 text-destructive", icon: XCircle },
  };

  const config = statusMap[status];
  const Icon = config.icon;

  return (
    <Badge className={`${config.color} gap-1`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}
