import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const azureDevOpsResource = "499b84ac-1321-427f-aa17-267ca6975798";
const cacheLifetimeMilliseconds = 5 * 60 * 1000;
const targetClouds = ["ussec", "usnat", "fairfax"];

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

function normalizePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .toLocaleLowerCase();
}

function parseAzureDevOpsRepository(repository) {
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
  if (gitIndex < 2 || !segments[gitIndex + 1]) return undefined;

  const organization =
    repository.organization ??
    (repositoryUrl.hostname.endsWith(".visualstudio.com")
      ? repositoryUrl.hostname.split(".")[0]
      : segments[0]);
  const project = repository.project ?? segments[gitIndex - 1];
  const name = segments[gitIndex + 1];
  if (!organization || !project || !name) return undefined;

  return {
    name,
    organization,
    paths: (repository.paths ?? []).map(normalizePath).filter(Boolean),
    project,
    purpose: repository.purpose,
    url: `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`,
  };
}

function loadCatalogServices(root) {
  const servicesRoot = path.join(root, "services");
  if (!existsSync(servicesRoot)) return [];
  const records = [];

  for (const entry of readdirSync(servicesRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sourcePath = path.join(entry.parentPath, entry.name);
    let record;
    try {
      record = JSON.parse(readFileSync(sourcePath, "utf8"));
    } catch {
      continue;
    }

    const serviceName = String(record?.service?.name ?? "").trim();
    const displayName = String(record?.service?.displayName ?? "").trim();
    if (!serviceName || !displayName) continue;
    const repositories = (record.repositories ?? [])
      .map(parseAzureDevOpsRepository)
      .filter(Boolean);
    const pipelines = (record.pipelines?.build ?? []).filter(
      (pipeline) => pipeline.provider === "azure-devops",
    );

    records.push({
      displayName,
      environments: (record.environments ?? []).map((item) => item.cloud),
      operationalImpact: record.operationalImpact,
      operationalImpactTier:
        record.service.operationalImpactTier ?? "medium",
      pipelines,
      repositories,
      serviceName,
      serviceTreeId: record.service.serviceTreeId,
    });
  }

  return records.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function loadSrmObservations(root) {
  const sourcePath = path.join(
    root,
    "intelligence",
    "srm",
    "release-observations.json",
  );
  if (!existsSync(sourcePath)) return [];
  try {
    return JSON.parse(readFileSync(sourcePath, "utf8")).releases ?? [];
  } catch {
    return [];
  }
}

function loadServiceGroups(root) {
  const sourcePath = path.join(
    root,
    "intelligence",
    "ev2",
    "service-groups.json",
  );
  if (!existsSync(sourcePath)) return new Map();

  let observations;
  try {
    observations =
      JSON.parse(readFileSync(sourcePath, "utf8")).observations ?? [];
  } catch {
    return new Map();
  }

  const groupsByService = new Map();
  for (const observation of observations) {
    for (const group of observation.serviceGroups ?? []) {
      for (const association of group.associations ?? []) {
        const serviceName = String(association.serviceName ?? "");
        if (!serviceName) continue;
        const groups = groupsByService.get(serviceName) ?? new Map();
        const existing = groups.get(group.serviceGroupId);
        groups.set(group.serviceGroupId, {
          associationBasis: association.basis,
          associationEvidence: association.evidence,
          clouds: [
            ...new Set([
              ...(existing?.clouds ?? []),
              String(observation.cloud ?? ""),
            ]),
          ].filter(Boolean),
          displayName: group.displayName,
          infrastructures: [
            ...new Set([
              ...(existing?.infrastructures ?? []),
              ...(group.infrastructures ?? []),
            ]),
          ].sort(),
          serviceGroupId: group.serviceGroupId,
          sourceUrl: group.sourceUrl,
        });
        groupsByService.set(serviceName, groups);
      }
    }
  }

  return new Map(
    [...groupsByService.entries()].map(([serviceName, groups]) => [
      serviceName,
      [...groups.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
    ]),
  );
}

function getAzureDevOpsToken() {
  return new Promise((resolve, reject) => {
    const argumentsList = [
      "account",
      "get-access-token",
      "--resource",
      azureDevOpsResource,
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ];
    const windowsAzureCli =
      [
        process.env["ProgramFiles(x86)"],
        process.env.PROGRAMFILES,
        "C:\\Program Files (x86)",
      ]
        .filter(Boolean)
        .map((root) =>
          path.join(
            root,
            "Microsoft",
            "SDKs",
            "Azure",
            "CLI2",
            "wbin",
            "az.cmd",
          ),
        )
        .find((candidate) => existsSync(candidate)) ?? "az.cmd";
    const command = process.platform === "win32" ? windowsAzureCli : "az";
    const child = spawn(command, argumentsList, {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Azure CLI authentication timed out."));
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          error.code === "ENOENT"
            ? "Azure CLI is not installed. Install it and run az login."
            : error.message,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const token = output.trim();
      if (code === 0 && token) {
        resolve(token);
        return;
      }
      reject(
        new Error(
          errorOutput.trim() ||
            "Azure CLI could not acquire an Azure DevOps token. Run az login and try again.",
        ),
      );
    });
  });
}

async function fetchAzureDevOpsJson(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      result?.message ?? `Azure DevOps returned ${response.status}.`,
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function definitionScope(repository) {
  return `${repository.organization.toLocaleLowerCase()}/${repository.project.toLocaleLowerCase()}`;
}

function repositoryKey(repository) {
  return `${definitionScope(repository)}/${repository.name.toLocaleLowerCase()}`;
}

function createResolver(token) {
  const repositoryCache = new Map();
  const definitionsCache = new Map();
  const definitionCache = new Map();

  async function getRepository(repository) {
    const key = repositoryKey(repository);
    if (!repositoryCache.has(key)) {
      repositoryCache.set(
        key,
        fetchAzureDevOpsJson(
          `https://dev.azure.com/${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.project)}/_apis/git/repositories/${encodeURIComponent(repository.name)}?api-version=7.1`,
          token,
        ),
      );
    }
    return repositoryCache.get(key);
  }

  async function getDefinitions(repository) {
    const key = repositoryKey(repository);
    if (!definitionsCache.has(key)) {
      definitionsCache.set(
        key,
        (async () => {
          const resolvedRepository = await getRepository(repository);
          const query = new URLSearchParams({
            repositoryId: resolvedRepository.id,
            repositoryType: "TfsGit",
            includeAllProperties: "true",
            "$top": "500",
            "api-version": "7.1",
          });
          const result = await fetchAzureDevOpsJson(
            `https://dev.azure.com/${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.project)}/_apis/build/definitions?${query.toString()}`,
            token,
          );
          return result.value ?? [];
        })(),
      );
    }
    return definitionsCache.get(key);
  }

  async function getDefinition(repository, definitionId) {
    const key = `${definitionScope(repository)}/${definitionId}`;
    if (!definitionCache.has(key)) {
      definitionCache.set(
        key,
        fetchAzureDevOpsJson(
          `https://dev.azure.com/${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.project)}/_apis/build/definitions/${encodeURIComponent(definitionId)}?api-version=7.1`,
          token,
        ),
      );
    }
    return definitionCache.get(key);
  }

  async function resolveDefinition(service, pipeline) {
    if (pipeline.definitionId !== undefined) {
      for (const repository of service.repositories) {
        try {
          const definition = await getDefinition(
            repository,
            pipeline.definitionId,
          );
          const matchingRepository =
            service.repositories.find(
              (candidate) =>
                candidate.name.toLocaleLowerCase() ===
                String(definition.repository?.name ?? "").toLocaleLowerCase(),
            ) ?? repository;
          return { definition, repository: matchingRepository };
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }

    const pipelinePath = normalizePath(pipeline.pipelineFile);
    if (!pipelinePath) {
      throw new Error(
        `${pipeline.name} has neither a usable definition ID nor pipeline file.`,
      );
    }

    const matches = [];
    await Promise.all(
      service.repositories.map(async (repository) => {
        const definitions = await getDefinitions(repository);
        for (const definition of definitions) {
          if (normalizePath(definition.process?.yamlFilename) === pipelinePath) {
            matches.push({ definition, repository });
          }
        }
      }),
    );
    if (matches.length === 0) {
      throw new Error(
        `No Azure DevOps build definition uses ${pipeline.pipelineFile}.`,
      );
    }

    const pipelineWords = String(pipeline.name)
      .toLocaleLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && word !== "official");
    matches.sort((left, right) => {
      const score = (match) => {
        const candidate =
          `${match.definition.name} ${match.repository.name}`.toLocaleLowerCase();
        return pipelineWords.filter((word) => candidate.includes(word)).length;
      };
      return score(right) - score(left);
    });
    return matches[0];
  }

  return { resolveDefinition };
}

function normalizeBuild(build, repositoryUrl) {
  return {
    branch: String(build.sourceBranch ?? "").replace(/^refs\/heads\//, ""),
    buildId: build.id,
    buildNumber: build.buildNumber,
    finishTime: build.finishTime,
    sourceVersion: build.sourceVersion,
    sourceVersionUrl: `${repositoryUrl}/commit/${build.sourceVersion}`,
    url: build._links?.web?.href ??
      `${build.project?.url ?? ""}/_build/results?buildId=${build.id}`,
  };
}

function environmentForPath(filePath) {
  const normalized = normalizePath(filePath);
  const matches = [];
  if (/(^|[\/_.-])(airgap|airgapped|sovereign|agc)([\/_.-]|$)/i.test(normalized)) {
    matches.push("ussec", "usnat");
  }
  if (/(^|[\/_.-])(ussec|sccloud|secret)([\/_.-]|$)/i.test(normalized)) {
    matches.push("ussec");
  }
  if (/(^|[\/_.-])(usnat|eaglex)([\/_.-]|$)/i.test(normalized)) {
    matches.push("usnat");
  }
  if (/(^|[\/_.-])(fairfax|usgov|government)([\/_.-]|$)/i.test(normalized)) {
    matches.push("fairfax");
  }
  return [...new Set(matches)];
}

function isDeploymentPath(filePath) {
  return /(^|[\/_.-])(ev2|deployment|rollout|manifest|scopebinding|servicegroup|region|environment|config|identity|certificate|network)([\/_.-]|$)/i.test(
    normalizePath(filePath),
  );
}

function isServiceScoped(filePath, repositoryPaths) {
  if (repositoryPaths.length === 0) return true;
  const normalized = normalizePath(filePath);
  return repositoryPaths.some(
    (repositoryPath) =>
      normalized === repositoryPath ||
      normalized.startsWith(`${repositoryPath}/`),
  );
}

function categoriesForPath(filePath) {
  const normalized = normalizePath(filePath);
  const categories = [];
  if (environmentForPath(filePath).length > 0) categories.push("sovereign");
  if (/(^|[\/_.-])(ev2|deployment|rollout|manifest|scopebinding|servicegroup)([\/_.-]|$)/i.test(normalized)) {
    categories.push("deployment");
  }
  if (/(^|[\/_.-])(identity|certificate|cert|secret|keyvault|msi)([\/_.-]|$)/i.test(normalized)) {
    categories.push("identity");
  }
  if (/(^|[\/_.-])(network|vnet|subnet|dns|firewall|privateendpoint)([\/_.-]|$)/i.test(normalized)) {
    categories.push("network");
  }
  if (/(^|[\/_.-])(test|tests|spec|specs)([\/_.-]|$)/i.test(normalized)) {
    categories.push("tests");
  }
  if (/(^|[\/_.-])(docs|documentation|readme)([\/_.-]|$)/i.test(normalized)) {
    categories.push("documentation");
  }
  if (
    categories.length === 0 &&
    /\.(cs|go|ts|tsx|js|jsx|py|cpp|c|h|java|rs)$/i.test(normalized)
  ) {
    categories.push("code");
  }
  if (categories.length === 0) categories.push("other");
  return categories;
}

function summarizeChanges(changes, repositoryPaths) {
  const normalized = changes
    .filter(
      (change) =>
        String(change.item?.gitObjectType ?? "").toLocaleLowerCase() !== "tree",
    )
    .map((change) => {
      const filePath = String(change.item?.path ?? "");
      return {
        categories: categoriesForPath(filePath),
        changeType: change.changeType ?? "edit",
        environments: environmentForPath(filePath),
        isDeployment: isDeploymentPath(filePath),
        isServiceScoped: isServiceScoped(filePath, repositoryPaths),
        path: filePath,
      };
    });
  const categoryCounts = {};
  for (const change of normalized) {
    for (const category of change.categories) {
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    }
  }
  const environmentCounts = Object.fromEntries(
    targetClouds.map((cloud) => [
      cloud,
      normalized.filter((change) => change.environments.includes(cloud)).length,
    ]),
  );
  const deploymentCount = normalized.filter(
    (change) => change.isDeployment,
  ).length;
  const serviceScopedCount = normalized.filter(
    (change) => change.isServiceScoped,
  ).length;
  const prioritized = [...normalized].sort(
    (left, right) =>
      Number(right.environments.length > 0) -
        Number(left.environments.length > 0) ||
      Number(right.isServiceScoped) - Number(left.isServiceScoped) ||
      Number(right.isDeployment) - Number(left.isDeployment) ||
      left.path.localeCompare(right.path),
  );
  return {
    changes: prioritized.slice(0, 200),
    categoryCounts,
    deploymentCount,
    environmentCounts,
    serviceScopedCount,
    totalChangeCount: normalized.length,
  };
}

function extractPullRequests(commits, repositoryUrl) {
  const pullRequests = new Map();
  for (const commit of commits) {
    for (const match of String(commit.comment ?? "").matchAll(
      /\b(?:merged\s+pr|pr)\s+#?(\d+)/gi,
    )) {
      const pullRequestId = Number(match[1]);
      pullRequests.set(pullRequestId, {
        pullRequestId,
        title: String(commit.comment ?? "").split(/\r?\n/, 1)[0],
        url: `${repositoryUrl}/pullrequest/${pullRequestId}`,
      });
    }
  }
  return [...pullRequests.values()];
}

function buildRisk(service, summary) {
  const environmentChangeCount = Object.values(
    summary.environmentCounts,
  ).reduce((total, count) => total + count, 0);
  if (environmentChangeCount > 0) return "high";
  if (summary.deploymentCount > 0 || summary.serviceScopedCount > 0) {
    return "medium";
  }
  return service.operationalImpactTier === "critical" ? "medium" : "low";
}

function buildImpactReasons(service, summary) {
  const reasons = [];
  for (const cloud of targetClouds) {
    const count = summary.environmentCounts[cloud];
    if (count > 0) {
      reasons.push(`${count} ${cloud.toUpperCase()}-relevant changed file${count === 1 ? "" : "s"}`);
    }
  }
  if (summary.deploymentCount > 0) {
    reasons.push(
      `${summary.deploymentCount} deployment, manifest, identity, network, or configuration file${summary.deploymentCount === 1 ? "" : "s"} changed`,
    );
  }
  if (summary.serviceScopedCount > 0) {
    reasons.push(
      `${summary.serviceScopedCount} changed file${summary.serviceScopedCount === 1 ? "" : "s"} under cataloged service paths`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      "No environment-specific or service-scoped files were found in the returned change set",
    );
  }
  if (service.operationalImpact?.summary) {
    reasons.push(service.operationalImpact.summary);
  }
  return reasons;
}

function serviceSrmContext(service, observations) {
  return observations
    .filter(
      (observation) =>
        observation.serviceName === service.serviceName ||
        (service.serviceTreeId &&
          observation.serviceTreeId === service.serviceTreeId),
    )
    .map((observation) => ({
      overallStatus: observation.overallStatus,
      releaseName: observation.releaseName,
      releaseUrl: observation.releaseUrl,
      serviceGroupId: observation.serviceGroupId,
      stages: (observation.stages ?? [])
        .filter((stage) => targetClouds.includes(stage.cloud))
        .map((stage) => ({
          cloud: stage.cloud,
          name: stage.name,
          status: stage.status,
          updatedOn: stage.updatedOn,
        })),
      updatedOn: observation.updatedOn,
    }))
    .filter((observation) => observation.stages.length > 0);
}

async function getCommitRange(
  repository,
  previousSourceVersion,
  currentSourceVersion,
  token,
) {
  const query = new URLSearchParams({
    "searchCriteria.itemVersion.version": previousSourceVersion,
    "searchCriteria.itemVersion.versionType": "commit",
    "searchCriteria.compareVersion.version": currentSourceVersion,
    "searchCriteria.compareVersion.versionType": "commit",
    "searchCriteria.includeLinks": "true",
    "searchCriteria.$top": "200",
    "api-version": "7.1",
  });
  const result = await fetchAzureDevOpsJson(
    `https://dev.azure.com/${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.project)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/commits?${query.toString()}`,
    token,
  );
  return result.value ?? [];
}

async function getComparison(
  service,
  pipeline,
  resolver,
  token,
  observations,
  serviceGroups,
) {
  try {
    const { definition, repository: catalogRepository } =
      await resolver.resolveDefinition(service, pipeline);
    const repository = {
      id: definition.repository?.id,
      name: definition.repository?.name ?? catalogRepository.name,
      organization: catalogRepository.organization,
      project: catalogRepository.project,
      url:
        definition.repository?.url?.replace(
          /_apis\/git\/repositories\/.+$/i,
          `_git/${encodeURIComponent(definition.repository?.name ?? catalogRepository.name)}`,
        ) ?? catalogRepository.url,
    };
    if (!repository.id) {
      throw new Error("The build definition does not identify its source repository.");
    }

    const buildQuery = new URLSearchParams({
      definitions: String(definition.id),
      statusFilter: "completed",
      resultFilter: "succeeded",
      "$top": "2",
      queryOrder: "finishTimeDescending",
      "api-version": "7.1",
    });
    const buildResult = await fetchAzureDevOpsJson(
      `https://dev.azure.com/${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.project)}/_apis/build/builds?${buildQuery.toString()}`,
      token,
    );
    const builds = buildResult.value ?? [];
    if (builds.length < 2) {
      return {
        definitionId: definition.id,
        environments: service.environments,
        error: "Fewer than two successful completed builds are available.",
        evidence: "build",
        pipelineName: pipeline.name,
        repository: repository.name,
        serviceDisplayName: service.displayName,
        serviceGroups: serviceGroups.get(service.serviceName) ?? [],
        serviceName: service.serviceName,
        status: "insufficient-builds",
      };
    }

    const [currentRaw, previousRaw] = builds;
    const current = normalizeBuild(currentRaw, repository.url);
    const previous = normalizeBuild(previousRaw, repository.url);
    const diffQuery = new URLSearchParams({
      baseVersion: previous.sourceVersion,
      targetVersion: current.sourceVersion,
      baseVersionType: "commit",
      targetVersionType: "commit",
      "$top": "2000",
      "api-version": "7.1",
    });
    const [diff, commits] = await Promise.all([
      fetchAzureDevOpsJson(
        `https://dev.azure.com/${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.project)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/diffs/commits?${diffQuery.toString()}`,
        token,
      ),
      getCommitRange(
        repository,
        previous.sourceVersion,
        current.sourceVersion,
        token,
      ),
    ]);
    const summary = summarizeChanges(
      diff.changes ?? [],
      catalogRepository.paths,
    );

    return {
      aheadCount: diff.aheadCount ?? commits.length,
      changeCount: summary.totalChangeCount,
      changeCategoryCounts: summary.categoryCounts,
      changes: summary.changes,
      commits: commits.map((commit) => ({
        author: commit.author?.name ?? "Unknown author",
        comment: String(commit.comment ?? "").split(/\r?\n/, 1)[0],
        commitId: commit.commitId,
        date: commit.author?.date ?? commit.committer?.date,
        url: `${repository.url}/commit/${commit.commitId}`,
      })),
      compareUrl: `${repository.url}/branchCompare?baseVersion=GC${previous.sourceVersion}&targetVersion=GC${current.sourceVersion}&_a=commits`,
      current,
      definitionId: definition.id,
      definitionName: definition.name,
      deploymentLineageConfirmed: false,
      deploymentPathChangeCount: summary.deploymentCount,
      environments: service.environments,
      environmentChangeCounts: summary.environmentCounts,
      evidence: "build",
      impactReasons: buildImpactReasons(service, summary),
      operationalImpactTier: service.operationalImpactTier,
      pipelineName: pipeline.name,
      previous,
      pullRequests: extractPullRequests(commits, repository.url),
      repository: repository.name,
      risk: buildRisk(service, summary),
      serviceDisplayName: service.displayName,
      serviceGroups: serviceGroups.get(service.serviceName) ?? [],
      serviceName: service.serviceName,
      serviceTreeId: service.serviceTreeId,
      serviceScopedChangeCount: summary.serviceScopedCount,
      srmContext: serviceSrmContext(service, observations),
      status: "available",
    };
  } catch (error) {
    return {
      environments: service.environments,
      error: error instanceof Error ? error.message : String(error),
      evidence: "unavailable",
      pipelineName: pipeline.name,
      serviceDisplayName: service.displayName,
      serviceGroups: serviceGroups.get(service.serviceName) ?? [],
      serviceName: service.serviceName,
      serviceTreeId: service.serviceTreeId,
      status: "unavailable",
    };
  }
}

async function loadDeploymentDiffs(services, observations, serviceGroups) {
  const token = await getAzureDevOpsToken();
  const resolver = createResolver(token);
  const targets = services.flatMap((service) =>
    service.pipelines.length > 0
      ? service.pipelines.map((pipeline) => ({ pipeline, service }))
      : [{ pipeline: undefined, service }],
  );

  const comparisons = await mapWithConcurrency(
    targets,
    4,
    async ({ pipeline, service }) => {
      if (!pipeline) {
        return {
          environments: service.environments,
          error: "No Azure DevOps build pipeline is cataloged.",
          evidence: "unavailable",
          pipelineName: "Not configured",
          serviceDisplayName: service.displayName,
          serviceGroups: serviceGroups.get(service.serviceName) ?? [],
          serviceName: service.serviceName,
          serviceTreeId: service.serviceTreeId,
          status: "unavailable",
        };
      }
      return getComparison(
        service,
        pipeline,
        resolver,
        token,
        observations,
        serviceGroups,
      );
    },
  );

  return {
    comparisons,
    generatedAt: new Date().toISOString(),
    targetClouds,
  };
}

export function deploymentDiffsPlugin() {
  let services = [];
  let observations = [];
  let serviceGroups = new Map();
  let cache;

  return {
    name: "grounds-deployment-diffs",
    apply: "serve",
    configResolved(config) {
      services = loadCatalogServices(config.root);
      observations = loadSrmObservations(config.root);
      serviceGroups = loadServiceGroups(config.root);
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        if (requestUrl.pathname !== "/__grounds/deployment-diffs") {
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
          if (
            !bypassCache &&
            cache &&
            Date.now() - cache.createdAt < cacheLifetimeMilliseconds
          ) {
            sendJson(response, 200, cache.payload);
            return;
          }
          const payload = await loadDeploymentDiffs(
            services,
            observations,
            serviceGroups,
          );
          cache = { createdAt: Date.now(), payload };
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
