import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { getAzureCliToken } from "../tools/azure-user-auth.mjs";
import { parseRepositoryUrl } from "../tools/service-onboarding.mjs";
import { inspectRepository } from "./onboarding.mjs";

const resource = "499b84ac-1321-427f-aa17-267ca6975798";
const lifetime = 15 * 60_000;
const stages = ["build", "release"];
const normalizePath = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
const message = (error) => error instanceof Error ? error.message : String(error);
const cachePath = (root) => path.join(root, "pipeline-discovery.json");
class PipelineIdentityError extends Error {}
class PipelineTransportError extends Error {}
class PipelineHttpError extends Error {
  constructor(status, pathname) {
    super(`Azure DevOps returned ${status} for ${pathname}. Check az login and repository/pipeline read permissions.`);
    this.status = status;
  }
}

export async function readPipelineDiscovery(root) {
  try {
    if ((await fs.stat(cachePath(root))).size > 16_000_000) throw new Error("Pipeline discovery cache exceeds 16 MB.");
    const value = JSON.parse(await fs.readFile(cachePath(root), "utf8"));
    const validEntry = (entry) => entry && typeof entry.fingerprint === "string" &&
      typeof entry.attemptedAt === "string" && Number.isFinite(Date.parse(entry.attemptedAt)) &&
      Array.isArray(entry.warnings) && entry.warnings.every((warning) => typeof warning === "string") &&
      stages.every((stage) => Array.isArray(entry.pipelines?.[stage]) && entry.pipelines[stage].every((pipeline) =>
        pipeline && typeof pipeline.name === "string" && pipeline.provider === "azure-devops" &&
        typeof pipeline.url === "string" && typeof pipeline.definitionId === "string")) &&
      Array.isArray(entry.candidates) && entry.candidates.every((candidate) =>
        candidate && ["yaml", "classic-build", "classic-release"].includes(candidate.implementation) &&
        ["matched", "needs-confirmation", "unavailable"].includes(candidate.status) &&
        ["key", "name", "url", "repositoryPath", "definitionId", "reason"].every((field) => typeof candidate[field] === "string"));
    if (value.schemaVersion !== 1 || !value.services || typeof value.services !== "object" || Array.isArray(value.services) ||
        !Object.values(value.services).every(validEntry)) {
      throw new Error("Unsupported pipeline discovery cache. Remove pipeline-discovery.json and retry.");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, services: {} };
    throw error;
  }
}

