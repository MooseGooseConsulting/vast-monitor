import express from "express";
import fs from "node:fs";
import path from "node:path";
import { getLiveDependencyHealth } from "./config.js";
import { buildFleetAggregate } from "./fleet-metrics.js";
import {
  buildPlatformGpuMetricIndex,
  buildMarketEnrichedBreakdownRows,
  computeFleetWeightedPlatformUtilization
} from "./platform-metrics.js";
import { getClientExtensionManifest, resolvePluginPublicDir } from "./plugins/index.js";
import { fetchMachineEarnings, fetchMachineReports } from "./vast-client.js";

export function createServer({ config, db, monitor, plugins = [], pluginRuntime, adminActionScheduler, platformMetricsClient } = {}) {
  const app = express();
  const routeMetrics = createRouteMetricsStore();
  const queueAdminAction = createAdminActionQueue({
    schedule: adminActionScheduler
  });

  app.use(express.json());
  app.use(express.static(path.join(config.projectRoot, "public")));
  registerPluginStaticDirs(app, config, plugins);

  app.get("/api/status", routeMetrics.wrap("status", async (_req, res) => {
    const fleet = db.getCurrentFleetStatus();
    res.json(await buildFleetResponse(fleet, config, db, monitor, plugins, platformMetricsClient));
  }));

  app.get("/api/health", routeMetrics.wrap("health", async (_req, res) => {
    const health = await buildHealthResponse({ config, db, monitor, routeMetrics, platformMetricsClient, pluginRuntime });
    res.status(health.ok ? 200 : 503).json(health);
  }));

  app.get("/api/admin/db-health", routeMetrics.wrap("admin_db_health", async (req, res) => {
    if (!requireAdminAccess(req, res, config)) {
      return;
    }

    const platformBenchmark = await getPlatformMetricsSnapshot(platformMetricsClient);
    res.json({
      ok: true,
      database: typeof db?.getDatabaseHealth === "function" ? db.getDatabaseHealth() : null,
      route_metrics: routeMetrics.snapshot(),
      platform_benchmark: {
        ok: platformBenchmark.ok,
        stale: platformBenchmark.stale,
        fetched_at: platformBenchmark.fetchedAt,
        source: platformBenchmark.source,
        error: platformBenchmark.error
      }
    });
  }));

  app.get("/api/admin/retention-preview", routeMetrics.wrap("admin_retention_preview", (req, res) => {
    if (!requireAdminAccess(req, res, config)) {
      return;
    }

    res.json({
      ok: true,
      preview: typeof db?.getRetentionPreview === "function" ? db.getRetentionPreview() : null
    });
  }));

  app.post("/api/admin/analyze", routeMetrics.wrap("admin_analyze", (req, res) => {
    if (!requireAdminAccess(req, res, config)) {
      return;
    }

    if (isAsyncAdminRequest(req)) {
      if (!queueAdminAction({
        db,
        action: "analyze",
        runner: () => db.runAnalyze()
      })) {
        res.status(409).json({ error: "maintenance already running" });
        return;
      }

      res.status(202).json({ ok: true, queued: true, action: "analyze" });
      return;
    }

    try {
      res.json({
        ok: true,
        analyze: typeof db?.runAnalyze === "function" ? db.runAnalyze() : null
      });
    } catch (error) {
      handleAdminActionError(res, error);
    }
  }));

  app.post("/api/admin/vacuum", routeMetrics.wrap("admin_vacuum", (req, res) => {
    if (!requireAdminAccess(req, res, config)) {
      return;
    }

    if (isAsyncAdminRequest(req)) {
      if (!queueAdminAction({
        db,
        action: "vacuum",
        runner: () => db.runVacuum()
      })) {
        res.status(409).json({ error: "maintenance already running" });
        return;
      }

      res.status(202).json({ ok: true, queued: true, action: "vacuum" });
      return;
    }

    try {
      res.json({
        ok: true,
        vacuum: typeof db?.runVacuum === "function" ? db.runVacuum() : null
      });
    } catch (error) {
      handleAdminActionError(res, error);
    }
  }));

  app.post("/api/admin/rebuild-derived", routeMetrics.wrap("admin_rebuild_derived", (req, res) => {
    if (!requireAdminAccess(req, res, config)) {
      return;
    }

    if (isAsyncAdminRequest(req)) {
      if (!queueAdminAction({
        db,
        action: "rebuild_derived",
        runner: () => db.runRebuildDerivedState()
      })) {
        res.status(409).json({ error: "maintenance already running" });
        return;
      }

      res.status(202).json({ ok: true, queued: true, action: "rebuild_derived" });
      return;
    }

    try {
      res.json({
        ok: true,
        rebuild: typeof db?.runRebuildDerivedState === "function" ? db.runRebuildDerivedState() : null
      });
    } catch (error) {
      handleAdminActionError(res, error);
    }
  }));

  app.post("/api/admin/daily-earnings", routeMetrics.wrap("admin_daily_earnings", (req, res) => {
    if (!requireAdminAccess(req, res, config)) {
      return;
    }

    try {
      const earningsDate = String(req.body?.earnings_date || req.body?.date || "").trim();
      const action = String(req.body?.action || "set").trim().toLowerCase();
      const source = String(req.body?.source || "manual").trim() || "manual";
      const note = req.body?.note == null ? null : String(req.body.note);
      const totalDailyEarnings = req.body?.total_daily_earnings ?? req.body?.total ?? null;

      if (action === "materialize") {
        const result = typeof db?.runMaterializeDailyEarningsHistory === "function"
          ? db.runMaterializeDailyEarningsHistory({
              earningsDate
            })
          : null;

        res.json({
          ok: true,
          materialize: result?.materialized || null,
          completed_at: result?.completed_at || null
        });
        return;
      }

      const result = typeof db?.runPatchDailyEarnings === "function"
        ? db.runPatchDailyEarnings({
            earningsDate,
            totalDailyEarnings,
            source,
            note,
            action
          })
        : null;

      res.json({
        ok: true,
        patch: result?.patched || null,
        completed_at: result?.completed_at || null
      });
    } catch (error) {
      handleAdminActionError(res, error);
    }
  }));

  app.get("/api/history", routeMetrics.wrap("history", (req, res) => {
    const machineId = Number(req.query.machine_id);
    const rawHours = req.query.hours == null ? 24 : Number(req.query.hours);

    if (!Number.isFinite(machineId)) {
      res.status(400).json({ error: "machine_id is required" });
      return;
    }

    if (!Number.isFinite(rawHours) || rawHours < 1) {
      res.status(400).json({ error: "hours must be a positive number" });
      return;
    }

    const hours = Math.floor(rawHours);

    res.json({
      machine_id: machineId,
      hours,
      history: db.getMachineHistory(machineId, hours)
    });
  }));

  app.get("/api/fleet/history", routeMetrics.wrap("fleet_history", (req, res) => {
    const rawHours = req.query.hours == null ? 168 : Number(req.query.hours);
    if (!Number.isFinite(rawHours) || rawHours < 1) {
      res.status(400).json({ error: "hours must be a positive number" });
      return;
    }

    const hours = Math.min(24 * 365, Math.floor(rawHours));
    const fleetHistory = db.getFleetHistory(hours);
    res.json({
      hours,
      history: fleetHistory.history,
      gpu_type_utilization: fleetHistory.gpu_type_utilization,
      market_gpu_type_utilization: fleetHistory.market_gpu_type_utilization,
      market_weighted_utilization_history: fleetHistory.market_weighted_utilization_history
    });
  }));

  app.get("/api/gpu-type/price-history", routeMetrics.wrap("gpu_type_price_history", (req, res) => {
    const rawHours = req.query.hours == null ? 168 : Number(req.query.hours);
    if (!Number.isFinite(rawHours) || rawHours < 1) {
      res.status(400).json({ error: "hours must be a positive number" });
      return;
    }

    const rawTop = req.query.top == null ? 6 : Number(req.query.top);
    if (!Number.isFinite(rawTop) || rawTop < 1) {
      res.status(400).json({ error: "top must be a positive number" });
      return;
    }

    const hours = Math.min(24 * 365, Math.floor(rawHours));
    const top = Math.min(12, Math.floor(rawTop));
    res.json(db.getGpuTypePriceHistory(hours, top));
  }));

  app.get("/api/reports", routeMetrics.wrap("reports", async (req, res) => {
    const machineId = Number(req.query.machine_id);
    if (!Number.isFinite(machineId)) {
      res.status(400).json({ error: "machine_id is required" });
      return;
    }

    try {
      const reports = await fetchMachineReports(config, machineId);
      res.json({
        machine_id: machineId,
        reports,
        dependency: {
          type: "vast-cli",
          ok: true
        }
      });
    } catch (error) {
      res.status(502).json({
        error: "failed to fetch reports",
        detail: error instanceof Error ? error.message : String(error),
        dependency: {
          type: "vast-cli",
          ok: false,
          health: getLiveDependencyHealth(config).vastCli
        }
      });
    }
  }));

  app.get("/api/earnings/machine", routeMetrics.wrap("machine_earnings", async (req, res) => {
    const machineId = Number(req.query.machine_id);
    const rawHours = req.query.hours == null ? 168 : Number(req.query.hours);
    const rawStart = typeof req.query.start === "string" ? req.query.start : null;
    const rawEnd = typeof req.query.end === "string" ? req.query.end : null;
    if (!Number.isFinite(machineId)) {
      res.status(400).json({ error: "machine_id is required" });
      return;
    }
    if ((rawStart && !rawEnd) || (!rawStart && rawEnd)) {
      res.status(400).json({ error: "start and end must be provided together" });
      return;
    }

    const hasDateRange = Boolean(rawStart && rawEnd);
    if (!hasDateRange && (!Number.isFinite(rawHours) || rawHours < 1)) {
      res.status(400).json({ error: "hours must be a positive number" });
      return;
    }

    try {
      let earningsRequest;
      if (hasDateRange) {
        const startMs = Date.parse(rawStart);
        const endMs = Date.parse(rawEnd);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
          res.status(400).json({ error: "start and end must be valid ISO datetimes" });
          return;
        }
        if (endMs <= startMs) {
          res.status(400).json({ error: "end must be after start" });
          return;
        }
        if ((endMs - startMs) > (24 * 365 * 60 * 60 * 1000)) {
          res.status(400).json({ error: "date range cannot exceed 365 days" });
          return;
        }

        earningsRequest = {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString()
        };
      } else {
        earningsRequest = {
          hours: Math.min(24 * 365, Math.floor(rawHours))
        };
      }

      const earnings = await fetchMachineEarnings(config, machineId, earningsRequest);
      res.json({
        ...earnings,
        dependency: {
          type: "vast-cli",
          ok: true
        }
      });
    } catch (error) {
      res.status(502).json({
        error: "failed to fetch machine earnings",
        detail: error instanceof Error ? error.message : String(error),
        dependency: {
          type: "vast-cli",
          ok: false,
          health: getLiveDependencyHealth(config).vastCli
        }
      });
    }
  }));

  app.get("/api/earnings/machine/monthly-summary", routeMetrics.wrap("machine_monthly_summary", async (req, res) => {
    const machineId = Number(req.query.machine_id);
    if (!Number.isFinite(machineId)) {
      res.status(400).json({ error: "machine_id is required" });
      return;
    }

    try {
      const months = await fetchMachineCalendarMonthSummary(config, machineId);
      res.json({
        machine_id: machineId,
        months,
        dependency: {
          type: "vast-cli",
          ok: true
        }
      });
    } catch (error) {
      res.status(502).json({
        error: "failed to fetch machine monthly earnings summary",
        detail: error instanceof Error ? error.message : String(error),
        dependency: {
          type: "vast-cli",
          ok: false,
          health: getLiveDependencyHealth(config).vastCli
        }
      });
    }
  }));

  app.get("/api/earnings/hourly", routeMetrics.wrap("hourly_earnings", (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
    res.json(db.getHourlyEarnings(date));
  }));

  app.get("/api/alerts", routeMetrics.wrap("alerts", (req, res) => {
    const rawLimit = req.query.limit == null ? 50 : Number(req.query.limit);
    if (!Number.isFinite(rawLimit) || rawLimit < 1) {
      res.status(400).json({ error: "limit must be a positive number" });
      return;
    }

    const limit = Math.min(500, Math.floor(rawLimit));
    res.json({
      alerts: db.getRecentAlerts(limit)
    });
  }));

  app.get("/api/extensions/raw-market/health", routeMetrics.wrap("raw_market_health", async (_req, res) => {
    const all = await pluginRuntime?.getHealth?.() || {};
    const health = all["raw-market"] || { ok: true, status: "disabled" };
    res.status(health.ok ? 200 : 503).json(health);
  }));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(config.projectRoot, "public/index.html"));
  });

  registerPluginRoutes({ app, config, db, monitor, plugins });

  return app;
}

