import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { adoWorkItemsPlugin } from "./tools/ado-work-items-plugin.mjs";
import { deploymentDiffsPlugin } from "./tools/deployment-diffs-plugin.mjs";
import { gitHistoryPlugin } from "./tools/git-history-plugin.mjs";
import { localReposPlugin } from "./tools/local-repos-plugin.mjs";
import { operationalIntelligencePlugin } from "./tools/operational-intelligence-plugin.mjs";
import { serviceCatalogPlugin } from "./tools/service-catalog-plugin.mjs";
import { serviceChatPlugin } from "./tools/service-chat-plugin.mjs";
import { srmCompanionPlugin } from "./tools/srm-companion-plugin.mjs";
import { srmStatusPlugin } from "./tools/srm-status-plugin.mjs";
import { workCompanionPlugin } from "./tools/work-companion-plugin.mjs";

export default defineConfig(({ mode }) => ({
  base: mode === "desktop" ? "./" : "/",
  build: { outDir: mode === "desktop" ? "dist-desktop" : "dist" },
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  plugins: mode === "desktop" ? [
    {
      name: "grounds-desktop-data",
      resolveId(id) {
        if (id.startsWith("virtual:")) return `\0${id}`;
      },
      load(id) {
        if (id === "\0virtual:service-catalog") {
          return "export const catalogEntries = []; export const initialValidation = {};";
        }
        if (id === "\0virtual:operational-intelligence") {
          return [
            'export const ev2ServiceGroupData = { observations: [] };',
            'export const srmObservationData = { releases: [] };',
            'export const teamsIntelligenceSnapshot = { signals: [] };',
          ].join("\n");
        }
      },
    },
    react(),
  ] : [
    serviceCatalogPlugin(),
    operationalIntelligencePlugin(),
    serviceChatPlugin(),
    srmCompanionPlugin(),
    srmStatusPlugin(),
    workCompanionPlugin(),
    adoWorkItemsPlugin(),
    deploymentDiffsPlugin(),
    gitHistoryPlugin(),
    localReposPlugin(),
    react(),
  ],
}));
