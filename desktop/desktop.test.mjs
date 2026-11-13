import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeData, createBackend, readSnapshot } from "./backend.mjs";
import { inspectRepository, normalizeRemote, saveWorkspace } from "./onboarding.mjs";
import { scanRepositoryConfig } from "./repository-config.mjs";
import { validateRequest } from "./transport.mjs";
import { createServiceRecord } from "../tools/service-onboarding.mjs";

const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grounds-desktop-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeData(root, resources);
  return root;
}

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const unrelatedId = "33333333-3333-4333-8333-333333333333";

async function repository(root, name, config = { serviceTreeId: firstId }) {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  await exec("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await exec("git", ["-C", directory, "remote", "add", "origin", `https://github.com/grounds-fixture/${name}.git`]);
  await exec("git", ["-C", directory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await fs.writeFile(path.join(directory, "azure-pipelines.yml"), "steps: []\n");
  if (config) await fs.writeFile(path.join(directory, "service.json"), JSON.stringify(config));
  return inspectRepository(directory);
}

const allowedRepositories = (repositories) => new Map(repositories.map((repository) => [repository.localPath, repository]));
function workspaceInput(repositories) {
  const ids = [...new Set(repositories.flatMap((repository) => repository.config.candidates.map((item) => item.serviceTreeId)))];
  return {
    confirmed: true, cloud: "public",
    services: ids.map((serviceTreeId, index) => ({
      serviceTreeId, serviceName: `fixture-service-${index + 1}`, displayName: `Fixture Service ${index + 1}`,
      description: "A sanitized desktop onboarding fixture.", serviceGroupPatterns: "fixture",
    })),
    mappings: repositories.map((repository) => ({
      repositoryPath: repository.localPath, defaultBranch: repository.defaultBranch, confirmed: true,
      services: repository.config.candidates.map(({ serviceTreeId }) => ({ serviceTreeId, source: "config" })),
    })),
  };
}

test("desktop request boundary rejects arbitrary URLs, methods, and oversized bodies", () => {
  assert.equal(validateRequest({ path: "/__grounds/local-repos?refresh=true", method: "GET" }).path, "/__grounds/local-repos?refresh=true");
  for (const input of [
    { path: "https://example.com/__grounds/local-repos", method: "GET" },
    { path: "/__grounds/../package.json", method: "GET" },
    { path: "/__grounds/local-repos", method: "PATCH" },
    { path: "/__grounds/local-repos", method: "POST", body: "x".repeat(250001) },
    { path: "/__grounds/work/notes", method: "POST", body: {} },
  ]) assert.throws(() => validateRequest(input));
});

test("SSH repository remotes normalize to supported HTTPS catalog URLs", () => {
  assert.equal(normalizeRemote("git@github.com:org/repo.git"), "https://github.com/org/repo.git");
  assert.equal(normalizeRemote("git@ssh.dev.azure.com:v3/org/project/repo"), "https://dev.azure.com/org/project/_git/repo");
  assert.equal(normalizeRemote("ssh://git@ssh.dev.azure.com/v3/org/project/repo"), "https://dev.azure.com/org/project/_git/repo");
});

test("fresh desktop data excludes existing private catalogs and preserves user records on initialization", async (t) => {
  const root = await workspace(t);
  const snapshot = await readSnapshot(root);
  assert.equal(snapshot.catalogEntries.length, 0);
  assert.deepEqual(snapshot.ev2ServiceGroupData.observations, []);
  assert.deepEqual(snapshot.srmObservationData.releases, []);
  assert.deepEqual(snapshot.teamsIntelligenceSnapshot.signals, []);
  const file = path.join(root, "intelligence", "ev2", "service-groups.json");
  const value = { schemaVersion: "1.0.0", generatedAt: new Date().toISOString(), observations: [] };
  await fs.writeFile(file, JSON.stringify(value));
  await initializeData(root, resources);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), value);
});

test("fresh initialization never imports sample operational data from bundled templates", async (t) => {
  const root = await workspace(t);
  const templates = path.join(root, "templates");
  const fresh = path.join(root, "fresh");
  await fs.mkdir(templates);
  for (const name of [
    "service_schema.json", "ev2_service_groups_schema.json", "srm_observations_schema.json",
    "teams_intelligence_schema.json", "troubleshooting_schema.json",
  ]) await fs.copyFile(path.join(resources, name), path.join(templates, name));
  for (const name of ["ev2/service-groups", "srm/release-observations", "teams/deployment-signals"]) {
    const file = path.join("intelligence", `${name}.example.json`);
    await fs.mkdir(path.dirname(path.join(templates, file)), { recursive: true });
    await fs.copyFile(path.join(resources, file), path.join(templates, file));
  }
  await fs.writeFile(path.join(templates, "intelligence", "ev2", "service-groups.example.json"), JSON.stringify({
    schemaVersion: "1.0.0", observations: [{ serviceTreeId: firstId }],
  }));
  await initializeData(fresh, templates);
  const snapshot = await readSnapshot(fresh);
  assert.equal(snapshot.catalogEntries.length, 0);
  assert.deepEqual(snapshot.ev2ServiceGroupData.observations, []);
  assert.deepEqual(snapshot.srmObservationData.releases, []);
  assert.deepEqual(snapshot.teamsIntelligenceSnapshot.signals, []);
});

test("onboarding groups IDs and persists confirmed many-to-many mappings with evidence", async (t) => {
  const root = await workspace(t);
  const repositories = [
    await repository(root, "shared", { services: [{ serviceTreeId: firstId }, { serviceTreeId: secondId }] }),
    await repository(root, "support"),
    await repository(root, "different", { serviceTreeId: secondId }),
  ];
  assert.deepEqual(repositories[0].pipelineFiles, ["azure-pipelines.yml"]);
  const allowed = allowedRepositories(repositories);
  const input = workspaceInput(repositories);
  await assert.rejects(saveWorkspace(root, input, new Map()), /folder picker/);
  await assert.rejects(saveWorkspace(root, { ...input, confirmed: false }, allowed), /Confirm/);
  input.mappings[0].confirmed = false;
  await assert.rejects(saveWorkspace(root, input, allowed), /Confirm/);
  input.mappings[0].confirmed = true;
  const setup = await saveWorkspace(root, input, allowed);
  assert.equal(setup.services.length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "onboarding.json"), "utf8")), setup);
  const snapshot = await readSnapshot(root);
  assert.equal(snapshot.catalogEntries.length, 2);
  for (const entry of snapshot.catalogEntries) {
    assert.match(entry.sourcePath, /services\/fixture-service-[12]\//);
    assert.equal(entry.record.repositories.length, 2);
    assert.equal(entry.record.repositories[0].checkoutStatus, "available");
    assert.equal(entry.record.repositories[0].serviceTreeMapping.source, "config");
    assert.equal(entry.record.repositories[0].serviceTreeMapping.evidence[0].file, "service.json");
    assert.match(entry.record.repositories[0].serviceTreeMapping.checkedAt, /^\d{4}-/);
  }
  assert.equal(snapshot.catalogEntries[0].record.repositories[0].url, snapshot.catalogEntries[1].record.repositories[0].url);
  await assert.rejects(saveWorkspace(root, input, allowed), /already exists/);
});

