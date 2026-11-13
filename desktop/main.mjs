import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeData, readSnapshot, createBackend } from "./backend.mjs";
import { inspectRepository, saveWorkspace } from "./onboarding.mjs";
import {
  createManifest, discoverManifests, saveManifestWorkspace,
  refreshManifestPipelines, readManifestPipelines, updateManifestPipelines,
  readPipelineInputs, confirmManifestPipeline,
} from "./manifest.mjs";
import { discoverPipelines, readPipelineDiscovery } from "./pipeline-discovery.mjs";
import { createCopilotRuntime } from "../tools/copilot-runtime.mjs";

const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = path.join(resources, "dist-desktop");
const origin = "grounds://app";
protocol.registerSchemesAsPrivileged([
  { scheme: "grounds", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const dataRoot = path.join(process.env.LOCALAPPDATA ?? app.getPath("appData"), "Grounds");
const copilot = createCopilotRuntime(dataRoot);
app.setPath("userData", dataRoot);
let window;
let backend;
let closing = false;
let resetting;
let loadingSnapshots = 0;
const retiringBackends = new Set();
let saving = false;
let scanning = false;
const selectedRepositories = new Map();
const setupFile = path.join(dataRoot, "onboarding.json");
const preferencesFile = path.join(dataRoot, "workspace.json");
let manifestCatalog;
let pipelineJob;
const pipelineAbort = new AbortController();

async function pipelineState() {
  const cache = await readPipelineDiscovery(dataRoot);
  const inputs = await readPipelineInputs(dataRoot);
  return {
    schemaVersion: 1,
    services: Object.fromEntries(inputs.filter((input) => input.fingerprint &&
      cache.services[input.serviceName]?.fingerprint === input.fingerprint)
      .map((input) => [input.serviceName, cache.services[input.serviceName]])),
  };
}

function resolvePipelines(force = false) {
  if (pipelineJob) return force ? pipelineJob.then(() => resolvePipelines(true)) : pipelineJob;
  pipelineJob = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inputs = await readPipelineInputs(dataRoot);
      const state = await discoverPipelines(dataRoot, inputs, {
        force, signal: AbortSignal.any([pipelineAbort.signal, AbortSignal.timeout(240_000)]),
      });
      const current = await readPipelineInputs(dataRoot);
      if (JSON.stringify(inputs) !== JSON.stringify(current)) continue;
      pipelineAbort.signal.throwIfAborted();
      loadingSnapshots++;
      try {
        const errors = await refreshManifestPipelines(dataRoot, state.services, { verifiedOnly: true });
        if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
        await resetBackend();
      } finally {
        loadingSnapshots--;
      }
      return state;
    }
    throw new Error("Repository manifests changed during pipeline discovery. Refresh again.");
  })().finally(() => { pipelineJob = undefined; });
  return pipelineJob;
}

async function readPreferences() {
  try {
    return JSON.parse(await fs.readFile(preferencesFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { cloud: "public" };
    throw error;
  }
}

async function scanManifests(directory) {
  const snapshot = await readSnapshot(dataRoot);
  manifestCatalog = await discoverManifests(directory, snapshot.catalogEntries.map((entry) => entry.record));
  manifestCatalog.cloud = (await readPreferences()).cloud ?? "public";
  return manifestCatalog;
}

async function readSetup() {
  try {
    const setup = JSON.parse(await fs.readFile(setupFile, "utf8"));
    // Resume markers written by the original single-service desktop wizard.
    return setup.services ? setup : { services: [{ serviceName: setup.serviceName, serviceTreeId: setup.serviceTreeId }], cloud: setup.cloud };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function resetBackend() {
  if (!resetting) {
    resetting = (async () => {
      let replacement;
      replacement = await createBackend(dataRoot, () => {
        if (!loadingSnapshots && backend === replacement && window && !window.isDestroyed()) {
          window.webContents.send("grounds:data-changed");
        }
      }, { copilot });
      const previous = backend;
      backend = replacement;
      if (previous) {
        const retirement = previous.close().catch((error) => console.error("Grounds background backend shutdown failed:", error))
          .finally(() => retiringBackends.delete(retirement));
        retiringBackends.add(retirement);
      }
    })().finally(() => { resetting = undefined; });
  }
  await resetting;
}

function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url.split("#")[0] !== `${origin}/index.html`) {
      throw new Error("Untrusted Grounds IPC sender.");
    }
    return action(...args);
  });
}

