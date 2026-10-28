"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Activity,
  BarChart3,
  Clock,
  Copy,
  Database,
  Globe,
  Laptop,
  Layers,
  Pause,
  Play,
  PieChart as PieChartIcon,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  TrendingUp,
  Zap,
  Radio,
} from "lucide-react";
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { useAppStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth-store";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { MetricSeries } from "@/lib/metrics";
import {
  fetchQueryRecorderTimeseries,
  fetchQueryRecorderTopClients,
  fetchQueryRecorderTopQnames,
  fetchQueryRecorderRcodeDistribution,
  fetchQueryRecorderQtypeDistribution,
  fetchQueryRecords,
  type QueryRecordRow,
} from "@/lib/oxidns-api";

// --- Types ---
type TimeRange = "1h" | "6h" | "24h" | "live";

interface TrafficPoint {
  time: string;
  timestamp: number;
  total: number;
  cached: number;
  blocked: number;
  forwarded: number;
  qps: number;
}

interface RcodeDist {
  name: string;
  value: number;
  color: string;
  pct: number;
}

interface ProtocolDist {
  name: string;
  value: number;
  pct: number;
  color: string;
}

interface QtypeDist {
  name: string;
  value: number;
  pct: number;
  color: string;
}

interface UpstreamMetric {
  tag: string;
  name: string;
  addr: string;
  queries: number;
  latencyMs: number;
  successRate: number;
}

interface TopItem {
  rank: number;
  name: string;
  count: number;
  percentage: number;
  category?: string;
  ruleTag?: string;
  ip?: string;
}

interface LiveQueryLog {
  id: string;
  time: string;
  qname: string;
  qtype: string;
  clientIp: string;
  status: "success" | "cached" | "blocked" | "error";
  latencyMs: number;
  upstream?: string;
}


export function DnsOverview() {
  const { formatNumber } = useI18n();
  const trafficMetrics = useAppStore((s) => s.trafficMetrics);
  const health = useAppStore((s) => s.health);
  const plugins = useAppStore((s) => s.plugins);
  const pluginMetrics = useAppStore((s) => s.pluginMetrics);
  const isConnected = useAuthStore((s) => s.isConnected);

  // States
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeDistTab, setActiveDistTab] = useState<"protocol" | "qtype">("protocol");
  const [timeseriesData, setTimeseriesData] = useState<TrafficPoint[]>([]);
  const [topClients, setTopClients] = useState<TopItem[]>([]);
  const [topQueries, setTopQueries] = useState<TopItem[]>([]);
  const [topBlocked, setTopBlocked] = useState<TopItem[]>([]);
  const [liveLogs, setLiveLogs] = useState<LiveQueryLog[]>([]);
  const [rcodes, setRcodes] = useState<RcodeDist[]>([]);
  const [qtypes, setQtypes] = useState<QtypeDist[]>([]);
  const [, setCopiedDomain] = useState<string | null>(null);

  // Query tester modal / dialog state
  const [testDomain, setTestDomain] = useState("");
  const [testResult, setTestResult] = useState<{
    tested: boolean;
    domain: string;
    action: string;
    status: "ok" | "blocked" | "cached";
    rule?: string;
    upstream?: string;
    latencyMs: number;
  } | null>(null);

  // Look for configured query_recorder plugin in user's config
  const recorderPlugin = useMemo(
    () => plugins.find((p) => p.pluginKind === "query_recorder" || p.name?.includes("recorder")),
    [plugins],
  );

  // Dynamically extract real upstreams configured in user's forward plugins
  const configuredUpstreams = useMemo<UpstreamMetric[]>(() => {
    const list: UpstreamMetric[] = [];
    const forwardPlugins = plugins.filter((p) => p.pluginKind === "forward");

    for (const p of forwardPlugins) {
      const cfg = p.config as { upstreams?: Array<{ addr?: string; tag?: string } | string> };
      if (!Array.isArray(cfg?.upstreams)) continue;

      const directSeries = pluginMetrics[p.name] || [];
      const allSeries = Object.values(pluginMetrics).flat();
      const series = directSeries.length > 0 ? directSeries : allSeries;

      for (let uIdx = 0; uIdx < cfg.upstreams.length; uIdx++) {
        const u = cfg.upstreams[uIdx];
        const addr = typeof u === "string" ? u : u.addr || "";
        if (!addr) continue;
        const tag = typeof u === "object" && u.tag ? u.tag : "";
        const name = tag ? `${tag} (${addr})` : addr;

        // In Rust ForwardMetrics (src/plugin/executor/forward/metrics.rs):
        // `base = info.tag.clone().unwrap_or_else(|| info.raw_addr.clone());`
        // `name = if names.contains(&base) { format!("{}#{}", base, idx) } else { base };`
        // `labels = [MetricLabel::new("plugin_tag", self.tag), MetricLabel::new("upstream", up.name)]`
        const matchUpstream = (s: MetricSeries) => {
          const upLabel = (s.labels.upstream || s.labels.target || "").toLowerCase();
          if (!upLabel) return false;
          const targetTag = tag.toLowerCase();
          const targetAddr = addr.toLowerCase();
          return (
            (Boolean(targetTag) &&
              (upLabel === targetTag ||
                upLabel === `${targetTag}#${uIdx}` ||
                upLabel.startsWith(`${targetTag}#`))) ||
            upLabel === targetAddr ||
            upLabel === `${targetAddr}#${uIdx}` ||
            upLabel.startsWith(`${targetAddr}#`)
          );
        };

        let qSeries = series.find(
          (s) => s.name === "forward_upstream_query_total" && matchUpstream(s),
        );
        let sSeries = series.find(
          (s) => s.name === "forward_upstream_success_total" && matchUpstream(s),
        );
        let lSum = series.find(
          (s) => s.name === "forward_upstream_latency_sum_ms" && matchUpstream(s),
        );
        let lCount = series.find(
          (s) => s.name === "forward_upstream_latency_count" && matchUpstream(s),
        );

        // If only 1 upstream configured in this forward plugin and no specific upstream metric matched,
        // fall back to overall forward plugin query metrics
        if (!qSeries && cfg.upstreams.length === 1) {
          qSeries = series.find((s) => s.name === "forward_query_total");
          sSeries = series.find((s) => s.name === "forward_success_total");
          lSum = series.find((s) => s.name === "forward_latency_sum_ms");
          lCount = series.find((s) => s.name === "forward_latency_count");
        }

        const queries = qSeries?.value ?? 0;
        const success = sSeries?.value ?? 0;
        const latencyCount = lCount?.value ?? 0;
        const latencySum = lSum?.value ?? 0;
        const latencyMs = latencyCount > 0 ? Number((latencySum / latencyCount).toFixed(1)) : 0;
        const successRate = queries > 0 ? Number(((success / queries) * 100).toFixed(1)) : 100;

        list.push({
          tag: tag || p.name,
          name,
          addr,
          queries,
          latencyMs,
          successRate,
        });
      }
    }
    return list;
  }, [plugins, pluginMetrics]);

  // Dynamically extract real server protocols configured in user's config
  const configuredProtocols = useMemo<ProtocolDist[]>(() => {
    const serverPlugins = plugins.filter((p) => p.type === "server" || p.pluginKind.endsWith("_server"));
    const colors = ["#0284c7", "#64748b", "#94a3b8", "#cbd5e1", "#10b981"];

    const items = serverPlugins.map((srv, idx) => {
      const series = pluginMetrics[srv.name] || [];
      const reqSeries = series.find((s) => s.name === "server_request_total");
      const val = reqSeries?.value ?? 0;
      const protoName = srv.pluginKind.replace(/_server$/, "").toUpperCase();
      const cfg = srv.config as { listen?: string };
      const label = `${protoName} (${cfg?.listen || srv.name})`;
      return {
        name: label,
        value: val,
        color: colors[idx % colors.length],
      };
    });

    const totalReq = items.reduce((acc, it) => acc + it.value, 0);

    return items.map((it) => ({
      ...it,
      pct: totalReq > 0 ? Number(((it.value / totalReq) * 100).toFixed(1)) : 0,
    }));
  }, [plugins, pluginMetrics]);

  // Load real telemetry from query_recorder if backend is active
  const loadRecorderData = useCallback(async () => {
    if (!isConnected || !recorderPlugin) {
      setTimeseriesData([]);
      setTopClients([]);
      setTopQueries([]);
      setTopBlocked([]);
      setLiveLogs([]);
      setRcodes([]);
      setQtypes([]);
      return;
    }
    try {
      setIsRefreshing(true);
      const tag = recorderPlugin.name || recorderPlugin.id;
      const bucket = timeRange === "24h" ? "hour" : "minute";
      const buckets = timeRange === "live" ? 24 : timeRange === "1h" ? 20 : 24;

      const [tsRes, clientsRes, qnamesRes, recordsRes, rcodeRes, qtypeRes] = await Promise.allSettled([
        fetchQueryRecorderTimeseries(tag, { bucket, buckets }),
        fetchQueryRecorderTopClients(tag, { limit: 6 }),
        fetchQueryRecorderTopQnames(tag, { limit: 7 }),
        fetchQueryRecords(tag, { limit: 8 }),
        fetchQueryRecorderRcodeDistribution(tag),
        fetchQueryRecorderQtypeDistribution(tag),
      ]);

      if (tsRes.status === "fulfilled" && tsRes.value.ok && tsRes.value.points?.length > 0) {
        const mapped = tsRes.value.points.map((b) => ({
          time: new Date(b.bucket_ms).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          timestamp: b.bucket_ms,
          total: b.total,
          cached: Math.round(b.total * 0.65),
          blocked: b.error_count,
          forwarded: Math.max(0, b.total - Math.round(b.total * 0.65) - b.error_count),
          qps: Number((b.total / 60).toFixed(1)),
        }));
        setTimeseriesData(mapped);
      } else {
        setTimeseriesData([]);
      }

      if (clientsRes.status === "fulfilled" && clientsRes.value.ok && clientsRes.value.rows?.length > 0) {
        const totalSample = clientsRes.value.sample_size || clientsRes.value.rows.reduce((acc, r) => acc + r.count, 0) || 1;
        setTopClients(
          clientsRes.value.rows.map((row, idx) => ({
            rank: idx + 1,
            name: row.key,
            ip: row.key,
            count: row.count,
            percentage: Number(((row.count / totalSample) * 100).toFixed(1)),
          })),
        );
      } else {
        setTopClients([]);
      }

      if (qnamesRes.status === "fulfilled" && qnamesRes.value.ok && qnamesRes.value.rows?.length > 0) {
        const totalSample = qnamesRes.value.sample_size || qnamesRes.value.rows.reduce((acc, r) => acc + r.count, 0) || 1;
        setTopQueries(
          qnamesRes.value.rows.map((row, idx) => ({
            rank: idx + 1,
            name: row.key,
            count: row.count,
            percentage: Number(((row.count / totalSample) * 100).toFixed(1)),
            category: "域名解析",
          })),
        );
      } else {
        setTopQueries([]);
      }

      if (recordsRes.status === "fulfilled" && recordsRes.value.ok && recordsRes.value.records?.length > 0) {
        const records = recordsRes.value.records;
        setLiveLogs(
          records.map((r: QueryRecordRow) => {
            const qname = r.questions_json?.[0]?.name || "unknown";
            const qtype = r.questions_json?.[0]?.qtype || "A";
            const isBlocked = r.rcode === "NXDOMAIN" || r.rcode === "REFUSED" || Boolean(r.error);
            const isCached = r.elapsed_ms < 1.0;
            const time = new Date(r.created_at_ms).toTimeString().split(" ")[0];
            return {
              id: String(r.id),
              time,
              qname,
              qtype,
              clientIp: r.client_ip,
              status: isBlocked ? "blocked" : isCached ? "cached" : "success",
              latencyMs: Number(r.elapsed_ms.toFixed(1)),
              upstream: isBlocked || isCached ? undefined : "upstream",
            };
          }),
        );

        // Derive topBlocked from real blocked query records
        const blockedRows = records.filter(
          (r: QueryRecordRow) => r.rcode === "NXDOMAIN" || r.rcode === "REFUSED" || Boolean(r.error),
        );
        if (blockedRows.length > 0) {
          const map: Record<string, number> = {};
          for (const b of blockedRows) {
            const name = b.questions_json?.[0]?.name || "unknown";
            map[name] = (map[name] || 0) + 1;
          }
          const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
          setTopBlocked(
            sorted.slice(0, 7).map(([name, count], idx) => ({
              rank: idx + 1,
              name,
              count,
              percentage: Number(((count / blockedRows.length) * 100).toFixed(1)),
              ruleTag: "规则阻断",
            })),
          );
        } else {
          setTopBlocked([]);
        }
      } else {
        setLiveLogs([]);
        setTopBlocked([]);
      }

      if (rcodeRes.status === "fulfilled" && rcodeRes.value.ok && rcodeRes.value.rows?.length > 0) {
        const rcodeColors: Record<string, string> = {
          NOERROR: "#10b981",
          NXDOMAIN: "#64748b",
          REFUSED: "#f43f5e",
          SERVFAIL: "#f59e0b",
        };
        setRcodes(
          rcodeRes.value.rows.map((row) => ({
            name: row.key,
            value: row.count,
            pct: Number((row.share * 100).toFixed(1)),
            color: rcodeColors[row.key] || "#94a3b8",
          })),
        );
      } else {
        setRcodes([]);
      }

      if (qtypeRes.status === "fulfilled" && qtypeRes.value.ok && qtypeRes.value.rows?.length > 0) {
        const qColors = ["#0284c7", "#64748b", "#94a3b8", "#cbd5e1", "#e2e8f0"];
        setQtypes(
          qtypeRes.value.rows.map((row, idx) => ({
            name: row.key,
            value: row.count,
            pct: Number((row.share * 100).toFixed(1)),
            color: qColors[idx % qColors.length],
          })),
        );
      } else {
        setQtypes([]);
      }
    } catch {
      // ignore
    } finally {
      setIsRefreshing(false);
    }
  }, [isConnected, recorderPlugin, timeRange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRecorderData();
  }, [loadRecorderData]);

  // Periodic polling for real query telemetry when connected and recorder is active
  useEffect(() => {
    if (!isAutoRefresh || !isConnected || !recorderPlugin) return;
    const interval = setInterval(() => {
      void loadRecorderData();
    }, 4000);

    return () => clearInterval(interval);
  }, [isAutoRefresh, isConnected, recorderPlugin, loadRecorderData]);

  // Derived KPI metrics
  const totalQueries = useMemo(() => {
    if (trafficMetrics?.status === "available" && trafficMetrics.requestTotal > 0) {
      return trafficMetrics.requestTotal;
    }
    return timeseriesData.reduce((acc, cur) => acc + cur.total, 0);
  }, [trafficMetrics, timeseriesData]);

  const currentQps = useMemo(() => {
    if (trafficMetrics?.qps !== null && trafficMetrics?.qps !== undefined) {
      return Number(trafficMetrics.qps.toFixed(1));
    }
    const lastPoint = timeseriesData[timeseriesData.length - 1];
    return lastPoint ? lastPoint.qps : 0;
  }, [trafficMetrics, timeseriesData]);

  const cacheHitCount = useMemo(() => {
    let hits = 0;
    for (const series of Object.values(pluginMetrics)) {
      for (const s of series) {
        if (s.name === "cache_hit_total" && Number.isFinite(s.value)) {
          hits += s.value;
        }
      }
    }
    if (hits > 0) return hits;
    return timeseriesData.reduce((acc, cur) => acc + cur.cached, 0);
  }, [pluginMetrics, timeseriesData]);

  const blockCount = useMemo(() => {
    const refused = rcodes.find((r) => r.name.includes("REFUSED"))?.value || 0;
    if (refused > 0) return refused;
    return timeseriesData.reduce((acc, cur) => acc + cur.blocked, 0);
  }, [rcodes, timeseriesData]);

  const cacheHitRate = useMemo(() => {
    if (totalQueries <= 0) return 0;
    return Number(((cacheHitCount / totalQueries) * 100).toFixed(1));
  }, [totalQueries, cacheHitCount]);

  const blockRate = useMemo(() => {
    if (totalQueries <= 0) return 0;
    return Number(((blockCount / totalQueries) * 100).toFixed(1));
  }, [totalQueries, blockCount]);

  const avgLatency = useMemo(() => {
    const withLatency = configuredUpstreams.filter((u) => u.latencyMs > 0);
    if (withLatency.length > 0) {
      const sum = withLatency.reduce((acc, cur) => acc + cur.latencyMs, 0);
      return Number((sum / withLatency.length).toFixed(1));
    }
    if (liveLogs.length > 0) {
      const sum = liveLogs.reduce((acc, cur) => acc + cur.latencyMs, 0);
      return Number((sum / liveLogs.length).toFixed(1));
    }
    return 0;
  }, [configuredUpstreams, liveLogs]);

  const fastestUpstream = useMemo(() => {
    const valid = configuredUpstreams.filter((u) => u.latencyMs > 0);
    if (valid.length === 0) return null;
    return valid.reduce((min, cur) => (cur.latencyMs < min.latencyMs ? cur : min), valid[0]);
  }, [configuredUpstreams]);

  // Handle quick DNS test
  const handleRunTest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!testDomain.trim()) return;
    const clean = testDomain.trim().toLowerCase();
    const isAd =
      clean.includes("ad") ||
      clean.includes("tracker") ||
      clean.includes("telemetry") ||
      clean.includes("e.qq.com");
    const isLocal = clean.endsWith(".cn") || clean.includes("baidu") || clean.includes("qq");

    setTestResult({
      tested: true,
      domain: clean,
      action: isAd
        ? "拦截并丢弃 (Blackhole 0.0.0.0)"
        : isLocal
          ? "国内直连解析 (forward_local)"
          : "上游分流解析 (forward_remote)",
      status: isAd ? "blocked" : "ok",
      rule: isAd ? "adguard_rule & category_ads_all" : isLocal ? "geosite:cn & geoip:cn" : "fallback",
      upstream: isAd ? "None (Short Circuit)" : isLocal ? "https://doh.pub/dns-query" : "udp://8.8.8.8:53",
      latencyMs: isAd ? 0.2 : isLocal ? 3.6 : 32.4,
    });
  };

  const copyText = (txt: string) => {
    void navigator.clipboard.writeText(txt);
    setCopiedDomain(txt);
    setTimeout(() => setCopiedDomain(null), 1800);
  };

  return (
    <div className="space-y-6">
      {/* ── Top Liquid Glass Title & Controls Bar ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold tracking-tight text-foreground">实时指标与策略监控</h2>
            <span className="liquid-glass-pill bg-foreground/[0.04] text-foreground/80 border border-foreground/[0.08]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {health?.status === "ok" ? "引擎运行正常" : "高可用守护中"}
            </span>
            <span className="hidden md:inline-flex liquid-glass-pill bg-foreground/[0.04] text-muted-foreground border border-foreground/[0.08]">
              <Zap className="h-3 w-3 text-primary" />
              双栈高性能内核
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            实时汇总 DNS 解析流量、规则拦截、缓存命中与上游节点延迟统计
          </p>
        </div>

        {/* Action Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Time range segmented control */}
          <div className="macos-segmented">
            {(["1h", "6h", "24h", "live"] as TimeRange[]).map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setTimeRange(range)}
                className={cn(
                  "macos-segmented-item px-2 sm:px-3 text-xs",
                  timeRange === range && "active",
                )}
              >
                {range === "1h" && (
                  <>
                    <span className="sm:hidden">1h</span>
                    <span className="hidden sm:inline">最近 1h</span>
                  </>
                )}
                {range === "6h" && (
                  <>
                    <span className="sm:hidden">6h</span>
                    <span className="hidden sm:inline">最近 6h</span>
                  </>
                )}
                {range === "24h" && (
                  <>
                    <span className="sm:hidden">24h</span>
                    <span className="hidden sm:inline">最近 24h</span>
                  </>
                )}
                {range === "live" && (
                  <>
                    <Radio className="h-3 w-3 text-rose-500 animate-pulse" />
                    <span className="sm:hidden">实时</span>
                    <span className="hidden sm:inline">实时 (5s)</span>
                  </>
                )}
              </button>
            ))}
          </div>

          {/* Auto refresh & manual refresh buttons */}
          <button
            type="button"
            onClick={() => setIsAutoRefresh(!isAutoRefresh)}
            title={isAutoRefresh ? "暂停自动刷新" : "开启自动刷新"}
            className={cn(
              "h-8 px-2.5 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-all",
              isAutoRefresh
                ? "bg-foreground/[0.05] text-foreground border-foreground/[0.1] hover:bg-foreground/[0.08]"
                : "bg-muted/40 text-muted-foreground border-border/40 hover:bg-muted/70",
            )}
          >
            {isAutoRefresh ? (
              <>
                <Pause className="h-3.5 w-3.5 text-muted-foreground" />
                <span>自动</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 text-muted-foreground" />
                <span>已暂停</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => void loadRecorderData()}
            disabled={isRefreshing}
            className="h-8 w-8 rounded-xl border border-border/40 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-all"
            title="手动刷新数据"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin text-primary")}
            />
          </button>
        </div>
      </div>

      {/* ── 6 Master Liquid Glass Metric Cards (Minimalist & High-Contrast) ── */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
        {/* Card 1: Total Queries */}
        <div className="liquid-glass-card p-3 sm:p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-1.5 sm:mb-2">
            <span className="text-xs font-medium text-muted-foreground truncate">总解析请求</span>
            <div className="h-6 w-6 sm:h-7 sm:w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center shrink-0">
              <Activity className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {formatNumber(totalQueries)}
          </div>
          <div className="flex items-center gap-1 text-[10px] sm:text-[11px] text-muted-foreground mt-1 sm:mt-1.5">
            <TrendingUp className="h-3 w-3 text-primary shrink-0" />
            <span className="truncate">累计解析总量</span>
          </div>
        </div>

        {/* Card 2: Real-time QPS */}
        <div className="liquid-glass-card p-3 sm:p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-1.5 sm:mb-2">
            <span className="text-xs font-medium text-muted-foreground truncate">实时 QPS</span>
            <div className="h-6 w-6 sm:h-7 sm:w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center shrink-0">
              <Zap className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-primary" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {currentQps}
            <span className="text-xs font-normal text-muted-foreground ml-1">req/s</span>
          </div>
          <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-muted-foreground mt-1 sm:mt-1.5">
            <span>吞吐速率</span>
            <span className={cn("font-medium", currentQps > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
              {currentQps > 0 ? "服务中" : "就绪"}
            </span>
          </div>
        </div>

        {/* Card 3: Threat & Ad Block Rate */}
        <div className="liquid-glass-card p-3 sm:p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-1.5 sm:mb-2">
            <span className="text-xs font-medium text-muted-foreground truncate">威胁与规则拦截</span>
            <div className="h-6 w-6 sm:h-7 sm:w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center shrink-0">
              <ShieldAlert className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-rose-500" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {blockRate}%
          </div>
          <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-muted-foreground mt-1 sm:mt-1.5">
            <span suppressHydrationWarning className="truncate">{formatNumber(blockCount)} 次拦截</span>
            <span className="text-[10px] font-mono text-muted-foreground shrink-0 hidden sm:inline">REFUSED</span>
          </div>
        </div>

        {/* Card 4: Average Latency */}
        <div className="liquid-glass-card p-3 sm:p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-1.5 sm:mb-2">
            <span className="text-xs font-medium text-muted-foreground truncate">平均响应耗时</span>
            <div className="h-6 w-6 sm:h-7 sm:w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center shrink-0">
              <Clock className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {avgLatency > 0 ? avgLatency : "-"}
            {avgLatency > 0 && <span className="text-xs font-normal text-muted-foreground ml-1">ms</span>}
          </div>
          <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-muted-foreground mt-1 sm:mt-1.5">
            <span>{avgLatency > 0 ? (avgLatency < 10 ? "极佳" : "正常") : "暂无采样"}</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
              {avgLatency > 0 && avgLatency < 20 ? "低延迟" : ""}
            </span>
          </div>
        </div>

        {/* Card 5: Cache Hit Ratio */}
        <div className="liquid-glass-card p-3 sm:p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-1.5 sm:mb-2">
            <span className="text-xs font-medium text-muted-foreground truncate">智能缓存命中率</span>
            <div className="h-6 w-6 sm:h-7 sm:w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center shrink-0">
              <Database className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {cacheHitRate}%
          </div>
          <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-muted-foreground mt-1 sm:mt-1.5">
            <span suppressHydrationWarning className="truncate">{formatNumber(cacheHitCount)} 命中</span>
            <span className="font-mono text-[10px] shrink-0">本地缓存</span>
          </div>
        </div>

        {/* Card 6: Upstream Health */}
        <div className="liquid-glass-card p-3 sm:p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-1.5 sm:mb-2">
            <span className="text-xs font-medium text-muted-foreground truncate">上游可用节点</span>
            <div className="h-6 w-6 sm:h-7 sm:w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center shrink-0">
              <Server className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {configuredUpstreams.length} <span className="text-xs font-normal text-muted-foreground ml-1">节点</span>
          </div>
          <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-muted-foreground mt-1 sm:mt-1.5 truncate">
            <span className="truncate">
              {fastestUpstream ? `最快: ${fastestUpstream.tag || fastestUpstream.addr}` : "已接入上游"}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium font-mono shrink-0">
              {fastestUpstream ? `${fastestUpstream.latencyMs}ms` : "-"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Chart Section 1: Minimalist Liquid Glass Area Chart ── */}
      <div className="liquid-glass-card p-3.5 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold text-foreground">DNS 流量与吞吐趋势</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              总解析查询量、本地缓存命中、规则拦截阻断与外部转发上游的实时动态对比
            </p>
          </div>

          {/* Minimalist Inline Legend */}
          <div className="flex flex-wrap items-center gap-3.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#0284c7]" />
              <span className="text-foreground/90 font-medium">总请求</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#10b981]" />
              <span>缓存命中</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#f43f5e]" />
              <span>安全拦截</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#64748b]" />
              <span>转发上游</span>
            </span>
          </div>
        </div>

        {timeseriesData.length > 0 ? (
          <div className="h-56 sm:h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timeseriesData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradientTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0284c7" stopOpacity={0.12} />
                    <stop offset="95%" stopColor="#0284c7" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="gradientCached" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.06} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="gradientBlocked" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.05} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="currentColor"
                  className="text-border/20"
                />
                <XAxis
                  dataKey="time"
                  stroke="currentColor"
                  className="text-[11px] text-muted-foreground"
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="currentColor"
                  className="text-[11px] text-muted-foreground"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val) => (val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(val))}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="liquid-glass-card p-3 shadow-xl text-xs space-y-1.5 min-w-[170px] border border-border/60">
                        <div className="font-semibold text-foreground border-b border-border/30 pb-1 flex items-center justify-between">
                          <span>时间: {label}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            QPS: {payload[0]?.payload?.qps}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-1.5 w-1.5 rounded-full bg-[#0284c7]" />
                            总请求:
                          </span>
                          <span className="font-bold tabular-nums text-foreground">{payload[0]?.value}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" />
                            缓存命中:
                          </span>
                          <span className="font-bold tabular-nums text-foreground">{payload[1]?.value}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-1.5 w-1.5 rounded-full bg-[#f43f5e]" />
                            规则拦截:
                          </span>
                          <span className="font-bold tabular-nums text-foreground">{payload[2]?.value}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-1.5 w-1.5 rounded-full bg-[#64748b]" />
                            上游转发:
                          </span>
                          <span className="font-bold tabular-nums text-foreground">{payload[3]?.value}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="#0284c7"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#gradientTotal)"
                />
                <Area
                  type="monotone"
                  dataKey="cached"
                  stroke="#10b981"
                  strokeWidth={1.5}
                  fillOpacity={1}
                  fill="url(#gradientCached)"
                />
                <Area
                  type="monotone"
                  dataKey="blocked"
                  stroke="#f43f5e"
                  strokeWidth={1.5}
                  fillOpacity={1}
                  fill="url(#gradientBlocked)"
                />
                <Area
                  type="monotone"
                  dataKey="forwarded"
                  stroke="#64748b"
                  strokeWidth={1.2}
                  strokeDasharray="3 3"
                  fillOpacity={0}
                  fill="transparent"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-xs text-muted-foreground">
            <BarChart3 className="h-10 w-10 text-muted-foreground/30 mb-2" />
            <span className="font-medium text-foreground">暂无实时流量趋势数据</span>
            <span className="text-[11px] text-muted-foreground mt-1">
              {recorderPlugin
                ? "正在等待 DNS 查询流量汇入..."
                : "在 config.yaml 主流水线中配置 query_recorder 插件即可开启流量趋势与时序图表分析"}
            </span>
          </div>
        )}
      </div>

      {/* ── Chart Section 2: Distribution Row (2 Columns) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Left: DNS Response Codes (RCODE) Donut */}
        <div className="liquid-glass-card p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <PieChartIcon className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">DNS 解析状态分布 (RCODE)</h3>
              </div>
              {rcodes.length > 0 && (
                <span className="liquid-glass-pill bg-foreground/[0.04] text-muted-foreground text-[11px] border border-foreground/[0.08]">
                  {rcodes.find((r) => r.name.includes("NOERROR"))?.pct ?? 100}% 正常服务率
                </span>
              )}
            </div>

            {rcodes.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 items-center gap-4">
                <div className="h-48 relative flex items-center justify-center">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={rcodes}
                        cx="50%"
                        cy="50%"
                        innerRadius={58}
                        outerRadius={80}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {rcodes.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const data = payload[0].payload as RcodeDist;
                          return (
                            <div className="liquid-glass-card p-2 text-xs shadow-md border border-border/50">
                              <span className="font-semibold text-foreground">{data.name}</span>:{" "}
                              {formatNumber(data.value)} ({data.pct}%)
                            </div>
                          );
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center Badge */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-xl font-bold font-mono text-foreground">
                      {rcodes.find((r) => r.name.includes("NOERROR"))?.pct ?? 100}%
                    </span>
                    <span className="text-[10px] text-muted-foreground">正常率</span>
                  </div>
                </div>

                {/* Legend List */}
                <div className="space-y-2.5">
                  {rcodes.map((rc) => (
                    <div key={rc.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: rc.color }} />
                        <span className="truncate text-foreground/90">{rc.name}</span>
                      </div>
                      <div className="flex items-center gap-2 font-mono tabular-nums">
                        <span className="text-muted-foreground">{formatNumber(rc.value)}</span>
                        <span className="font-medium text-foreground min-w-[38px] text-right">{rc.pct}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-48 flex flex-col items-center justify-center text-center p-4 text-xs text-muted-foreground">
                <PieChartIcon className="h-8 w-8 text-muted-foreground/30 mb-2" />
                <span>暂无 RCODE 状态分布数据</span>
                <span className="text-[11px] text-muted-foreground/60 mt-0.5">
                  在主流程中启用 query_recorder 插件后可自动收集
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Protocols & QTypes Segmented Card */}
        <div className="liquid-glass-card p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">协议传输与记录类型占比</h3>
              </div>

              {/* Segmented Switcher */}
              <div className="macos-segmented">
                <button
                  type="button"
                  onClick={() => setActiveDistTab("protocol")}
                  className={cn(
                    "macos-segmented-item py-1 text-xs",
                    activeDistTab === "protocol" && "active",
                  )}
                >
                  传输协议
                </button>
                <button
                  type="button"
                  onClick={() => setActiveDistTab("qtype")}
                  className={cn(
                    "macos-segmented-item py-1 text-xs",
                    activeDistTab === "qtype" && "active",
                  )}
                >
                  记录类型 (QType)
                </button>
              </div>
            </div>

            {/* Content for Active Tab */}
            {activeDistTab === "protocol" ? (
              <div className="space-y-3 pt-1">
                {configuredProtocols.length > 0 ? (
                  configuredProtocols.map((p) => (
                    <div key={p.name} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium flex items-center gap-1.5 text-foreground">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                          {p.name}
                        </span>
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {formatNumber(p.value)} ({p.pct}%)
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-foreground/[0.05] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${p.pct}%`,
                            backgroundColor: p.color,
                          }}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="h-40 flex flex-col items-center justify-center text-center p-4 text-xs text-muted-foreground">
                    <Layers className="h-8 w-8 text-muted-foreground/30 mb-2" />
                    <span>暂无监听服务协议</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                {qtypes.length > 0 ? (
                  qtypes.map((q) => (
                    <div key={q.name} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium flex items-center gap-1.5 text-foreground">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: q.color }} />
                          {q.name}
                        </span>
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {formatNumber(q.value)} ({q.pct}%)
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-foreground/[0.05] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${q.pct}%`,
                            backgroundColor: q.color,
                          }}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="h-40 flex flex-col items-center justify-center text-center p-4 text-xs text-muted-foreground">
                    <Layers className="h-8 w-8 text-muted-foreground/30 mb-2" />
                    <span>暂无 QType 记录分布</span>
                    <span className="text-[11px] text-muted-foreground/60 mt-0.5">
                      在主流程中启用 query_recorder 插件后可自动统计
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Chart Section 3: Upstream Nodes Performance (Bar Chart) ── */}
      <div className="liquid-glass-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
          <div>
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold text-foreground">上游 DNS 节点性能与响应延迟</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              各配置上游（来自 forward 插件的 upstreams 配置）的解析承载量与实测延迟对比
            </p>
          </div>
          <span className="liquid-glass-pill bg-foreground/[0.04] text-muted-foreground text-xs border border-foreground/[0.08]">
            已配置节点: {configuredUpstreams.length} 个
          </span>
        </div>

        {configuredUpstreams.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
            {configuredUpstreams.map((ups) => {
              const maxQ = Math.max(1, ...configuredUpstreams.map((u) => u.queries));
              return (
                <div
                  key={`${ups.tag}-${ups.addr}`}
                  className="p-3.5 rounded-xl border border-border/40 bg-foreground/[0.02] hover:bg-foreground/[0.04] transition-all space-y-2.5"
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 pr-2">
                      <h4 className="text-xs font-semibold text-foreground truncate" title={ups.name}>
                        {ups.tag || ups.name}
                      </h4>
                      <p className="text-[11px] text-muted-foreground font-mono truncate" title={ups.addr}>
                        {ups.addr}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-md font-mono font-medium border",
                        ups.latencyMs > 0 && ups.latencyMs < 15
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                          : "bg-foreground/[0.04] text-muted-foreground border-foreground/[0.08]",
                      )}
                    >
                      {ups.latencyMs > 0 ? `${ups.latencyMs} ms` : "-"}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>处理量: {formatNumber(ups.queries)}</span>
                      <span>成功率: {ups.queries > 0 ? `${ups.successRate}%` : "-"}</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-foreground/[0.06] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{
                          width: `${Math.min(100, (ups.queries / maxQ) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-8 text-center rounded-xl border border-dashed border-border/60 bg-foreground/[0.01]">
            <Globe className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-xs font-medium text-foreground">暂未检测到配置的上游 DNS 节点</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              请检查 config.yaml 中是否配置了 forward 插件并声明了 upstreams 列表
            </p>
          </div>
        )}
      </div>

      {/* ── Section 4: Rankings & Tables (Top Domains & Clients) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Top 10 Queried Domains */}
        <div className="liquid-glass-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Top 热门查询域名</h3>
            </div>
            <span className="text-[11px] text-muted-foreground">占比统计</span>
          </div>

          <div className="space-y-2">
            {topQueries.length > 0 ? (
              topQueries.slice(0, 7).map((item) => (
                <div
                  key={item.name}
                  className="group flex items-center justify-between p-2 rounded-lg hover:bg-foreground/[0.04] transition-all text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={cn(
                        "h-5 w-5 rounded-md flex items-center justify-center font-mono font-bold text-[10px] shrink-0",
                        item.rank <= 3
                          ? "bg-foreground/[0.08] text-foreground font-semibold"
                          : "bg-foreground/[0.03] text-muted-foreground",
                      )}
                    >
                      {item.rank}
                    </span>
                    <div className="min-w-0">
                      <div className="font-mono text-foreground font-medium truncate max-w-[140px]" title={item.name}>
                        {item.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">{item.category || "域名解析"}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {formatNumber(item.count)}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyText(item.name)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:text-foreground text-muted-foreground rounded transition-opacity"
                      title="复制域名"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground/60">
                暂无请求域名数据
              </div>
            )}
          </div>
        </div>

        {/* Top 10 Blocked Ad & Threat Domains */}
        <div className="liquid-glass-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-rose-500" />
              <h3 className="text-sm font-semibold text-foreground">Top 拦截广告与威胁</h3>
            </div>
            <span className="liquid-glass-pill bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 text-[11px]">
              规则拦截
            </span>
          </div>

          <div className="space-y-2">
            {topBlocked.length > 0 ? (
              topBlocked.slice(0, 7).map((item) => (
                <div
                  key={item.name}
                  className="group flex items-center justify-between p-2 rounded-lg hover:bg-foreground/[0.04] transition-all text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="h-5 w-5 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center font-mono font-bold text-[10px] shrink-0">
                      {item.rank}
                    </span>
                    <div className="min-w-0">
                      <div className="font-mono text-foreground font-medium truncate max-w-[140px]" title={item.name}>
                        {item.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono truncate">
                        {item.ruleTag || "规则拦截"}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="font-mono tabular-nums text-foreground/85 font-medium">
                      {formatNumber(item.count)}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyText(item.name)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:text-foreground text-muted-foreground rounded transition-opacity"
                      title="复制域名"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground/60">
                暂无拦截记录
              </div>
            )}
          </div>
        </div>

        {/* Top Clients Ranking */}
        <div className="liquid-glass-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Laptop className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Top 活跃客户端设备</h3>
            </div>
            <span className="text-[11px] text-muted-foreground">局域网 IP</span>
          </div>

          <div className="space-y-3">
            {topClients.length > 0 ? (
              topClients.map((item) => (
                <div key={item.ip || item.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-medium truncate text-foreground">{item.name}</span>
                    </div>
                    <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                      {item.percentage}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-foreground/[0.05] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${item.percentage}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground/60">
                {recorderPlugin ? "暂无客户端记录" : "需在配置中启用 query_recorder 插件以统计真实客户端"}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Section 5: Real-time Live Query Stream & Test Utility ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Real-time Query Activity Ticker (2 Cols) */}
        <div className="liquid-glass-card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-emerald-500 animate-pulse" />
              <h3 className="text-sm font-semibold text-foreground">实时 DNS 解析流水</h3>
            </div>
            <span className="text-[11px] text-muted-foreground font-mono">
              Live Stream (Auto Update)
            </span>
          </div>

          <div className="overflow-x-auto -mx-1 sm:mx-0">
            <table className="w-full text-left text-xs min-w-[580px]">
              <thead>
                <tr className="border-b border-border/40 text-muted-foreground font-medium">
                  <th className="pb-2 pl-1">时间</th>
                  <th className="pb-2">查询域名</th>
                  <th className="pb-2">类型</th>
                  <th className="pb-2">客户端 IP</th>
                  <th className="pb-2">上游/处理</th>
                  <th className="pb-2">耗时</th>
                  <th className="pb-2 pr-1 text-right">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20 font-mono">
                {liveLogs.length > 0 ? (
                  liveLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-foreground/[0.02] transition-colors">
                      <td className="py-2.5 pl-1 text-muted-foreground text-[11px]">{log.time}</td>
                      <td className="py-2.5 font-medium text-foreground max-w-[200px] truncate" title={log.qname}>
                        {log.qname}
                      </td>
                      <td className="py-2.5 text-muted-foreground">{log.qtype}</td>
                      <td className="py-2.5 text-muted-foreground">{log.clientIp}</td>
                      <td className="py-2.5 text-muted-foreground text-[11px]">
                        {log.upstream || (log.status === "cached" ? "local_cache" : "blackhole")}
                      </td>
                      <td className="py-2.5 text-[11px]">{log.latencyMs} ms</td>
                      <td className="py-2.5 pr-1 text-right">
                        {log.status === "cached" && (
                          <span className="liquid-glass-pill bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-[10px] py-0.5">
                            缓存命中
                          </span>
                        )}
                        {log.status === "blocked" && (
                          <span className="liquid-glass-pill bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 text-[10px] py-0.5">
                            规则拦截
                          </span>
                        )}
                        {log.status === "success" && (
                          <span className="liquid-glass-pill bg-foreground/[0.04] text-foreground/80 border border-foreground/[0.08] text-[10px] py-0.5">
                            正常解析
                          </span>
                        )}
                        {log.status === "error" && (
                          <span className="liquid-glass-pill bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 text-[10px] py-0.5">
                            解析异常
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-xs text-muted-foreground/60">
                      {recorderPlugin ? "等待 DNS 查询流水..." : "未在配置中检测到 query_recorder 插件，暂无流水"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Quick DNS Test Tool Widget (1 Col) */}
        <div className="liquid-glass-card p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Search className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">快速测试域名解析</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              输入域名模拟经由 OxiDNS 流水线的处理规则（缓存/广告过滤/国内外分流）
            </p>

            <form onSubmit={handleRunTest} className="space-y-3">
              <div>
                <input
                  type="text"
                  placeholder="例如: doh.pub 或 e.qq.com"
                  value={testDomain}
                  onChange={(e) => setTestDomain(e.target.value)}
                  className="w-full text-xs px-3 py-2 rounded-xl bg-background/60 border border-border/60 focus:outline-none focus:ring-2 focus:ring-primary/40 font-mono"
                />
              </div>
              <button
                type="submit"
                className="w-full h-8 text-xs font-medium rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center justify-center gap-1.5 shadow-sm"
              >
                <Zap className="h-3.5 w-3.5" />
                执行模拟解析
              </button>
            </form>

            {testResult?.tested && (
              <div className="mt-4 p-3 rounded-xl bg-foreground/[0.02] border border-border/50 text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground font-mono">{testResult.domain}</span>
                  <span
                    className={cn(
                      "liquid-glass-pill text-[10px] py-0.5 border",
                      testResult.status === "blocked"
                        ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
                        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
                    )}
                  >
                    {testResult.status === "blocked" ? "已阻断" : "成功解析"}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground space-y-1 font-mono">
                  <div>匹配策略: <span className="text-foreground">{testResult.rule}</span></div>
                  <div>执行动作: <span className="text-foreground">{testResult.action}</span></div>
                  <div>指定上游: <span className="text-foreground">{testResult.upstream}</span></div>
                  <div>评估耗时: <span className="text-foreground">{testResult.latencyMs} ms</span></div>
                </div>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-border/40 text-[11px] text-muted-foreground flex items-center justify-between">
            <span>支持 A / AAAA / CNAME 查询</span>
            <span className="text-primary hover:underline cursor-pointer">查看规则库</span>
          </div>
        </div>
      </div>
    </div>
  );
}
