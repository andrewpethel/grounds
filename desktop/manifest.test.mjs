import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createBackend, initializeData, readSnapshot } from "./backend.mjs";
import {
  createManifest, discoverManifests, manifestName, readManifestPipelines,
  refreshManifestPipelines, saveManifestWorkspace, updateManifestPipelines, validateManifest,
  readPipelineInputs, confirmManifestPipeline,
} from "./manifest.mjs";
import { buildSrmServiceGroups, deploymentSelectorsMatch, resolveDeploymentOwner } from "../tools/deployment-matching.mjs";

const exec = promisify(execFile);
const resources = path.resolve(import.meta.dirname, "..");
const tree = "11111111-1111-4111-8111-111111111111";
const service = (name = "one-rp", extra = {}) => ({
  name, displayName: name === "one-rp" ? "OneRP" : name, serviceTreeId: tree, ...extra,
});
const manifest = (...services) => ({ schemaVersion: 1, services });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grounds-manifest-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const repos = path.join(root, "repos");
  await fs.mkdir(repos);
  await initializeData(data, resources);
  return { root, data, repos };
}

async function repository(root, name, value) {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  await exec("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await exec("git", ["-C", directory, "remote", "add", "origin", `https://github.com/grounds-fixture/${name}.git`]);
  await exec("git", ["-C", directory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  if (value) await fs.writeFile(path.join(directory, manifestName), JSON.stringify(value));
  return fs.realpath(directory);
}

test("manifest validation preserves operator identity and rejects ambiguous or unsafe declarations", () => {
  assert.equal(validateManifest(manifest(service())).services[0].displayName, "OneRP");
  for (const value of [
    manifest(service(), service()),
    manifest(service("Uppercase")),
    manifest(service("one-rp", { serviceTreeId: "00000000-0000-0000-0000-000000000000" })),
    manifest(service("one-rp", { deploymentMatching: { regex: ".*" } })),
    manifest(service("one-rp", { deploymentMatching: { serviceGroupNames: [] } })),
    manifest(service("one-rp", { sourcePaths: ["../sibling"] })),
    manifest(service("one-rp", { sourcePaths: ["C:\\private"] })),
    manifest(service("one-rp", { sourcePaths: ["src/**"] })),
    manifest(service("one-rp", { credentials: "not-allowed" })),
    manifest(service("one-rp", { domain: "   " })),
    manifest(service("one-rp", { domain: "Invalid\nDomain" })),
    manifest(service("one-rp", { domain: "x".repeat(151) })),
  ]) assert.throws(() => validateManifest(value));
  assert.deepEqual(validateManifest(manifest(service("one-rp", { sourcePaths: ["src\\OneRP"] }))).services[0].sourcePaths, ["src/OneRP"]);
});

const buildLink = { name: "OneRP Official", provider: "azure-devops", url: "https://dev.azure.com/example/Project/_build?definitionId=42" };
const releaseLink = { name: "OneRP Release", provider: "ev2", url: "https://dev.azure.com/example/Project/_release?definitionId=73" };
const oversizedPipelines = () => {
  const links = Array.from({ length: 100 }, (_, index) => ({
    ...buildLink, url: `https://example.com/pipelines/${index}?label=${"x".repeat(1500)}`,
  }));
  return { build: links, release: links };
};

test("pipeline links reuse the catalog model, normalize URL IDs, and reject invalid metadata", () => {
  const pipelines = validateManifest(manifest(service("one-rp", { pipelines: { build: [buildLink] } }))).services[0].pipelines;
  assert.deepEqual(pipelines, { build: [{ ...buildLink, definitionId: "42" }], release: [] });
  for (const invalid of [
    { ...buildLink, url: "http://example.com/build" },
    { ...buildLink, url: "javascript:alert(1)" },
    { ...buildLink, url: "https://user:password@example.com/build" },
    { ...buildLink, url: "https://example.com/a b" },
    { ...buildLink, definitionId: 43 },
    { ...buildLink, name: "   " },
    { ...buildLink, credentials: "not-allowed" },
  ]) assert.throws(() => validateManifest(manifest(service("one-rp", { pipelines: { build: [invalid] } }))));
  assert.throws(() => validateManifest(manifest(service("one-rp", { pipelines: { deploy: [] } }))));
});

test("pipeline selectors are bounded literal alternatives, with separate build/classic-release ID namespaces", () => {
  const selector = { yamlPaths: [".pipelines\\Official.yml"], names: ["  Official  "], definitionKeys: ["build:42", "release:42"] };
  const normalized = validateManifest(manifest(service("one-rp", { pipelineMatching: { release: selector } }))).services[0].pipelineMatching.release;
  assert.deepEqual(normalized, { ...selector, yamlPaths: [".pipelines/Official.yml"], names: ["Official"] });
  for (const pipelineMatching of [
    { release: {} }, { deploy: { names: ["Official"] } }, { build: { names: [] } },
    { build: { yamlPaths: ["../outside.yml"] } }, { build: { yamlPaths: ["C:\\outside.yml"] } },
    { build: { definitionKeys: ["42"] } }, { release: { definitionKeys: ["build:0"] } },
  ]) assert.throws(() => validateManifest(manifest(service("one-rp", { pipelineMatching }))));
});

test("pipeline confirmation writes only a stable namespaced selector and rejects stale/conflicting/unavailable choices", async (t) => {
  const { repos, data } = await fixture(t);
  const directory = await repository(repos, "primary", manifest(service(), service("another-service")));
  await saveManifestWorkspace(data, { serviceNames: ["one-rp"], cloud: "public" }, await discoverManifests(repos));
  let [input] = await readPipelineInputs(data);
  assert.equal(input.sources[0].serviceCount, 2, "Count includes services not selected into Grounds.");
  const candidate = { name: "Release", definitionId: "42", repositoryPath: directory, implementation: "yaml", status: "needs-confirmation" };
  const confirmation = { serviceName: "one-rp", stage: "release" };
  await confirmManifestPipeline(data, confirmation, candidate, input.fingerprint);
  const document = JSON.parse(await fs.readFile(path.join(directory, manifestName), "utf8"));
  assert.deepEqual(document.services[0].pipelineMatching, { release: { definitionKeys: ["build:42"] } });
  assert.deepEqual(document.services[1], service("another-service"));
  await assert.rejects(confirmManifestPipeline(data, confirmation, candidate, input.fingerprint), /changed/);
  [input] = await readPipelineInputs(data);
  await assert.rejects(confirmManifestPipeline(data, { ...confirmation, stage: "build" }, candidate, input.fingerprint), /also matches the release selector/);
  await assert.rejects(confirmManifestPipeline(data, confirmation, { ...candidate, status: "unavailable" }, input.fingerprint), /available/);
  await assert.rejects(confirmManifestPipeline(data, confirmation, { ...candidate, cached: true }, input.fingerprint), /available/);
  await refreshManifestPipelines(data, {
    "one-rp": { fingerprint: input.fingerprint, pipelines: { build: [], release: [{ ...buildLink, definitionId: "42" }] } },
  }, { verifiedOnly: true });
  assert.equal((await readSnapshot(data)).catalogEntries[0].record.pipelines.release.length, 1);
  await refreshManifestPipelines(data, {}, { verifiedOnly: true });
  assert.deepEqual((await readSnapshot(data)).catalogEntries[0].record.pipelines, { build: [], release: [] });
});

test("pipeline contributions merge per repository, deduplicate, and reject conflicts or stale onboarding", async (t) => {
  const { repos, data } = await fixture(t);
  const first = await repository(repos, "first", manifest(service("one-rp", { pipelines: { build: [buildLink] } })));
  const second = await repository(repos, "second", manifest(service("one-rp", {
    pipelines: { build: [{ ...buildLink, definitionId: 42 }], release: [releaseLink] },
  })));
  let catalog = await discoverManifests(repos);
  assert.equal(catalog.services[0].pipelines.build.length, 1);
  assert.equal(catalog.services[0].pipelines.release.length, 1);
  const input = { serviceNames: ["one-rp"], cloud: "public" };
  await fs.writeFile(path.join(first, manifestName), JSON.stringify(manifest(service("one-rp", {
    pipelines: { build: [{ ...buildLink, name: "Changed after scan" }] },
  }))));
  await assert.rejects(saveManifestWorkspace(data, input, catalog), /changed/);
  catalog = await discoverManifests(repos);
  assert.match(catalog.services[0].error, /Conflicting build pipeline/);
  await fs.writeFile(path.join(first, manifestName), JSON.stringify(manifest(service("one-rp", { pipelines: { build: [buildLink] } }))));
  catalog = await discoverManifests(repos);
  await saveManifestWorkspace(data, input, catalog);
  const record = (await readSnapshot(data)).catalogEntries[0].record;
  assert.deepEqual(record.pipelines, catalog.services[0].pipelines);
  assert.deepEqual((await readManifestPipelines(data, "one-rp")).map((row) => row.repositoryPath), [first, second]);
});

test("pipeline CRUD edits only the selected manifest service, protects revisions, and leaves artifacts intact", async (t) => {
  const { repos, data } = await fixture(t);
  const sibling = service("lami", { pipelines: { release: [releaseLink] } });
  const directory = await repository(repos, "primary", manifest(service(), sibling));
  const support = await repository(repos, "support", manifest(service()));
  const artifactNames = ["pipeline.yml", "ServiceSpec.json", "ServiceModel.json"];
  for (const name of artifactNames) await fs.writeFile(path.join(directory, name), `unchanged ${name}\r\n`);
  await saveManifestWorkspace(data, { serviceNames: ["one-rp"], cloud: "public" }, await discoverManifests(repos));
  let [row] = await readManifestPipelines(data, "one-rp");
  const input = { serviceName: "one-rp", repositoryPath: directory, previousRevision: row.revision, pipelines: { build: [buildLink], release: [releaseLink] } };
  await assert.rejects(updateManifestPipelines(data, { ...input, repositoryPath: repos }), /associated/);
  await assert.rejects(updateManifestPipelines(data, { ...input, pipelines: oversizedPipelines() }), /256 KB/);
  const originalRename = fs.rename.bind(fs);
  const rename = t.mock.method(fs, "rename", async (from, to) => {
    if (to === path.join(directory, manifestName)) throw new Error("Fixture manifest write failed.");
    return originalRename(from, to);
  });
  await assert.rejects(updateManifestPipelines(data, input), /Fixture manifest write failed/);
  assert.equal((await readManifestPipelines(data, "one-rp"))[0].revision, row.revision);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  rename.mock.restore();
  await updateManifestPipelines(data, input);
  await assert.rejects(updateManifestPipelines(data, input), /manifest changed/);
  [row] = await readManifestPipelines(data, "one-rp");
  assert.equal(row.pipelines.build[0].definitionId, "42");
  const supportBefore = await fs.readFile(path.join(support, manifestName), "utf8");
  const edited = { ...buildLink, name: "Edited pipeline", url: buildLink.url.replace("42", "99") };
  await updateManifestPipelines(data, { ...input, previousRevision: row.revision, pipelines: { build: [edited] } });
  [row] = await readManifestPipelines(data, "one-rp");
  assert.equal(row.pipelines.build[0].definitionId, "99");
  assert.equal(row.pipelines.release.length, 0);
  await updateManifestPipelines(data, { ...input, previousRevision: row.revision, pipelines: {} });
  assert.deepEqual((await readManifestPipelines(data, "one-rp"))[0].pipelines, { build: [], release: [] });
  const saved = JSON.parse(await fs.readFile(path.join(directory, manifestName), "utf8"));
  assert.deepEqual(saved.services[1], sibling);
  assert.equal(await fs.readFile(path.join(support, manifestName), "utf8"), supportBefore);
  for (const name of artifactNames) assert.equal(await fs.readFile(path.join(directory, name), "utf8"), `unchanged ${name}\r\n`);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  await fs.writeFile(path.join(directory, manifestName), JSON.stringify(manifest(service("one-rp", { displayName: "Different identity" }), sibling)));
  await assert.rejects(readManifestPipelines(data, "one-rp"), /identity no longer matches/);
});

test("manifest refresh updates and removes links, preserves workspace metadata, and reports cached-link failures", async (t) => {
  const { repos, data } = await fixture(t);
  const directory = await repository(repos, "primary", manifest(service("one-rp", { pipelines: { build: [buildLink] } }), service("legacy")));
  await saveManifestWorkspace(data, { serviceNames: ["one-rp", "legacy"], cloud: "public" }, await discoverManifests(repos));
  let entries = (await readSnapshot(data)).catalogEntries;
  const entry = entries.find(({ record }) => record.service.name === "one-rp");
  const recordFile = path.join(data, entry.sourcePath);
  entry.record.service.domain = "My workspace grouping";
  entry.record.tags.push("keep-me");
  await fs.writeFile(recordFile, JSON.stringify(entry.record));
  const legacy = entries.find(({ record }) => record.service.name === "legacy");
  legacy.record.repositories[0].serviceTreeMapping.source = "manual";
  legacy.record.pipelines = { build: [buildLink], release: [] };
  const legacyFile = path.join(data, legacy.sourcePath);
  await fs.writeFile(legacyFile, JSON.stringify(legacy.record));
  const legacyBefore = await fs.readFile(legacyFile, "utf8");
  const file = path.join(directory, manifestName);
  await fs.writeFile(file, JSON.stringify(manifest(service("one-rp", { pipelines: { release: [releaseLink] } }))));
  assert.deepEqual(await refreshManifestPipelines(data), {});
  let refreshed = JSON.parse(await fs.readFile(recordFile, "utf8"));
  assert.deepEqual(refreshed.pipelines, { build: [], release: [releaseLink] });
  assert.equal(refreshed.service.domain, "My workspace grouping");
  assert.deepEqual(refreshed.tags, entry.record.tags);
  assert.deepEqual(refreshed.repositories, entry.record.repositories);
  assert.equal(await fs.readFile(legacyFile, "utf8"), legacyBefore);
  const unchanged = await fs.readFile(recordFile, "utf8");
  assert.deepEqual(await refreshManifestPipelines(data), {});
  assert.equal(await fs.readFile(recordFile, "utf8"), unchanged);
  await fs.writeFile(file, "{");
  assert.match((await refreshManifestPipelines(data))[entry.sourcePath], /previously saved links are retained/);
  assert.equal(await fs.readFile(recordFile, "utf8"), unchanged);
  await fs.writeFile(file, JSON.stringify(manifest(service())));
  assert.deepEqual(await refreshManifestPipelines(data), {});
  refreshed = JSON.parse(await fs.readFile(recordFile, "utf8"));
  assert.deepEqual(refreshed.pipelines, { build: [], release: [] });
});

test("discovery reads ignored manifests directly and groups by service key, never Service Tree ID", async (t) => {
  const { repos, data } = await fixture(t);
  const oneRp = service("one-rp", { domain: "Azure Alerts Control Plane", deploymentMatching: { serviceGroupNameContains: [".AlertsRP"] }, sourcePaths: ["src/OneRP"] });
  const shared = await repository(repos, "shared", manifest(oneRp, service("lami", {
    deploymentMatching: { serviceGroupNameContains: [".LAMetricIngestion"] },
  })));
  await fs.writeFile(path.join(shared, ".gitignore"), `${manifestName}\n`);
  const support = await repository(repos, "support", manifest({ ...oneRp, sourcePaths: ["lib"] }));
  await repository(repos, "unconfigured");
  const broken = await repository(repos, "broken");
  await fs.writeFile(path.join(broken, manifestName), "{");
  const catalog = await discoverManifests(repos);
  assert.equal(catalog.services.length, 2);
  assert.equal(catalog.repositories.length, 4);
  assert.equal(catalog.services.find((entry) => entry.name === "one-rp").repositories.length, 2);
  assert.ok(catalog.repositories.find((entry) => entry.localPath === broken).error);
  const input = { serviceNames: ["one-rp", "lami"], cloud: "ussec" };
  const setup = await saveManifestWorkspace(data, input, catalog);
  assert.deepEqual(setup.services.map((entry) => entry.serviceName), ["one-rp", "lami"]);
  const records = (await readSnapshot(data)).catalogEntries.map((entry) => entry.record);
  const record = records.find((record) => record.service.name === "one-rp");
  assert.deepEqual(record.service.deploymentMatching, oneRp.deploymentMatching);
  assert.equal(record.service.domain, "Azure Alerts Control Plane");
  assert.equal(records.find((record) => record.service.name === "lami").service.domain, "lami");
  assert.deepEqual(record.repositories.map((repo) => repo.paths), [["src/OneRP"], ["lib"]]);
  assert.equal(record.repositories[0].serviceTreeMapping.source, "manifest");
  assert.equal(record.repositories[0].serviceTreeMapping.evidence[0].file, manifestName);
  assert.equal((await discoverManifests(repos, records)).services.every((entry) => entry.added), true);
  await assert.rejects(saveManifestWorkspace(data, input, catalog), /already exists/);
  const other = await repository(repos, "other", manifest(service("another-service")));
  const refreshed = await discoverManifests(repos, records);
  const expanded = await saveManifestWorkspace(data, { serviceNames: ["another-service"], cloud: "public" }, refreshed);
  assert.notEqual(expanded.id, setup.id);
  assert.deepEqual(expanded.services.map((entry) => entry.serviceName), ["one-rp", "lami", "another-service"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, "onboarding.json"), "utf8")), expanded);
  assert.equal((await readSnapshot(data)).catalogEntries.length, 3);
  assert.equal((await discoverManifests(other)).services.length, 1);
  assert.equal((await discoverManifests(support)).services.length, 1);
});

test("adding services preserves a legacy pending discovery marker and rolls back failed writes", async (t) => {
  const { repos, data } = await fixture(t);
  await repository(repos, "new-service", manifest(service("new-service")));
  const marker = path.join(data, "onboarding.json");
  const legacy = { serviceName: "existing-service", serviceTreeId: tree, cloud: "public" };
  await fs.writeFile(marker, JSON.stringify(legacy));
  const originalRename = fs.rename.bind(fs);
  const rename = t.mock.method(fs, "rename", async (source, target) => {
    if (target === marker) throw new Error("Fixture marker write failed.");
    return originalRename(source, target);
  });
  const input = { serviceNames: ["new-service"], cloud: "public" };
  const catalog = await discoverManifests(repos);
  await assert.rejects(saveManifestWorkspace(data, input, catalog), /Fixture marker write failed/);
  assert.equal((await readSnapshot(data)).catalogEntries.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), legacy);
  assert.equal((await fs.readdir(data)).some((name) => name.endsWith(".tmp")), false);
  rename.mock.restore();
  const setup = await saveManifestWorkspace(data, input, catalog);
  assert.deepEqual(setup.services.map((entry) => entry.serviceName), ["existing-service", "new-service"]);
  assert.ok(setup.id);
});

