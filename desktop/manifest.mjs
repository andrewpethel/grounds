import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { inspectRepository, persistWorkspace } from "./onboarding.mjs";
import { createServiceRecord } from "../tools/service-onboarding.mjs";
import { createServiceValidator, listServiceFiles, toSourcePath } from "../tools/service-validation.mjs";
import { pipelineSelectorMatches } from "./pipeline-discovery.mjs";

export const manifestName = "GroundsManifest.json";
const schema = JSON.parse(await fs.readFile(new URL("../grounds_manifest_schema.json", import.meta.url), "utf8"));
const serviceSchema = JSON.parse(await fs.readFile(new URL("../service_schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(serviceSchema, "service_schema.json");
const validate = ajv.compile(schema);

function normalizePipelines(pipelines = {}) {
  return Object.fromEntries(["build", "release"].map((stage) => [stage, (pipelines[stage] ?? []).map((pipeline) => {
    const url = new URL(pipeline.url);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw new Error("Pipeline links must be HTTPS URLs without embedded credentials.");
    }
    const definitionId = pipeline.provider === "azure-devops" ? url.searchParams.get("definitionId") : null;
    if (definitionId && pipeline.definitionId !== undefined && String(pipeline.definitionId) !== definitionId) {
      throw new Error(`${pipeline.name}: definitionId does not match the pipeline link.`);
    }
    return {
      ...pipeline, name: pipeline.name.trim(), url: url.href,
      ...(definitionId ? { definitionId } : {}),
    };
  })]));
}

function mergePipelines(declarations) {
  const merged = { build: [], release: [] };
  for (const stage of ["build", "release"]) {
    const links = new Map();
    for (const declaration of declarations) {
      for (const pipeline of declaration.pipelines?.[stage] ?? []) {
        const key = `${pipeline.provider}:${pipeline.url}`;
        const previous = links.get(key);
        if (previous && Object.keys({ ...previous, ...pipeline })
          .some((field) => JSON.stringify(previous[field]) !== JSON.stringify(pipeline[field]))) {
          throw new Error(`Conflicting ${stage} pipeline metadata for ${pipeline.url}. Keep one consistent declaration per link.`);
        }
        links.set(key, pipeline);
      }
    }
    merged[stage] = [...links.values()].sort((left, right) => left.url.localeCompare(right.url));
  }
  return merged;
}

export function validateManifest(value) {
  if (!validate(value)) throw new Error(`Invalid ${manifestName}: ${JSON.stringify(validate.errors)}`);
  const names = new Set();
  return {
    schemaVersion: 1,
    services: value.services.map((service) => {
      if (names.has(service.name)) throw new Error(`Duplicate service key: ${service.name}.`);
      names.add(service.name);
      const sourcePaths = service.sourcePaths?.map((source) => {
        const relative = source.replaceAll("\\", "/");
        if (path.win32.isAbsolute(source) || relative.split("/").includes("..") ||
            /[:*?[\]\0]/.test(relative) || relative.startsWith("/") ||
            relative.split("/").some((part) => !part || part.endsWith(".") && part !== "." || part.endsWith(" "))) {
          throw new Error(`${service.name}: sourcePaths must be literal repository-relative paths without traversal or globs.`);
        }
        return relative;
      });
      return {
        ...service, displayName: service.displayName.trim(), serviceTreeId: service.serviceTreeId.toLowerCase(),
        ...(service.domain ? { domain: service.domain.trim() } : {}),
        ...(service.description ? { description: service.description.trim() } : {}),
        ...(sourcePaths ? { sourcePaths } : {}),
        ...(service.pipelineMatching ? {
          pipelineMatching: Object.fromEntries(Object.entries(service.pipelineMatching).map(([stage, selector]) => [
            stage, Object.fromEntries(Object.entries(selector).map(([field, entries]) => [field, [...new Set(entries.map((entry) => {
              const value = entry.trim();
              if (field === "yamlPaths") {
                const relative = value.replaceAll("\\", "/");
                if (path.win32.isAbsolute(value) || relative.split("/").includes("..") || /[:*?[\]\0]/.test(relative)) {
                  throw new Error(`${service.name}: pipelineMatching.yamlPaths must be literal repository-relative paths.`);
                }
                return relative;
              }
              return value;
            }))]])),
          ])),
        } : {}),
        ...(service.pipelines ? { pipelines: normalizePipelines(service.pipelines) } : {}),
        ...(service.deploymentMatching ? {
          deploymentMatching: Object.fromEntries(Object.entries(service.deploymentMatching)
            .map(([key, entries]) => [key, [...new Set(entries.map((entry) => entry.trim()))].sort()])),
        } : {}),
      };
    }),
  };
}

async function readManifestDocument(directory) {
  const file = path.join(directory, manifestName);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) {
    throw new Error(`${manifestName} must be a regular file no larger than 256 KB.`);
  }
  const contents = await fs.readFile(file, "utf8");
  if (Buffer.byteLength(contents) > 256_000) throw new Error(`${manifestName} must be no larger than 256 KB.`);
  const value = JSON.parse(contents);
  return { contents, value, manifest: validateManifest(value) };
}

async function readManifest(directory) {
  return (await readManifestDocument(directory))?.manifest ?? null;
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function identity(service) {
  return JSON.stringify({
    name: service.name, displayName: service.displayName, serviceTreeId: service.serviceTreeId,
    description: service.description ?? service.displayName,
    domain: service.domain ?? service.displayName,
    deploymentMatching: {
      serviceGroupNames: service.deploymentMatching?.serviceGroupNames,
      serviceGroupNameContains: service.deploymentMatching?.serviceGroupNameContains,
    },
  });
}

export async function discoverManifests(directory, existing = []) {
  const root = await fs.realpath(directory);
  const directories = [];
  const diagnostics = [];
  if (await exists(path.join(root, ".git"))) {
    directories.push(root);
  } else {
    const children = await fs.readdir(root, { withFileTypes: true });
    if (children.length > 3000) throw new Error("This folder has more than 3,000 entries. Choose a narrower repositories folder.");
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!child.isDirectory() || child.isSymbolicLink() || [".git", "node_modules", "dist", "release"].includes(child.name)) continue;
      const candidate = path.join(root, child.name);
      if (await exists(path.join(candidate, ".git"))) directories.push(candidate);
    }
  }
  if (directories.length > 100) throw new Error("This folder has more than 100 repositories. Choose a narrower folder.");
  const repositories = [];
  const services = new Map();
  for (const localPath of directories) {
    const row = { localPath, name: path.basename(localPath), manifest: null };
    repositories.push(row);
    try {
      row.manifest = await readManifest(localPath);
      if (!row.manifest) continue;
      row.repository = await inspectRepository(localPath, undefined, { manifestOnly: true });
      row.defaultBranch = row.repository.defaultBranch;
      row.warnings = row.repository.warnings;
      for (const service of row.manifest.services) {
        const entry = services.get(service.name);
        if (entry) {
          entry.repositories.push(localPath);
          if (identity(entry) !== identity(service)) entry.error = "Conflicting metadata across repository manifests. Make the service name, display name, Service Tree ID, description, domain, and deployment selectors agree.";
          try {
            entry.pipelines = mergePipelines([entry, service]);
          } catch (error) {
            entry.error = error.message;
          }
        } else {
          services.set(service.name, { ...service, pipelines: mergePipelines([service]), repositories: [localPath] });
        }
      }
    } catch (error) {
      row.error = error.message;
    }
  }
  for (const service of services.values()) {
    const record = existing.find((record) => record.service.name === service.name);
    service.added = Boolean(record);
    if (record && (record.service.serviceTreeId?.toLowerCase() !== service.serviceTreeId ||
        record.service.displayName !== service.displayName)) {
      service.error = "This service key already exists with a different name or Service Tree association. Existing records were not changed.";
    }
  }
  if (!directories.length) diagnostics.push("No Git repositories found. Choose a repository itself or a folder containing immediate child repositories.");
  return { root, repositories, services: [...services.values()], diagnostics };
}

