import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";
import electronPath from "electron";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "grounds-electron-smoke-"));
const repos = path.join(temporary, "repos");
const tree = "11111111-1111-4111-8111-111111111111";
const exec = promisify(execFile);
let application;
const env = { ...process.env, LOCALAPPDATA: temporary };
delete env.ELECTRON_RUN_AS_NODE;

async function launch() {
  const instance = await electron.launch({
    executablePath: process.argv[2] ?? electronPath,
    args: process.argv[2] ? [] : [root], env, timeout: 45_000,
  });
  instance.process().stderr?.on("data", (data) => process.stderr.write(data));
  await instance.context().addInitScript(() => {
    window.smokeDiscoveryCalls = { repositories: 0, srm: 0 };
    let current = window.fetch.bind(window);
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => current,
      set: (next) => {
        current = async (input, init) => {
          const url = String(input);
          if (url.includes("/__grounds/local-repos")) {
            window.smokeDiscoveryCalls.repositories++;
            return new Response(JSON.stringify({ repositories: [], summary: { total: 0 } }));
          }
          if (url.includes("/__grounds/srm-release-status")) {
            window.smokeDiscoveryCalls.srm++;
            if (window.smokeHoldSrm) {
              await new Promise((resolve) => { window.smokeReleaseSrm = resolve; });
            }
            if (window.smokeDiscoveryCalls.srm === 1) {
              return new Response(JSON.stringify({ error: "Fixture SRM access denied" }), { status: 403 });
            }
            return new Response(JSON.stringify({
              generatedAt: new Date().toISOString(),
              serviceGroups: [
                { serviceTreeId: "11111111-1111-4111-8111-111111111111", serviceGroupName: "Prod.AlertsRP", environment: "public", releaseName: "1.0", releaseUrl: "https://example.com/release", status: "Completed", updatedAt: new Date().toISOString() },
                { serviceTreeId: "11111111-1111-4111-8111-111111111111", serviceGroupName: "Prod.LAMetricIngestion", environment: "public", releaseName: "2.0", releaseUrl: "https://example.com/release", status: "Completed", updatedAt: new Date().toISOString() },
                { serviceTreeId: "11111111-1111-4111-8111-111111111111", serviceGroupName: "Prod.Shared", environment: "public", releaseName: "3.0", releaseUrl: "https://example.com/release", status: "Failed", updatedAt: new Date().toISOString() },
              ],
              deploymentHistory: [], serviceTrees: [],
            }));
          }
          return next(input, init);
        };
      },
    });
    window.fetch = current;
  });
  return instance;
}

