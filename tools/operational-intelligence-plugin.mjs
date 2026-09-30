import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveOperationalDataPath } from "./operational-data.mjs";

const virtualModuleId = "virtual:operational-intelligence";
const resolvedVirtualModuleId = `\0${virtualModuleId}`;

const records = {
  ev2ServiceGroupData: ["intelligence", "ev2", "service-groups.json"],
  srmObservationData: ["intelligence", "srm", "release-observations.json"],
  teamsIntelligenceSnapshot: [
    "intelligence",
    "teams",
    "deployment-signals.json",
  ],
};

function moduleSource(root) {
  return Object.entries(records)
    .map(([exportName, segments]) => {
      const privatePath = path.join(root, ...segments);
      const sourcePath = resolveOperationalDataPath(privatePath);
      const value = JSON.parse(readFileSync(sourcePath, "utf8"));
      return `export const ${exportName} = ${JSON.stringify(value)};`;
    })
    .join("\n");
}

export function operationalIntelligencePlugin() {
  let root;

  function invalidate(server) {
    const module = server.moduleGraph.getModuleById(resolvedVirtualModuleId);
    if (module) server.moduleGraph.invalidateModule(module);
    server.ws.send({ type: "full-reload" });
  }

  return {
    name: "grounds-operational-intelligence",
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      return id === virtualModuleId ? resolvedVirtualModuleId : undefined;
    },
    load(id) {
      return id === resolvedVirtualModuleId ? moduleSource(root) : undefined;
    },
    configureServer(server) {
      const intelligenceRoot = path.join(root, "intelligence");
      server.watcher.add(intelligenceRoot);
      const handleChange = (filePath) => {
        if (
          filePath.startsWith(intelligenceRoot) &&
          (filePath.endsWith(".json") || filePath.endsWith(".example.json"))
        ) {
          invalidate(server);
        }
      };
      server.watcher.on("add", handleChange);
      server.watcher.on("change", handleChange);
      server.watcher.on("unlink", handleChange);
    },
  };
}
