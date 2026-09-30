import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const azureDevOpsResource = "499b84ac-1321-427f-aa17-267ca6975798";
const defaultDays = 365;
const maximumDays = 365;
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

function parseAzureDevOpsRepository(repository, serviceName) {
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
    key: `${organization.toLocaleLowerCase()}/${project.toLocaleLowerCase()}/${name.toLocaleLowerCase()}`,
    name,
    organization,
    project,
    serviceNames: [serviceName],
    url: `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`,
  };
}

function loadCatalogRepositories(root) {
  const servicesRoot = path.join(root, "services");
  const repositories = new Map();
  if (!existsSync(servicesRoot)) return [];

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
    if (!serviceName) continue;

    for (const repository of record.repositories ?? []) {
      const target = parseAzureDevOpsRepository(repository, serviceName);
      if (!target) continue;
      const current = repositories.get(target.key);
      if (current) {
        current.serviceNames = [
          ...new Set([...current.serviceNames, serviceName]),
        ].sort();
      } else {
        repositories.set(target.key, target);
      }
    }
  }

  return [...repositories.values()].sort(
    (left, right) =>
      left.organization.localeCompare(right.organization) ||
      left.project.localeCompare(right.project) ||
      left.name.localeCompare(right.name),
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
    throw new Error(
      result?.message ?? `Azure DevOps returned ${response.status}.`,
    );
  }
  return result;
}

async function getIdentity(organization, token) {
  const result = await fetchAzureDevOpsJson(
    `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1`,
    token,
  );
  const identity = result.authenticatedUser ?? result.authorizedUser;
  if (!identity?.id) {
    throw new Error(
      `Azure DevOps could not resolve the signed-in identity in ${organization}.`,
    );
  }
  return {
    displayName: String(identity.providerDisplayName ?? identity.customDisplayName ?? ""),
    id: String(identity.id),
    uniqueName: String(
      identity.properties?.Account?.$value ??
        identity.properties?.Mail?.$value ??
        identity.uniqueName ??
        "",
    ),
  };
}