test("conflicting manifests, changed source paths, and changed Git origins block save without partial records", async (t) => {
  const { repos, data } = await fixture(t);
  const first = await repository(repos, "first", manifest(service()));
  const second = await repository(repos, "second", manifest(service("one-rp", { displayName: "Different component" })));
  let catalog = await discoverManifests(repos);
  assert.match(catalog.services[0].error, /Conflicting/);
  const input = { serviceNames: ["one-rp"], cloud: "public" };
  await assert.rejects(saveManifestWorkspace(data, input, catalog), /Conflicting/);
  await fs.writeFile(path.join(second, manifestName), JSON.stringify(manifest(service("one-rp", { domain: "Different domain" }))));
  assert.match((await discoverManifests(repos)).services[0].error, /Conflicting/);
  await fs.writeFile(path.join(second, manifestName), JSON.stringify(manifest(service())));
  catalog = await discoverManifests(repos);
  await fs.writeFile(path.join(first, manifestName), JSON.stringify(manifest(service("one-rp", { sourcePaths: ["component"] }))));
  await assert.rejects(saveManifestWorkspace(data, input, catalog), /changed/);
  catalog = await discoverManifests(repos);
  await exec("git", ["-C", second, "remote", "set-url", "origin", "https://github.com/grounds-fixture/renamed.git"]);
  await assert.rejects(saveManifestWorkspace(data, input, catalog), /changed/);
  assert.equal((await readSnapshot(data)).catalogEntries.length, 0);
});

