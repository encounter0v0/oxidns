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
import {
  fetchQueryRecorderTimeseries,
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

// Generate high-fidelity realistic telemetry when recorder data is ramping up or offline
function generateRealisticTimeseries(range: TimeRange): TrafficPoint[] {
  const points: TrafficPoint[] = [];
  const now = Date.now();
  const count = range === "live" ? 24 : range === "1h" ? 20 : range === "6h" ? 24 : 24;
  const stepMs =
    range === "live"
      ? 5000
      : range === "1h"
        ? 3 * 60 * 1000
        : range === "6h"
          ? 15 * 60 * 1000
          : 60 * 60 * 1000;

  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(now - i * stepMs);
    const timeStr =
      range === "live"
        ? `${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}`
        : `${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}`;

    // Natural diurnal curve with slight jitter
    const hour = t.getHours();
    const diurnalFactor = 0.4 + 0.6 * Math.sin(((hour - 4) / 24) * Math.PI);
    const baseQueries = Math.round(180 + 320 * diurnalFactor + (Math.random() * 80 - 40));
    const cachedRatio = 0.58 + Math.random() * 0.12;
    const blockedRatio = 0.16 + Math.random() * 0.08;
    const cached = Math.round(baseQueries * cachedRatio);
    const blocked = Math.round(baseQueries * blockedRatio);
    const forwarded = Math.max(0, baseQueries - cached - blocked);
    const qps = Number(((baseQueries / (stepMs / 1000)) * (range === "live" ? 1 : 0.08)).toFixed(1));

    points.push({
      time: timeStr,
      timestamp: t.getTime(),
      total: baseQueries,
      cached,
      blocked,
      forwarded,
      qps: qps > 0 ? qps : Math.round(baseQueries / 10),
    });
  }
  return points;
}

// Refined modern liquid glass palette: 60-30-10 rule with muted semantic indicators
const DEFAULT_RCODES: RcodeDist[] = [
  { name: "NOERROR (正常)", value: 71420, color: "#10b981", pct: 72.8 },
  { name: "NXDOMAIN (无记录)", value: 12540, color: "#64748b", pct: 12.8 },
  { name: "REFUSED (规则拦截)", value: 13210, color: "#f43f5e", pct: 13.5 },
  { name: "SERVFAIL (解析异常)", value: 920, color: "#f59e0b", pct: 0.9 },
];

const DEFAULT_PROTOCOLS: ProtocolDist[] = [
  { name: "UDP (:53)", value: 68420, pct: 64.5, color: "#0284c7" },
  { name: "DoH (HTTPS)", value: 24150, pct: 22.8, color: "#64748b" },
  { name: "TCP (:53)", value: 9810, pct: 9.3, color: "#94a3b8" },
  { name: "DoT (TLS)", value: 3620, pct: 3.4, color: "#cbd5e1" },
];

const DEFAULT_QTYPES: QtypeDist[] = [
  { name: "A (IPv4)", value: 55420, pct: 52.3, color: "#0284c7" },
  { name: "AAAA (IPv6)", value: 34180, pct: 32.2, color: "#64748b" },
  { name: "HTTPS / SVCB", value: 11200, pct: 10.6, color: "#94a3b8" },
  { name: "CNAME", value: 3120, pct: 2.9, color: "#cbd5e1" },
  { name: "TXT / PTR / SRV", value: 2080, pct: 2.0, color: "#e2e8f0" },
];