async function writeCache(root, value) {
  const temporary = `${cachePath(root)}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents) > 16_000_000) throw new Error("Pipeline discovery results exceeded the 16 MB cache limit.");
  try {
    await fs.writeFile(temporary, contents, { flag: "wx" });
    await fs.rename(temporary, cachePath(root));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function inspectPipelineYaml(repositoryPath, filename, { readFile } = {}) {
  const root = readFile ? repositoryPath : await fs.realpath(repositoryPath);
  const visited = new Set();
  const tasks = [];
  let deployment = false;
  let bytes = 0;
  async function read(relative, depth) {
    const normalized = relative.replaceAll("\\", "/").replace(/^\//, "");
    if (path.win32.isAbsolute(normalized) || normalized.split("/").includes("..") ||
        normalized.includes("@") || /[:\0]/.test(normalized)) throw new Error("Pipeline YAML must be a literal repository-relative path.");
    const file = path.resolve(root, normalized.replaceAll("/", path.sep));
    const key = file.toLowerCase();
    if (visited.has(key)) return;
    if (depth > 12 || visited.size >= 50) throw new Error("Pipeline template inspection reached its limit.");
    visited.add(key);
    if (!readFile) {
      let current = root;
      for (const part of path.relative(root, file).split(path.sep)) {
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Pipeline inspection does not follow symbolic links.");
      }
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 256_000) throw new Error("Pipeline YAML must be a regular file no larger than 256 KB.");
    }
    const contents = readFile ? await readFile(normalized) : await fs.readFile(file, "utf8");
    if (typeof contents !== "string" || Buffer.byteLength(contents) > 256_000) throw new Error("Pipeline YAML is missing or larger than 256 KB.");
    bytes += Buffer.byteLength(contents);
    if (bytes > 2_000_000) throw new Error("Pipeline template inspection exceeded 2 MB.");
    const document = parseDocument(contents);
    if (document.errors.length) throw new Error(`Cannot parse ${normalized}: ${document.errors[0].message}`);
    const templates = [];
    function visit(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "deployment") deployment = true;
        if (key === "task" && typeof child === "string") tasks.push(child);
        if (key === "template" && typeof child === "string" && !child.includes("${{")) {
          if (!child.includes("@") || child.endsWith("@self")) templates.push(child.replace(/@self$/, ""));
        }
        visit(child);
      }
    }
    visit(document.toJS({ maxAliasCount: 50 }));
    for (const template of templates) {
      const relativeTemplate = template.startsWith("/")
        ? template.slice(1) : path.posix.join(path.posix.dirname(normalized), template);
      await read(relativeTemplate, depth + 1);
    }
  }
  await read(filename, 0);
  const deployTask = tasks.some((task) => /^(?:ev2|azure.*deploy|azurewebapp|azurefunctionapp|kubernetes|helmdeploy)/i.test(task));
  const buildTask = tasks.some((task) => /^(?:vsbuild|msbuild|dotnetcorecli|maven|gradle|publishbuildartifacts|publishpipelineartifact)/i.test(task));
  return { stage: deployment || deployTask ? "release" : buildTask ? "build" : null, files: visited.size };
}

function createClient({ getToken, fetch: request, signal }) {
  let token;
  const requests = new Map();
  async function get(url) {
    if (!requests.has(url)) requests.set(url, (async () => {
      signal.throwIfAborted();
      token ??= getToken(resource, { signal });
      let response;
      try {
        response = await request(url, {
          headers: { Authorization: `Bearer ${await token}`, Accept: "application/json" },
          redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
      } catch (error) {
        throw new PipelineTransportError(`Azure DevOps request failed: ${message(error)}`);
      }
      if (!response.ok) throw new PipelineHttpError(response.status, new URL(url).pathname);
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4_000_000) throw new Error("Azure DevOps response exceeded the 4 MB inspection limit.");
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        throw new PipelineTransportError(`Azure DevOps response could not be read: ${message(error)}`);
      } finally {
        await reader.cancel();
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return { value, continuation: response.headers.get("x-ms-continuationtoken") };
    })());
    return requests.get(url);
  }
  async function list(url) {
    const values = [];
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const result = await get(url);
      if (!Array.isArray(result.value.value)) throw new Error("Azure DevOps returned an invalid pipeline list.");
      values.push(...result.value.value);
      if (!result.continuation) return values;
      if (seen.has(result.continuation)) throw new Error("Azure DevOps repeated a pipeline continuation token.");
      seen.add(result.continuation);
      const next = new URL(url);
      next.searchParams.set("continuationToken", result.continuation);
      url = next.href;
    }
    throw new Error("Pipeline discovery reached its pagination limit. Narrow the repository/project scope.");
  }
  return { get, list };
}

export function pipelineSelectorMatches(selector, candidate) {
  return Boolean(
    selector?.definitionKeys?.includes(`${candidate.implementation === "classic-release" ? "release" : "build"}:${candidate.definitionId}`) ||
    selector?.names?.some((name) => name.toLowerCase() === candidate.name.toLowerCase()) ||
    selector?.namePrefixes?.some((prefix) => candidate.name.toLowerCase().startsWith(prefix.toLowerCase())) ||
    candidate.pipelineFile && selector?.yamlPaths?.some((file) => normalizePath(file) === normalizePath(candidate.pipelineFile))
  );
}

function ownership(source, candidate) {
  const selected = stages.filter((stage) => pipelineSelectorMatches(source.service.pipelineMatching?.[stage], candidate));
  if (selected.length > 1) return { stage: null, reason: "Conflicting build/release selectors. Refine this service's pipelineMatching." };
  if (selected.length) {
    if (candidate.implementation === "classic-release" && selected[0] !== "release") {
      return { stage: null, reason: "A classic release cannot be assigned a build role." };
    }
    return { stage: selected[0], reason: "Matched the service's manifest selector." };
  }
  const fileRoles = stages.filter((stage) => !source.service.pipelineMatching?.[stage] && candidate.pipelineFile &&
    source.service.pipelines?.[stage]?.some((link) => normalizePath(link.pipelineFile) === normalizePath(candidate.pipelineFile)));
  if (fileRoles.length === 1) return { stage: fileRoles[0], reason: "Matched the manifest's pipeline-file reference to a registered definition." };
  if (fileRoles.length > 1) return { stage: null, reason: "Manifest references assign this YAML file to both build and release. Refine the service's mapping." };
  if (source.serviceCount === 1 && candidate.implementation === "yaml" && candidate.stage && !source.service.pipelineMatching?.[candidate.stage]) {
    return { stage: candidate.stage, reason: "Single-service repository; role identified from YAML deployment/build steps." };
  }
  return { stage: null, reason: "Confirm the service and role; repository or Service Tree membership alone does not establish ownership or currency." };
}

function pipelineLink(candidate, source, stage) {
  const reference = source.service.pipelines?.[stage]?.find((link) =>
    link.url === candidate.url || candidate.pipelineFile && normalizePath(link.pipelineFile) === normalizePath(candidate.pipelineFile));
  return {
    ...(reference?.artifactName ? { artifactName: reference.artifactName } : {}),
    ...(reference?.environments ? { environments: reference.environments } : {}),
    ...(reference?.description ? { description: reference.description } : {}),
    name: candidate.name, provider: "azure-devops", definitionId: candidate.definitionId, url: candidate.url,
    ...(candidate.pipelineFile ? { pipelineFile: candidate.pipelineFile } : {}),
  };
}

async function inspectRemote(source, client) {
  const repository = parseRepositoryUrl(source.repository.url);
  if (repository.provider !== "azure-devops") return { candidates: [], errors: ["Automatic pipeline verification currently supports Azure DevOps repositories. Manifest links remain unverified references."] };
  const checkout = await inspectRepository(source.repository.localPath, undefined, { manifestOnly: true });
  if (checkout.canonicalUrl.toLowerCase() !== repository.canonicalUrl.toLowerCase()) throw new PipelineIdentityError("The checkout's Git origin no longer matches this service's repository.");
  const scope = `${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.project)}`;
  const base = `https://dev.azure.com/${scope}`;
  const remote = (await client.get(`${base}/_apis/git/repositories/${encodeURIComponent(repository.name)}?api-version=7.1`)).value;
  if (!remote.id || !remote.project?.id || remote.name?.toLowerCase() !== repository.name.toLowerCase()) {
    throw new PipelineIdentityError("Azure DevOps repository identity could not be verified.");
  }
  const query = new URLSearchParams({
    repositoryId: remote.id, repositoryType: "TfsGit", includeAllProperties: "true", "$top": "100", "api-version": "7.1",
  });
  const definitions = await client.list(`${base}/_apis/build/definitions?${query}`);
  const candidates = [];
  const errors = [];
  const buildIds = new Set();
  for (const summary of definitions) {
    const definition = summary.process && summary.repository ? summary :
      (await client.get(`${base}/_apis/build/definitions/${encodeURIComponent(summary.id)}?api-version=7.1`)).value;
    if (String(definition.repository?.id).toLowerCase() !== String(remote.id).toLowerCase()) continue;
    buildIds.add(String(definition.id));
    if (!Number.isSafeInteger(definition.id) || !definition.name) throw new Error("Azure DevOps returned an invalid build definition.");
    const yaml = definition.process?.type === 2;
    const candidate = {
      key: `${source.repository.localPath}|${scope}:build:${definition.id}`, name: definition.name, definitionId: String(definition.id),
      repositoryPath: source.repository.localPath, implementation: yaml ? "yaml" : "classic-build",
      url: `${base}/_build?definitionId=${definition.id}`,
      pipelineFile: yaml ? definition.process.yamlFilename : undefined,
      stage: null, status: "needs-confirmation", reason: "",
    };
    if (definition.isDeleted || definition.queueStatus !== "enabled") {
      candidate.status = "unavailable";
      candidate.reason = `Definition is deleted, disabled, paused, or its queue status could not be verified (${definition.queueStatus ?? "unknown"}).`;
    } else if (yaml) {
      try {
        if (!candidate.pipelineFile) throw new Error("The registered YAML path is missing.");
        const branch = definition.repository.defaultBranch;
        if (!branch?.startsWith("refs/heads/")) throw new Error("The definition's registered branch could not be verified.");
        candidate.stage = (await inspectPipelineYaml(source.repository.localPath, candidate.pipelineFile, {
          readFile: async (file) => {
            const parameters = new URLSearchParams({
              path: `/${file}`, includeContent: "true", "versionDescriptor.versionType": "branch",
              "versionDescriptor.version": branch.slice("refs/heads/".length), "api-version": "7.1",
            });
            return (await client.get(`${base}/_apis/git/repositories/${encodeURIComponent(remote.id)}/items?${parameters}`)).value.content;
          },
        })).stage;
      } catch (error) {
        candidate.status = "unavailable";
        candidate.reason = `YAML inspection failed: ${message(error)}`;
        if (error instanceof PipelineTransportError || error instanceof PipelineHttpError && error.status !== 404) {
          candidate.transient = true;
          errors.push(`${candidate.name}: ${candidate.reason}`);
        }
      }
    }
    candidates.push(candidate);
  }
  const releases = new Map();
  let classicFailed = false;
  const artifactScopes = [...buildIds].map((id) => ({ artifactType: "Build", artifactSourceId: `${remote.project.id}:${id}` }));
  artifactScopes.push({ artifactType: "Git", artifactSourceId: `${remote.project.id}:${remote.id}` });
  for (const artifactScope of artifactScopes) {
    try {
      const parameters = new URLSearchParams({ ...artifactScope, "$expand": "artifacts", "$top": "100", "api-version": "7.1" });
      const definitions = await client.list(`https://vsrm.dev.azure.com/${scope}/_apis/release/definitions?${parameters}`);
      for (const definition of definitions) releases.set(definition.id, definition);
    } catch (error) {
      classicFailed = true;
      errors.push(`Classic release discovery failed (${artifactScope.artifactType}): ${message(error)}`);
    }
  }
  for (const definition of releases.values()) {
      const associated = definition.artifacts?.some((artifact) => {
        const reference = artifact.definitionReference;
        if (artifact.type === "Build") return reference?.project?.id?.toLowerCase() === remote.project.id.toLowerCase() && buildIds.has(String(reference?.definition?.id));
        return artifact.type === "Git" && String(reference?.definition?.id).toLowerCase() === String(remote.id).toLowerCase();
      });
      if (!associated) continue;
      if (!Number.isSafeInteger(definition.id) || !definition.name) throw new Error("Azure DevOps returned an invalid classic release definition.");
      candidates.push({
        key: `${source.repository.localPath}|${scope}:release:${definition.id}`, name: definition.name, definitionId: String(definition.id),
        repositoryPath: source.repository.localPath, implementation: "classic-release", stage: "release",
        url: `${base}/_release?definitionId=${definition.id}`,
        status: definition.isDeleted ? "unavailable" : "needs-confirmation",
        reason: definition.isDeleted ? "Classic release definition was deleted." : "",
      });
  }
  return { candidates, errors, classicFailed };
}