test("manifest creation is opt-in for gitignore, exclusive, and rolls back when ignoring fails", async (t) => {
  const { repos } = await fixture(t);
  const ignored = await repository(repos, "ignored");
  await fs.writeFile(path.join(ignored, ".gitignore"), "# existing content");
  await createManifest(ignored, manifest(service()), true);
  assert.equal(await fs.readFile(path.join(ignored, ".gitignore"), "utf8"), `# existing content\n/${manifestName}\n`);
  await assert.rejects(createManifest(ignored, manifest(service("different")), true), { code: "EEXIST" });
  assert.equal(JSON.parse(await fs.readFile(path.join(ignored, manifestName), "utf8")).services[0].name, "one-rp");
  const local = await repository(repos, "local");
  await createManifest(local, manifest(service()), false);
  await assert.rejects(fs.stat(path.join(local, ".gitignore")), { code: "ENOENT" });
  const blocked = await repository(repos, "blocked");
  await fs.mkdir(path.join(blocked, ".gitignore"));
  await assert.rejects(createManifest(blocked, manifest(service()), true), /regular file/);
  await assert.rejects(fs.stat(path.join(blocked, manifestName)), { code: "ENOENT" });
  const oversized = await repository(repos, "oversized");
  await assert.rejects(createManifest(oversized, manifest(service("one-rp", { pipelines: oversizedPipelines() })), true), /256 KB/);
  await assert.rejects(fs.stat(path.join(oversized, manifestName)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(oversized, ".gitignore")), { code: "ENOENT" });
});