async function fetchMachineCalendarMonthSummary(config, machineId, now = new Date()) {
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousPreviousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  const previousComparableEndExclusive = getPreviousComparableEndExclusive(currentMonthStart, previousMonthStart, now);

  const [previousPreviousMonth, previousMonth, previousComparablePeriod, currentMonth] = await Promise.all([
    fetchMachineEarnings(config, machineId, {
      start: previousPreviousMonthStart.toISOString(),
      end: previousMonthStart.toISOString(),
      requirePerMachineTotal: true
    }),
    fetchMachineEarnings(config, machineId, {
      start: previousMonthStart.toISOString(),
      end: currentMonthStart.toISOString(),
      requirePerMachineTotal: true
    }),
    fetchMachineEarnings(config, machineId, {
      start: previousMonthStart.toISOString(),
      end: previousComparableEndExclusive.toISOString(),
      requirePerMachineTotal: true
    }),
    fetchMachineEarnings(config, machineId, {
      start: currentMonthStart.toISOString(),
      end: now.toISOString(),
      requirePerMachineTotal: true
    })
  ]);

  return [
    {
      key: "previous",
      label: formatMonthLabel(previousMonthStart),
      start: previousMonth.start,
      end: previousMonth.end,
      total: previousMonth.total,
      source: "vast-per-machine-range",
      comparison_label: "vs Last Month",
      comparison: buildComparisonMetric(previousMonth.total, previousPreviousMonth.total, 2),
      comparison_start: previousPreviousMonth.start,
      comparison_end: previousPreviousMonth.end
    },
    {
      key: "current",
      label: formatMonthLabel(currentMonthStart),
      start: currentMonth.start,
      end: currentMonth.end,
      total: currentMonth.total,
      source: "vast-per-machine-range",
      comparison_label: "vs Last Month",
      comparison: buildComparisonMetric(currentMonth.total, previousComparablePeriod.total, 2),
      comparison_start: previousComparablePeriod.start,
      comparison_end: previousComparablePeriod.end
    }
  ];
}

