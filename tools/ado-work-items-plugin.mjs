import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fetchAuthenticatedJson, getAzureCliToken } from "./azure-user-auth.mjs";

const azureDevOpsResource = "499b84ac-1321-427f-aa17-267ca6975798";
const cacheLifetimeMilliseconds = 5 * 60 * 1000;
const completedStates = new Set(["closed", "done", "removed", "resolved"]);
const requestedFields = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.AssignedTo",
  "System.AreaPath",
  "System.IterationPath",
  "System.ChangedDate",
  "System.CreatedDate",
  "System.TeamProject",
  "System.Tags",
];

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

function parseRepositoryScope(repository, serviceName) {
  if (repository.provider !== "azure-devops") return undefined;
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repository.url);
  } catch {
    return undefined;
  }
  if (repositoryUrl.protocol !== "https:") return undefined;

  const segments = repositoryUrl.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const gitIndex = segments.findIndex(
    (segment) => segment.toLocaleLowerCase() === "_git",
  );
  if (gitIndex < 2) return undefined;

  const organization =
    repository.organization ??
    (repositoryUrl.hostname.endsWith(".visualstudio.com")
      ? repositoryUrl.hostname.split(".")[0]
      : segments[0]);
  const project = repository.project ?? segments[gitIndex - 1];
  if (!organization || !project) return undefined;

  return {
    key: `${organization.toLocaleLowerCase()}/${project.toLocaleLowerCase()}`,
    organization,
    project,
    serviceNames: [serviceName],
  };
}

function parseBoardScope(value) {
  if (!value) return undefined;
  let boardUrl;
  try {
    boardUrl = new URL(value);
  } catch {
    throw new Error("Enter a valid Azure DevOps team board URL.");
  }
  if (boardUrl.protocol !== "https:") {
    throw new Error("The Azure DevOps board URL must use HTTPS.");
  }
  const segments = boardUrl.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const organization =
    boardUrl.hostname === "dev.azure.com"
      ? segments[0]
      : boardUrl.hostname.endsWith(".visualstudio.com")
        ? boardUrl.hostname.slice(0, -".visualstudio.com".length)
        : undefined;
  const project =
    boardUrl.hostname === "dev.azure.com" ? segments[1] : segments[0];
  if (!organization || !project || !segments.includes("_boards")) {
    throw new Error(
      "Use an Azure DevOps board URL such as https://dev.azure.com/{organization}/{project}/_boards/....",
    );
  }
  return {
    key: `${organization.toLocaleLowerCase()}/${project.toLocaleLowerCase()}`,
    organization,
    project,
    serviceNames: [],
  };
}

function loadProjectScopes(root) {
  const servicesRoot = path.join(root, "services");
  const scopes = new Map();
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
    const serviceName = String(record?.service?.name ?? "").trim();
    if (!serviceName) continue;

    for (const repository of record.repositories ?? []) {
      const scope = parseRepositoryScope(repository, serviceName);
      if (!scope) continue;
      const current = scopes.get(scope.key);
      if (current) {
        current.serviceNames = [
          ...new Set([...current.serviceNames, serviceName]),
        ].sort();
      } else {
        scopes.set(scope.key, scope);
      }
    }
  }

  return [...scopes.values()].sort(
    (left, right) =>
      left.organization.localeCompare(right.organization) ||
      left.project.localeCompare(right.project),
  );
}

async function getIdentity(organization, token) {
  const result = await fetchAuthenticatedJson(
    `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1`,
    token,
  );
  const identity = result.authenticatedUser ?? result.authorizedUser;
  return {
    displayName: String(
      identity?.providerDisplayName ?? identity?.customDisplayName ?? "",
    ),
    uniqueName: String(
      identity?.properties?.Account?.$value ??
        identity?.properties?.Mail?.$value ??
        identity?.uniqueName ??
        "",
    ),
  };
}

async function getAssignedIds(scope, token) {
  const result = await fetchAuthenticatedJson(
    `https://dev.azure.com/${encodeURIComponent(scope.organization)}/${encodeURIComponent(scope.project)}/_apis/wit/wiql?$top=20000&api-version=7.1`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `SELECT [System.Id]
FROM WorkItems
WHERE [System.AssignedTo] = @Me
  AND [System.State] <> 'Removed'
ORDER BY [System.ChangedDate] DESC`,
      }),
    },
  );
  return (result.workItems ?? []).map((item) => item.id);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function normalizeIdentity(value) {
  if (!value) return { displayName: "", uniqueName: "" };
  if (typeof value === "string") {
    return { displayName: value, uniqueName: value };
  }
  return {
    displayName: String(value.displayName ?? ""),
    uniqueName: String(value.uniqueName ?? value.uniqueName ?? ""),
  };
}