async function openExternal(value) {
  const url = new URL(value);
  if (!["https:", "vscode:"].includes(url.protocol)) throw new Error("External link protocol is not allowed.");
  if (url.protocol === "vscode:") {
    const result = await dialog.showMessageBox(window, {
      type: "question", buttons: ["Cancel", "Open VS Code"], defaultId: 0,
      message: "Open this location in Visual Studio Code?", detail: value,
    });
    if (result.response !== 1) return;
  }
  await shell.openExternal(url.href);
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 650,
    title: "Grounds", backgroundColor: "#f3f7f5", show: false,
    webPreferences: {
      preload: path.join(resources, "desktop", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webviewTag: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url).catch((error) => dialog.showErrorBox("Unable to open link", error.message));
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.split("#")[0] !== `${origin}/index.html`) {
      event.preventDefault();
      openExternal(url).catch((error) => dialog.showErrorBox("Unable to open link", error.message));
    }
  });
  window.once("ready-to-show", () => window.show());
  await window.loadURL(`${origin}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    await initializeData(dataRoot, resources);
    protocol.handle("grounds", async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "app" || request.method !== "GET") return new Response(null, { status: 403 });
      const filePath = path.resolve(rendererRoot, `.${decodeURIComponent(url.pathname).replaceAll("/", path.sep)}`);
      const relative = path.relative(rendererRoot, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response(null, { status: 403 });
      try {
        const result = await net.fetch(pathToFileURL(filePath).href);
        const headers = new Headers(result.headers);
        headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
        return new Response(result.body, { status: result.status, headers });
      } catch (error) {
        console.error("Unable to load Grounds asset:", error);
        return new Response("Unable to load Grounds asset.", { status: 404 });
      }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    handle("grounds:snapshot", async () => {
      loadingSnapshots++;
      try {
        const pipelineDiscovery = await pipelineState();
        const manifestPipelineErrors = await refreshManifestPipelines(dataRoot, pipelineDiscovery.services, { verifiedOnly: true });
        await resetBackend();
        return { ...await readSnapshot(dataRoot), manifestPipelineErrors, pipelineDiscovery, pendingOnboarding: await readSetup() };
      } finally {
        loadingSnapshots--;
      }
    });
    handle("grounds:manifest-pipelines", (serviceName) => readManifestPipelines(dataRoot, serviceName));
    handle("grounds:discover-pipelines", (force) => {
      if (typeof force !== "boolean") throw new Error("Specify whether pipeline discovery should refresh.");
      return resolvePipelines(force);
    });
    handle("grounds:confirm-pipeline", async (input) => {
      if (scanning || saving) throw new Error("Repository inspection or workspace save is already running.");
      if (!input || typeof input.serviceName !== "string" || typeof input.key !== "string" ||
          typeof input.fingerprint !== "string" || !["build", "release"].includes(input.stage)) {
        throw new Error("Choose a discovered pipeline and its service role.");
      }
      await resolvePipelines(true);
      const state = await pipelineState();
      const entry = state.services[input.serviceName];
      const candidate = entry?.candidates.find((candidate) => candidate.key === input.key);
      if (!candidate || candidate.cached || entry.fingerprint !== input.fingerprint) throw new Error("The pipeline or manifest changed, or could not be verified live. Refresh discovery before confirming.");
      if (scanning || saving) throw new Error("Repository inspection or workspace save is already running.");
      saving = true;
      try {
        await confirmManifestPipeline(dataRoot, input, candidate, entry.fingerprint);
      } finally {
        saving = false;
      }
      return resolvePipelines(true);
    });
    handle("grounds:update-manifest-pipelines", async (input) => {
      if (scanning || saving) throw new Error("Repository inspection or workspace save is already running.");
      saving = true;
      try {
        await updateManifestPipelines(dataRoot, input);
      } finally {
        saving = false;
      }
    });
    handle("grounds:request", async (input) => {
      if (resetting) await resetting;
      if (!backend) throw new Error("Grounds is not initialized.");
      return backend.request(input);
    });
    handle("grounds:available-services", async (chooseFolder) => {
      if (scanning || saving) throw new Error("Repository inspection or workspace save is already running.");
      scanning = true;
      try {
        let directory;
        if (chooseFolder) {
          const result = await dialog.showOpenDialog(window, {
            title: "Choose your repositories folder", properties: ["openDirectory"],
          });
          if (result.canceled) return null;
          directory = result.filePaths[0];
        } else {
          directory = (await readPreferences()).repositoryRoot;
          if (!directory) return null;
        }
        const catalog = await scanManifests(directory);
        await fs.writeFile(preferencesFile, `${JSON.stringify({ repositoryRoot: catalog.root, cloud: catalog.cloud })}\n`);
        return catalog;
      } finally {
        scanning = false;
      }
    });
    handle("grounds:create-manifest", async (input) => {
      if (scanning || saving) throw new Error("Repository inspection or workspace save is already running.");
      if (!input || typeof input.addToGitignore !== "boolean" ||
          !manifestCatalog?.repositories.some((row) => row.localPath === input.repositoryPath && !row.manifest && !row.error)) {
        throw new Error("Choose an unconfigured repository from the current catalog.");
      }
      saving = true;
      try {
        await createManifest(input.repositoryPath, input.manifest, input.addToGitignore);
        return await scanManifests(manifestCatalog.root);
      } finally {
        saving = false;
      }
    });
    handle("grounds:open-manifest-workspace", async (input) => {
      if (scanning || saving) throw new Error("Repository inspection or workspace save is already running.");
      saving = true;
      try {
        if (!manifestCatalog || !["public", "ussec", "usnat"].includes(input?.cloud)) throw new Error("Select available services and a supported cloud.");
        await fs.writeFile(preferencesFile, `${JSON.stringify({ repositoryRoot: manifestCatalog.root, cloud: input.cloud })}\n`);
        const setup = await saveManifestWorkspace(dataRoot, input, manifestCatalog);
        await resetBackend();
        return setup;
      } finally {
        saving = false;
      }
    });
    handle("grounds:select-repositories", async (scanId) => {
      if (!Number.isSafeInteger(scanId) || scanId < 1) throw new Error("Invalid repository scan.");
      if (scanning || saving) throw new Error("Repository inspection or workspace save is already running.");
      scanning = true;
      try {
        const result = await dialog.showOpenDialog(window, {
          title: "Select enlisted service repositories", properties: ["openDirectory", "multiSelections"],
        });
        if (result.canceled) return [];
        if (result.filePaths.length > 25) throw new Error("Select no more than 25 repositories.");
        selectedRepositories.clear();
        const send = (event) => { if (!window.isDestroyed()) window.webContents.send("grounds:repository-scan", { scanId, ...event }); };
        send({ type: "start", paths: result.filePaths });
        const scans = [];
        for (const selectedPath of result.filePaths) {
          send({ type: "progress", scan: { selectedPath, status: "scanning" } });
          let scan;
          try {
            const repository = await inspectRepository(selectedPath, (progress) =>
              send({ type: "progress", scan: { selectedPath, status: "scanning", ...progress } }));
            if (selectedRepositories.has(repository.localPath)) throw new Error("This checkout was selected more than once. Exclude the duplicate folder.");
            selectedRepositories.set(repository.localPath, repository);
            scan = { selectedPath, status: "done", repository };
          } catch (error) {
            scan = { selectedPath, status: "error", error: error.message };
          }
          scans.push(scan);
          send({ type: "progress", scan });
        }
        return scans;
      } finally {
        scanning = false;
      }
    });
    handle("grounds:save-workspace", async (input) => {
      if (saving || scanning) throw new Error("Repository inspection or workspace save is already running.");
      saving = true;
      try {
        const setup = await saveWorkspace(dataRoot, input, selectedRepositories);
        await resetBackend();
        return setup;
      } finally {
        saving = false;
      }
    });
    handle("grounds:finish-onboarding", async (id) => {
      const setup = await readSetup();
      if (saving || !setup || setup.id !== id) return;
      await fs.rm(setupFile, { force: true });
    });
    await createWindow();
  }).catch((error) => {
    dialog.showErrorBox("Grounds could not start", error.stack ?? error.message);
    app.quit();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    pipelineAbort.abort();
    Promise.all([copilot.close(), ...(backend ? [backend.close()] : []), ...retiringBackends, ...(pipelineJob ? [pipelineJob] : [])])
      .catch((error) => console.error("Grounds shutdown failed:", error)).finally(() => app.quit());
  });
}
