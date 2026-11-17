# Grounds interactive demo

A standalone, static showcase for VibeHub. All services, source excerpts,
deployments, observations, and troubleshooting answers are fictional.
There is no authentication, backend, database, runtime API access, or worker.

The unnumbered **About Grounds** page explains the product's objectives and
flexible individual scope: one or several selected services, services spanning
repositories, and distinct components sharing a repository. It distinguishes
the real app's integrations and data handling from the four-step fictional demo.

From the repository root:

```powershell
npm run dev:demo
npm run test:demo
npm run package:demo
```

Upload `release-demo\grounds-demo.zip` as a **Vibe-project**. The archive has
`index.html` at its root. Packaging uses Windows PowerShell and .NET's built-in
ZIP support. To serve the production build locally, use `npm run preview:demo`.
Use an HTTP host rather than opening `index.html` as a local file.

## Boundaries

- `demo\vite.config.ts` does not load the web app's Vite configuration or
  operational plugins. It disables environment-file loading and public-file copying.
- Demo runtime source stays under `demo\src`. A build-time boundary check rejects
  imports from other repository directories. React is shared as a dependency,
  not as an application runtime.
- Demo CSS follows Grounds' existing palette and visual language but does not
  import `src\styles.css`, which loads external fonts. All demo assets are local.
- State stays in memory. Navigation preserves prepared answers; reset or reload
  clears them. There is no browser storage.
- Architecture positions and edges are authored in `scenario.ts`; no layout
  engine or worker is loaded.
- Production HTML blocks network connections and workers with a content security
  policy. Development omits that policy to allow Vite's local hot reload.
- Existing application startup, production Vite configuration, data, and desktop
  packaging rules are unchanged. The only root changes are additive npm scripts
  and ignored demo output directories.

`npm run test:demo` builds the actual static output and exercises it with
headless Microsoft Edge using the existing Playwright dependency. It serves
under a nested path, checks all four steps, evidence, prepared answers, reset,
hash navigation, themes, and narrow layouts, and fails on unexpected network
access, workers, persistent storage, browser errors, or CSP violations.