test("config scanning uses parsed explicit fields and ignores unrelated and dependency GUIDs", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "evidence", null);
  const files = {
    "ServiceModel.json": JSON.stringify({
      serviceMetadata: { serviceIdentifier: firstId, displayName: "Fixture EV2", buildout: { dependencies: [{ serviceIdentifier: unrelatedId }] } },
      serviceId: unrelatedId, subscriptionId: unrelatedId, dependencies: { serviceTreeId: unrelatedId },
    }),
    "settings.jsonc": `// Comment\n{"ServiceTree": {"Id": "${firstId}"},}`,
    "ownership.yml": `component:\n  SERVICE_TREE_GUID: ${secondId}\n`,
    "tests/fixture.json": JSON.stringify({ serviceTreeId: unrelatedId }),
    "docs/example.json": JSON.stringify({ serviceTreeId: unrelatedId }),
    "private.json": JSON.stringify({ serviceTreeId: unrelatedId }),
    ".gitignore": "private.json\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo.localPath, name)), { recursive: true });
    await fs.writeFile(path.join(repo.localPath, name), content);
  }
  const progress = [];
  const scan = await scanRepositoryConfig(repo.localPath, (event) => progress.push(event));
  assert.deepEqual(scan.candidates.map((item) => item.serviceTreeId), [firstId, secondId]);
  assert.equal(scan.status, "multiple");
  assert.deepEqual(scan.diagnostics, []);
  assert.equal(scan.candidates[0].evidence[0].field, "/serviceMetadata/serviceIdentifier");
  assert.equal(scan.candidates[0].evidence[0].displayName, "Fixture EV2");
  assert.equal(progress.at(-1).scannedFiles, scan.scannedFiles);
});