function formatMonthLabel(date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC"
  }).format(date);
}

function getPreviousComparableEndExclusive(currentMonthStart, previousMonthStart, now) {
  const nextDayOfMonth = now.getUTCDate() + 1;
  const previousMonthNextDayStart = new Date(Date.UTC(
    previousMonthStart.getUTCFullYear(),
    previousMonthStart.getUTCMonth(),
    nextDayOfMonth
  ));
  const previousMonthEnd = currentMonthStart;

  if (previousMonthNextDayStart.getTime() >= previousMonthEnd.getTime()) {
    return previousMonthEnd;
  }

  return previousMonthNextDayStart;
}

function buildComparisonMetric(current, previous, decimals = 2) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return {
      current: Number.isFinite(current) ? Number(current.toFixed(decimals)) : null,
      previous: Number.isFinite(previous) ? Number(previous.toFixed(decimals)) : null,
      delta: null,
      pct_delta: null
    };
  }

  const roundedCurrent = Number(current.toFixed(decimals));
  const roundedPrevious = Number(previous.toFixed(decimals));
  const delta = Number((current - previous).toFixed(decimals));
  const pctDelta = previous === 0 ? null : Number((((current - previous) / previous) * 100).toFixed(2));

  return {
    current: roundedCurrent,
    previous: roundedPrevious,
    delta,
    pct_delta: pctDelta
  };
}

