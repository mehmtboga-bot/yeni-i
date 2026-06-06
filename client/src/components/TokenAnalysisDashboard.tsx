import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  ShieldCheck,
  Clock,
  BarChart2,
  RefreshCw,
  Skull,
  Zap,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TokenAnalysis {
  mintAddress: string;
  symbol: string;
  name: string;
  detectedAt: number;
  survivedMinutes: number;
  trades: {
    total: number;
    bought: number;
    sold: number;
    failed: number;
    winRate: number;
    avgPnL: number;
  };
  recommendation: "BUY" | "CAUTION" | "AVOID";
  recommendationScore: number;
}

interface VariantStats {
  avgRugPullRisk: number;
  avgSurvivedMinutes: number;
  rugPullCount: number;
  totalCount: number;
}

interface Variant {
  symbol: string;
  count: number;
  tokens: TokenAnalysis[];
  bestToken: TokenAnalysis | null;
  stats: VariantStats;
}

interface GroupStats {
  avgRugPullRisk: number;
  avgSurvivedMinutes: number;
  rugPullCount: number;
  rugPullPercentage: number;
}

interface SimilarGroup {
  baseSymbol: string;
  variants: Variant[];
  totalCount: number;
  bestOverall: TokenAnalysis | null;
  groupStats: GroupStats;
}

interface OverallStats {
  totalTokens: number;
  rugPullCount: number;
  rugPullPercentage: number;
  avgSurvivedMinutes: number;
  avgRugPullRisk: number;
  bestTokens: TokenAnalysis[];
  worstTokens: TokenAnalysis[];
}

interface TokenAnalysisDashboardProps {
  analysis: TokenAnalysis[];
  similarGroups: SimilarGroup[];
  overallStats: OverallStats;
  onRefresh?: () => void;
  onSelectToken?: (mintAddress: string, symbol: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type DashboardTab = "overview" | "groups" | "all";

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}dk`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}s ${m}dk` : `${h}s`;
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function RecommendationBadge({
  recommendation,
}: {
  recommendation: string;
}) {
  if (recommendation === "BUY") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1 text-xs">
        <TrendingUp className="h-3 w-3" />
        AL
      </Badge>
    );
  }
  if (recommendation === "AVOID") {
    return (
      <Badge className="bg-red-500/15 text-red-400 border-red-500/30 gap-1 text-xs">
        <AlertTriangle className="h-3 w-3" />
        KAÇIN
      </Badge>
    );
  }
  return (
    <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-xs">
      DİKKAT
    </Badge>
  );
}