test("malformed, duplicate, dynamic, and placeholder configuration requires review without guessed IDs", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "invalid", null);
  assert.equal(repo.config.status, "missing");
  const files = {
    "broken.json": "{",
    "duplicate.json": `{"serviceTreeId":"${firstId}","serviceTreeId":"${secondId}"}`,
    "dynamic.yml": "serviceTreeId: $config(serviceTreeId)\n",
    "placeholder.json": '{"serviceTreeId":"00000000-0000-0000-0000-000000000000"}',
    "broken.yaml": "serviceTreeId: [unterminated",
    "duplicate.yaml": `serviceTreeId: ${firstId}\nserviceTreeId: ${secondId}\n`,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(repo.localPath, name), content);
  const scan = await scanRepositoryConfig(repo.localPath);
  assert.equal(scan.status, "review");
  assert.equal(scan.candidates.length, 0);
  assert.equal(scan.diagnostics.length, 6);
  assert.ok(scan.diagnostics.some((item) => item.includes("duplicate JSON keys")));
});

test("ServiceSpec identifiers and service names are associated with the ServiceTree provider, not file names or owner GUIDs", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "specification", null);
  const files = {
    "ServiceSpec.json": { providerType: "ServiceTree", identifier: firstId, description: "Fixture Service Name", ownerGroupObjectId: unrelatedId },
    "custom-registration.json": { ProviderType: "servicetree", Identifier: secondId, DisplayName: "Second Service", description: "Not the display name" },
    "arbitrary-ids.json": { identifier: unrelatedId, description: "Not a ServiceSpec" },
    "other-provider.json": { providerType: "Other", identifier: unrelatedId, displayName: "Wrong provider" },
    "nested.json": { dependencies: [{ providerType: "ServiceTree", identifier: unrelatedId }] },
  };
  for (const [file, value] of Object.entries(files)) await fs.writeFile(path.join(repo.localPath, file), JSON.stringify(value));
  const scan = await scanRepositoryConfig(repo.localPath);
  assert.deepEqual(scan.candidates.map((candidate) => candidate.serviceTreeId), [firstId, secondId]);
  assert.deepEqual(scan.diagnostics, []);
  const first = scan.candidates[0].evidence[0];
  assert.equal(first.kind, "service-spec");
  assert.equal(first.field, "/identifier");
  assert.equal(first.displayName, "Fixture Service Name");
  assert.equal(first.displayNameField, "/description");
  const second = scan.candidates[1].evidence[0];
  assert.equal(second.file, "custom-registration.json");
  assert.equal(second.displayName, "Second Service");
  assert.equal(second.displayNameField, "/DisplayName");
});

test("invalid ServiceSpecs and oversized name suggestions require review rather than guessed metadata", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "invalid-specifications", null);
  const files = {
    "ServiceSpec.json": { identifier: unrelatedId },
    "ServiceSpecification.json": { providerType: "ServiceTree", description: "No ID" },
    "invalid-guid.json": { providerType: "ServiceTree", identifier: "$config(serviceId)" },
    "long-description.json": { providerType: "ServiceTree", identifier: firstId, description: "x".repeat(151) },
  };
  for (const [file, value] of Object.entries(files)) await fs.writeFile(path.join(repo.localPath, file), JSON.stringify(value));
  const scan = await scanRepositoryConfig(repo.localPath);
  assert.equal(scan.status, "review");
  assert.deepEqual(scan.candidates.map((candidate) => candidate.serviceTreeId), [firstId]);
  assert.equal(scan.candidates[0].evidence[0].displayName, undefined);
  assert.equal(scan.diagnostics.length, 4);
});