export async function createManifest(directory, value, addToGitignore) {
  const manifest = validateManifest(value);
  const real = await fs.realpath(directory);
  const repository = await inspectRepository(real, undefined, { manifestOnly: true });
  if (repository.localPath !== real) throw new Error("Create the manifest at the repository root.");
  const file = path.join(real, manifestName);
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(contents) > 256_000) throw new Error(`${manifestName} must be no larger than 256 KB.`);
  await fs.writeFile(file, contents, { flag: "wx" });
  if (addToGitignore) {
    try {
      const ignoreFile = path.join(real, ".gitignore");
      let current = "";
      try {
        const stat = await fs.lstat(ignoreFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error(".gitignore must be a regular file no larger than 1 MB.");
        current = await fs.readFile(ignoreFile, "utf8");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!current.split(/\r?\n/).includes(`/${manifestName}`)) {
        await fs.appendFile(ignoreFile, `${current && !current.endsWith("\n") ? "\n" : ""}/${manifestName}\n`);
      }
    } catch (error) {
      await fs.unlink(file);
      throw error;
    }
  }
  return manifest;
}

export async function saveManifestWorkspace(root, input, catalog) {
  if (!catalog || !input || !Array.isArray(input.serviceNames) || !input.serviceNames.length ||
      input.serviceNames.length > 100 || new Set(input.serviceNames).size !== input.serviceNames.length) {
    throw new Error("Select between one and 100 available services.");
  }
  if (!["public", "ussec", "usnat"].includes(input.cloud)) throw new Error("Select a supported cloud.");
  const existing = [];
  for (const file of await listServiceFiles(root)) existing.push(JSON.parse(await fs.readFile(file, "utf8")));
  const fresh = await discoverManifests(catalog.root, existing);
  const records = [];
  const validateRecord = await createServiceValidator(root);
  for (const name of input.serviceNames) {
    const previous = catalog.services.find((service) => service.name === name);
    const service = fresh.services.find((service) => service.name === name);
    if (!previous || !service || identity(previous) !== identity(service) ||
        JSON.stringify(previous.repositories) !== JSON.stringify(service.repositories) ||
        service.repositories.some((localPath) => {
          const before = catalog.repositories.find((row) => row.localPath === localPath);
          const after = fresh.repositories.find((row) => row.localPath === localPath);
          return JSON.stringify(before?.manifest) !== JSON.stringify(after?.manifest) ||
            before?.repository?.canonicalUrl !== after?.repository?.canonicalUrl ||
            before?.repository?.defaultBranch !== after?.repository?.defaultBranch;
        })) throw new Error(`${name}: repository or manifest changed. Rescan before opening the workspace.`);
    if (service.error) throw new Error(`${name}: ${service.error}`);
    if (service.added) throw new Error(`${name}: service already exists. Existing records were not changed.`);
    const repositories = service.repositories.map((localPath) => fresh.repositories.find((row) => row.localPath === localPath));
    const primary = repositories[0].repository;
    const result = createServiceRecord({
      serviceName: service.name, displayName: service.displayName,
      description: service.description ?? service.displayName, serviceTreeId: service.serviceTreeId,
      domain: service.domain, defaultBranch: primary.defaultBranch, repositoryUrl: primary.canonicalUrl,
    });
    if (service.deploymentMatching) result.record.service.deploymentMatching = service.deploymentMatching;
    result.record.pipelines = service.pipelines;
    result.record.repositories = repositories.map(({ repository, manifest }, index) => {
      const declaration = manifest.services.find((entry) => entry.name === name);
      return {
        name: repository.name, provider: repository.provider, organization: repository.organization,
        ...(repository.project ? { project: repository.project } : {}),
        url: repository.canonicalUrl, defaultBranch: repository.defaultBranch,
        purpose: index === 0 ? "primary-source" : "other",
        checkoutStatus: "available", localPath: repository.localPath,
        ...(declaration.sourcePaths ? { paths: declaration.sourcePaths } : {}),
        serviceTreeMapping: {
          source: "manifest", checkedAt: new Date().toISOString(),
          evidence: [{ file: manifestName, field: `/services/${manifest.services.indexOf(declaration)}/serviceTreeId` }],
        },
      };
    });
    result.record.tags = ["desktop-onboarding"];
    if (!validateRecord(result.record)) throw new Error(`Service validation failed: ${JSON.stringify(validateRecord.errors)}`);
    records.push(result);
  }

  return persistWorkspace(root, records, {
    services: records.map(({ record }) => ({ serviceName: record.service.name, serviceTreeId: record.service.serviceTreeId })),
    cloud: input.cloud,
  });
}

