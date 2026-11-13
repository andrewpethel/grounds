import { promises as fs } from "node:fs";
import path from "node:path";
import connect from "connect";
import { watch } from "chokidar";
import { serviceCatalogPlugin } from "../tools/service-catalog-plugin.mjs";
import { operationalIntelligencePlugin } from "../tools/operational-intelligence-plugin.mjs";
import { serviceChatPlugin } from "../tools/service-chat-plugin.mjs";
import { srmCompanionPlugin } from "../tools/srm-companion-plugin.mjs";
import { srmStatusPlugin } from "../tools/srm-status-plugin.mjs";
import { workCompanionPlugin } from "../tools/work-companion-plugin.mjs";
import { adoWorkItemsPlugin } from "../tools/ado-work-items-plugin.mjs";
import { deploymentDiffsPlugin } from "../tools/deployment-diffs-plugin.mjs";
import { gitHistoryPlugin } from "../tools/git-history-plugin.mjs";
import { localReposPlugin } from "../tools/local-repos-plugin.mjs";
import { createServiceValidator, listServiceFiles, validateServiceFile } from "../tools/service-validation.mjs";
import { readOperationalJson } from "../tools/operational-data.mjs";
import { dispatch } from "./transport.mjs";

export async function initializeData(root, resources) {
  for (const directory of ["services", "troubleshooting", "intelligence/ev2", "intelligence/srm", "intelligence/teams"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  for (const name of [
    "service_schema.json", "ev2_service_groups_schema.json", "srm_observations_schema.json",
    "teams_intelligence_schema.json", "troubleshooting_schema.json",
  ]) {
    await fs.copyFile(path.join(resources, name), path.join(root, name));
  }
  const timestamp = new Date().toISOString();
  for (const [name, empty] of [
    ["ev2/service-groups", { observations: [] }],
    ["srm/release-observations", { releases: [] }],
    ["teams/deployment-signals", { windowStart: timestamp, windowEnd: timestamp, signals: [] }],
  ]) {
    try {
      await fs.writeFile(
        path.join(root, "intelligence", `${name}.json`),
        `${JSON.stringify({ schemaVersion: "1.0.0", generatedAt: timestamp, ...empty }, null, 2)}\n`,
        { flag: "wx" },
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

export async function readSnapshot(root) {
  const validate = await createServiceValidator(root);
  const catalogEntries = [];
  const initialValidation = {};
  for (const file of await listServiceFiles(root)) {
    const result = await validateServiceFile(root, file, validate);
    initialValidation[result.sourcePath] = {
      checkedAt: result.checkedAt, errors: result.errors,
      sourcePath: result.sourcePath, status: result.status,
    };
    if (result.status === "valid") {
      catalogEntries.push({ record: result.record, sourceFilePath: file, sourcePath: result.sourcePath });
    } else {
      throw new Error(`Invalid service record ${result.sourcePath}: ${JSON.stringify(result.errors)}`);
    }
  }
  return {
    catalogEntries, initialValidation,
    ev2ServiceGroupData: await readOperationalJson(path.join(root, "intelligence", "ev2", "service-groups.json")),
    srmObservationData: await readOperationalJson(path.join(root, "intelligence", "srm", "release-observations.json")),
    teamsIntelligenceSnapshot: await readOperationalJson(path.join(root, "intelligence", "teams", "deployment-signals.json")),
  };
}

export async function createBackend(root, onDataChanged = () => {}, { copilot } = {}) {
  const plugins = [
    serviceCatalogPlugin(), operationalIntelligencePlugin(), serviceChatPlugin({ copilot }),
    srmCompanionPlugin(), srmStatusPlugin(), workCompanionPlugin(),
    adoWorkItemsPlugin(), deploymentDiffsPlugin(), gitHistoryPlugin(), localReposPlugin(),
  ];
  const watcher = watch([], { ignoreInitial: true });
  const middlewares = connect();
  const server = {
    middlewares, watcher,
    moduleGraph: { getModuleById: () => undefined },
    ws: { send: (message) => { if (message.type === "full-reload") onDataChanged(); } },
  };
  watcher.on("error", (error) => console.error("Grounds data watcher failed:", error));
  try {
    for (const plugin of plugins) await plugin.configResolved?.({ root, command: "serve" });
    for (const plugin of plugins) await plugin.configureServer?.(server);
  } catch (error) {
    await watcher.close();
    for (const plugin of plugins) await plugin.closeBundle?.();
    throw error;
  }
  const pending = new Set();
  return {
    request(input) {
      const result = dispatch(middlewares, input);
      pending.add(result);
      result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    },
    async close() {
      await Promise.allSettled([...pending]);
      await watcher.close();
      for (const plugin of plugins) await plugin.closeBundle?.();
    },
  };
}
