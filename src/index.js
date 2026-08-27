import { config, getOptionalRuntimeWarnings, validateRuntimeConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { AlertManager } from "./alerts/alert-manager.js";
import { ConsoleAlertChannel } from "./alerts/console-alert-channel.js";
import { FleetMonitor } from "./monitor.js";
import { loadPlugins, startPluginRuntime } from "./plugins/index.js";
import { createPlatformMetricsClient } from "./platform-metrics.js";
import { createServer } from "./server.js";

export async function startApp(options = {}) {
  const runtimeConfig = options.config || config;

  console.log("[startup] Loading configuration");
  const validation = validateRuntimeConfig(runtimeConfig);
  if (!validation.ok) {
    for (const issue of validation.issues) {
      console.error(`[startup] ${issue}`);
    }
    throw new Error("Invalid runtime configuration");
  }

  for (const warning of getOptionalRuntimeWarnings(runtimeConfig)) {
    console.warn(`[startup] ${warning}`);
  }

  const db = options.db || createDatabase(runtimeConfig.dbPath, runtimeConfig);
  console.log(`[startup] Database ready at ${runtimeConfig.dbPath}`);
  if (typeof db.getStartupMaintenanceSummary === "function") {
    console.log(`[startup] Database maintenance: ${formatDatabaseMaintenanceSummary(db.getStartupMaintenanceSummary())}`);
  }

  const plugins = options.plugins || await loadPlugins(runtimeConfig);
  if (plugins.length > 0) {
    console.log(`[startup] Loaded plugins: ${plugins.map((plugin) => plugin.name).join(", ")}`);
  }

  const alertManager = options.alertManager || new AlertManager([new ConsoleAlertChannel()], {
    defaultCooldownMinutes: runtimeConfig.alertCooldownMinutes,
    hostnameCollisionCooldownMinutes: runtimeConfig.alertHostnameCollisionCooldownMinutes
  });
  const platformMetricsClient = options.platformMetricsClient || createPlatformMetricsClient();
  const monitor = options.monitor || new FleetMonitor({
    config: runtimeConfig,
    db,
    alertManager,
    plugins,
    platformMetricsClient
  });
  const pluginRuntime = options.pluginRuntime || await startPluginRuntime({
    plugins,
    context: { config: runtimeConfig, db, monitor },
  });
  const app = options.app || createServer({
    config: runtimeConfig,
    db,
    monitor,
    plugins,
    pluginRuntime,
    platformMetricsClient
  });

  console.log(`[startup] Starting HTTP server on port ${runtimeConfig.port}`);
  const server = app.listen(runtimeConfig.port, () => {
    console.log(`vast-monitor listening on http://localhost:${runtimeConfig.port}`);
  });

  console.log("[startup] Starting fleet monitor");
  monitor.start()
    .then((initialPollSucceeded) => {
      if (initialPollSucceeded) {
        console.log("[startup] Initial fleet sync complete");
      } else {
        console.warn("[startup] Service is running, but initial fleet sync failed; waiting for next poll");
      }
    })
    .catch((error) => {
      console.error("[startup] Fleet monitor failed to start:", error);
      process.exitCode = 1;
    });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log(`[shutdown] Received ${signal}, stopping monitor`);
      Promise.resolve(pluginRuntime.stop(signal)).finally(() => {
        monitor.stop();
        server.close(() => {
        process.exit(0);
        });
      });
    });
  }

  return { config: runtimeConfig, db, plugins, pluginRuntime, alertManager, monitor, platformMetricsClient, app, server };
}

function formatDatabaseMaintenanceSummary(summary = {}) {
  const parts = [];
  const fleet = summary.fleet_snapshots || {};
  const retention = summary.retention || {};

  if ((summary.deduped_fleet_snapshot_rows || 0) > 0) {
    parts.push(`deduped ${summary.deduped_fleet_snapshot_rows} fleet snapshot row(s)`);
  }

  if (fleet.mode === "full_rebuild") {
    parts.push(`fleet snapshots rebuilt (${fleet.inserted_snapshots || 0} poll(s))`);
  } else if ((fleet.inserted_snapshots || 0) > 0) {
    parts.push(`fleet snapshots backfilled (${fleet.inserted_snapshots} poll(s))`);
  }

  const retentionDeleted = [
    retention.fleet_snapshots_deleted || 0,
    retention.machine_snapshots_deleted || 0,
    retention.platform_gpu_metric_snapshots_deleted || 0,
    retention.polls_deleted || 0,
    retention.alerts_deleted || 0,
    retention.events_deleted || 0
  ].reduce((sum, count) => sum + count, 0);
  if ((retention.fleet_snapshot_hourly_rollups_upserted || 0) > 0) {
    parts.push(`fleet hourly rollups updated (${retention.fleet_snapshot_hourly_rollups_upserted} bucket(s))`);
  }
  if ((retention.machine_snapshot_hourly_rollups_upserted || 0) > 0) {
    parts.push(`hourly rollups updated (${retention.machine_snapshot_hourly_rollups_upserted} bucket(s))`);
  }
  if ((retention.gpu_type_utilization_hourly_rollups_upserted || 0) > 0) {
    parts.push(`GPU util rollups updated (${retention.gpu_type_utilization_hourly_rollups_upserted} bucket(s))`);
  }
  if ((retention.gpu_type_price_hourly_rollups_upserted || 0) > 0) {
    parts.push(`GPU price rollups updated (${retention.gpu_type_price_hourly_rollups_upserted} bucket(s))`);
  }
  if ((retention.platform_gpu_metric_hourly_rollups_upserted || 0) > 0) {
    parts.push(`benchmark rollups updated (${retention.platform_gpu_metric_hourly_rollups_upserted} bucket(s))`);
  }
  if (retentionDeleted > 0) {
    parts.push(`retention pruned ${retentionDeleted} row(s)`);
  }

  if (parts.length === 0) {
    return "no maintenance needed";
  }

  return parts.join("; ");
}

const startedDirectly = process.argv[1] === new URL(import.meta.url).pathname;
if (startedDirectly) {
  startApp().catch((error) => {
    console.error("[startup] Failed to start:", error);
    process.exit(1);
  });
}
