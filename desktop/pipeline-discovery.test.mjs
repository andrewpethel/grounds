import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { discoverPipelines, inspectPipelineYaml, readPipelineDiscovery } from "./pipeline-discovery.mjs";

const exec = promisify(execFile);
const repositoryId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const build = (id, name, extra = {}) => ({
  id, name, repository: { id: repositoryId, defaultBranch: "refs/heads/main" }, queueStatus: "enabled",
  process: { type: 2, yamlFilename: `.pipelines/${name}.yml` }, ...extra,
});

async function fixture(t, { serviceCount = 1, service = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grounds-pipeline-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const localPath = path.join(root, "repo");
  await fs.mkdir(localPath);
  await exec("git", ["init", "--quiet", "--initial-branch=main", localPath]);
  const url = "https://dev.azure.com/example/Project/_git/component";
  await exec("git", ["-C", localPath, "remote", "add", "origin", url]);
  await exec("git", ["-C", localPath, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return {
    root, localPath,
    inputs: [{ serviceName: "component", fingerprint: "manifest-one", sources: [{
      repository: { localPath, url, name: "component" }, serviceCount, service,
    }] }],
  };
}

function server({ builds = [build(1, "Official")], releases = [], yaml = "steps:\n- task: MSBuild@1\n", fail, pages } = {}) {
  const calls = [];
  const options = {
    getToken: async () => "fixture-token",
    fetch: async (value, options) => {
      calls.push(value);
      const url = new URL(value);
      assert.ok(["dev.azure.com", "vsrm.dev.azure.com"].includes(url.hostname));
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      assert.equal(options.redirect, "error");
      if (fail?.(url)) return new Response("denied", { status: 403 });
      if (url.pathname.endsWith("/git/repositories/component")) return Response.json({ id: repositoryId, name: "component", project: { id: projectId } });
      if (url.pathname.endsWith("/items")) return Response.json({ content: typeof yaml === "function" ? yaml(url) : yaml });
      if (url.pathname.endsWith("/build/definitions")) {
        if (pages) return pages(url);
        return Response.json({ value: builds });
      }
      if (url.pathname.includes("/build/definitions/")) return Response.json(builds.find((definition) => String(definition.id) === url.pathname.split("/").at(-1)));
      if (url.pathname.endsWith("/release/definitions")) return Response.json({ value: releases });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  };
  return { options, calls };
}

test("registered YAML paths resolve on the registered branch; deployment YAML remains Release and supports multiple definitions", async (t) => {
  const { root, inputs } = await fixture(t, { serviceCount: 3, service: { pipelineMatching: {
    release: { namePrefixes: ["Component-Release-"] }, build: { yamlPaths: [".pipelines/Official.yml"] },
  } } });
  const mock = server({ builds: [build(1, "Official"), build(2, "Component-Release-Global"), build(3, "Component-Release-Regional"),
    build(4, "Foreign", { repository: { id: "another-repo" } }), build(5, "Disabled", { queueStatus: "disabled" })] });
  const result = (await discoverPipelines(root, inputs, mock.options)).services.component;
  assert.equal(result.error, undefined);
  assert.deepEqual(result.pipelines.build.map((pipeline) => pipeline.definitionId), ["1"]);
  assert.deepEqual(result.pipelines.release.map((pipeline) => pipeline.definitionId), ["2", "3"]);
  assert.ok(result.pipelines.release.every((pipeline) => pipeline.url.includes("/_build?definitionId=")));
  assert.equal(result.candidates.find((candidate) => candidate.definitionId === "5").status, "unavailable");
  assert.equal(result.candidates.some((candidate) => candidate.definitionId === "4"), false);
  assert.ok(mock.calls.some((value) => value.includes("versionDescriptor.version=main")));
});

test("shared repositories require service ownership even when only one service is onboarded; selectors never fall back", async (t) => {
  const { root, inputs } = await fixture(t, { serviceCount: 3 });
  const mock = server();
  let entry = (await discoverPipelines(root, inputs, mock.options)).services.component;
  assert.equal(entry.pipelines.build.length, 0);
  assert.equal(entry.candidates[0].status, "needs-confirmation");
  inputs[0].sources[0].service.pipelineMatching = { build: { names: ["Missing"] } };
  inputs[0].fingerprint = "manifest-two";
  entry = (await discoverPipelines(root, inputs, mock.options)).services.component;
  assert.equal(entry.pipelines.build.length, 0);
  inputs[0].sources[0].service.pipelineMatching = { build: { names: ["Official"] }, release: { namePrefixes: ["Official"] } };
  inputs[0].fingerprint = "manifest-three";
  entry = (await discoverPipelines(root, inputs, mock.options)).services.component;
  assert.equal(entry.pipelines.build.length + entry.pipelines.release.length, 0);
  assert.match(entry.candidates[0].reason, /Conflicting/);
});

test("classic release association checks artifact project and repository; build/release IDs remain separate", async (t) => {
  const { root, inputs } = await fixture(t, { service: { pipelineMatching: { release: { names: ["Classic"] } } } });
  const artifact = (project, definition) => ({ type: "Build", definitionReference: { project: { id: project }, definition: { id: definition } } });
  const mock = server({ releases: [
    { id: 1, name: "Classic", artifacts: [artifact(projectId, "1")] },
    { id: 2, name: "Foreign project", artifacts: [artifact("foreign-project", "1")] },
    { id: 3, name: "Foreign build", artifacts: [artifact(projectId, "99")] },
  ] });
  const entry = (await discoverPipelines(root, inputs, mock.options)).services.component;
  assert.equal(entry.pipelines.build.length, 1);
  assert.equal(entry.pipelines.release.length, 1);
  assert.equal(entry.pipelines.release[0].url, "https://dev.azure.com/example/Project/_release?definitionId=1");
  assert.equal(new Set(entry.candidates.map((candidate) => candidate.key)).size, 2);
  assert.ok(mock.calls.filter((value) => value.includes("/release/definitions")).every((value) =>
    new URL(value).searchParams.get("artifactSourceId")?.startsWith(`${projectId}:`)));
  delete inputs[0].sources[0].service.pipelineMatching;
  inputs[0].fingerprint = "without-owner-selection";
  const unselected = (await discoverPipelines(root, inputs, mock.options)).services.component;
  assert.equal(unselected.pipelines.release.length, 0);
  assert.equal(unselected.candidates.find((candidate) => candidate.implementation === "classic-release").status, "needs-confirmation");
});

test("single-service YAML roles use parsed deployment/build steps, not filenames or template-only guesses", async (t) => {
  const { root, inputs } = await fixture(t);
  const mock = server({
    builds: [build(1, "Deployment"), build(2, "Misleading-Release"), build(3, "Template"), build(4, "Unavailable")],
    yaml: (url) => url.searchParams.get("path").includes("Deployment") ? "jobs:\n- deployment: production\n" :
      url.searchParams.get("path").includes("Misleading") ? "steps:\n- task: MSBuild@1\n" :
        url.searchParams.get("path").includes("Unavailable") ? "steps: [" : "parameters:\n- name: example\n  type: string\n",
  });
  const entry = (await discoverPipelines(root, inputs, mock.options)).services.component;
  assert.deepEqual(entry.pipelines.build.map((pipeline) => pipeline.definitionId), ["2"]);
  assert.deepEqual(entry.pipelines.release.map((pipeline) => pipeline.definitionId), ["1"]);
  assert.equal(entry.candidates.find((candidate) => candidate.definitionId === "3").status, "needs-confirmation");
  assert.equal(entry.candidates.find((candidate) => candidate.definitionId === "4").status, "unavailable");
});

test("cached verified links survive offline errors, never substitute historical declarations, and invalidate with the manifest", async (t) => {
  const { root, inputs } = await fixture(t, { service: { pipelines: { release: [{ name: "Legacy", url: "https://dev.azure.com/example/Project/_release?definitionId=999" }] } } });
  const mock = server();
  await discoverPipelines(root, inputs, mock.options);
  const cached = await discoverPipelines(root, inputs, { ...mock.options, getToken: () => { throw new Error("Cache should avoid authentication"); } });
  assert.equal(cached.services.component.pipelines.build.length, 1);
  assert.equal(cached.services.component.pipelines.release.length, 0);
  const denied = server({ fail: () => true });
  const offline = await discoverPipelines(root, inputs, { ...denied.options, force: true });
  assert.equal(offline.services.component.pipelines.build.length, 1);
  assert.match(offline.services.component.error, /403/);
  const stillOffline = await discoverPipelines(root, inputs, { ...denied.options, force: true });
  assert.equal(stillOffline.services.component.pipelines.build.length, 1);
  inputs[0].fingerprint = "changed-manifest";
  const changed = await discoverPipelines(root, inputs, denied.options);
  assert.equal(changed.services.component.pipelines.build.length, 0);
  assert.equal(changed.services.component.pipelines.release.length, 0);
  assert.deepEqual(await readPipelineDiscovery(root), changed);
  await assert.rejects(discoverPipelines(root, inputs, { ...mock.options, signal: AbortSignal.abort() }), /abort/i);
});

test("continuation headers are followed, repeated tokens fail explicitly, and incomplete classic discovery retains only cached verified links", async (t) => {
  const { root, inputs } = await fixture(t);
  const mock = server({ pages: (url) => url.searchParams.has("continuationToken") ?
    Response.json({ value: [build(2, "Second")] }) :
    Response.json({ value: [build(1, "Official")] }, { headers: { "x-ms-continuationtoken": "next" } }),
  });
  const first = await discoverPipelines(root, inputs, mock.options);
  assert.equal(first.services.component.pipelines.build.length, 2);
  const partial = server({ fail: (url) => url.hostname === "vsrm.dev.azure.com" });
  const next = await discoverPipelines(root, inputs, { ...partial.options, force: true });
  assert.match(next.services.component.error, /Classic release discovery failed/);
  assert.equal(next.services.component.pipelines.build.length, 1, "An absent build is not retained because classic discovery failed.");
  const repeated = server({ pages: () => Response.json({ value: [] }, { headers: { "x-ms-continuationtoken": "same" } }) });
  const failed = await discoverPipelines(root, inputs, { ...repeated.options, force: true });
  assert.match(failed.services.component.error, /repeated.*continuation/i);
});

test("YAML inspection follows only bounded, local templates and rejects traversal and symlinks without executing content", async (t) => {
  const { localPath } = await fixture(t);
  await fs.mkdir(path.join(localPath, ".pipelines"));
  await fs.writeFile(path.join(localPath, ".pipelines", "main.yml"), "extends:\n  template: template.yml@self\n");
  await fs.writeFile(path.join(localPath, ".pipelines", "template.yml"), "steps:\n- task: Ev2RARollout@2\n- script: echo never-executed\n");
  assert.equal((await inspectPipelineYaml(localPath, ".pipelines/main.yml")).stage, "release");
  await assert.rejects(inspectPipelineYaml(localPath, "../outside.yml"), /relative path/);
  await fs.symlink(localPath, path.join(localPath, "linked"), "junction");
  await assert.rejects(inspectPipelineYaml(localPath, "linked/.pipelines/main.yml"), /symbolic links/);
  await fs.writeFile(path.join(localPath, ".pipelines", "template.yml"), "steps: [");
  await assert.rejects(inspectPipelineYaml(localPath, ".pipelines/main.yml"), /Cannot parse/);
});

test("YAML permission/network failures retain cached verification, but known repository identity changes invalidate it", async (t) => {
  const { root, inputs, localPath } = await fixture(t);
  await discoverPipelines(root, inputs, server().options);
  const deniedYaml = server({ fail: (url) => url.pathname.endsWith("/items") });
  const cached = (await discoverPipelines(root, inputs, { ...deniedYaml.options, force: true })).services.component;
  assert.equal(cached.pipelines.build.length, 1);
  assert.match(cached.error, /YAML inspection failed.*403/);
  assert.equal(cached.candidates[0].cached, true);
  await exec("git", ["-C", localPath, "remote", "set-url", "origin", "https://dev.azure.com/example/Project/_git/replaced"]);
  const changed = (await discoverPipelines(root, inputs, { ...server().options, force: true })).services.component;
  assert.equal(changed.pipelines.build.length, 0);
  assert.match(changed.error, /Git origin no longer matches/);
});
