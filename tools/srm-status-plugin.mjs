import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fetchAuthenticatedJson, getAzureCliToken } from "./azure-user-auth.mjs";

const cluster = "https://srm.eastus.kusto.windows.net";
const database = "SovereignReleaseStatus";
const cacheLifetimeMilliseconds = 5 * 60 * 1000;

function isLocalRequest(request) {
  const remoteAddress = request.socket.remoteAddress ?? "";
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function loadServiceTrees(root) {
  const servicesRoot = path.join(root, "services");
  const trees = new Map();
  if (!existsSync(servicesRoot)) return [];

  for (const entry of readdirSync(servicesRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let record;
    try {
      record = JSON.parse(
        readFileSync(path.join(entry.parentPath, entry.name), "utf8"),
      );
    } catch {
      continue;
    }
    const id = String(record?.service?.serviceTreeId ?? "").toLocaleLowerCase();
    const serviceName = String(record?.service?.name ?? "");
    if (
      !serviceName ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        id,
      )
    ) {
      continue;
    }
    const current = trees.get(id) ?? { id, serviceNames: [] };
    current.serviceNames.push(serviceName);
    trees.set(id, current);
  }

  return [...trees.values()].map((tree) => ({
    ...tree,
    serviceNames: [...new Set(tree.serviceNames)].sort(),
  }));
}

function primaryRows(response) {
  const table = response.find(
    (frame) =>
      frame.FrameType === "DataTable" && frame.TableKind === "PrimaryResult",
  );
  if (!table) return [];
  const columns = table.Columns.map((column) => column.ColumnName);
  return table.Rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]])),
  );
}

function releaseUrl(releaseCorrelationId) {
  return releaseCorrelationId
    ? `https://srm.azure.com/#/ReleaseStatus/Release/${encodeURIComponent(releaseCorrelationId)}`
    : "";
}