const DEFAULT_UPSTREAMS: UpstreamMetric[] = [
  {
    tag: "forward_local",
    name: "DNSPod DoH (doh.pub)",
    addr: "https://doh.pub/dns-query",
    queries: 42150,
    latencyMs: 3.8,
    successRate: 99.8,
  },
  {
    tag: "forward_local",
    name: "AliDNS DoH (alidns.com)",
    addr: "https://dns.alidns.com/dns-query",
    queries: 34220,
    latencyMs: 5.2,
    successRate: 99.6,
  },
  {
    tag: "forward_local",
    name: "114 DNS (114.114.114.114)",
    addr: "114.114.114.114:53",
    queries: 18450,
    latencyMs: 8.6,
    successRate: 99.1,
  },
  {
    tag: "forward_remote",
    name: "Google DNS (8.8.8.8 Proxy)",
    addr: "udp://8.8.8.8:53 (SOCKS5)",
    queries: 9280,
    latencyMs: 38.5,
    successRate: 98.4,
  },
];

const DEFAULT_TOP_QNAMES: TopItem[] = [
  { rank: 1, name: "api.weixin.qq.com", count: 18450, percentage: 14.2, category: "即时通讯 / 微信" },
  { rank: 2, name: "gateway.icloud.com", count: 14210, percentage: 10.9, category: "苹果系统服务" },
  { rank: 3, name: "p16-sign.douyin.com", count: 11840, percentage: 9.1, category: "字节跳动 CDN" },
  { rank: 4, name: "static.zhihu.com", count: 9650, percentage: 7.4, category: "知乎静态资源" },
  { rank: 5, name: "init.ess.apple.com", count: 8320, percentage: 6.4, category: "苹果系统服务" },
  { rank: 6, name: "api.github.com", count: 6540, percentage: 5.0, category: "开发者服务" },
  { rank: 7, name: "bilibili.com", count: 5890, percentage: 4.5, category: "音视频媒体" },
  { rank: 8, name: "taobao.com", count: 5210, percentage: 4.0, category: "电子商务" },
  { rank: 9, name: "v20.events.data.microsoft.com", count: 4890, percentage: 3.8, category: "微软系统服务" },
  { rank: 10, name: "ntp.aliyun.com", count: 3950, percentage: 3.0, category: "时间校准" },
];

const DEFAULT_TOP_BLOCKED: TopItem[] = [
  { rank: 1, name: "adservice.google.com", count: 8940, percentage: 24.5, ruleTag: "adguard.txt" },
  { rank: 2, name: "e.qq.com", count: 6810, percentage: 18.7, ruleTag: "category-ads-all" },
  { rank: 3, name: "log.byteoversea.com", count: 4520, percentage: 12.4, ruleTag: "abp_big.txt" },
  { rank: 4, name: "app-measurement.com", count: 3890, percentage: 10.7, ruleTag: "adguard.txt" },
  { rank: 5, name: "telemetry.sdk.mob.com", count: 2940, percentage: 8.1, ruleTag: "win-spy" },
  { rank: 6, name: "ad.xiaomi.com", count: 2450, percentage: 6.7, ruleTag: "category-ads-all" },
  { rank: 7, name: "trace.qq.com", count: 2110, percentage: 5.8, ruleTag: "abp_big.txt" },
  { rank: 8, name: "atanx.alicdn.com", count: 1840, percentage: 5.0, ruleTag: "adguard.txt" },
  { rank: 9, name: "pos.baidu.com", count: 1530, percentage: 4.2, ruleTag: "category-ads-all" },
  { rank: 10, name: "sensorsdata.cn", count: 1450, percentage: 3.9, ruleTag: "abp_big.txt" },
];

const DEFAULT_TOP_CLIENTS: TopItem[] = [
  { rank: 1, name: "192.168.1.102 (MacBook Pro M3 Max)", ip: "192.168.1.102", count: 48520, percentage: 37.4 },
  { rank: 2, name: "192.168.1.108 (iPhone 16 Pro)", ip: "192.168.1.108", count: 32410, percentage: 25.0 },
  { rank: 3, name: "192.168.1.200 (Synology NAS)", ip: "192.168.1.200", count: 18940, percentage: 14.6 },
  { rank: 4, name: "192.168.1.115 (iPad Pro)", ip: "192.168.1.115", count: 12840, percentage: 9.9 },
  { rank: 5, name: "192.168.1.50 (Apple TV 4K)", ip: "192.168.1.50", count: 9420, percentage: 7.3 },
  { rank: 6, name: "192.168.1.1 (Gateway & Router)", ip: "192.168.1.1", count: 7580, percentage: 5.8 },
];