test("ServiceSpec files are inspected before unrelated configuration reaches the scan file limit", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "prioritized", null);
  await fs.mkdir(path.join(repo.localPath, "z-deployment"));
  await fs.writeFile(path.join(repo.localPath, "z-deployment", "ServiceSpec.json"), JSON.stringify({
    providerType: "ServiceTree", identifier: firstId, description: "Prioritized Service",
  }));
  await Promise.all(Array.from({ length: 2000 }, (_, index) =>
    fs.writeFile(path.join(repo.localPath, `a-${String(index).padStart(4, "0")}.json`), "{}")));
  const scan = await scanRepositoryConfig(repo.localPath);
  assert.deepEqual(scan.candidates.map((candidate) => candidate.serviceTreeId), [firstId]);
  assert.equal(scan.candidates[0].evidence[0].displayName, "Prioritized Service");
  assert.ok(scan.diagnostics.some((item) => item.includes("2000 files")));
});

test("configuration byte limits are explicit diagnostics rather than successful full validation", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "bounded");
  await fs.writeFile(path.join(repo.localPath, "large.json"), " ".repeat(1_000_001));
  for (let index = 0; index < 12; index++) {
    await fs.writeFile(path.join(repo.localPath, `padding-${index}.json`), JSON.stringify({ description: "x".repeat(900_000) }));
  }
  const scan = await scanRepositoryConfig(repo.localPath);
  assert.equal(scan.status, "review");
  assert.ok(scan.diagnostics.some((item) => item.includes("1 MB")));
  assert.ok(scan.diagnostics.some((item) => item.includes("10 MB")));
});

test("deleted tracked files and cyclic YAML aliases do not prevent reviewing usable mappings", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "partial");
  await fs.writeFile(path.join(repo.localPath, "removed.json"), "{}");
  await exec("git", ["-C", repo.localPath, "add", "removed.json"]);
  await fs.unlink(path.join(repo.localPath, "removed.json"));
  await fs.writeFile(path.join(repo.localPath, "aliases.yaml"), `service: &service\n  serviceTreeId: ${secondId}\n  self: *service\n`);
  const scan = await scanRepositoryConfig(repo.localPath);
  assert.equal(scan.status, "review");
  assert.deepEqual(scan.candidates.map((candidate) => candidate.serviceTreeId), [firstId, secondId]);
  assert.ok(scan.diagnostics.some((item) => item.includes("missing from this checkout")));
});

test("configuration changes block saving until folders are rescanned and mappings are reviewed again", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "changing");
  await fs.writeFile(path.join(repo.localPath, "service.json"), JSON.stringify({ serviceTreeId: secondId }));
  await assert.rejects(saveWorkspace(root, workspaceInput([repo]), allowedRepositories([repo])), /configuration changed/);
  assert.equal((await readSnapshot(root)).catalogEntries.length, 0);
  const rescanned = await inspectRepository(repo.localPath);
  const setup = await saveWorkspace(root, workspaceInput([rescanned]), allowedRepositories([rescanned]));
  assert.equal(setup.services[0].serviceTreeId, secondId);
});

test("manual mappings are explicit and shared repositories can be associated with another service", async (t) => {
  const root = await workspace(t);
  const repo = await repository(root, "manual");
  const input = workspaceInput([repo]);
  await saveWorkspace(root, input, allowedRepositories([repo]));
  await fs.unlink(path.join(root, "onboarding.json"));
  input.services[0].serviceTreeId = secondId;
  input.services[0].serviceName = "another-service";
  input.mappings[0].services[0].serviceTreeId = secondId;
  await assert.rejects(saveWorkspace(root, input, allowedRepositories([repo])), /no matching configuration evidence/);
  input.mappings[0].services[0].source = "manual";
  await saveWorkspace(root, input, allowedRepositories([repo]));
  const snapshot = await readSnapshot(root);
  assert.equal(snapshot.catalogEntries.length, 2);
  const record = snapshot.catalogEntries.find(({ record }) => record.service.serviceTreeId === secondId).record;
  assert.deepEqual(record.repositories[0].serviceTreeMapping.evidence, []);
  assert.equal(record.repositories[0].serviceTreeMapping.source, "manual");
});

