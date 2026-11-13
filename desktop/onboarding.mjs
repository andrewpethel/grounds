import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createServiceRecord, parseRepositoryUrl } from "../tools/service-onboarding.mjs";
import { createServiceValidator, listServiceFiles } from "../tools/service-validation.mjs";
import { scanRepositoryConfig, serviceTreeIdPattern } from "./repository-config.mjs";

const execFileAsync = promisify(execFile);

async function git(directory, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], {
    windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000,
  });
  return stdout.trim();
}

export function normalizeRemote(remote) {
  if (remote.startsWith("git@github.com:")) {
    return `https://github.com/${remote.slice("git@github.com:".length)}`;
  }
  const azure = remote.match(/^(?:git@ssh\.dev\.azure\.com:v3\/|ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/)([^/]+)\/([^/]+)\/(.+)$/i);
  if (azure) return `https://dev.azure.com/${azure[1]}/${azure[2]}/_git/${azure[3]}`;
  return remote;
}

export async function inspectRepository(directory, onProgress, { manifestOnly = false } = {}) {
  const localPath = await fs.realpath(await git(directory, "rev-parse", "--show-toplevel"));
  const repository = parseRepositoryUrl(normalizeRemote(await git(localPath, "remote", "get-url", "origin")));
  let defaultBranch;
  const warnings = [];
  try {
    defaultBranch = (await git(localPath, "symbolic-ref", "refs/remotes/origin/HEAD")).replace(/^refs\/remotes\/origin\//, "");
  } catch (error) {
    if (error.code !== 1) throw error;
    defaultBranch = await git(localPath, "branch", "--show-current");
    if (!defaultBranch) throw new Error("Cannot determine the default branch from a detached checkout. Set origin/HEAD and retry.");
    warnings.push(`origin/HEAD is not set; review the suggested default branch (${defaultBranch}).`);
  }
  const pipelineFiles = [];
  let inspected = 0;
  async function scan(directoryPath, depth) {
    for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
      if (++inspected > 3000) return;
      if ([".git", "node_modules", "dist", "bin", "obj"].includes(entry.name)) continue;
      const filePath = path.join(directoryPath, entry.name);
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        const relative = path.relative(localPath, filePath).replaceAll(path.sep, "/");
        if (/^azure-pipelines[^/]*\.ya?ml$|^\.pipelines\/|^\.github\/workflows\//i.test(relative)) {
          pipelineFiles.push(relative);
        }
      } else if (entry.isDirectory() && depth < 2 && !entry.isSymbolicLink()) {
        await scan(filePath, depth + 1);
      }
    }
  }
  if (!manifestOnly) await scan(localPath, 0);
  if (inspected > 3000) warnings.push("Pipeline inspection reached its file limit; additional pipelines may need manual configuration.");
  return {
    ...repository, localPath, defaultBranch, pipelineFiles, warnings,
    displayName: repository.name.replace(/[-_]+/g, " "),
    ...(!manifestOnly ? { config: await scanRepositoryConfig(localPath, onProgress) } : {}),
  };
}