try {
  await fs.mkdir(repos);
  for (const name of ["primary", "support", "unconfigured", "broken"]) {
    const directory = path.join(repos, name);
    await fs.mkdir(directory);
    await exec("git", ["init", "--quiet", "--initial-branch=main", directory]);
    await exec("git", ["-C", directory, "remote", "add", "origin", `https://github.com/grounds-fixture/${name}.git`]);
    await exec("git", ["-C", directory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }
  const oneRp = { name: "one-rp", displayName: "OneRP", domain: "Azure Alerts Control Plane", serviceTreeId: tree, deploymentMatching: { serviceGroupNameContains: [".AlertsRP"] } };
  const lami = { name: "lami", displayName: "LAMI", domain: "Azure LA Ingestion", serviceTreeId: tree, deploymentMatching: { serviceGroupNameContains: [".LAMetricIngestion"] } };
  const catalogServices = Array.from({ length: 12 }, (_, index) => ({
    name: `catalog-component-${index + 1}`, displayName: `Catalog Component ${index + 1}`, serviceTreeId: tree,
    description: "An independently selectable operational component with repository and deployment scope details.",
  }));
  const buildLink = { name: "OneRP Official", provider: "azure-devops", url: "https://dev.azure.com/example/Project/_build?definitionId=42" };
  const releaseLink = { name: "Support Release", provider: "ev2", url: "https://dev.azure.com/example/Project/_release?definitionId=73" };
  await fs.writeFile(path.join(repos, "primary", "GroundsManifest.json"), JSON.stringify({
    schemaVersion: 1, services: [{ ...oneRp, pipelines: { build: [buildLink] } }, lami, ...catalogServices],
  }));
  await fs.writeFile(path.join(repos, "primary", ".gitignore"), "GroundsManifest.json\n");
  await fs.writeFile(path.join(repos, "primary", "architecture.md"), "Architecture: OneRP publishes work to Work queue.\n");
  await exec("git", ["-C", path.join(repos, "primary"), "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "add", "architecture.md"]);
  await fs.writeFile(path.join(repos, "support", "GroundsManifest.json"), JSON.stringify({
    schemaVersion: 1, services: [{ ...oneRp, pipelines: { release: [releaseLink] } }],
  }));
  await fs.writeFile(path.join(repos, "broken", "GroundsManifest.json"), "{");
  application = await launch();
  let page = await application.firstWindow();
  await page.getByRole("heading", { name: "Available services" }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.getByRole("button", { name: "Setup options", exact: true }).getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByRole("combobox", { name: "Deployment cloud", exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await application.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return prefs.contextIsolation && prefs.sandbox && !prefs.nodeIntegration;
  }), true);
  await assert.rejects(page.evaluate(() =>
    window.groundsDesktop.request({ path: "https://example.com", method: "GET" })), /Invalid Grounds request/);
  await assert.rejects(page.evaluate(() =>
    window.groundsDesktop.createManifest({ repositoryPath: "C:\\", manifest: {}, addToGitignore: true })), /current catalog/);
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, repos);
  await page.getByRole("button", { name: "Choose repositories folder" }).click();
  await page.getByRole("checkbox", { name: "OneRP", exact: true }).waitFor();
  for (const [width, height, minimumColumns] of [[1440, 900, 3], [1024, 768, 2], [390, 844, 1], [320, 650, 1]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => {
      const catalog = document.querySelector(".desktop-repository-list");
      const card = document.querySelector(".desktop-setup-card");
      const footer = document.querySelector(".desktop-setup-footer").getBoundingClientRect();
      const button = document.querySelector(".desktop-setup-actions button").getBoundingClientRect();
      const scroller = document.querySelector(innerWidth > 900 ? ".desktop-setup-catalog" : ".desktop-setup-layout");
      scroller.scrollTop = scroller.scrollHeight;
      const afterScroll = document.querySelector(".desktop-setup-footer").getBoundingClientRect();
      return {
        columns: getComputedStyle(catalog).gridTemplateColumns.split(" ").length,
        horizontalOverflow: card.scrollWidth > card.clientWidth || document.documentElement.scrollWidth > innerWidth,
        // Windows display scaling can round the footer edge by a fraction of a CSS pixel.
        footerVisible: footer.top >= 0 && footer.bottom <= innerHeight + 1,
        buttonVisible: button.top >= 0 && button.bottom <= innerHeight && button.right <= innerWidth,
        footerStayedVisible: afterScroll.top === footer.top && afterScroll.bottom === footer.bottom,
        scrollTop: scroller.scrollTop,
      };
    });
    assert.ok(layout.columns >= minimumColumns, `${width}px: expected at least ${minimumColumns} grid columns`);
    assert.equal(layout.horizontalOverflow, false, `${width}px: no horizontal overflow`);
    assert.equal(layout.footerVisible && layout.buttonVisible && layout.footerStayedVisible, true, `${width}px: sticky footer and action remain visible: ${JSON.stringify(layout)}`);
    assert.ok(layout.scrollTop > 0, `${width}px: catalog scrolls independently of footer`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("checkbox", { name: "OneRP", exact: true }).check();
  await page.getByRole("combobox", { name: "Deployment cloud", exact: true }).selectOption("ussec");
  await page.getByRole("button", { name: "Setup options", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Deployment cloud", exact: true }).isVisible(), false);
  assert.equal(await page.getByRole("checkbox", { name: "OneRP", exact: true }).isChecked(), true);
  await page.getByRole("button", { name: "Setup options", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Deployment cloud", exact: true }).inputValue(), "ussec");
  await page.getByRole("combobox", { name: "Deployment cloud", exact: true }).selectOption("public");
  await page.getByRole("checkbox", { name: "LAMI", exact: true }).check();
  await page.getByText("Set up another repository (2)", { exact: true }).click();
  await page.getByText("Set up unconfigured", { exact: true }).click();
  await page.setViewportSize({ width: 320, height: 650 });
  assert.equal(await page.evaluate(() => {
    const layout = document.querySelector(".desktop-setup-layout");
    return layout.scrollWidth <= layout.clientWidth;
  }), true, "expanded repository setup fits a narrow viewport");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("Service key", { exact: true }).fill("other-component");
  await page.getByLabel("Display name", { exact: true }).fill("Other Component");
  await page.getByLabel("Service Tree ID", { exact: true }).fill(tree);
  await page.getByText("Build and release links (optional)", { exact: true }).click();
  await page.getByRole("button", { name: "Add build link", exact: true }).click();
  await page.getByLabel("build pipeline name 1", { exact: true }).fill("Component CI");
  await page.getByLabel("build pipeline provider 1", { exact: true }).selectOption("github-actions");
  await page.getByLabel("build pipeline URL 1", { exact: true }).fill("https://github.com/grounds-fixture/unconfigured/actions/workflows/ci.yml");
  await page.getByRole("button", { name: "Create GroundsManifest.json", exact: true }).click();
  await page.getByRole("checkbox", { name: "Other Component", exact: true }).waitFor();
  assert.match(await fs.readFile(path.join(repos, "unconfigured", ".gitignore"), "utf8"), /\/GroundsManifest\.json/);
  await page.getByRole("checkbox", { name: "Other Component", exact: true }).check();
  await page.getByRole("button", { name: "Open workspace (3)", exact: true }).click();
  await page.getByRole("button", { name: "Open OneRP", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open LAMI", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByText("Fixture SRM access denied", { exact: false }).waitFor();
  const primaryRecordPath = path.join(temporary, "Grounds", "services", "azure-alerts-control-plane", "one-rp.json");
  const primaryRecord = JSON.parse(await fs.readFile(primaryRecordPath, "utf8"));
  assert.equal(primaryRecord.repositories.length, 2);
  assert.equal(primaryRecord.service.serviceTreeId, tree);
  assert.equal(primaryRecord.service.displayName, "OneRP");
  assert.deepEqual(primaryRecord.pipelines, { build: [], release: [] }, "Unverified declarations do not populate verified workspace pipelines.");
  const initialReferences = await page.evaluate(() => window.groundsDesktop.manifestPipelines("one-rp"));
  assert.equal(initialReferences[0].pipelines.build[0].definitionId, "42");
  assert.deepEqual(initialReferences[1].pipelines.release, [releaseLink]);
  const markerPath = path.join(temporary, "Grounds", "onboarding.json");
  const originalSetup = JSON.parse(await fs.readFile(markerPath, "utf8"));
  await application.evaluate(() => {
    const originalFetch = globalThis.fetch;
    let started;
    let completed;
    globalThis.smokeBackendStarted = new Promise((resolve) => { started = resolve; });
    globalThis.smokeBackendCompleted = new Promise((resolve) => { completed = resolve; });
    globalThis.smokeRestoreFetch = () => { globalThis.fetch = originalFetch; };
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (!url.startsWith("https://api.github.com/repos/grounds-fixture/pending")) return originalFetch(input, options);
      if (url.endsWith("/pending")) {
        started();
        await new Promise((resolve) => { globalThis.smokeReleaseBackend = resolve; });
        return new Response(JSON.stringify({ default_branch: "main", description: "Pending fixture" }));
      }
      if (url.endsWith("/readme")) completed();
      return new Response(JSON.stringify({ tree: [], content: "" }));
    };
  });
  await page.evaluate(() => {
    window.groundsDesktop.request({
      path: "/__grounds/service-onboarding/analyze", method: "POST",
      body: JSON.stringify({ repositoryUrl: "https://github.com/grounds-fixture/pending" }),
    }).catch((error) => console.error("Pending smoke request failed:", error));
  });
  await application.evaluate(() => globalThis.smokeBackendStarted);
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("checkbox", { name: "Catalog Component 1", exact: true }).check();
  await page.getByRole("button", { name: "Open workspace (1)", exact: true }).click();
  await page.getByRole("button", { name: "Open Catalog Component 1", exact: true }).waitFor({ timeout: 10_000 });
  const expandedSetup = JSON.parse(await fs.readFile(markerPath, "utf8"));
  assert.equal(expandedSetup.services.length, 4);
  assert.notEqual(expandedSetup.id, originalSetup.id);
  await page.evaluate((id) => window.groundsDesktop.finishOnboarding(id), originalSetup.id);
  assert.equal(JSON.parse(await fs.readFile(markerPath, "utf8")).id, expandedSetup.id);
  await application.evaluate(async () => {
    globalThis.smokeReleaseBackend();
    await globalThis.smokeBackendCompleted;
    globalThis.smokeRestoreFetch();
  });
  await page.getByText("Fixture SRM access denied", { exact: false }).waitFor();
  await page.evaluate(() => { window.smokeHoldSrm = true; });
  await page.getByRole("button", { name: "Retry failed discovery", exact: true }).click();
  await page.getByText("SRM deployment status: running", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Dismiss discovery", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("checkbox", { name: "Catalog Component 2", exact: true }).check();
  await page.getByRole("button", { name: "Open workspace (1)", exact: true }).click();
  await page.getByRole("button", { name: "Open Catalog Component 2", exact: true }).waitFor({ timeout: 10_000 });
  await application.close();
  const legacyPath = path.join(temporary, "Grounds", "services", "ungrouped", "other-component.json");
  const otherPath = path.join(temporary, "Grounds", "services", "other-component", "other-component.json");
  const legacy = JSON.parse(await fs.readFile(otherPath, "utf8"));
  delete legacy.service.domain;
  legacy.environments = [];
  await fs.mkdir(path.dirname(legacyPath));
  await fs.writeFile(legacyPath, JSON.stringify(legacy));
  await fs.rm(otherPath);
  application = await launch();
  page = await application.firstWindow();
  await page.getByRole("button", { name: "Open OneRP", exact: true }).waitFor();
  await page.getByText("Fixture SRM access denied", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Retry failed discovery", exact: true }).click();
  await page.getByText("SRM deployment status: done", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.smokeDiscoveryCalls), { repositories: 1, srm: 2 });
  await assert.rejects(fs.access(markerPath), { code: "ENOENT" });
  await page.getByRole("button", { name: "Dismiss discovery", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, "Grounds", "intelligence", "ev2", "service-groups.json"), "utf8")).observations, []);
  await page.evaluate(() => {
    const key = "grounds-page-cache:srm-release-status";
    const entry = JSON.parse(localStorage.getItem(key));
    entry.storedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    entry.value.serviceGroups = [];
    localStorage.setItem(key, JSON.stringify(entry));
  });
  await page.getByRole("button", { name: "Open Other Component", exact: true }).click();
  await page.locator(".service-group-card").waitFor();
  assert.equal(await page.evaluate(() => window.smokeDiscoveryCalls.srm), 3, "Service overview refreshes an expired empty SRM cache");
  assert.deepEqual(await page.locator(".service-group-card h4").allTextContents(), ["Prod.\u200BShared"]);
  await page.getByText("Unattributed Service Tree scope - ownership is not established.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open in EV2", exact: true }).count(), 0);
  await page.evaluate(() => {
    const key = "grounds-page-cache:srm-release-status";
    const entry = JSON.parse(localStorage.getItem(key));
    entry.storedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    entry.value.serviceGroups = [];
    localStorage.setItem(key, JSON.stringify(entry));
  });
  await page.evaluate(() => { window.location.hash = "#/service/other-component/deployments"; });
  await page.getByRole("heading", { name: "Deployments: Other Component", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: /^All current/ }).getAttribute("aria-selected"), "true");
  await page.getByRole("heading", { name: "Unattributed Service Tree scope", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.smokeDiscoveryCalls.srm), 4, "Deployment page refreshes an expired empty SRM cache");
  await page.locator(".deployment-group").getByText("Prod.Shared", { exact: true }).first().waitFor();
  assert.equal(await page.locator(".deployment-group").getByText("Failed", { exact: true }).count(), 1);
  assert.equal(await page.locator(".deployment-group").getByText("Prod.AlertsRP", { exact: true }).count(), 0);
  await page.getByRole("tab", { name: /^Versions/ }).click();
  await page.locator(".deployment-version-table").getByText("Unattributed Service Tree scope", { exact: true }).waitFor();
  await page.getByRole("tab", { name: /^Active/ }).click();
  await page.getByText("No deployments are currently pending or processing.", { exact: true }).waitFor();
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  for (const domain of ["Azure Alerts Control Plane", "Azure LA Ingestion", "Other Component"]) {
    assert.equal(await navigation.getByRole("button", { name: domain, exact: true }).count(), 1);
  }
  assert.equal(await navigation.getByRole("button", { name: "Ungrouped", exact: true }).count(), 0);
  const sharedDomain = "Operations / Billing & Ingestion";
  for (const name of ["OneRP", "LAMI"]) {
    await navigation.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
    await page.getByText("Edit service domain", { exact: true }).click();
    await page.getByLabel("Service domain", { exact: true }).fill(sharedDomain);
    await page.getByRole("button", { name: "Save domain", exact: true }).click();
    await page.waitForFunction(({ title, count }) => {
      const button = [...document.querySelectorAll('nav[aria-label="Primary navigation"] button')]
        .find((element) => element.getAttribute("aria-label") === title);
      return button?.querySelector(".nav-count")?.textContent === count;
    }, { title: sharedDomain, count: name === "OneRP" ? "1" : "2" });
  }
  const editedRecord = JSON.parse(await fs.readFile(primaryRecordPath, "utf8"));
  assert.equal(editedRecord.service.domain, sharedDomain);
  assert.deepEqual(editedRecord.repositories, primaryRecord.repositories);
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Open OneRP", exact: true }).click();
  assert.deepEqual(await page.locator(".service-group-card h4").allTextContents(), ["Prod.\u200BAlertsRP"]);
  await page.getByText(/^Unverified manifest references \(/).click();
  assert.equal(await page.getByRole("link", { name: "OneRP Official", exact: true }).getAttribute("href"), buildLink.url);
  assert.equal(await page.getByRole("link", { name: "Support Release", exact: true }).getAttribute("href"), releaseLink.url);
  const primaryManifestPath = path.join(repos, "primary", "GroundsManifest.json");
  const supportBefore = await fs.readFile(path.join(repos, "support", "GroundsManifest.json"), "utf8");
  const otherServicesBefore = JSON.parse(await fs.readFile(primaryManifestPath, "utf8")).services.slice(1);
  await page.getByText("Edit pipeline links", { exact: true }).click();
  const pipelineEditor = page.locator(".manifest-pipelines-editor");
  await pipelineEditor.getByRole("button", { name: "Save pipeline links", exact: true }).waitFor();
  await pipelineEditor.getByRole("combobox", { name: "Repository manifest", exact: true }).selectOption(path.join(repos, "support"));
  assert.equal(await pipelineEditor.getByLabel("release pipeline name 1", { exact: true }).inputValue(), "Support Release");
  await pipelineEditor.getByRole("combobox", { name: "Repository manifest", exact: true }).selectOption(path.join(repos, "primary"));
  await pipelineEditor.getByLabel("build pipeline name 1", { exact: true }).fill("Edited OneRP Build");
  const editedBuildUrl = buildLink.url.replace("42", "99");
  await pipelineEditor.getByLabel("build pipeline URL 1", { exact: true }).fill(editedBuildUrl);
  await pipelineEditor.getByRole("button", { name: "Add release link", exact: true }).click();
  await pipelineEditor.getByLabel("release pipeline name 1", { exact: true }).fill("Primary Release");
  await pipelineEditor.getByLabel("release pipeline URL 1", { exact: true }).fill("https://dev.azure.com/example/Project/_release?definitionId=101");
  await page.setViewportSize({ width: 390, height: 844 });
  const editorLayout = await pipelineEditor.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowing: [...element.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > element.getBoundingClientRect().right)
      .map((child) => `${child.tagName}: ${child.getBoundingClientRect().width}`),
  }));
  assert.ok(editorLayout.scrollWidth <= editorLayout.width, `Narrow pipeline editor overflow: ${JSON.stringify(editorLayout)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    pipelineEditor.getByRole("button", { name: "Save pipeline links", exact: true }).click(),
  ]);
  await page.getByText(/^Unverified manifest references \(/).click();
  await page.getByRole("link", { name: "Edited OneRP Build", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Edited OneRP Build", exact: true }).getAttribute("href"), editedBuildUrl);
  await page.getByRole("link", { name: "Primary Release", exact: true }).waitFor();
  await page.getByText("Edit pipeline links", { exact: true }).click();
  await pipelineEditor.getByRole("button", { name: "Remove build link 1", exact: true }).click();
  await pipelineEditor.getByRole("button", { name: "Remove release link 1", exact: true }).click();
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    pipelineEditor.getByRole("button", { name: "Save pipeline links", exact: true }).click(),
  ]);
  await page.getByText(/^Unverified manifest references \(/).click();
  await page.getByRole("link", { name: "Support Release", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Edited OneRP Build", exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Primary Release", exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(primaryManifestPath, "utf8")).services.slice(1), otherServicesBefore);
  assert.equal(await fs.readFile(path.join(repos, "support", "GroundsManifest.json"), "utf8"), supportBefore);
  const pipelineRecord = JSON.parse(await fs.readFile(primaryRecordPath, "utf8"));
  assert.deepEqual(pipelineRecord.pipelines, { build: [], release: [] });
  assert.equal(pipelineRecord.service.domain, sharedDomain);
  assert.equal(await navigation.getByRole("button", { name: "Flows", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Create Flow", exact: true }).click();
  await page.getByRole("heading", { name: "Architecture flow: OneRP", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Flow", exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => location.hash), "#/service/one-rp/flow");
  await page.getByRole("button", { name: "Back to service", exact: true }).click();
  await navigation.getByRole("button", { name: sharedDomain, exact: true }).click();
  await page.getByRole("button", { name: "Deployments", exact: true }).click();
  await page.getByRole("heading", { name: `Deployments: ${sharedDomain}`, exact: true }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#/domain/${encodeURIComponent(`domain:${sharedDomain}`)}/deployments`);
  await page.reload();
  await page.getByRole("heading", { name: `Deployments: ${sharedDomain}`, exact: true }).waitFor();
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Open OneRP", exact: true }).click();
  await page.evaluate(() => { window.location.hash = "#/service/one-rp/deployments"; });
  await page.getByRole("heading", { name: "Deployments: OneRP", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: /^All current/ }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByText("Prod.LAMetricIngestion", { exact: true }).count(), 0);
  await page.getByText("Prod.AlertsRP", { exact: true }).first().waitFor();
  const notes = await page.evaluate(async () => {
    const response = await fetch("/__grounds/work/notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceName: "one-rp", title: "Smoke note", body: "Persistence fixture" }),
    });
    return { status: response.status, value: await response.json() };
  });
  assert.equal(notes.status, 201);
  assert.equal(notes.value.note.title, "Smoke note");

  const pipelineRepo = path.join(repos, "pipelines");
  await fs.mkdir(pipelineRepo);
  await exec("git", ["init", "--quiet", "--initial-branch=main", pipelineRepo]);
  await exec("git", ["-C", pipelineRepo, "remote", "add", "origin", "https://dev.azure.com/example/Project/_git/pipelines"]);
  await exec("git", ["-C", pipelineRepo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const pipelineManifest = path.join(pipelineRepo, "GroundsManifest.json");
  await fs.writeFile(pipelineManifest, JSON.stringify({ schemaVersion: 1, services: [
    { name: "pipeline-component", displayName: "Pipeline Component", serviceTreeId: tree,
      pipelineMatching: { build: { names: ["Component-Official"] }, release: { namePrefixes: ["Component-Release-"] } } },
    { name: "pipeline-companion", displayName: "Pipeline Companion", serviceTreeId: tree },
  ] }));
  await application.evaluate(() => {
    const childProcess = process.getBuiltinModule("child_process");
    const fileSystem = process.getBuiltinModule("fs");
    const { EventEmitter } = process.getBuiltinModule("events");
    const { PassThrough } = process.getBuiltinModule("stream");
    const spawn = childProcess.spawn;
    const exists = fileSystem.existsSync;
    fileSystem.existsSync = (file) => String(file).includes("Microsoft\\SDKs\\Azure\\CLI2\\") || exists(file);
    childProcess.spawn = (command, args, options) => {
      if (!args.includes("get-access-token")) return spawn(command, args, options);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit("close", 1);
      queueMicrotask(() => { child.stdout.end("fixture-token\n"); child.emit("close", 0); });
      return child;
    };
    process.getBuiltinModule("module").syncBuiltinESMExports();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (value, options) => {
      const url = new URL(String(value));
      if (!["dev.azure.com", "vsrm.dev.azure.com"].includes(url.hostname)) return originalFetch(value, options);
      if (options.headers.Authorization !== "Bearer fixture-token") throw new Error("Smoke pipeline authentication boundary was not mocked.");
      if (globalThis.smokePipelineHold) {
        globalThis.smokePipelineStarted?.();
        await globalThis.smokePipelineHold;
      }
      if (globalThis.smokePipelineOffline) return new Response("denied", { status: 403 });
      if (url.pathname.endsWith("/git/repositories/pipelines")) return Response.json({ id: "repository", name: "pipelines", project: { id: "project" } });
      if (url.pathname.endsWith("/build/definitions")) return Response.json({ value: [
        [42, "Component-Official"], [43, "Component-Release-Global"], [44, "Unmapped Shared Release"],
      ].map(([id, name]) => ({
        id, name, queueStatus: "enabled", repository: { id: "repository", defaultBranch: "refs/heads/main" },
        process: { type: 2, yamlFilename: `.pipelines/${id === 42 ? "Official" : "Release"}.yml` },
      })) });
      if (url.pathname.endsWith("/items")) return Response.json({
        content: url.searchParams.get("path").includes("Official") ? "steps:\n- task: MSBuild@1\n" : "jobs:\n- deployment: production\n",
      });
      if (url.pathname.endsWith("/release/definitions")) return Response.json({ value: [{
        id: 43, name: "Component Classic Release", artifacts: [{
          type: "Build", definitionReference: { project: { id: "project" }, definition: { id: "42" } },
        }],
      }] });
      throw new Error(`Unexpected smoke pipeline endpoint: ${url.pathname}`);
    };
  });
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("checkbox", { name: "Pipeline Component", exact: true }).check();
  await page.getByRole("button", { name: "Open workspace (1)", exact: true }).click();
  await page.getByRole("button", { name: "Dismiss discovery", exact: true }).click();
  await page.getByRole("button", { name: "Open Pipeline Component", exact: true }).click();
  const releaseCard = page.locator(".pipeline-card").filter({ hasText: "Component-Release-Global" });
  await releaseCard.getByText("Release / azure-devops", { exact: true }).waitFor();
  assert.equal(await releaseCard.getByRole("link").getAttribute("href"), "https://dev.azure.com/example/Project/_build?definitionId=43");
  await page.locator(".pipeline-associations summary").click();
  const unmatched = page.locator(".pipeline-candidate").filter({ hasText: "Unmapped Shared Release" });
  await unmatched.getByRole("button", { name: "Use as release", exact: true }).click();
  await page.locator(".pipeline-card").filter({ hasText: "Unmapped Shared Release" }).waitFor();
  const confirmed = JSON.parse(await fs.readFile(pipelineManifest, "utf8"));
  assert.deepEqual(confirmed.services[0].pipelineMatching.release.definitionKeys, ["build:44"]);
  const classic = page.locator(".pipeline-candidate").filter({ hasText: "Component Classic Release" });
  await classic.getByRole("button", { name: "Use as release", exact: true }).click();
  const classicCard = page.locator(".pipeline-card").filter({ hasText: "Component Classic Release" });
  await classicCard.waitFor();
  assert.equal(await classicCard.getByRole("link").getAttribute("href"), "https://dev.azure.com/example/Project/_release?definitionId=43");
  await page.getByText("Edit pipeline links", { exact: true }).click();
  await page.locator(".manifest-pipelines-editor").getByRole("button", { name: "Add build link", exact: true }).click();
  await page.getByLabel("build pipeline name 1", { exact: true }).fill("Unsaved pipeline draft");
  await application.evaluate(() => { globalThis.smokePipelineOffline = true; });
  await page.getByRole("button", { name: "Refresh pipelines", exact: true }).click();
  await page.locator(".pipeline-discovery [role=alert]").filter({ hasText: "403" }).waitFor();
  assert.equal(await page.getByLabel("build pipeline name 1", { exact: true }).inputValue(), "Unsaved pipeline draft");
  assert.equal(await releaseCard.count(), 1);
  await application.evaluate(() => {
    globalThis.smokePipelineOffline = false;
    globalThis.smokePipelineHold = new Promise((resolve) => { globalThis.smokeReleasePipelines = resolve; });
    globalThis.smokePipelineRequestStarted = new Promise((resolve) => { globalThis.smokePipelineStarted = resolve; });
  });
  await page.getByRole("button", { name: "Refresh pipelines", exact: true }).click();
  await application.evaluate(() => globalThis.smokePipelineRequestStarted);
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("checkbox", { name: "Pipeline Companion", exact: true }).check();
  await page.getByRole("button", { name: "Open workspace (1)", exact: true }).click();
  await page.getByRole("button", { name: "Open Pipeline Companion", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Dismiss discovery", exact: true }).click();
  await application.evaluate(() => { globalThis.smokeReleasePipelines(); globalThis.smokePipelineHold = undefined; });
  await page.getByRole("button", { name: "Open Pipeline Component", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) =>
    button.textContent === "Refresh pipelines" && !button.disabled));
  await releaseCard.waitFor();
  const verifiedRecord = JSON.parse(await fs.readFile(path.join(temporary, "Grounds", "services", "pipeline-component", "pipeline-component.json"), "utf8"));
  assert.equal(verifiedRecord.pipelines.release.length, 3);
  verifiedRecord.environments = [{ name: "Public fixture", cloud: "public", status: "unknown" }];
  await fs.writeFile(path.join(temporary, "Grounds", "services", "pipeline-component", "pipeline-component.json"), JSON.stringify(verifiedRecord));
  await application.evaluate(async ({ app }) => {
    const path = process.getBuiltinModule("node:path");
    const require = process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(), "package.json"));
    const { CopilotClient } = require(path.join(app.getAppPath(), "node_modules", "@github", "copilot-sdk", "dist", "index.js"));
    const { createCopilotClient, restrictedSessionOptions, copilotEnvironment } = require(path.join(app.getAppPath(), "tools", "copilot-runtime.mjs"));
    const fs = process.getBuiltinModule("node:fs/promises");
    const directory = path.join(app.getPath("userData"), ".grounds", "runtime-smoke-probe");
    await fs.mkdir(directory, { recursive: true });
    const probe = await createCopilotClient({
      baseDirectory: directory, workingDirectory: directory,
      useLoggedInUser: false, env: copilotEnvironment(), logLevel: "none",
    });
    const requests = [];
    const server = process.getBuiltinModule("node:http").createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "fixture", object: "chat.completion", created: 1, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "Synthetic local response." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await probe.start();
      const session = await probe.createSession({
        ...restrictedSessionOptions(directory), model: "fixture",
        provider: { type: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-local-only" },
      });
      const account = await session.rpc.accounts.get({ query: { kind: "status" } });
      if (account.status.isAuthenticated) throw new Error("A clean Copilot runtime reused ambient authentication.");
      await session.rpc.tools.initializeAndValidate();
      if ((await session.rpc.tools.getCurrentMetadata()).tools?.length !== 0) {
        throw new Error("The restricted Copilot runtime exposed execution tools.");
      }
      await session.sendAndWait({ prompt: "First-service-private-marker" }, 20_000);
      await session.abort();
      const first = (await session.getEvents()).find((event) => event.type === "user.message");
      if (!first) throw new Error("The native runtime did not record the synthetic user turn.");
      const truncated = await session.rpc.history.truncate({ eventId: first.id });
      if (truncated.checkpointCleanupFailed ||
        (await session.getEvents()).some((event) => ["user.message", "assistant.message"].includes(event.type))) {
        throw new Error("The native runtime did not clear the first service's conversation.");
      }
      await session.sendAndWait({ prompt: "Second-service-independent-marker" }, 20_000);
      if (requests.length !== 2 || JSON.stringify(requests[1]).includes("First-service-private-marker") ||
        !JSON.stringify(requests[1]).includes("Second-service-independent-marker")) {
        throw new Error("Native session reuse leaked earlier service context into the next model request.");
      }
      await session.disconnect();
      await probe.deleteSession(session.sessionId);
    } finally {
      try {
        if ((await probe.stop()).length) throw new Error("The native Copilot runtime did not stop cleanly.");
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
    const state = globalThis.smokeCopilot = { authenticated: false, login: "smoke-operator", prompts: [] };
    CopilotClient.prototype.start = async function () {};
    CopilotClient.prototype.stop = async function () { return []; };
    CopilotClient.prototype.deleteSession = async function () {};
    CopilotClient.prototype.createSession = async function () {
      const local = { authenticated: false, login: undefined, events: [], listeners: new Set() };
      return {
        sessionId: `smoke-${state.prompts.length}`,
        on(listener) { local.listeners.add(listener); return () => local.listeners.delete(listener); },
        async getEvents() { return local.events; },
        async abort() { state.releaseArchitecture?.(); },
        async disconnect() {},
        async sendAndWait({ prompt }) {
          if (!local.authenticated) throw new Error("A fresh SDK session has no authenticated operator.");
          if (local.events.length) throw new Error("Previous service context was not cleared.");
          state.prompts.push(JSON.parse(prompt));
          local.events.push({ id: `user-${state.prompts.length}`, type: "user.message" });
          if (state.rejectAuth) {
            for (const listener of local.listeners) listener({
              type: "session.error", data: { errorType: "authentication", statusCode: 401, message: "Synthetic rejected sign-in" },
            });
            throw new Error("Synthetic rejected sign-in");
          }
          if (state.fail) throw new Error("Synthetic provider unavailable");
          const input = state.prompts.at(-1);
          if (input.task === "architecture-flow") {
            if (state.holdArchitecture) await new Promise((resolve) => { state.releaseArchitecture = resolve; });
            const sourceId = input.evidence.code[0]?.sourceId ?? 1;
            const displayName = input.evidence.catalog.service.displayName;
            return { data: { content: JSON.stringify({
              title: `${displayName} logical overview`, summary: "A bounded evidence-backed logical draft.",
              nodes: [
                { id: "service", label: displayName, kind: "service", description: "The selected operator-facing service.", evidenceSourceIds: [1] },
                { id: "queue", label: "Work queue", kind: "queue", description: "Receives published work.", evidenceSourceIds: [sourceId] },
              ],
              edges: [{ id: "publish", source: "service", target: "queue", label: "Publishes work", evidenceSourceIds: [sourceId] }],
              uncertainties: ["The available evidence does not establish a protocol or network topology."],
            }) } };
          }
          return { data: { content: `Smoke model response ${state.prompts.length}. [1]${input.evidence.architecture ? ` [${input.evidence.architecture.sourceId}]` : ""}` } };
        },
        rpc: { history: {
          async truncate() { const count = local.events.length; local.events = []; return { eventsRemoved: count }; },
        }, accounts: {
          async get() { return { kind: "status", status: {
            isAuthenticated: local.authenticated, activeLogin: local.login,
            activeHost: "https://github.com", accountCount: local.authenticated ? 1 : 0,
          } }; },
          async enumerate() { return { kind: "accounts", items: [
            ...(local.authenticated ? [{ login: local.login, host: "https://github.com", selectionId: local.login }] : []),
          ] }; },
          async set({ command }) {
            if (command.kind === "logout") state.authenticated = local.authenticated = false;
            return { ok: true };
          },
          login: {
            async begin() { return {
              flowId: "smoke-sign-in", step: { kind: "open-url", url: "https://github.com/login/oauth/authorize?client_id=smoke" },
            }; },
            async advance() {
              return new Promise((resolve) => { state.finishLogin = () => {
                state.authenticated = true;
                local.authenticated = true;
                local.login = state.login;
                resolve({ kind: "completed", result: { status: "completed" } });
              }; });
            },
            async cancel() { state.finishLogin?.(); },
          },
        } },
      };
    };
  });
  await page.getByRole("button", { name: "Troubleshoot", exact: true }).click();
  const composer = page.locator(".service-chat-composer textarea");
  await page.getByRole("button", { name: "Connect GitHub Copilot", exact: true }).waitFor();
  assert.equal(await composer.isDisabled(), true);
  async function connectCopilot(login) {
    await application.evaluate((_electron, nextLogin) => { globalThis.smokeCopilot.login = nextLogin; }, login);
    await page.getByRole("button", { name: /^(Connect|Reconnect) GitHub Copilot$/ }).click();
    await page.getByRole("link", { name: "Open GitHub sign-in", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Open GitHub sign-in" }).getAttribute("href"),
      "https://github.com/login/oauth/authorize?client_id=smoke");
    await application.evaluate(() => globalThis.smokeCopilot.finishLogin());
    const connected = await page.evaluate(async () => (await fetch("/__grounds/service-chat/copilot/status")).json());
    assert.equal(connected.authenticated, true, JSON.stringify(connected));
    try {
      await page.getByText(`Connected as ${login}`, { exact: true }).waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(`Copilot connection UI did not update: ${await page.locator(".service-chat-connection").innerText()}`, { cause: error });
    }
    await page.waitForFunction(() => !document.querySelector(".service-chat-composer textarea").disabled);
  }
  await connectCopilot("smoke-operator");
  await page.locator(".service-chat-context select").first().selectOption("public");
  await composer.fill("Smoke monitor is unhealthy");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".service-chat-message.assistant").filter({ hasText: "Smoke model response 1." }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".service-chat-composer textarea").disabled);
  await composer.fill("Compare with my previous observation");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".service-chat-message.assistant").filter({ hasText: "Smoke model response 2." }).waitFor();
  const prompts = await application.evaluate(() => globalThis.smokeCopilot.prompts);
  assert.equal(prompts[1].history.length, 2);
  assert.equal(prompts[1].history[0].content, "Smoke monitor is unhealthy");
  assert.equal(prompts[1].history[0].context.environment, "public");
  await page.waitForFunction(() => !document.querySelector(".service-chat-composer textarea").disabled);
  await application.evaluate(() => { globalThis.smokeCopilot.fail = true; });
  await composer.fill("Keep the failed question as a draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".service-chat-composer [role=alert]").filter({ hasText: "could not complete" }).waitFor();
  assert.equal(await composer.inputValue(), "Keep the failed question as a draft");
  assert.equal(await page.locator(".service-chat-message.assistant").count(), 2);
  await page.getByText("Connected as smoke-operator", { exact: true }).waitFor();
  await application.evaluate(() => { globalThis.smokeCopilot.fail = false; globalThis.smokeCopilot.rejectAuth = true; });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Reconnect GitHub Copilot", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "Keep the failed question as a draft");
  assert.equal(await composer.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  await application.evaluate(() => { globalThis.smokeCopilot.rejectAuth = false; });
  await connectCopilot("smoke-operator");
  assert.equal(await composer.inputValue(), "Keep the failed question as a draft");
  assert.equal(await page.locator(".service-chat-message.assistant").count(), 2);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".service-chat-message.assistant").filter({ hasText: "Smoke model response 5." }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".service-chat-composer textarea").disabled);
  await page.getByRole("button", { name: "Sign out of Copilot", exact: true }).click();
  await connectCopilot("smoke-other-operator");
  assert.equal(await page.locator(".service-chat-sessions article").count(), 0);
  assert.equal(await page.locator(".service-chat-message").count(), 0);
  assert.equal(await composer.inputValue(), "");
  await page.getByRole("button", { name: "Sign out of Copilot", exact: true }).click();
  await connectCopilot("smoke-operator");
  await page.locator(".service-chat-message.assistant").nth(2).waitFor();
  assert.equal(await page.locator(".service-chat-message").count(), 6);
  const beforeArchitecture = await application.evaluate(() => globalThis.smokeCopilot.prompts.length);
  await page.evaluate(() => { window.location.hash = "#/service/one-rp/flow"; });
  await page.getByText("No saved architecture flow for this service and operator. Create Flow starts the first analysis.", { exact: true }).waitFor();
  assert.equal(await application.evaluate(() => globalThis.smokeCopilot.prompts.length), beforeArchitecture);
  await page.getByRole("button", { name: "Create Flow", exact: true }).click();
  try {
    await page.getByRole("heading", { name: "OneRP logical overview", exact: true }).waitFor();
  } catch (error) {
    throw new Error(`Architecture generation did not finish: ${await page.locator(".architecture-page").innerText()}`, { cause: error });
  }
  try {
    await page.locator(".architecture-canvas .react-flow__edge-path").waitFor({ state: "attached", timeout: 10_000 });
  } catch (error) {
    throw new Error(`Architecture rendering failed: ${await page.locator(".architecture-page").innerText()}`, { cause: error });
  }
  assert.equal(await page.locator(".architecture-canvas .react-flow__node").count(), 2);
  assert.match(await page.locator(".architecture-canvas .react-flow__edge-path").getAttribute("marker-end"), /^url\(/);
  await page.locator(".architecture-contents summary").click();
  await page.getByRole("button", { name: "OneRP to Work queue: Publishes work", exact: true }).click();
  await page.getByRole("complementary", { name: "Selected architecture evidence" }).getByText(/Architecture: OneRP publishes work/).waitFor();
  const draft = await page.evaluate(async () => (await (await fetch("/__grounds/service-chat/architecture/one-rp")).json()).flow);
  assert.equal(draft.status, "draft");
  assert.equal(draft.repositories[0].revision, null, "An unborn fixture repository must not claim a committed snapshot.");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await page.getByText("Operator reviewed - not independently verified", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "OneRP logical overview", exact: true }).waitFor();
  await page.locator(".architecture-canvas .react-flow__edge-path").waitFor({ state: "attached" });
  assert.equal(await application.evaluate(() => globalThis.smokeCopilot.prompts.length), beforeArchitecture + 1);
  await application.evaluate(() => { globalThis.smokeCopilot.holdArchitecture = true; });
  await page.getByRole("button", { name: "Regenerate Flow", exact: true }).click();
  await page.getByText("Copilot is constructing an evidence-backed architecture draft...", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel generation", exact: true }).click();
  await page.getByText("Generation cancelled. The previous saved flow was not changed.", { exact: true }).waitFor();
  await application.evaluate(() => { globalThis.smokeCopilot.holdArchitecture = false; });
  const preserved = await page.evaluate(async () => (await (await fetch("/__grounds/service-chat/architecture/one-rp")).json()).flow);
  assert.equal(preserved.id, draft.id);
  assert.equal(preserved.status, "reviewed");
  await page.getByRole("button", { name: "Troubleshoot with flow", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".service-chat-composer textarea").disabled);
  await composer.fill("Use my saved flow to explain this relationship");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".service-chat-message.assistant").first().waitFor();
  const architecturePrompt = await application.evaluate(() => globalThis.smokeCopilot.prompts.at(-1));
  assert.equal(architecturePrompt.evidence.architecture.id, draft.id);
  assert.equal(architecturePrompt.evidence.architecture.status, "reviewed");
  await page.locator(".service-chat-message.assistant .chat-citation").last().click();
  assert.equal(await page.evaluate(() => location.hash), "#/service/one-rp/troubleshoot");
  await page.getByRole("link", { name: /OneRP reviewed architecture flow/ }).click();
  await page.getByRole("heading", { name: "OneRP logical overview", exact: true }).waitFor();
  await page.getByRole("button", { name: "Troubleshoot with flow", exact: true }).click();
  await page.getByRole("button", { name: "Sign out of Copilot", exact: true }).click();
  await connectCopilot("smoke-other-operator");
  const afterArchitecture = await application.evaluate(() => globalThis.smokeCopilot.prompts.length);
  await page.getByRole("button", { name: "Architecture flow", exact: true }).click();
  await page.getByText("No saved architecture flow for this service and operator. Create Flow starts the first analysis.", { exact: true }).waitFor();
  assert.equal(await application.evaluate(() => globalThis.smokeCopilot.prompts.length), afterArchitecture);
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await page.getByRole("button", { name: "Open OneRP", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("checkbox", { name: "OneRP - Already in workspace", exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "OneRP - Already in workspace", exact: true }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: "OneRP - Already in workspace", exact: true }).isDisabled(), true);
  const restored = await page.evaluate(async () => (await fetch("/__grounds/work/notes")).json());
  assert.equal(restored.notes[0].title, "Smoke note");
  for (const highContrast of [false, true]) {
    await page.evaluate((contrast) => {
      window.localStorage.setItem("grounds-color-mode", "dark");
      window.localStorage.setItem("grounds-high-contrast", String(contrast));
    }, highContrast);
    await page.reload();
    await page.getByRole("button", { name: "Add service", exact: true }).click();
    await page.getByRole("heading", { name: "Available services" }).waitFor();
    await page.getByRole("checkbox", { name: "OneRP - Already in workspace", exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.locator("html").getAttribute("data-contrast"), highContrast ? "high" : "normal");
    assert.equal(await page.evaluate(() =>
      getComputedStyle(document.querySelector(".desktop-onboarding")).backgroundColor === getComputedStyle(document.documentElement).backgroundColor), true);
  }
  console.log("Electron smoke passed: on-demand service architecture, directed diagrams, evidence, review, cancellation and saved-flow troubleshooting; Copilot connection, contextual responses and account isolation; pipelines, manifest CRUD, onboarding, deployments, appearance and persistence.");
} finally {
  await application?.evaluate(() => { globalThis.smokeReleaseBackend?.(); globalThis.smokeReleasePipelines?.(); })
    .catch((error) => console.error("Unable to release smoke backend request:", error));
  await application?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