test("manifest source paths scope troubleshooting search to the declared component", async (t) => {
  const { repos, data } = await fixture(t);
  const directory = await repository(repos, "components", manifest(service("one-rp", { sourcePaths: ["src/OneRP"] })));
  for (const component of ["OneRP", "LAMI"]) {
    const folder = path.join(directory, "src", component);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "signal.txt"), `MonitorSignal from ${component}\n`);
  }
  await exec("git", ["-c", "core.autocrlf=false", "-C", directory, "add", "src"]);
  const catalog = await discoverManifests(repos);
  await saveManifestWorkspace(data, { serviceNames: ["one-rp"], cloud: "public" }, catalog);
  const actor = { operatorId: "https://github.com|fixture-operator", login: "fixture-operator", host: "https://github.com" };
  const backend = await createBackend(data, () => {}, { copilot: {
    async operator() { return actor; },
    async investigate(_sessionId, action) {
      return action(actor, async (prompt) => JSON.parse(prompt).evidence.code
        .map((match) => `${match.excerpt} [${match.sourceId}]`).join("\n"));
    },
    isInvestigating() { return false; },
  } });
  try {
    const created = await backend.request({
      path: "/__grounds/service-chat/sessions", method: "POST",
      body: JSON.stringify({ serviceName: "one-rp" }),
    });
    assert.equal(created.status, 201, created.body);
    const response = await backend.request({
      path: `/__grounds/service-chat/sessions/${JSON.parse(created.body).session.id}/messages`, method: "POST",
      body: JSON.stringify({ question: "Investigate MonitorSignal" }),
    });
    assert.equal(response.status, 201, response.body);
    const sources = JSON.parse(response.body).assistantMessage.sources.filter((source) => source.type === "repository");
    assert.equal(sources.length, 1);
    assert.match(sources[0].title, /src\/OneRP\/signal.txt/);
    assert.doesNotMatch(JSON.parse(response.body).assistantMessage.content, /from LAMI/);
  } finally {
    await backend.close();
  }
});