function activityDate(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizePullRequest(pullRequest, target, associations) {
  const repositoryUrl =
    pullRequest.repository?.webUrl?.replace(/\/$/, "") ?? target.url;
  return {
    associations: [...associations].sort(),
    author: {
      displayName: pullRequest.createdBy?.displayName ?? "Unknown author",
      uniqueName: pullRequest.createdBy?.uniqueName ?? "",
    },
    date: pullRequest.closedDate ?? pullRequest.creationDate,
    id: `pr:${target.key}:${pullRequest.pullRequestId}`,
    organization: target.organization,
    project: target.project,
    pullRequestId: pullRequest.pullRequestId,
    repository: target.name,
    serviceNames: target.serviceNames,
    sourceBranch: String(pullRequest.sourceRefName ?? "").replace(
      /^refs\/heads\//,
      "",
    ),
    status: pullRequest.status ?? "unknown",
    targetBranch: String(pullRequest.targetRefName ?? "").replace(
      /^refs\/heads\//,
      "",
    ),
    title: pullRequest.title ?? `Pull request ${pullRequest.pullRequestId}`,
    type: "pull-request",
    url: `${repositoryUrl}/pullrequest/${pullRequest.pullRequestId}`,
  };
}

function normalizeCommit(commit, target) {
  return {
    associations: ["authored"],
    author: {
      displayName: commit.author?.name ?? "Unknown author",
      uniqueName: commit.author?.email ?? "",
    },
    changeCounts: commit.changeCounts ?? {},
    date: commit.author?.date ?? commit.committer?.date,
    id: `commit:${target.key}:${commit.commitId}`,
    organization: target.organization,
    project: target.project,
    repository: target.name,
    serviceNames: target.serviceNames,
    sha: commit.commitId,
    title:
      String(commit.comment ?? "").split(/\r?\n/, 1)[0] ||
      commit.commitId.slice(0, 12),
    type: "commit",
    url: `${target.url}/commit/${commit.commitId}`,
  };
}

async function getRepositoryActivity(target, identity, token, fromDate) {
  const organization = encodeURIComponent(target.organization);
  const project = encodeURIComponent(target.project);
  const repository = encodeURIComponent(target.name);
  const baseUrl = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repository}`;
  const commonPullRequestParameters =
    "searchCriteria.status=all&$top=100&api-version=7.1";
  const commitParameters = new URLSearchParams({
    "searchCriteria.$top": "100",
    "searchCriteria.author": identity.uniqueName,
    "searchCriteria.fromDate": fromDate,
    "api-version": "7.1",
  });
  const [commitsResult, authoredResult, reviewedResult] = await Promise.all([
    fetchAzureDevOpsJson(
      `${baseUrl}/commits?${commitParameters.toString()}`,
      token,
    ),
    fetchAzureDevOpsJson(
      `${baseUrl}/pullrequests?searchCriteria.creatorId=${encodeURIComponent(identity.id)}&${commonPullRequestParameters}`,
      token,
    ),
    fetchAzureDevOpsJson(
      `${baseUrl}/pullrequests?searchCriteria.reviewerId=${encodeURIComponent(identity.id)}&${commonPullRequestParameters}`,
      token,
    ),
  ]);

  const pullRequests = new Map();
  for (const [association, values] of [
    ["authored", authoredResult.value ?? []],
    ["reviewed", reviewedResult.value ?? []],
  ]) {
    for (const pullRequest of values) {
      const key = String(pullRequest.pullRequestId);
      const current = pullRequests.get(key) ?? {
        associations: new Set(),
        pullRequest,
      };
      current.associations.add(association);
      pullRequests.set(key, current);
    }
  }

  const fromTimestamp = activityDate(fromDate);
  return [
    ...(commitsResult.value ?? []).map((commit) =>
      normalizeCommit(commit, target),
    ),
    ...[...pullRequests.values()]
      .map(({ associations, pullRequest }) =>
        normalizePullRequest(pullRequest, target, associations),
      )
      .filter((item) => activityDate(item.date) >= fromTimestamp),
  ];
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

async function loadGitHistory(repositories, requestedDays) {
  const days = Math.min(
    maximumDays,
    Math.max(1, Number.parseInt(requestedDays, 10) || defaultDays),
  );
  const fromDate = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const token = await getAzureDevOpsToken();
  const organizations = [...new Set(repositories.map((item) => item.organization))];
  const identityEntries = await Promise.all(
    organizations.map(async (organization) => [
      organization,
      await getIdentity(organization, token),
    ]),
  );
  const identities = new Map(identityEntries);
  const errors = [];

  const repositoryResults = await mapWithConcurrency(
    repositories,
    4,
    async (repository) => {
      try {
        return await getRepositoryActivity(
          repository,
          identities.get(repository.organization),
          token,
          fromDate,
        );
      } catch (error) {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          organization: repository.organization,
          project: repository.project,
          repository: repository.name,
        });
        return [];
      }
    },
  );
  const activities = repositoryResults
    .flat()
    .sort((left, right) => activityDate(right.date) - activityDate(left.date));
  const primaryIdentity = identityEntries[0]?.[1];

  return {
    activities,
    days,
    errors,
    generatedAt: new Date().toISOString(),
    identity: primaryIdentity,
    repositoryCount: repositories.length,
  };
}

export function gitHistoryPlugin() {
  let repositories = [];
  const cache = new Map();

  return {
    name: "grounds-git-history",
    apply: "serve",
    configResolved(config) {
      repositories = loadCatalogRepositories(config.root);
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        if (requestUrl.pathname !== "/__grounds/git-history") {
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
          const days = Math.min(
            maximumDays,
            Math.max(
              1,
              Number.parseInt(
                requestUrl.searchParams.get("days") ?? String(defaultDays),
                10,
              ) || defaultDays,
            ),
          );
          const cacheKey = String(days);
          const cached = cache.get(cacheKey);
          const bypassCache = requestUrl.searchParams.get("refresh") === "true";
          if (
            !bypassCache &&
            cached &&
            Date.now() - cached.createdAt < cacheLifetimeMilliseconds
          ) {
            sendJson(response, 200, cached.payload);
            return;
          }

          const payload = await loadGitHistory(repositories, days);
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