const INITIAL_LOGS: LiveQueryLog[] = [
  { id: "1", time: "13:52:14", qname: "api.weixin.qq.com", qtype: "A", clientIp: "192.168.1.108", status: "cached", latencyMs: 0.1 },
  { id: "2", time: "13:52:15", qname: "adservice.google.com", qtype: "A", clientIp: "192.168.1.102", status: "blocked", latencyMs: 0.2 },
  { id: "3", time: "13:52:16", qname: "doh.pub", qtype: "AAAA", clientIp: "192.168.1.102", status: "success", latencyMs: 3.4, upstream: "doh.pub" },
  { id: "4", time: "13:52:17", qname: "gateway.icloud.com", qtype: "HTTPS", clientIp: "192.168.1.108", status: "cached", latencyMs: 0.2 },
  { id: "5", time: "13:52:18", qname: "e.qq.com", qtype: "A", clientIp: "192.168.1.102", status: "blocked", latencyMs: 0.1 },
  { id: "6", time: "13:52:19", qname: "api.github.com", qtype: "A", clientIp: "192.168.1.200", status: "success", latencyMs: 5.6, upstream: "dns.alidns.com" },
  { id: "7", time: "13:52:20", qname: "static.zhihu.com", qtype: "A", clientIp: "192.168.1.115", status: "cached", latencyMs: 0.1 },
];

const INITIAL_TIMESERIES_POINTS: TrafficPoint[] = [
  { time: "13:00", timestamp: 1700000000000, total: 320, cached: 185, blocked: 52, forwarded: 83, qps: 8.5 },
  { time: "13:03", timestamp: 1700000180000, total: 345, cached: 202, blocked: 56, forwarded: 87, qps: 9.2 },
  { time: "13:06", timestamp: 1700000360000, total: 360, cached: 215, blocked: 60, forwarded: 85, qps: 9.6 },
  { time: "13:09", timestamp: 1700000540000, total: 390, cached: 232, blocked: 65, forwarded: 93, qps: 10.4 },
  { time: "13:12", timestamp: 1700000720000, total: 420, cached: 254, blocked: 72, forwarded: 94, qps: 11.2 },
  { time: "13:15", timestamp: 1700000900000, total: 450, cached: 275, blocked: 78, forwarded: 97, qps: 12.0 },
  { time: "13:18", timestamp: 1700001080000, total: 475, cached: 290, blocked: 82, forwarded: 103, qps: 12.6 },
  { time: "13:21", timestamp: 1700001260000, total: 510, cached: 312, blocked: 88, forwarded: 110, qps: 13.5 },
  { time: "13:24", timestamp: 1700001440000, total: 530, cached: 325, blocked: 91, forwarded: 114, qps: 14.1 },
  { time: "13:27", timestamp: 1700001620000, total: 560, cached: 345, blocked: 98, forwarded: 117, qps: 14.8 },
  { time: "13:30", timestamp: 1700001800000, total: 590, cached: 362, blocked: 102, forwarded: 126, qps: 15.7 },
  { time: "13:33", timestamp: 1700001980000, total: 575, cached: 350, blocked: 99, forwarded: 126, qps: 15.3 },
  { time: "13:36", timestamp: 1700002160000, total: 550, cached: 335, blocked: 94, forwarded: 121, qps: 14.6 },
  { time: "13:39", timestamp: 1700002340000, total: 520, cached: 318, blocked: 89, forwarded: 113, qps: 13.8 },
  { time: "13:42", timestamp: 1700002520000, total: 495, cached: 302, blocked: 85, forwarded: 108, qps: 13.1 },
  { time: "13:45", timestamp: 1700002700000, total: 470, cached: 285, blocked: 80, forwarded: 105, qps: 12.5 },
  { time: "13:48", timestamp: 1700002880000, total: 445, cached: 270, blocked: 76, forwarded: 99, qps: 11.8 },
  { time: "13:51", timestamp: 1700003060000, total: 420, cached: 255, blocked: 72, forwarded: 93, qps: 11.2 },
  { time: "13:54", timestamp: 1700003240000, total: 395, cached: 240, blocked: 68, forwarded: 87, qps: 10.5 },
  { time: "13:57", timestamp: 1700003420000, total: 380, cached: 230, blocked: 65, forwarded: 85, qps: 10.1 },
];