async function buildFleetResponse(fleet, config, db, monitor, plugins = [], platformMetricsClient) {
  // Deduplicate machines by hostname to avoid double counting old offline machine IDs
  const byHostname = new Map();
  for (const m of fleet.machines) {
    const existing = byHostname.get(m.hostname);
    if (!existing || m.machine_id > existing.machine_id) {
      byHostname.set(m.hostname, m);
    }
  }
  const uniqueMachines = Array.from(byHostname.values());

  let machines = uniqueMachines.map((machine) => ({
    machine_id: machine.machine_id,
    hostname: machine.hostname,
    gpu_type: machine.gpu_type,
    num_gpus: machine.num_gpus,
    listed_min_gpu_count: machine.listed_min_gpu_count,
    occupancy: machine.occupancy || "",
    occupied_gpus: machine.occupied_gpus || 0,
    current_rentals_running: machine.current_rentals_running || 0,
    listed: Boolean(machine.listed),
    listed_gpu_cost: machine.listed_gpu_cost,
    previous_listed_gpu_cost: machine.previous_listed_gpu_cost,
    price_changed_at: machine.price_changed_at,
    price_change_direction: machine.price_change_direction,
    previous_rentals: machine.previous_rentals,
    rentals_changed_at: machine.rentals_changed_at,
    rentals_change_direction: machine.rentals_change_direction,
    previous_reliability: machine.previous_reliability,
    reliability_changed_at: machine.reliability_changed_at,
    reliability_change_direction: machine.reliability_change_direction,
    previous_status: machine.previous_status,
    status_changed_at: machine.status_changed_at,
    status_change_direction: machine.status_change_direction,
    reliability: machine.reliability,
    gpu_max_cur_temp: machine.gpu_max_cur_temp,
    earn_day: machine.earn_day,
    num_reports: machine.num_reports || 0,
    num_recent_reports: machine.num_recent_reports,
    reports_changed: machine.reports_changed || 0,
    has_new_report_72h: Boolean(machine.has_new_report_72h),
    status: machine.status,
    error_message: sanitizeErrorMessage(machine.error_message),
    machine_maintenance: parseMaintenance(machine.machine_maintenance),
    last_online_at: machine.last_online_at,
    public_ipaddr: machine.public_ipaddr,
    host_id: machine.host_id,
    hosting_type: machine.hosting_type,
    is_datacenter: Boolean(machine.is_datacenter),
    datacenter_id: machine.datacenter_id,
    verified: machine.verified == null ? null : Boolean(machine.verified),
    verification: machine.verification || null,
    uptime: machine.uptime
  }));

  machines = await decorateStatusMachines(machines, { config, db, monitor, plugins });

  const fleetAggregate = buildFleetAggregate(machines);
  const fleetMachines = fleetAggregate.machines;
  const totalMachines = fleetAggregate.summary.total_machines;
  const datacenterMachines = fleetAggregate.summary.datacenter_machines;
  const unlistedMachines = fleetAggregate.summary.unlisted_machines;
  const listedGpus = fleetAggregate.summary.listed_gpus;
  const unlistedGpus = fleetAggregate.summary.unlisted_gpus;
  const occupiedGpus = fleetAggregate.summary.occupied_gpus;
  const totalDailyEarnings = fleetAggregate.summary.total_daily_earnings;
  const utilisationPct = fleetAggregate.summary.utilisation_pct;
  const marketBenchmark = await getPlatformMetricsSnapshot(platformMetricsClient);
  const marketMetricIndex = buildPlatformGpuMetricIndex(marketBenchmark.rows, marketBenchmark.segments);

  const gpuTypes = new Map();
  for (const machine of fleetMachines) {
    const key = machine.gpu_type || "Unknown";
    const current = gpuTypes.get(key) || {
      gpu_type: key,
      machines: 0,
      listed_gpus: 0,
      unlisted_gpus: 0,
      occupied_gpus: 0,
      total_price_weighted: 0,
      priced_gpus: 0,
      earnings: 0
    };

    current.machines += 1;
    if (machine.listed) {
      const gpuCount = machine.num_gpus || 0;
      current.listed_gpus += gpuCount;
      current.occupied_gpus += machine.status === "online" ? machine.occupied_gpus || 0 : 0;
      if (typeof machine.listed_gpu_cost === "number" && gpuCount > 0) {
        current.total_price_weighted += machine.listed_gpu_cost * gpuCount;
        current.priced_gpus += gpuCount;
      }
    } else {
      current.unlisted_gpus += machine.num_gpus || 0;
    }
    current.earnings += machine.earn_day || 0;
    gpuTypes.set(key, current);
  }

  const breakdown = buildMarketEnrichedBreakdownRows([...gpuTypes.values()], marketMetricIndex);
  const marketSummary = computeFleetWeightedPlatformUtilization(breakdown);

  return {
    latestPollAt: fleet.latestPollAt,
    health: buildHealthStatus({
      latestPollAt: fleet.latestPollAt,
      pollIntervalMs: config.pollIntervalMs
    }),
    observability: normalizeMonitorObservability(
      typeof monitor?.getHealthSnapshot === "function" ? monitor.getHealthSnapshot() : {}
    ),
    summary: {
      totalMachines,
      datacenterMachines,
      unlistedMachines,
      listedGpus,
      unlistedGpus,
      occupiedGpus,
      utilisationPct,
      totalDailyEarnings,
      marketUtilisationPct: marketSummary.marketUtilisationPct,
      marketMatchedListedGpus: marketSummary.marketMatchedListedGpus,
      marketTotalListedGpus: marketSummary.marketTotalListedGpus,
      marketCoveragePct: marketSummary.marketCoveragePct,
      comparison24h: fleet.comparison24h ?? null
    },
    marketBenchmark: {
      ok: marketBenchmark.ok,
      stale: marketBenchmark.stale,
      fetchedAt: marketBenchmark.fetchedAt,
      source: marketBenchmark.source,
      error: marketBenchmark.error
    },
    extensions: getClientExtensionManifest(plugins),
    gpuTypeBreakdown: breakdown,
    machines
  };
}

