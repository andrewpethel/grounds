import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { adoWorkItemsPlugin } from "./tools/ado-work-items-plugin.mjs";
import { deploymentDiffsPlugin } from "./tools/deployment-diffs-plugin.mjs";
import { gitHistoryPlugin } from "./tools/git-history-plugin.mjs";
import { localReposPlugin } from "./tools/local-repos-plugin.mjs";
import { serviceCatalogPlugin } from "./tools/service-catalog-plugin.mjs";
import { serviceChatPlugin } from "./tools/service-chat-plugin.mjs";
import { srmCompanionPlugin } from "./tools/srm-companion-plugin.mjs";
import { srmStatusPlugin } from "./tools/srm-status-plugin.mjs";
import { workCompanionPlugin } from "./tools/work-companion-plugin.mjs";

export default defineConfig({
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  plugins: [
    serviceCatalogPlugin(),
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
});
