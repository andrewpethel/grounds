import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

function loadRepositories(root) {
  const servicesRoot = path.join(root, "services");
  const repositories = new Map();
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
    for (const repository of record?.repositories ?? []) {
      const localPath = String(repository.localPath ?? "").trim();
      if (!localPath) continue;
      const key = path.resolve(localPath).toLocaleLowerCase();
      const current = repositories.get(key);
      if (current) {
        current.serviceNames = [
          ...new Set([...current.serviceNames, serviceName]),
        ].sort();
        continue;
      }
      repositories.set(key, {
        defaultBranch: String(repository.defaultBranch ?? "main"),
        localPath: path.resolve(localPath),
        name: String(repository.name ?? path.basename(localPath)),
        remoteUrl: String(repository.url ?? ""),
        serviceNames: serviceName ? [serviceName] : [],
      });
    }
  }

  return [...repositories.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function runGit(cwd, args, timeoutMilliseconds = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out.`));
    }, timeoutMilliseconds);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `git ${args[0]} failed.`));
    });
  });
}

async function inspectRepository(repository) {
  const checkedAt = new Date().toISOString();
  if (!existsSync(repository.localPath)) {
    return { ...repository, checkedAt, status: "not-enlisted" };
  }
  if (!existsSync(path.join(repository.localPath, ".git"))) {
    return {
      ...repository,
      checkedAt,
      error: "The configured path is not a Git worktree.",
      status: "error",
    };
  }

  try {
    await runGit(repository.localPath, [
      "fetch",
      "--quiet",
      "--prune",
      "origin",
      repository.defaultBranch,
    ], 90_000);
    const [branch, counts, dirtyOutput, lastCommit] = await Promise.all([
      runGit(repository.localPath, ["branch", "--show-current"]),
      runGit(repository.localPath, [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...origin/${repository.defaultBranch}`,
      ]),
      runGit(repository.localPath, ["status", "--porcelain"]),
      runGit(repository.localPath, ["log", "-1", "--format=%cI"]),
    ]);
    const [ahead = 0, behind = 0] = counts
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10) || 0);
    return {
      ...repository,
      ahead,
      behind,
      branch,
      checkedAt,
      dirty: Boolean(dirtyOutput),
      lastCommit,
      status: behind > 0 ? "behind" : ahead > 0 ? "ahead" : "current",
    };
  } catch (error) {
    return {
      ...repository,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }
}

async function inspectRepositories(repositories) {
  const results = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < repositories.length) {
      const index = nextIndex++;
      results[index] = await inspectRepository(repositories[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, repositories.length) }, () => worker()),
  );
  return {
    generatedAt: new Date().toISOString(),
    repositories: results,
    summary: {
      behind: results.filter((item) => item.status === "behind").length,
      current: results.filter((item) => item.status === "current").length,
      errors: results.filter((item) => item.status === "error").length,
      notEnlisted: results.filter((item) => item.status === "not-enlisted").length,
      total: results.length,
    },
  };
}

export function localReposPlugin() {
  let repositories = [];
  let cache;

  return {
    name: "grounds-local-repos",
    apply: "serve",
    configResolved(config) {
      repositories = loadRepositories(config.root);
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        if (requestUrl.pathname !== "/__grounds/local-repos") {
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
          const requestedPath = requestUrl.searchParams.get("localPath");
          if (requestedPath) {
            const repository = repositories.find(
              (item) =>
                item.localPath.toLocaleLowerCase() ===
                path.resolve(requestedPath).toLocaleLowerCase(),
            );
            if (!repository) {
              sendJson(response, 404, {
                error: "The requested repository is not registered in Grounds.",
              });
              return;
            }
            const refreshedRepository = await inspectRepository(repository);
            if (cache) {
              cache.payload.repositories = cache.payload.repositories.map((item) =>
                item.localPath.toLocaleLowerCase() ===
                refreshedRepository.localPath.toLocaleLowerCase()
                  ? refreshedRepository
                  : item,
              );
              cache.payload.generatedAt = new Date().toISOString();
              cache.payload.summary = {
                behind: cache.payload.repositories.filter(
                  (item) => item.status === "behind",
                ).length,
                current: cache.payload.repositories.filter(
                  (item) => item.status === "current",
                ).length,
                errors: cache.payload.repositories.filter(
                  (item) => item.status === "error",
                ).length,
                notEnlisted: cache.payload.repositories.filter(
                  (item) => item.status === "not-enlisted",
                ).length,
                total: cache.payload.repositories.length,
              };
              cache.createdAt = Date.now();
            }
            sendJson(response, 200, {
              generatedAt: new Date().toISOString(),
              repository: refreshedRepository,
            });
            return;
          }

          const bypassCache = requestUrl.searchParams.get("refresh") === "true";
          if (
            !bypassCache &&
            cache &&
            Date.now() - cache.createdAt < cacheLifetimeMilliseconds
          ) {
            sendJson(response, 200, cache.payload);
            return;
          }
          const payload = await inspectRepositories(repositories);
          cache = { createdAt: Date.now(), payload };
          sendJson(response, 200, payload);
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