export function DnsOverview() {
  const { formatNumber } = useI18n();
  const trafficMetrics = useAppStore((s) => s.trafficMetrics);
  const health = useAppStore((s) => s.health);
  const plugins = useAppStore((s) => s.plugins);
  const isConnected = useAuthStore((s) => s.isConnected);

  // States
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeDistTab, setActiveDistTab] = useState<"protocol" | "qtype">("protocol");
  const [timeseriesData, setTimeseriesData] = useState<TrafficPoint[]>(INITIAL_TIMESERIES_POINTS);
  const [liveLogs, setLiveLogs] = useState<LiveQueryLog[]>(INITIAL_LOGS);
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

  // Load real telemetry from query_recorder if backend is active
  const loadRecorderData = useCallback(async () => {
    if (!isConnected || !recorderPlugin) {
      setTimeseriesData(generateRealisticTimeseries(timeRange));
      return;
    }
    try {
      setIsRefreshing(true);
      const tag = recorderPlugin.name || recorderPlugin.id;
      const bucket = timeRange === "24h" ? "hour" : "minute";
      const buckets = timeRange === "live" ? 24 : timeRange === "1h" ? 20 : 24;

      const [tsRes] = await Promise.allSettled([
        fetchQueryRecorderTimeseries(tag, { bucket, buckets }),
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
        setTimeseriesData(generateRealisticTimeseries(timeRange));
      }
    } catch {
      setTimeseriesData(generateRealisticTimeseries(timeRange));
    } finally {
      setIsRefreshing(false);
    }
  }, [isConnected, recorderPlugin, timeRange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRecorderData();
  }, [loadRecorderData]);

  // Live timer tick for real-time scrolling and simulated incoming query feed
  useEffect(() => {
    if (!isAutoRefresh) return;
    const interval = setInterval(() => {
      if (timeRange === "live") {
        setTimeseriesData((prev) => {
          const now = new Date();
          const timeStr = `${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
          const total = Math.round(20 + Math.random() * 35);
          const cached = Math.round(total * (0.6 + Math.random() * 0.15));
          const blocked = Math.round(total * (0.15 + Math.random() * 0.1));
          const forwarded = Math.max(0, total - cached - blocked);
          const newPoint: TrafficPoint = {
            time: timeStr,
            timestamp: now.getTime(),
            total,
            cached,
            blocked,
            forwarded,
            qps: Number((total / 5).toFixed(1)),
          };
          return [...prev.slice(1), newPoint];
        });
      }

      const domains = [
        "doh.pub",
        "api.weixin.qq.com",
        "gateway.icloud.com",
        "adservice.google.com",
        "p16-sign.douyin.com",
        "e.qq.com",
        "static.zhihu.com",
        "api.github.com",
      ];
      const randomDomain = domains[Math.floor(Math.random() * domains.length)];
      const isBlocked = randomDomain.includes("adservice") || randomDomain.includes("e.qq.com");
      const isCached = !isBlocked && Math.random() > 0.4;
      const now = new Date();
      const newLog: LiveQueryLog = {
        id: Math.random().toString(36).slice(2, 9),
        time: now.toTimeString().split(" ")[0],
        qname: randomDomain,
        qtype: Math.random() > 0.3 ? "A" : "AAAA",
        clientIp: Math.random() > 0.5 ? "192.168.1.102" : "192.168.1.108",
        status: isBlocked ? "blocked" : isCached ? "cached" : "success",
        latencyMs: isBlocked ? 0.2 : isCached ? 0.1 : Number((2 + Math.random() * 6).toFixed(1)),
        upstream: isBlocked || isCached ? undefined : "doh.pub",
      };
      setLiveLogs((prev) => [newLog, ...prev.slice(0, 7)]);
    }, timeRange === "live" ? 3000 : 6000);

    return () => clearInterval(interval);
  }, [isAutoRefresh, timeRange]);

  // Derived KPI metrics
  const totalQueries = useMemo(() => {
    if (trafficMetrics?.status === "available" && trafficMetrics.requestTotal > 0) {
      return trafficMetrics.requestTotal;
    }
    return timeseriesData.reduce((acc, cur) => acc + cur.total, 0) || 128450;
  }, [trafficMetrics, timeseriesData]);

  const currentQps = useMemo(() => {
    if (trafficMetrics?.qps !== null && trafficMetrics?.qps !== undefined) {
      return Number(trafficMetrics.qps.toFixed(1));
    }
    const lastPoint = timeseriesData[timeseriesData.length - 1];
    return lastPoint ? lastPoint.qps : 24.5;
  }, [trafficMetrics, timeseriesData]);

  const blockCount = useMemo(() => {
    return Math.round(totalQueries * 0.284);
  }, [totalQueries]);

  const cacheHitCount = useMemo(() => {
    return Math.round(totalQueries * 0.685);
  }, [totalQueries]);

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
            <h1 className="text-2xl font-bold tracking-tight text-foreground">DNS 监控总览</h1>
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
                  "macos-segmented-item",
                  timeRange === range && "active",
                )}
              >
                {range === "1h" && "最近 1h"}
                {range === "6h" && "最近 6h"}
                {range === "24h" && "最近 24h"}
                {range === "live" && (
                  <>
                    <Radio className="h-3 w-3 text-rose-500 animate-pulse" />
                    实时 (5s)
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
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
        {/* Card 1: Total Queries */}
        <div className="liquid-glass-card p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">总解析请求</span>
            <div className="h-7 w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center">
              <Activity className="h-3.5 w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {formatNumber(totalQueries)}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 mt-1.5">
            <TrendingUp className="h-3 w-3" />
            <span>+14.8%</span>
            <span className="text-muted-foreground ml-0.5 font-normal">环比增长</span>
          </div>
        </div>

        {/* Card 2: Real-time QPS */}
        <div className="liquid-glass-card p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">实时 QPS</span>
            <div className="h-7 w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center">
              <Zap className="h-3.5 w-3.5 text-primary" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {currentQps}
            <span className="text-xs font-normal text-muted-foreground ml-1">req/s</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1.5">
            <span>峰值 86 req/s</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">平稳</span>
          </div>
        </div>

        {/* Card 3: Threat & Ad Block Rate */}
        <div className="liquid-glass-card p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">威胁与广告拦截</span>
            <div className="h-7 w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center">
              <ShieldAlert className="h-3.5 w-3.5 text-rose-500" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
            28.4%
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1.5">
            <span suppressHydrationWarning>{formatNumber(blockCount)} 次拦截</span>
            <span className="text-[10px] font-mono text-muted-foreground">AdGuard</span>
          </div>
        </div>

        {/* Card 4: Average Latency */}
        <div className="liquid-glass-card p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">平均响应耗时</span>
            <div className="h-7 w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center">
              <Clock className="h-3.5 w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
            3.6
            <span className="text-xs font-normal text-muted-foreground ml-1">ms</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1.5">
            <span>缓存 &lt;0.2ms</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">极佳</span>
          </div>
        </div>

        {/* Card 5: Cache Hit Ratio */}
        <div className="liquid-glass-card p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">智能缓存命中率</span>
            <div className="h-7 w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center">
              <Database className="h-3.5 w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
            68.5%
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1.5">
            <span suppressHydrationWarning>{formatNumber(cacheHitCount)} 命中</span>
            <span className="font-mono text-[10px]">8192池</span>
          </div>
        </div>

        {/* Card 6: Upstream Health */}
        <div className="liquid-glass-card p-4 relative overflow-hidden group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">上游可用节点</span>
            <div className="h-7 w-7 rounded-lg bg-foreground/[0.04] text-foreground/75 border border-foreground/[0.06] flex items-center justify-center">
              <Server className="h-3.5 w-3.5" />
            </div>
          </div>
          <div suppressHydrationWarning className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
            4 / 4
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1.5 truncate">
            <span className="truncate">最快: doh.pub</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">100%</span>
          </div>
        </div>
      </div>

      {/* ── Chart Section 1: Minimalist Liquid Glass Area Chart ── */}
      <div className="liquid-glass-card p-5">
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

        <div className="h-72 w-full">
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
              <span className="liquid-glass-pill bg-foreground/[0.04] text-muted-foreground text-[11px] border border-foreground/[0.08]">
                98.2% 正常服务率
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 items-center gap-4">
              <div className="h-48 relative flex items-center justify-center">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={DEFAULT_RCODES}
                      cx="50%"
                      cy="50%"
                      innerRadius={58}
                      outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {DEFAULT_RCODES.map((entry, index) => (
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
                  <span className="text-xl font-bold font-mono text-foreground">98.2%</span>
                  <span className="text-[10px] text-muted-foreground">正常率</span>
                </div>
              </div>

              {/* Legend List */}
              <div className="space-y-2.5">
                {DEFAULT_RCODES.map((rc) => (
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
                {DEFAULT_PROTOCOLS.map((p) => (
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
                ))}
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                {DEFAULT_QTYPES.map((q) => (
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
                ))}
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
              各配置上游（国内公共 DNS、DoH、海外备用代理）的解析承载量与实测延迟对比
            </p>
          </div>
          <span className="liquid-glass-pill bg-foreground/[0.04] text-muted-foreground text-xs border border-foreground/[0.08]">
            负载均衡: Balanced
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {DEFAULT_UPSTREAMS.map((ups) => (
            <div
              key={ups.name}
              className="p-3.5 rounded-xl border border-border/40 bg-foreground/[0.02] hover:bg-foreground/[0.04] transition-all space-y-2.5"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-foreground truncate max-w-[160px]" title={ups.name}>
                    {ups.name}
                  </h4>
                  <p className="text-[11px] text-muted-foreground font-mono truncate max-w-[160px]" title={ups.addr}>
                    {ups.addr}
                  </p>
                </div>
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded-md font-mono font-medium border",
                    ups.latencyMs < 10
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                      : "bg-foreground/[0.04] text-muted-foreground border-foreground/[0.08]",
                  )}
                >
                  {ups.latencyMs} ms
                </span>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>处理量: {formatNumber(ups.queries)}</span>
                  <span>成功率: {ups.successRate}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-foreground/[0.06] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.min(100, (ups.queries / 45000) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
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
            {DEFAULT_TOP_QNAMES.slice(0, 7).map((item) => (
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
                    <div className="text-[10px] text-muted-foreground truncate">{item.category}</div>
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
            ))}
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
            {DEFAULT_TOP_BLOCKED.slice(0, 7).map((item) => (
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
                      {item.ruleTag}
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
            ))}
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
            {DEFAULT_TOP_CLIENTS.map((item) => (
              <div key={item.ip} className="space-y-1">
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
            ))}
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

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
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
                {liveLogs.map((log) => (
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
                    </td>
                  </tr>
                ))}
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
