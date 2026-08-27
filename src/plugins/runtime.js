/** Start optional plugins without giving them ownership of the dashboard. */
export async function startPluginRuntime({ plugins = [], context = {}, logger = console } = {}) {
  const entries = [];
  for (const plugin of plugins) {
    const entry = { plugin, started: false, instance: null, error: null };
    entries.push(entry);
    if (typeof plugin.start !== "function") continue;
    try {
      entry.instance = await plugin.start(context);
      entry.started = true;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      logger.error?.(`[plugins] ${plugin.name} failed to start: ${entry.error}`);
    }
  }

  return {
    entries,
    async stop(reason = "shutdown") {
      await Promise.all(entries.map(async (entry) => {
        if (!entry.started || typeof entry.plugin.stop !== "function") return;
        try { await entry.plugin.stop({ reason, instance: entry.instance }); }
        catch (error) { logger.error?.(`[plugins] ${entry.plugin.name} failed to stop: ${error}`); }
      }));
    },
    async getHealth() {
      const extensions = {};
      for (const entry of entries) {
        const key = entry.plugin.slug || entry.plugin.name;
        if (entry.error) { extensions[key] = { ok: false, status: "degraded", error: entry.error }; continue; }
        if (!entry.started) { extensions[key] = { ok: true, status: "disabled" }; continue; }
        try {
          const health = typeof entry.plugin.getHealth === "function"
            ? await entry.plugin.getHealth({ instance: entry.instance }) : { ok: true, status: "ok" };
          extensions[key] = { ok: health?.ok !== false, status: health?.status || (health?.ok === false ? "degraded" : "ok"), ...health };
        } catch (error) {
          extensions[key] = { ok: false, status: "degraded", error: error instanceof Error ? error.message : String(error) };
        }
      }
      return extensions;
    }
  };
}