async function manifestPipelineSources(record) {
  const sources = [];
  for (const repository of record.repositories.filter((entry) => entry.serviceTreeMapping?.source === "manifest")) {
    if (!repository.localPath) throw new Error(`${repository.name}: the manifest repository has no local checkout.`);
    const document = await readManifestDocument(repository.localPath);
    if (!document) throw new Error(`${repository.name}: ${manifestName} is missing.`);
    const service = document.manifest.services.find((entry) => entry.name === record.service.name);
    if (!service || service.serviceTreeId !== record.service.serviceTreeId?.toLowerCase() ||
        service.displayName !== record.service.displayName) {
      throw new Error(`${repository.name}: the manifest service identity no longer matches this workspace.`);
    }
    if (sources.length && identity(service) !== identity(sources[0].service)) {
      throw new Error("Conflicting service metadata across repository manifests.");
    }
    sources.push({ repository, file: path.join(repository.localPath, manifestName), service, ...document });
  }
  return sources;
}

export const pipelineSourcesFingerprint = (sources) => createHash("sha256")
  .update(JSON.stringify(sources.map(({ contents, repository }) => [contents, repository.localPath, repository.url]))).digest("hex");

export async function readPipelineInputs(root) {
  const inputs = [];
  for (const file of await listServiceFiles(root)) {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (!record.repositories.some((repository) => repository.serviceTreeMapping?.source === "manifest")) continue;
    try {
      const sources = await manifestPipelineSources(record);
      inputs.push({
        serviceName: record.service.name, fingerprint: pipelineSourcesFingerprint(sources),
        sources: sources.map(({ repository, service, manifest }) => ({
          repository, service, serviceCount: manifest.services.length,
        })),
      });
    } catch (error) {
      inputs.push({ serviceName: record.service.name, error: error.message });
    }
  }
  return inputs;
}