export async function discoverPipelines(root, inputs, { force = false, getToken = getAzureCliToken, fetch: request = globalThis.fetch, signal = AbortSignal.timeout(240_000) } = {}) {
  const previous = await readPipelineDiscovery(root);
  const result = { schemaVersion: 1, services: {} };
  const client = createClient({ getToken, fetch: request, signal });
  const remotes = new Map();
  for (const input of inputs) {
    signal.throwIfAborted();
    const old = previous.services[input.serviceName];
    const same = old?.fingerprint && old.fingerprint === input.fingerprint;
    if (!force && same && !old.error && Date.now() - Date.parse(old.attemptedAt) < lifetime) {
      result.services[input.serviceName] = old;
      continue;
    }
    signal.throwIfAborted();
    const entry = {
      fingerprint: input.fingerprint ?? "", attemptedAt: new Date().toISOString(),
      ...(same && old.checkedAt ? { checkedAt: old.checkedAt } : {}),
      candidates: [], pipelines: { build: [], release: [] }, warnings: [],
    };
    const failures = [];
    const cached = [];
    if (input.error) failures.push(input.error);
    for (const source of input.sources ?? []) {
      try {
        const key = JSON.stringify([source.repository.localPath, source.repository.url]);
        if (!remotes.has(key)) remotes.set(key, inspectRemote(source, client));
        const remote = await remotes.get(key);
        failures.push(...remote.errors);
        if (same && remote.errors.length) cached.push(...old.candidates.filter((candidate) =>
          candidate.repositoryPath === source.repository.localPath && candidate.status === "matched" &&
          (remote.classicFailed && candidate.implementation === "classic-release" ||
            remote.candidates.some((fresh) => fresh.url === candidate.url && fresh.transient))));
        for (const discovered of remote.candidates) {
          const candidate = { ...discovered };
          if (candidate.status !== "unavailable") {
            const match = ownership(source, candidate);
            candidate.reason = match.reason;
            if (match.stage) {
              candidate.stage = match.stage;
              candidate.status = "matched";
              entry.pipelines[match.stage].push(pipelineLink(candidate, source, match.stage));
            }
          }
          entry.candidates.push(candidate);
        }
        for (const stage of stages) for (const link of source.service.pipelines?.[stage] ?? []) {
          if (!entry.candidates.some((candidate) => candidate.status === "matched" && candidate.url === link.url)) {
            entry.warnings.push(`${link.name}: configured link is not a verified, selected definition. It remains an unverified reference.`);
          }
        }
      } catch (error) {
        failures.push(`${source.repository.name}: ${message(error)}`);
        if (same && !(error instanceof PipelineIdentityError)) cached.push(...old.candidates.filter((candidate) =>
          candidate.repositoryPath === source.repository.localPath && candidate.status === "matched"));
      }
    }
    const retained = cached.filter((candidate) => !entry.candidates.some((fresh) => fresh.url === candidate.url && !fresh.transient));
    entry.candidates = entry.candidates.filter((candidate) => !candidate.transient || !retained.some((old) => old.url === candidate.url));
    entry.candidates.push(...retained.map((candidate) => ({ ...candidate, cached: true })));
    for (const stage of stages) {
      const links = new Map(entry.pipelines[stage].map((pipeline) => [pipeline.url, pipeline]));
      if (failures.length && same) for (const pipeline of old.pipelines[stage]) {
        if (retained.some((candidate) => candidate.url === pipeline.url)) links.set(pipeline.url, pipeline);
      }
      entry.pipelines[stage] = [...links.values()].sort((left, right) => left.url.localeCompare(right.url));
    }
    if (failures.length) entry.error = `${[...new Set(failures)].join(" ")} Previously verified links, if present, are retained as cached results; no historical link is substituted.`;
    else entry.checkedAt = entry.attemptedAt;
    entry.warnings = [...new Set(entry.warnings)];
    result.services[input.serviceName] = entry;
  }
  await writeCache(root, result);
  return result;
}