function TokenRow({
  token,
  rank,
  onSelect,
}: {
  token: TokenAnalysis;
  rank?: number;
  onSelect?: (mintAddress: string, symbol: string) => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
        token.recommendation === "BUY"
          ? "bg-emerald-950/10 border-emerald-500/15"
          : token.recommendation === "CAUTION"
          ? "bg-yellow-950/10 border-yellow-500/15"
          : "bg-zinc-900/40 border-zinc-700/30"
      }`}
    >
      {rank !== undefined && (
        <span className="text-xs text-muted-foreground w-5 text-center shrink-0 tabular-nums">
          {rank}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-foreground">
            {token.symbol}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">
            {shortMint(token.mintAddress)}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatMinutes(token.survivedMinutes)}
          </span>
          {token.trades.sold > 0 && (
            <>
              <span className="text-[11px] text-muted-foreground">
                Win {token.trades.winRate}%
              </span>
              <span
                className={`text-[11px] font-medium ${
                  token.trades.avgPnL >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {token.trades.avgPnL >= 0 ? "+" : ""}
                {token.trades.avgPnL}%
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <RecommendationBadge recommendation={token.recommendation} />
        {onSelect && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
            onClick={() => onSelect(token.mintAddress, token.symbol)}
          >
            AL
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  overallStats,
  onSelect,
}: {
  overallStats: OverallStats;
  onSelect?: (mintAddress: string, symbol: string) => void;
}) {
  const stats = overallStats;

  const statCards = [
    {
      label: "Toplam Token",
      value: stats.totalTokens,
      icon: <BarChart2 className="h-4 w-4 text-primary" />,
      color: "text-foreground",
    },
    {
      label: "Rug Pull",
      value: `${stats.rugPullCount} (%${stats.rugPullPercentage})`,
      icon: <Skull className="h-4 w-4 text-red-400" />,
      color: stats.rugPullPercentage > 30 ? "text-red-400" : "text-foreground",
    },
    {
      label: "Ort. Hayatta Kalma",
      value: formatMinutes(stats.avgSurvivedMinutes),
      icon: <Clock className="h-4 w-4 text-chart-4" />,
      color: "text-foreground",
    },
    {
      label: "Ort. Risk Skoru",
      value: `${stats.avgRugPullRisk}/100`,
      icon: <AlertTriangle className="h-4 w-4 text-yellow-400" />,
      color:
        stats.avgRugPullRisk > 60
          ? "text-red-400"
          : stats.avgRugPullRisk > 40
          ? "text-yellow-400"
          : "text-emerald-400",
    },
  ];

  return (
    <div className="space-y-5">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statCards.map((s) => (
          <Card key={s.label} className="p-3 bg-card/60">
            <div className="flex items-center gap-2 mb-1">
              {s.icon}
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
            <div className={`text-lg font-bold tabular-nums ${s.color}`}>
              {s.value}
            </div>
          </Card>
        ))}
      </div>

      {/* Best Tokens */}
      {stats.bestTokens.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-foreground">
              En Güvenli Token'ler
            </h3>
          </div>
          <div className="space-y-1.5">
            {stats.bestTokens.map((t, i) => (
              <TokenRow
                key={t.mintAddress}
                token={t}
                rank={i + 1}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}

      {/* Worst Tokens */}
      {stats.worstTokens.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Skull className="h-4 w-4 text-red-400" />
            <h3 className="text-sm font-semibold text-foreground">
              En Riskli Token'ler
            </h3>
          </div>
          <div className="space-y-1.5">
            {stats.worstTokens.map((t, i) => (
              <TokenRow key={t.mintAddress} token={t} rank={i + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Groups Tab ───────────────────────────────────────────────────────────────

function GroupsTab({
  similarGroups,
  onSelect,
}: {
  similarGroups: SimilarGroup[];
  onSelect?: (mintAddress: string, symbol: string) => void;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(
    new Set()
  );

  const toggleGroup = (key: string) => {
    const next = new Set(expandedGroups);
    next.has(key) ? next.delete(key) : next.add(key);
    setExpandedGroups(next);
  };

  const toggleVariant = (key: string) => {
    const next = new Set(expandedVariants);
    next.has(key) ? next.delete(key) : next.add(key);
    setExpandedVariants(next);
  };

  if (similarGroups.length === 0) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <BarChart2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm">Benzer isimde token grubu bulunamadı.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {similarGroups.map((group) => {
        const isGroupExpanded = expandedGroups.has(group.baseSymbol);
        const rugPct = group.groupStats.rugPullPercentage;

        return (
          <div key={group.baseSymbol} className="rounded-lg border border-border overflow-hidden">
            {/* Group Header */}
            <button
              className="w-full flex items-center gap-3 px-4 py-3 bg-card hover:bg-muted/40 transition-colors text-left"
              onClick={() => toggleGroup(group.baseSymbol)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-base text-foreground">
                    {group.baseSymbol}
                  </span>
                  <Badge variant="secondary" className="text-xs">
                    {group.totalCount} token · {group.variants.length} varyant
                  </Badge>
                  {rugPct > 0 && (
                    <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-xs gap-1">
                      <Skull className="h-3 w-3" />
                      %{rugPct} rug
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Ort. {formatMinutes(group.groupStats.avgSurvivedMinutes)}
                  </span>
                  <span>Risk: {group.groupStats.avgRugPullRisk}/100</span>
                  {group.bestOverall && (
                    <RecommendationBadge
                      recommendation={group.bestOverall.recommendation}
                    />
                  )}
                </div>
              </div>
              {isGroupExpanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
            </button>

            {/* Group Body */}
            {isGroupExpanded && (
              <div className="border-t border-border divide-y divide-border/50">
                {group.variants.map((variant) => {
                  const variantKey = `${group.baseSymbol}::${variant.symbol}`;
                  const isVariantExpanded = expandedVariants.has(variantKey);

                  return (
                    <div key={variant.symbol}>
                      {/* Variant Header */}
                      <button
                        className="w-full flex items-center gap-3 px-4 py-2.5 bg-muted/20 hover:bg-muted/40 transition-colors text-left"
                        onClick={() => toggleVariant(variantKey)}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-foreground">
                              {variant.symbol}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {variant.count} token
                            </span>
                            {variant.stats.rugPullCount > 0 && (
                              <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px] px-1.5 py-0 gap-1">
                                <Skull className="h-2.5 w-2.5" />
                                {variant.stats.rugPullCount} rug
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
                            <span>
                              Ort. {formatMinutes(variant.stats.avgSurvivedMinutes)}
                            </span>
                            <span>Risk: {variant.stats.avgRugPullRisk}/100</span>
                            {variant.bestToken && (
                              <RecommendationBadge
                                recommendation={variant.bestToken.recommendation}
                              />
                            )}
                          </div>
                        </div>
                        {isVariantExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        )}
                      </button>

                      {/* Variant Tokens */}
                      {isVariantExpanded && (
                        <div className="px-4 py-2 space-y-1.5 bg-background/40">
                          {variant.tokens.map((token, idx) => (
                            <TokenRow
                              key={token.mintAddress}
                              token={token}
                              rank={idx + 1}
                              onSelect={onSelect}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── All Tokens Tab ───────────────────────────────────────────────────────────

function AllTokensTab({
  analysis,
  onSelect,
}: {
  analysis: TokenAnalysis[];
  onSelect?: (mintAddress: string, symbol: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "buy" | "caution" | "avoid">(
    "all"
  );

  const filtered = analysis.filter((t) => {
    if (filter === "all") return true;
    return t.recommendation.toLowerCase() === filter;
  });

  const counts = {
    all: analysis.length,
    buy: analysis.filter((t) => t.recommendation === "BUY").length,
    caution: analysis.filter((t) => t.recommendation === "CAUTION").length,
    avoid: analysis.filter((t) => t.recommendation === "AVOID").length,
  };

  const filterButtons: {
    key: typeof filter;
    label: string;
    color: string;
  }[] = [
    { key: "all", label: `Tümü (${counts.all})`, color: "text-foreground" },
    {
      key: "buy",
      label: `✅ AL (${counts.buy})`,
      color: "text-emerald-400",
    },
    {
      key: "caution",
      label: `⚠️ Dikkat (${counts.caution})`,
      color: "text-yellow-400",
    },
    {
      key: "avoid",
      label: `🚫 Kaçın (${counts.avoid})`,
      color: "text-orange-400",
    },
  ];

  return (
    <div className="space-y-3">
      {/* Filter Buttons */}
      <div className="flex flex-wrap gap-1.5">
        {filterButtons.map((btn) => (
          <button
            key={btn.key}
            onClick={() => setFilter(btn.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              filter === btn.key
                ? "bg-primary/20 border-primary/50 text-primary"
                : "bg-muted/30 border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {btn.label}
          </button>
        ))}
      </div>

      {/* Token List */}
      {filtered.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          Bu filtrede token bulunamadı.
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((token, i) => (
            <TokenRow
              key={token.mintAddress}
              token={token}
              rank={i + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export function TokenAnalysisDashboard({
  analysis,
  similarGroups,
  overallStats,
  onRefresh,
  onSelectToken,
}: TokenAnalysisDashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");

  const tabs: { id: DashboardTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "overview",
      label: "Özet",
      icon: <BarChart2 className="h-3.5 w-3.5" />,
    },
    {
      id: "groups",
      label: `Gruplar (${similarGroups.length})`,
      icon: <Zap className="h-3.5 w-3.5" />,
    },
    {
      id: "all",
      label: `Tümü (${analysis.length})`,
      icon: <TrendingDown className="h-3.5 w-3.5" />,
    },
  ];

  return (
    <Card className="p-4 bg-card/80 border-border">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-gradient-to-br from-chart-3 to-chart-2 flex items-center justify-center shrink-0">
            <BarChart2 className="h-4 w-4 text-white" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-foreground">
              Token Analiz Dashboard
            </h2>
            <p className="text-[10px] text-muted-foreground">
              Son 12 saat · {overallStats.totalTokens} token
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Quick stats */}
          <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Skull className="h-3 w-3 text-red-400" />
              <span className="text-red-400 font-medium">
                %{overallStats.rugPullPercentage}
              </span>{" "}
              rug
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3 text-chart-4" />
              {formatMinutes(overallStats.avgSurvivedMinutes)} ort.
            </span>
          </div>

          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              className="h-7 px-2 text-xs gap-1"
            >
              <RefreshCw className="h-3 w-3" />
              Yenile
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-muted/30 rounded-lg p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === tab.id
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <OverviewTab overallStats={overallStats} onSelect={onSelectToken} />
      )}
      {activeTab === "groups" && (
        <GroupsTab similarGroups={similarGroups} onSelect={onSelectToken} />
      )}
      {activeTab === "all" && (
        <AllTokensTab analysis={analysis} onSelect={onSelectToken} />
      )}
    </Card>
  );
}