function normalizeWorkItem(item, scope) {
  const fields = item.fields ?? {};
  const state = String(fields["System.State"] ?? "Unknown");
  return {
    active: !completedStates.has(state.toLocaleLowerCase()),
    areaPath: String(fields["System.AreaPath"] ?? ""),
    assignedTo: normalizeIdentity(fields["System.AssignedTo"]),
    changedDate: String(fields["System.ChangedDate"] ?? ""),
    createdDate: String(fields["System.CreatedDate"] ?? ""),
    id: Number(fields["System.Id"] ?? item.id),
    iterationPath: String(fields["System.IterationPath"] ?? ""),
    organization: scope.organization,
    project: String(fields["System.TeamProject"] ?? scope.project),
    serviceNames: scope.serviceNames,
    state,
    tags: String(fields["System.Tags"] ?? "")
      .split(";")
      .map((tag) => tag.trim())
      .filter(Boolean),
    title: String(fields["System.Title"] ?? `Work item ${item.id}`),
    type: String(fields["System.WorkItemType"] ?? "Work item"),
    url: `https://dev.azure.com/${encodeURIComponent(scope.organization)}/${encodeURIComponent(scope.project)}/_workitems/edit/${item.id}`,
  };
}

async function getProjectWorkItems(scope, token) {
  const ids = await getAssignedIds(scope, token);
  const batches = await Promise.all(
    chunks(ids, 200).map((batch) =>
      fetchAuthenticatedJson(
        `https://dev.azure.com/${encodeURIComponent(scope.organization)}/${encodeURIComponent(scope.project)}/_apis/wit/workitems?ids=${batch.join(",")}&fields=${encodeURIComponent(requestedFields.join(","))}&errorPolicy=Omit&api-version=7.1`,
        token,
      ),
    ),
  );
  return batches
    .flatMap((batch) => batch.value ?? [])
    .map((item) => normalizeWorkItem(item, scope));
}

async function loadWorkItems(scopes, boardUrl) {
  const requestedScope = parseBoardScope(boardUrl);
  const queriedScopes = requestedScope ? [requestedScope] : scopes;
  const token = await getAzureCliToken(azureDevOpsResource);
  const errors = [];
  const results = await Promise.all(
    queriedScopes.map(async (scope) => {
      try {
        return await getProjectWorkItems(scope, token);
      } catch (error) {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          organization: scope.organization,
          project: scope.project,
        });
        return [];
      }
    }),
  );
  const workItems = results
    .flat()
    .sort(
      (left, right) =>
        Date.parse(right.changedDate) - Date.parse(left.changedDate),
    );
  const organizations = [
    ...new Set(queriedScopes.map((scope) => scope.organization)),
  ];
  const identity =
    organizations.length > 0
      ? await getIdentity(organizations[0], token)
      : undefined;

  return {
    activeCount: workItems.filter((item) => item.active).length,
    errors,
    generatedAt: new Date().toISOString(),
    identity,
    projectCount: queriedScopes.length,
    workItems,
  };
}

export function adoWorkItemsPlugin() {
  let scopes = [];
  const cache = new Map();

  return {
    name: "grounds-ado-work-items",
    apply: "serve",
    configResolved(config) {
      scopes = loadProjectScopes(config.root);
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        if (requestUrl.pathname !== "/__grounds/ado-work-items") {
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
          const bypassCache = requestUrl.searchParams.get("refresh") === "true";
          const boardUrl = requestUrl.searchParams.get("boardUrl") ?? "";
          const cacheKey = boardUrl;
          const cached = cache.get(cacheKey);
          if (
            !bypassCache &&
            cached &&
            Date.now() - cached.createdAt < cacheLifetimeMilliseconds
          ) {
            sendJson(response, 200, cached.payload);
            return;
          }
          const payload = await loadWorkItems(scopes, boardUrl);
          cache.set(cacheKey, { createdAt: Date.now(), payload });
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