export async function refreshManifestPipelines(root, resolutions = {}, { verifiedOnly = false } = {}) {
  const errors = {};
  const validateRecord = await createServiceValidator(root);
  for (const file of await listServiceFiles(root)) {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (!validateRecord(record)) {
      errors[toSourcePath(root, file)] = `Cannot refresh an invalid service record: ${JSON.stringify(validateRecord.errors)}`;
      continue;
    }
    try {
      const sources = await manifestPipelineSources(record);
      if (!sources.length) continue;
      const resolution = resolutions[record.service.name];
      const pipelines = resolution?.fingerprint === pipelineSourcesFingerprint(sources)
        ? resolution.pipelines : verifiedOnly ? { build: [], release: [] } : mergePipelines(sources.map((source) => source.service));
      if (JSON.stringify(record.pipelines) === JSON.stringify(pipelines)) continue;
      record.pipelines = pipelines;
      record.lastUpdated = new Date().toISOString();
      if (!validateRecord(record)) throw new Error(`Invalid pipeline record: ${JSON.stringify(validateRecord.errors)}`);
      await writeJsonAtomically(file, record);
    } catch (error) {
      errors[toSourcePath(root, file)] = `Manifest pipeline refresh failed; previously saved links are retained. ${error.message}`;
    }
  }
  return errors;
}