test("selectors use literal case-insensitive alternatives within lists and intersect both lists", () => {
  const selected = service("one-rp", {
    deploymentMatching: {
      serviceGroupNames: ["Prod.AlertsRP", "Test.AlertsRP"],
      serviceGroupNameContains: [".AlertsRP", ".Other"],
    },
  });
  assert.equal(deploymentSelectorsMatch(selected, "prod.alertsrp"), true);
  assert.equal(deploymentSelectorsMatch(selected, "Different.AlertsRP"), false);
  assert.equal(deploymentSelectorsMatch({ ...selected, deploymentMatching: { serviceGroupNameContains: [".*"] } }, "Prod.AlertsRP"), false);
  assert.equal(deploymentSelectorsMatch(service(), "Prod.AlertsRP"), undefined);
  assert.equal(deploymentSelectorsMatch({ ...selected, deploymentMatching: undefined, serviceGroupPatterns: [".AlertsRP"] }, "Prod.AlertsRP"), true);
});

test("deployment ownership never falls back to Service Tree and remains unresolved for conflicting selectors", () => {
  const oneRp = service("one-rp", { deploymentMatching: { serviceGroupNameContains: [".AlertsRP"] } });
  const lami = service("lami", { deploymentMatching: { serviceGroupNameContains: [".LAMetricIngestion"] } });
  assert.equal(resolveDeploymentOwner([oneRp, lami], tree, "Prod.AlertsRP"), "one-rp");
  assert.equal(resolveDeploymentOwner([oneRp, lami], tree, "Prod.LAMetricIngestion"), "lami");
  assert.equal(resolveDeploymentOwner([service()], tree, "Anything"), undefined);
  assert.equal(resolveDeploymentOwner([oneRp], tree, "Prod.Unrelated"), undefined);
  assert.equal(resolveDeploymentOwner([oneRp], tree, "Prod.Unrelated", ["one-rp"]), undefined);
  assert.equal(resolveDeploymentOwner([oneRp, { ...oneRp, name: "other" }], tree, "Prod.AlertsRP"), undefined);
  assert.equal(resolveDeploymentOwner([service()], tree, "Prod.AlertsRP", ["one-rp"]), "one-rp");
  assert.equal(resolveDeploymentOwner([oneRp], "22222222-2222-4222-8222-222222222222", "Prod.AlertsRP"), undefined);
});

