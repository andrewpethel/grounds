const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("groundsDesktop", {
  snapshot: () => ipcRenderer.invoke("grounds:snapshot"),
  availableServices: (chooseFolder) => ipcRenderer.invoke("grounds:available-services", chooseFolder),
  createManifest: (input) => ipcRenderer.invoke("grounds:create-manifest", input),
  openManifestWorkspace: (input) => ipcRenderer.invoke("grounds:open-manifest-workspace", input),
  selectRepositories: (scanId) => ipcRenderer.invoke("grounds:select-repositories", scanId),
  saveWorkspace: (input) => ipcRenderer.invoke("grounds:save-workspace", input),
  finishOnboarding: (id) => ipcRenderer.invoke("grounds:finish-onboarding", id),
  manifestPipelines: (serviceName) => ipcRenderer.invoke("grounds:manifest-pipelines", serviceName),
  discoverPipelines: (force) => ipcRenderer.invoke("grounds:discover-pipelines", force),
  confirmPipeline: (input) => ipcRenderer.invoke("grounds:confirm-pipeline", input),
  updateManifestPipelines: (input) => ipcRenderer.invoke("grounds:update-manifest-pipelines", input),
  request: (input) => ipcRenderer.invoke("grounds:request", input),
  onDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("grounds:data-changed", listener);
    return () => ipcRenderer.removeListener("grounds:data-changed", listener);
  },
  onRepositoryScan: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("grounds:repository-scan", listener);
    return () => ipcRenderer.removeListener("grounds:repository-scan", listener);
  },
});
