# Grounds

Grounds is a local operator workspace for understanding services, deployments,
repository freshness, work items, architecture flows, and service-scoped
troubleshooting context.

## Run locally

Requirements:

- Node.js 22 or later
- Azure CLI for authenticated Azure DevOps features
- A Chromium-based browser for SRM collection features

```powershell
npm install
npm run dev
```

The development and preview servers bind to `127.0.0.1`. Local middleware
rejects requests that do not originate from the loopback interface.
Vite prints the active URL in the terminal; it normally uses port `5173` and
selects the next available port when another instance is already running.

See [Onboard your first service](docs/onboarding-your-first-service.md) to add
private service metadata and enable authenticated deployment features.

## Validate and build

```powershell
npm run validate:services
npm run build
```

## Local operational data

The repository contains sanitized example records only. Real service catalog,
deployment intelligence, and troubleshooting records are intentionally ignored
by Git because they may contain organization-specific topology, links, local
paths, or operational observations.

Copy an example record to a new `.json` file under the corresponding directory
and populate it locally:

- `services/`
- `troubleshooting/`
- `intelligence/`

Do not commit credentials, access tokens, private keys, connection strings, or
internal operational exports.

## License

Grounds is available under the [MIT License](LICENSE).