async function loadReleaseStatus(serviceTrees) {
  if (serviceTrees.length === 0) {
    return {
      deploymentHistory: [],
      generatedAt: new Date().toISOString(),
      releases: [],
      serviceGroups: [],
      serviceTrees,
    };
  }
  const ids = serviceTrees.map((tree) => `'${tree.id}'`).join(",");
  const releasesQuery = `
let releases = Release_Status_Snapshot
| where ServiceTreeId in~ (${ids})
| summarize arg_max(EventDateUtc, *) by ReleaseCorrelationId
| top 100 by EventDateUtc desc;
let builds = Build_Status_Snapshot
| where ServiceTreeId in~ (${ids})
| summarize arg_max(EventDateUtc, *) by ReleaseCorrelationId, BuildInstanceCorrelationId
| summarize Builds=make_list(pack(
    "buildNumber", BuildNumber,
    "repository", RepositoryName,
    "branch", BranchName,
    "artifactId", HydrationArtifactId,
    "uniqueIdentifier", UniqueIdentifier,
    "status", CompletionIndicatorString,
    "environment", Environment), 25) by ReleaseCorrelationId;
let stages = Stage_Status_Snapshot
| where ServiceTreeId in~ (${ids})
| summarize arg_max(EventDateUtc, *) by ReleaseCorrelationId, ReleaseStageCorrelationId
| summarize Stages=make_list(pack(
    "name", StageName,
    "environment", Environment,
    "status", CompletionIndicatorString,
    "updatedAt", EventDateUtc), 100) by ReleaseCorrelationId;
releases
| join kind=leftouter builds on ReleaseCorrelationId
| join kind=leftouter stages on ReleaseCorrelationId
| project ServiceTreeId, ServiceTreeName, ReleaseCorrelationId,
    SourceReleaseId=ReleaseId,
    ReleaseName, OrganizationName, ProjectName, ComponentName, Environments,
    CompletionIndicatorString, ReleasePipelineSource, EventDateUtc, Builds, Stages
| order by EventDateUtc desc`;
  const serviceGroupsQuery = `
let deployments = Deployment_Status_Snapshot
| where ServiceTreeId in~ (${ids})
| extend ServiceGroupName=tostring(MetadataJson.serviceGroupName.value)
| where isnotempty(ServiceGroupName)
| summarize arg_max(EventDateUtc, *) by ServiceGroupName, Environment
| project ServiceTreeId, ServiceTreeName, ServiceGroupName, Environment,
    CompletionIndicatorString, DisplayName, DeploymentType,
    ReleaseCorrelationId, ReleaseStageCorrelationId, DeploymentCorrelationId,
    EventDateUtc;
let releaseDetails = Release_Status_Snapshot
| where ServiceTreeId in~ (${ids})
| summarize arg_max(EventDateUtc, *) by ReleaseCorrelationId
| project ReleaseCorrelationId, SourceReleaseId=ReleaseId, ReleaseName;
deployments
| join kind=leftouter releaseDetails on ReleaseCorrelationId
| project ServiceTreeId, ServiceTreeName, ServiceGroupName, Environment,
    CompletionIndicatorString, DisplayName, DeploymentType,
    ReleaseCorrelationId, ReleaseStageCorrelationId, DeploymentCorrelationId,
    SourceReleaseId, ReleaseName, EventDateUtc
| order by EventDateUtc desc`;
  const deploymentHistoryQuery = `
let deployments = Deployment_Status_Snapshot
| where ServiceTreeId in~ (${ids})
| where EventDateUtc > ago(180d)
| extend ServiceGroupName=tostring(MetadataJson.serviceGroupName.value)
| where isnotempty(ServiceGroupName) and isnotempty(DeploymentCorrelationId)
| summarize arg_max(EventDateUtc, *) by DeploymentCorrelationId
| top 750 by EventDateUtc desc
| project ServiceTreeId, ServiceTreeName, ServiceGroupName, Environment,
    CompletionIndicatorString, DisplayName, DeploymentType,
    ReleaseCorrelationId, ReleaseStageCorrelationId, DeploymentCorrelationId,
    EventDateUtc;
let releaseDetails = Release_Status_Snapshot
| where ServiceTreeId in~ (${ids})
| summarize arg_max(EventDateUtc, *) by ReleaseCorrelationId
| project ReleaseCorrelationId, SourceReleaseId=ReleaseId, ReleaseName;
deployments
| join kind=leftouter releaseDetails on ReleaseCorrelationId
| project ServiceTreeId, ServiceTreeName, ServiceGroupName, Environment,
    CompletionIndicatorString, DisplayName, DeploymentType,
    ReleaseCorrelationId, ReleaseStageCorrelationId, DeploymentCorrelationId,
    SourceReleaseId, ReleaseName, EventDateUtc
| order by EventDateUtc desc`;
  const token = await getAzureCliToken(cluster);
  const [releaseResponse, serviceGroupResponse, deploymentHistoryResponse] =
    await Promise.all(
    [releasesQuery, serviceGroupsQuery, deploymentHistoryQuery].map((query) =>
      fetchAuthenticatedJson(`${cluster}/v2/rest/query`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ db: database, csl: query }),
      }),
    ),
  );
  const servicesByTree = new Map(
    serviceTrees.map((tree) => [tree.id, tree.serviceNames]),
  );
  const releases = primaryRows(releaseResponse).map((row) => ({
    builds: row.Builds ?? [],
    componentName: row.ComponentName ?? "",
    environments: String(row.Environments ?? "")
      .split(",")
      .map((environment) => environment.trim())
      .filter(Boolean),
    organization: row.OrganizationName ?? "",
    pipelineSource: row.ReleasePipelineSource ?? "",
    project: row.ProjectName ?? "",
    releaseCorrelationId: row.ReleaseCorrelationId,
    releaseId: row.ReleaseCorrelationId,
    releaseName: row.ReleaseName ?? "",
    releaseUrl: releaseUrl(row.ReleaseCorrelationId),
    sourceReleaseId: row.SourceReleaseId,
    serviceNames:
      servicesByTree.get(String(row.ServiceTreeId).toLocaleLowerCase()) ?? [],
    serviceTreeId: row.ServiceTreeId,
    serviceTreeName: row.ServiceTreeName,
    stages: row.Stages ?? [],
    status: row.CompletionIndicatorString ?? "",
    updatedAt: row.EventDateUtc,
  }));
  const serviceGroups = primaryRows(serviceGroupResponse).map((row) => ({
    deploymentCorrelationId: row.DeploymentCorrelationId,
    deploymentType: row.DeploymentType ?? "",
    displayName: row.DisplayName ?? "",
    environment: row.Environment ?? "",
    releaseCorrelationId: row.ReleaseCorrelationId,
    releaseId: row.ReleaseCorrelationId,
    releaseName: row.ReleaseName ?? "",
    releaseUrl: releaseUrl(row.ReleaseCorrelationId),
    releaseStageCorrelationId: row.ReleaseStageCorrelationId,
    serviceGroupName: row.ServiceGroupName,
    serviceNames:
      servicesByTree.get(String(row.ServiceTreeId).toLocaleLowerCase()) ?? [],
    serviceTreeId: row.ServiceTreeId,
    serviceTreeName: row.ServiceTreeName,
    status: row.CompletionIndicatorString ?? "",
    sourceReleaseId: row.SourceReleaseId,
    updatedAt: row.EventDateUtc,
  }));
  const deploymentHistory = primaryRows(deploymentHistoryResponse).map(
    (row) => ({
      deploymentCorrelationId: row.DeploymentCorrelationId,
      deploymentType: row.DeploymentType ?? "",
      displayName: row.DisplayName ?? "",
      environment: row.Environment ?? "",
      releaseCorrelationId: row.ReleaseCorrelationId,
      releaseId: row.ReleaseCorrelationId,
      releaseName: row.ReleaseName ?? "",
      releaseUrl: releaseUrl(row.ReleaseCorrelationId),
      releaseStageCorrelationId: row.ReleaseStageCorrelationId,
      serviceGroupName: row.ServiceGroupName,
      serviceNames:
        servicesByTree.get(String(row.ServiceTreeId).toLocaleLowerCase()) ?? [],
      serviceTreeId: row.ServiceTreeId,
      serviceTreeName: row.ServiceTreeName,
      status: row.CompletionIndicatorString ?? "",
      sourceReleaseId: row.SourceReleaseId,
      updatedAt: row.EventDateUtc,
    }),
  );

  return {
    cluster,
    database,
    deploymentHistory,
    generatedAt: new Date().toISOString(),
    releases,
    serviceGroups,
    serviceTrees,
  };
}

export function srmStatusPlugin() {
  let root;
  let cache;

  return {
    name: "grounds-srm-status",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        if (requestUrl.pathname !== "/__grounds/srm-release-status") {
          next();
          return;
        }
        if (!isLocalRequest(request)) {
          sendJson(response, 403, { error: "Local Grounds origin required." });
          return;
        }
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed." });
          return;
        }

        try {
          const serviceTrees = loadServiceTrees(root);
          const bypassCache = requestUrl.searchParams.get("refresh") === "true";
          const serviceTreeKey = serviceTrees
            .map((tree) => `${tree.id}:${tree.serviceNames.join("|")}`)
            .join(",");
          if (
            !bypassCache &&
            cache &&
            cache.serviceTreeKey === serviceTreeKey &&
            Date.now() - cache.createdAt < cacheLifetimeMilliseconds
          ) {
            sendJson(response, 200, cache.payload);
            return;
          }
          const payload = await loadReleaseStatus(serviceTrees);
          cache = { createdAt: Date.now(), payload, serviceTreeKey };
          sendJson(response, 200, payload);
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