export async function saveWorkspace(root, input, selectedRepositories) {
  if (!input || input.confirmed !== true) throw new Error("Confirm the reviewed repository-to-service mappings.");
  if (!["public", "ussec", "usnat"].includes(input.cloud)) throw new Error("Select a supported cloud.");
  if (!Array.isArray(input.mappings) || input.mappings.length === 0 || input.mappings.length > 25) {
    throw new Error("Select between one and 25 repositories.");
  }
  if (!Array.isArray(input.services) || input.services.length === 0 || input.services.length > 100) {
    throw new Error("Review between one and 100 services.");
  }
  const groups = new Map();
  const paths = new Set();
  const checkedAt = new Date().toISOString();
  for (const mapping of input.mappings) {
    const previous = selectedRepositories.get(mapping.repositoryPath);
    if (!previous) throw new Error("Select repository folders using the Grounds folder picker.");
    if (paths.has(mapping.repositoryPath)) throw new Error("Review each repository only once.");
    paths.add(mapping.repositoryPath);
    if (mapping.confirmed !== true || !Array.isArray(mapping.services) || !mapping.services.length || mapping.services.length > 100) {
      throw new Error("Confirm at least one service association for every included repository.");
    }
    if (typeof mapping.defaultBranch !== "string" || !mapping.defaultBranch.trim()) throw new Error("Review repository default branches.");
    const repository = await inspectRepository(mapping.repositoryPath);
    if (repository.config.fingerprint !== previous.config.fingerprint ||
        repository.canonicalUrl !== previous.canonicalUrl || repository.defaultBranch !== previous.defaultBranch) {
      throw new Error(`${repository.name}: repository configuration changed. Choose the folders again to rescan and review the updated mappings.`);
    }
    const ids = new Set();
    for (const association of mapping.services) {
      if (typeof association.serviceTreeId !== "string" || !serviceTreeIdPattern.test(association.serviceTreeId)) {
        throw new Error("Every service association must use a literal Service Tree GUID.");
      }
      const serviceTreeId = association.serviceTreeId.toLowerCase();
      if (ids.has(serviceTreeId)) throw new Error("A repository contains a duplicate service association.");
      ids.add(serviceTreeId);
      const candidate = repository.config.candidates.find((item) => item.serviceTreeId === serviceTreeId);
      if (!["config", "manual"].includes(association.source) || (association.source === "config" && !candidate)) {
        throw new Error(`${repository.name}: this service association has no matching configuration evidence. Rescan or confirm it as a manual mapping.`);
      }
      const repositories = groups.get(serviceTreeId) ?? [];
      repositories.push({
        ...repository, defaultBranch: mapping.defaultBranch.trim(),
        serviceTreeMapping: {
          source: association.source, checkedAt,
          evidence: association.source === "config" ? candidate.evidence.map(({ file, field }) => ({ file, field })) : [],
        },
      });
      groups.set(serviceTreeId, repositories);
    }
  }
  if (groups.size !== input.services.length) throw new Error("Review metadata for every mapped service.");
  const validate = await createServiceValidator(root);
  const records = [];
  const names = new Set();
  const serviceIds = new Set();
  for (const service of input.services) {
    const serviceTreeId = typeof service.serviceTreeId === "string" ? service.serviceTreeId.toLowerCase() : "";
    const repositories = groups.get(serviceTreeId);
    if (!repositories || serviceIds.has(serviceTreeId)) throw new Error("Service metadata does not match the reviewed associations.");
    serviceIds.add(serviceTreeId);
    const primary = repositories[0];
    const result = createServiceRecord({
      ...service, serviceTreeId,
      defaultBranch: primary.defaultBranch, repositoryUrl: primary.canonicalUrl, pipelineFiles: primary.pipelineFiles,
    });
    const { record } = result;
    record.repositories = repositories.map((repository, index) => ({
      name: repository.name, provider: repository.provider, organization: repository.organization,
      ...(repository.project ? { project: repository.project } : {}),
      url: repository.canonicalUrl, defaultBranch: repository.defaultBranch,
      purpose: index === 0 ? "primary-source" : "other",
      checkoutStatus: "available", localPath: repository.localPath,
      serviceTreeMapping: repository.serviceTreeMapping,
    }));
    record.tags = ["desktop-onboarding"];
    if (!validate(record)) throw new Error(`Service validation failed: ${JSON.stringify(validate.errors)}`);
    if (names.has(record.service.name)) throw new Error("Each service needs a unique service identifier.");
    names.add(record.service.name);
    records.push(result);
  }
  for (const file of await listServiceFiles(root)) {
    const existing = JSON.parse(await fs.readFile(file, "utf8"));
    if (names.has(existing.service.name)) throw new Error("A service with this name already exists.");
    if (serviceIds.has(existing.service.serviceTreeId?.toLowerCase())) throw new Error("A mapped Service Tree ID is already cataloged. No existing service was overwritten.");
  }
  const setup = {
    services: records.map(({ record }) => ({ serviceName: record.service.name, serviceTreeId: record.service.serviceTreeId })),
    cloud: input.cloud,
  };
  return persistWorkspace(root, records, setup);
}

export async function persistWorkspace(root, records, setup) {
  const written = [];
  const marker = path.join(root, "onboarding.json");
  const temporary = `${marker}.${randomUUID()}.tmp`;
  try {
    let previous;
    try {
      previous = JSON.parse(await fs.readFile(marker, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const pending = previous?.services ??
      (previous ? [{ serviceName: previous.serviceName, serviceTreeId: previous.serviceTreeId }] : []);
    setup = {
      ...setup,
      id: randomUUID(),
      services: [...new Map([...pending, ...setup.services].map((service) => [service.serviceName, service])).values()],
    };
    for (const { record, domain, fileName } of records) {
      const directory = path.join(root, "services", domain);
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, fileName);
      const handle = await fs.open(file, "wx");
      written.push(file);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      } finally {
        await handle.close();
      }
    }
    const handle = await fs.open(temporary, "wx");
    written.push(temporary);
    try {
      await handle.writeFile(`${JSON.stringify(setup)}\n`);
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, marker);
  } catch (error) {
    await Promise.all(written.map((file) => fs.unlink(file)));
    throw error;
  }
  return setup;
}