test("batch validation and marker failures do not leave partially saved services", async (t) => {
  const root = await workspace(t);
  const repositories = [await repository(root, "one"), await repository(root, "two", { serviceTreeId: secondId })];
  const input = workspaceInput(repositories);
  const invalid = structuredClone(input);
  invalid.services[1].serviceName = invalid.services[0].serviceName;
  await assert.rejects(saveWorkspace(root, invalid, allowedRepositories(repositories)), /unique service identifier/);
  assert.equal((await readSnapshot(root)).catalogEntries.length, 0);
  await fs.mkdir(path.join(root, "onboarding.json"));
  await assert.rejects(saveWorkspace(root, input, allowedRepositories(repositories)), /EISDIR|EACCES|EPERM/);
  assert.equal((await readSnapshot(root)).catalogEntries.length, 0);
});

test("service domain edits persist arbitrary titles, protect stale changes, and clear to the service-name fallback", async (t) => {
  const root = await workspace(t);
  const { record } = createServiceRecord({
    serviceName: "billing", displayName: "Billing API", description: "Billing operations",
    repositoryUrl: "https://github.com/grounds-fixture/billing", defaultBranch: "main",
  });
  delete record.service.domain;
  const directory = path.join(root, "services", "ungrouped");
  await fs.mkdir(directory);
  const file = path.join(directory, "billing.json");
  await fs.writeFile(file, JSON.stringify(record));
  let backend = await createBackend(root);
  const update = (domain, previousDomain = null, sourcePath = "services/ungrouped/billing.json") =>
    backend.request({ path: "/__grounds/service-domain", method: "PUT", body: JSON.stringify({ sourcePath, domain, previousDomain }) });
  try {
    assert.equal((await update("Azure Monitor Billing / Finance")).status, 200);
    let saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(saved.service.domain, "Azure Monitor Billing / Finance");
    assert.equal(saved.service.description, record.service.description);
    assert.deepEqual(saved.repositories, record.repositories);
    assert.equal((await update("Stale change")).status, 409);
    assert.equal((await update("x".repeat(151), saved.service.domain)).status, 400);
    assert.equal((await update("Invalid\nTitle", saved.service.domain)).status, 400);
    assert.equal((await update("Outside", null, "../outside.json")).status, 404);
    assert.equal((await backend.request({ path: "/__grounds/service-domain", method: "GET" })).status, 405);
    await backend.close();
    backend = await createBackend(root);
    assert.equal((await readSnapshot(root)).catalogEntries[0].record.service.domain, saved.service.domain);
    assert.equal((await update("", saved.service.domain)).status, 200);
    saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(saved.service.domain, undefined);
    assert.equal(saved.service.displayName, "Billing API");
  } finally {
    await backend.close();
  }
});

test("existing middleware works over IPC streams, persists notes, and closes cleanly", { timeout: 30_000 }, async (t) => {
  const root = await workspace(t);
  let backend = await createBackend(root);
  try {
    let response = await backend.request({ path: "/__grounds/work/notes", method: "GET" });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).notes, []);
    response = await backend.request({
      path: "/__grounds/work/notes", method: "POST",
      body: JSON.stringify({ serviceName: "fixture-service", title: "Fixture", body: "Persistent desktop note" }),
    });
    assert.equal(response.status, 201, response.body);
    await backend.close();
    backend = await createBackend(root);
    response = await backend.request({ path: "/__grounds/work/notes", method: "GET" });
    assert.equal(JSON.parse(response.body).notes[0].title, "Fixture");
    response = await backend.request({ path: "/__grounds/service-onboarding/create", method: "GET" });
    assert.equal(response.status, 405);
    response = await backend.request({ path: "/__grounds/service-onboarding/create", method: "POST", body: "{" });
    assert.equal(response.status, 400);
    assert.match(JSON.parse(response.body).error, /valid JSON/);
    await assert.rejects(backend.request({
      path: "/__grounds/ev2-service-groups", method: "POST", body: "x".repeat(10001),
    }), /closed before completing/);
  } finally {
    await backend.close();
  }
});