test("SRM supplies groups without EV2, deduplicates environments, and respects service scope", () => {
  const oneRp = service("one-rp", { deploymentMatching: { serviceGroupNameContains: [".AlertsRP"] } });
  const lami = service("lami", { deploymentMatching: { serviceGroupNameContains: [".LAMetricIngestion"] } });
  const statuses = [
    { serviceTreeId: tree.toUpperCase(), serviceGroupName: "Prod.AlertsRP", environment: "public" },
    { serviceTreeId: tree, serviceGroupName: "Prod.AlertsRP", environment: "usnat" },
    { serviceTreeId: tree, serviceGroupName: "Prod.LAMetricIngestion", environment: "public" },
    { serviceTreeId: "22222222-2222-4222-8222-222222222222", serviceGroupName: "Foreign.AlertsRP", environment: "public" },
  ];
  const groups = buildSrmServiceGroups([oneRp, lami], oneRp, statuses, []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].serviceGroupId, "Prod.AlertsRP");
  assert.equal(groups[0].owner, "one-rp");
  assert.equal(groups[0].enriched, false);
  assert.deepEqual(groups[0].deployments, []);
  assert.deepEqual(buildSrmServiceGroups([oneRp], { name: "no-tree" }, statuses, []), []);
});

test("EV2 only enriches SRM groups and never introduces snapshot-only groups", () => {
  const selected = service();
  const group = {
    serviceGroupId: "Prod.Shared", displayName: "Shared infrastructure",
    sourceUrl: "https://example.com/ev2/group", infrastructures: ["Infrastructure"],
    associations: [{ serviceName: selected.name, basis: "operator-confirmed" }],
    deployments: [{ deploymentId: "captured", displayName: "Captured deployment", status: "completed" }],
  };
  const observations = [
    { serviceTreeId: tree, cloud: "public", serviceGroups: [group, { ...group, serviceGroupId: "EV2.Only" }] },
    { serviceTreeId: tree, cloud: "usnat", serviceGroups: [{ ...group, displayName: "Not Public enrichment" }] },
  ];
  const groups = buildSrmServiceGroups([selected], selected, [
    { serviceTreeId: tree, serviceGroupName: "Prod.Shared" },
  ], observations);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].displayName, group.displayName);
  assert.equal(groups[0].sourceUrl, group.sourceUrl);
  assert.deepEqual(groups[0].infrastructures, group.infrastructures);
  assert.deepEqual(groups[0].deployments, group.deployments);
  assert.equal(groups[0].owner, selected.name);
  assert.equal(groups[0].enriched, true);
  assert.deepEqual(buildSrmServiceGroups([selected], selected, [], observations), []);
});

test("unattributed SRM groups stay visible without claiming ownership, including ambiguous matches", () => {
  const selected = service();
  const lami = service("lami", { deploymentMatching: { serviceGroupNameContains: [".LAMetricIngestion"] } });
  const statuses = [
    { serviceTreeId: tree, serviceGroupName: "Prod.Shared" },
    { serviceTreeId: tree, serviceGroupName: "Prod.LAMetricIngestion" },
  ];
  const groups = buildSrmServiceGroups([selected, lami], selected, statuses, []);
  assert.deepEqual(groups.map((group) => [group.serviceGroupId, group.owner]), [["Prod.Shared", undefined]]);
  const selector = { deploymentMatching: { serviceGroupNameContains: [".Shared"] } };
  const ambiguous = buildSrmServiceGroups(
    [{ ...selected, ...selector }, service("other", selector)],
    { ...selected, ...selector }, statuses, [],
  );
  assert.deepEqual(ambiguous.map((group) => [group.serviceGroupId, group.owner]), [["Prod.Shared", undefined]]);
});