async function writeJsonAtomically(file, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (path.basename(file) === manifestName && Buffer.byteLength(contents) > 256_000) {
    throw new Error(`${manifestName} must be no larger than 256 KB.`);
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function findManifestService(root, serviceName) {
  for (const file of await listServiceFiles(root)) {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (record.service.name === serviceName) return record;
  }
  throw new Error("Unknown workspace service.");
}

const revisionOf = (contents) => createHash("sha256").update(contents).digest("hex");

export async function readManifestPipelines(root, serviceName) {
  const sources = await manifestPipelineSources(await findManifestService(root, serviceName));
  if (!sources.length) throw new Error("This service was not onboarded from a repository manifest.");
  return sources.map(({ repository, service, contents }) => ({
    repositoryPath: repository.localPath, name: repository.name,
    pipelines: normalizePipelines(service.pipelines), revision: revisionOf(contents),
  }));
}

export async function updateManifestPipelines(root, input) {
  if (!input || typeof input.previousRevision !== "string") throw new Error("Reload the manifest before editing pipeline links.");
  const sources = await manifestPipelineSources(await findManifestService(root, input.serviceName));
  const source = sources.find(({ repository }) => repository.localPath === input.repositoryPath);
  if (!source) throw new Error("Choose a manifest repository associated with this service.");
  if (revisionOf(source.contents) !== input.previousRevision) throw new Error("The manifest changed. Reload it before saving pipeline links.");
  const service = source.value.services.find((entry) => entry.name === input.serviceName);
  if (!input.pipelines || typeof input.pipelines !== "object") throw new Error("Supply build and release pipeline links.");
  service.pipelines = input.pipelines;
  const updated = validateManifest(source.value).services.find((entry) => entry.name === input.serviceName);
  mergePipelines(sources.map((entry) => entry === source ? updated : entry.service));
  service.pipelines = updated.pipelines;
  if (await fs.readFile(source.file, "utf8") !== source.contents) {
    throw new Error("The manifest changed. Reload it before saving pipeline links.");
  }
  await writeJsonAtomically(source.file, source.value);
}

export async function confirmManifestPipeline(root, input, candidate, fingerprint) {
  if (!["build", "release"].includes(input?.stage) || candidate.status === "unavailable" || candidate.cached ||
      candidate.implementation === "classic-release" && input.stage !== "release") {
    throw new Error("Choose an available pipeline and a supported role.");
  }
  const sources = await manifestPipelineSources(await findManifestService(root, input.serviceName));
  if (pipelineSourcesFingerprint(sources) !== fingerprint) throw new Error("The manifest changed. Refresh pipeline discovery before confirming.");
  const source = sources.find(({ repository }) => repository.localPath === candidate.repositoryPath);
  if (!source) throw new Error("This pipeline is not associated with a manifest repository for the service.");
  const service = source.value.services.find((entry) => entry.name === input.serviceName);
  const opposite = input.stage === "build" ? "release" : "build";
  if (pipelineSelectorMatches(service.pipelineMatching?.[opposite], candidate)) {
    throw new Error(`This pipeline also matches the ${opposite} selector. Refine pipelineMatching in GroundsManifest.json before assigning another role.`);
  }
  service.pipelineMatching ??= {};
  service.pipelineMatching[input.stage] ??= {};
  const selector = service.pipelineMatching[input.stage];
  const definitionKey = `${candidate.implementation === "classic-release" ? "release" : "build"}:${candidate.definitionId}`;
  selector.definitionKeys = [...new Set([...(selector.definitionKeys ?? []), definitionKey])];
  validateManifest(source.value);
  if (await fs.readFile(source.file, "utf8") !== source.contents) throw new Error("The manifest changed. Refresh before confirming.");
  await writeJsonAtomically(source.file, source.value);
}
