import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFromEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = {
  projectRoot,
  port: numberFromEnv("PORT", 3000),
  pollIntervalMs: numberFromEnv("POLL_INTERVAL_MS", 5 * 60 * 1000),
  vastCliPath: process.env.VAST_CLI_PATH || path.join(process.env.HOME || "", "Desktop/dev/vast/vast"),
  vastApiUrl: process.env.VAST_API_URL || "https://console.vast.ai/api/v0",
  vastApiKeyPath: process.env.VAST_API_KEY_PATH || path.join(os.homedir(), ".config/vastai/vast_api_key"),
  alertTempThreshold: numberFromEnv("ALERT_TEMP_THRESHOLD", 85),
  alertIdleHours: numberFromEnv("ALERT_IDLE_HOURS", 6),
  alertCooldownMinutes: numberFromEnv("ALERT_COOLDOWN_MINUTES", 60),
  alertHostnameCollisionCooldownMinutes: numberFromEnv("ALERT_HOSTNAME_COLLISION_COOLDOWN_MINUTES", 360),
  adminApiToken: String(process.env.ADMIN_API_TOKEN || "").trim(),
  dbSnapshotRetentionDays: numberFromEnv("DB_SNAPSHOT_RETENTION_DAYS", 0),
  dbAlertRetentionDays: numberFromEnv("DB_ALERT_RETENTION_DAYS", 0),
  dbEventRetentionDays: numberFromEnv("DB_EVENT_RETENTION_DAYS", 0),
  pluginModules: listFromEnv("PLUGIN_MODULES"),
  rawArchiveEnabled: String(process.env.RAW_ARCHIVE_ENABLED || "").toLowerCase() === "true",
  rawArchiveDatabaseUrl: String(process.env.DATABASE_URL || "").trim(),
  rawArchivePollIntervalMs: numberFromEnv("RAW_ARCHIVE_POLL_INTERVAL_MS", 5 * 60 * 1000),
  rawArchiveOffersUrl: process.env.VAST_OFFERS_URL || "https://console.vast.ai/api/v0/bundles/",
  rawArchiveGpuCatalogUrl: process.env.VAST_GPU_CATALOG_URL || "https://console.vast.ai/api/v0/gpu_names/unique/",
  dbPath: process.env.DB_PATH ? path.resolve(projectRoot, process.env.DB_PATH) : path.resolve(projectRoot, "data/vast-monitor.db")
};

export function validateRuntimeConfig(runtimeConfig) {
  const issues = [];

  if (!fileExists(runtimeConfig.vastCliPath)) {
    issues.push(`VAST CLI not found at ${runtimeConfig.vastCliPath}`);
  } else if (!isExecutable(runtimeConfig.vastCliPath)) {
    issues.push(`VAST CLI is not executable at ${runtimeConfig.vastCliPath}`);
  }

  const apiKeyStatus = getApiKeyStatus(runtimeConfig.vastApiKeyPath);
  if (!apiKeyStatus.ok) {
    issues.push(apiKeyStatus.message);
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

export function getLiveDependencyHealth(runtimeConfig) {
  const vastCliExists = fileExists(runtimeConfig.vastCliPath);
  const vastCliExecutable = vastCliExists && isExecutable(runtimeConfig.vastCliPath);
  const apiKeyStatus = getApiKeyStatus(runtimeConfig.vastApiKeyPath);

  return {
    vastCli: {
      ok: vastCliExecutable,
      path: runtimeConfig.vastCliPath,
      detail: !vastCliExists
        ? "CLI binary not found"
        : !vastCliExecutable
          ? "CLI binary is not executable"
          : "ready"
    },
    vastApiKey: {
      ok: apiKeyStatus.ok,
      path: runtimeConfig.vastApiKeyPath,
      detail: apiKeyStatus.ok ? "ready" : apiKeyStatus.message
    }
  };
}

export function getOptionalRuntimeWarnings(runtimeConfig) {
  const warnings = [];
  const dateutilStatus = getPythonDateutilStatus(runtimeConfig);

  if (!dateutilStatus.ok) {
    warnings.push(dateutilStatus.message);
  }

  return warnings;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getApiKeyStatus(apiKeyPath) {
  try {
    const value = fs.readFileSync(apiKeyPath, "utf8").trim();
    if (!value) {
      return {
        ok: false,
        message: `Vast API key file is empty at ${apiKeyPath}`
      };
    }

    return { ok: true, message: "ready" };
  } catch (error) {
    return {
      ok: false,
      message: `Vast API key file is not readable at ${apiKeyPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function getPythonDateutilStatus(runtimeConfig) {
  if (!fileExists(runtimeConfig.vastCliPath) || !isExecutable(runtimeConfig.vastCliPath)) {
    return { ok: true, message: "skipped" };
  }

  try {
    const output = execFileSync("python3", ["-c", "import dateutil; print(dateutil.__version__)"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();

    if (!isSupportedDateutilVersion(output)) {
      return {
        ok: false,
        message: `Optional prereq warning: python-dateutil ${output || "unknown"} is too old for live Vast earnings; upgrade to >= 2.7 in the Python 3 environment used by the Vast CLI`
      };
    }

    return { ok: true, message: "ready" };
  } catch (error) {
    return {
      ok: false,
      message: `Optional prereq warning: python-dateutil is missing or unreadable in the Python 3 environment used by the Vast CLI; live earnings may fail (${error instanceof Error ? error.message : String(error)})`
    };
  }
}

function isSupportedDateutilVersion(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);

  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false;
  }

  if (major > 2) {
    return true;
  }

  return major === 2 && minor >= 7;
}