async function getPlatformMetricsSnapshot(platformMetricsClient) {
  if (!platformMetricsClient || typeof platformMetricsClient.getSnapshot !== "function") {
    return {
      ok: false,
      stale: false,
      source: null,
      fetchedAt: null,
      rows: [],
      segments: [],
      error: null
    };
  }

  try {
    const snapshot = await platformMetricsClient.getSnapshot();
    return {
      ok: snapshot?.ok === true,
      stale: snapshot?.stale === true,
      source: snapshot?.source || null,
      fetchedAt: snapshot?.fetchedAt || null,
      rows: Array.isArray(snapshot?.rows) ? snapshot.rows : [],
      segments: Array.isArray(snapshot?.segments) ? snapshot.segments : [],
      error: snapshot?.error || null
    };
  } catch (error) {
    return {
      ok: false,
      stale: false,
      source: null,
      fetchedAt: null,
      rows: [],
      segments: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function buildHealthResponse({ config, db, monitor, routeMetrics, platformMetricsClient, pluginRuntime }) {
  const latestPollAt = db.getCurrentFleetStatus().latestPollAt;
  const status = buildHealthStatus({
    latestPollAt,
    pollIntervalMs: config.pollIntervalMs
  });
  const monitorHealth = typeof monitor?.getHealthSnapshot === "function" ? monitor.getHealthSnapshot() : {};
  const liveDependencies = getLiveDependencyHealth(config);
  const liveOperationsOk = Object.values(liveDependencies).every((dependency) => dependency.ok);
  const platformBenchmark = await getPlatformMetricsSnapshot(platformMetricsClient);
  const extensions = await pluginRuntime?.getHealth?.() || {};

  return {
    ok: !status.isStale,
    status: status.isStale ? "stale" : liveOperationsOk ? "ok" : "degraded",
    latestPollAt,
    pollIntervalMs: config.pollIntervalMs,
    staleThresholdMs: status.staleThresholdMs,
    pollAgeMs: status.pollAgeMs,
    liveOperationsOk,
    liveDependencies,
    platform_benchmark: {
      ok: platformBenchmark.ok,
      stale: platformBenchmark.stale,
      fetched_at: platformBenchmark.fetchedAt,
      source: platformBenchmark.source,
      error: platformBenchmark.error
    },
    observability: normalizeMonitorObservability(monitorHealth),
    endpoint_timings: routeMetrics?.snapshot?.() || {},
    extensions,
    ...monitorHealth
  };
}

function normalizeMonitorObservability(monitorHealth = {}) {
  return {
    lastPollDurationMs: monitorHealth.lastPollDurationMs ?? null,
    lastFetchDurationMs: monitorHealth.lastFetchDurationMs ?? null,
    lastPersistDurationMs: monitorHealth.lastPersistDurationMs ?? null,
    lastAlertDispatchDurationMs: monitorHealth.lastAlertDispatchDurationMs ?? null,
    lastSuccessfulMachineCount: monitorHealth.lastSuccessfulMachineCount ?? 0,
    lastOnlineMachineCount: monitorHealth.lastOnlineMachineCount ?? 0,
    lastOfflineMachineCount: monitorHealth.lastOfflineMachineCount ?? 0,
    lastEventCount: monitorHealth.lastEventCount ?? 0,
    lastAlertCount: monitorHealth.lastAlertCount ?? 0,
    lastHostnameCollisionCount: monitorHealth.lastHostnameCollisionCount ?? 0
  };
}

function buildHealthStatus({ latestPollAt, pollIntervalMs }) {
  const staleThresholdMs = pollIntervalMs * 2;
  const pollAgeMs = latestPollAt ? Math.max(0, Date.now() - Date.parse(latestPollAt)) : null;
  const isStale = pollAgeMs == null || pollAgeMs > staleThresholdMs;

  return {
    isStale,
    pollAgeMs,
    staleThresholdMs
  };
}

function sanitizeErrorMessage(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }

  if (IGNORED_ERROR_MESSAGES.has(text)) {
    return null;
  }

  return text;
}

function parseMaintenance(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requireAdminAccess(req, res, config) {
  const configuredToken = String(config?.adminApiToken || "").trim();
  if (!configuredToken) {
    res.status(404).json({ error: "admin api disabled" });
    return false;
  }

  const authHeader = String(req.headers?.authorization || "").trim();
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const directToken = String(req.headers?.["x-admin-token"] || "").trim();
  const suppliedToken = bearerToken || directToken;

  if (suppliedToken !== configuredToken) {
    res.status(401).json({ error: "admin authorization required" });
    return false;
  }

  return true;
}

function handleAdminActionError(res, error) {
  const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : 500;
  res.status(statusCode).json({
    error: error instanceof Error ? error.message : String(error)
  });
}

function isAsyncAdminRequest(req) {
  return String(req.query?.async || "") === "1";
}

function createAdminActionQueue({ schedule = (callback) => setTimeout(callback, 0) } = {}) {
  let queued = false;

  return ({ db, action, runner }) => {
    if (queued || db?.getDatabaseHealth?.().maintenance?.in_progress) {
      return false;
    }

    queued = true;
    schedule(() => {
      try {
        runner();
      } catch (error) {
        console.error(`[admin] Background maintenance failed for ${action}:`, error);
      } finally {
        queued = false;
      }
    }, 0);

    return true;
  };
}

function createRouteMetricsStore() {
  const metrics = new Map();

  function wrap(name, handler) {
    return async (req, res) => {
      const startedAt = Date.now();
      try {
        await handler(req, res);
      } catch (error) {
        observe(name, Date.now() - startedAt, 500);
        throw error;
      }

      observe(name, Date.now() - startedAt, getStatusCode(res));
    };
  }

  function observe(name, durationMs, statusCode) {
    const current = metrics.get(name) || {
      calls: 0,
      errors: 0,
      last_duration_ms: null,
      max_duration_ms: 0,
      total_duration_ms: 0,
      avg_duration_ms: null,
      last_status_code: null
    };

    current.calls += 1;
    current.errors += statusCode >= 500 ? 1 : 0;
    current.last_duration_ms = durationMs;
    current.max_duration_ms = Math.max(current.max_duration_ms, durationMs);
    current.total_duration_ms += durationMs;
    current.avg_duration_ms = Number((current.total_duration_ms / current.calls).toFixed(2));
    current.last_status_code = statusCode;
    metrics.set(name, current);
  }

  function snapshot() {
    return Object.fromEntries(
      [...metrics.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [
          name,
          {
            calls: value.calls,
            errors: value.errors,
            last_duration_ms: value.last_duration_ms,
            max_duration_ms: value.max_duration_ms,
            avg_duration_ms: value.avg_duration_ms,
            last_status_code: value.last_status_code
          }
        ])
    );
  }

  return { wrap, snapshot };
}

function getStatusCode(res) {
  return Number.isFinite(res?.statusCode) ? res.statusCode : 200;
}

const IGNORED_ERROR_MESSAGES = new Set([
  "Error: machine does not support VMs."
]);

function registerPluginRoutes({ app, config, db, monitor, plugins }) {
  for (const plugin of plugins) {
    if (typeof plugin?.registerRoutes !== "function") {
      continue;
    }

    plugin.registerRoutes({ app, config, db, monitor });
  }
}

function registerPluginStaticDirs(app, config, plugins) {
  for (const plugin of plugins) {
    const publicDir = resolvePluginPublicDir(config, plugin);
    if (!publicDir || !fs.existsSync(publicDir)) {
      continue;
    }

    app.use(`/plugins/${plugin.slug}`, express.static(publicDir));
  }
}

async function decorateStatusMachines(machines, { config, db, monitor, plugins }) {
  const decoratedMachines = [];

  for (const machine of machines) {
    let currentMachine = machine;

    for (const plugin of plugins) {
      if (typeof plugin?.decorateStatusMachine !== "function") {
        continue;
      }

      const nextMachine = await plugin.decorateStatusMachine({
        machine: currentMachine,
        config,
        db,
        monitor
      });

      if (nextMachine && typeof nextMachine === "object") {
        currentMachine = nextMachine;
      }
    }

    decoratedMachines.push(currentMachine);
  }

  return decoratedMachines;
}
