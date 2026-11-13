# Grounds

Grounds is a local operator workspace for understanding services, deployments,
repository freshness, work items, architecture flows, and service-scoped
troubleshooting context.

## Windows desktop

Grounds can also run as an Electron Windows application. Install Git, Azure CLI,
and Microsoft Edge, then run:

```powershell
npm install
az login
npm run desktop
```

Choose a repositories folder, select entries from **Available services**, and
open the workspace. Grounds reads `GroundsManifest.json` at each repository
root; the selected folder can be a repository itself or contain immediate child
repositories. The folder is remembered locally. **Set up another repository**
can create a manifest and, with your explicit checkbox selection, add its exact
filename to that repository's `.gitignore`.

A manifest declares stable service keys and operator-facing names, independently
of Service Tree IDs. OneRP and LAMI, for example, can be distinct services under
the same Service Tree. Only matching service keys are combined across repositories;
conflicting declarations block onboarding. Optional exact/substring deployment
selectors narrow matching without treating all deployments under a Service Tree
as belonging to that service. See the
[manifest format and matching rules](docs/onboarding-your-first-service.md).

Azure DevOps build/release discovery runs automatically in the background.
Grounds verifies repository IDs, registered YAML paths/branches, queue state,
and classic release artifact associations. YAML deployment pipelines appear as
**Release** even though their portal URLs use `_build`. Shared-repository
ownership requires manifest evidence or explicit confirmation; matching a
Service Tree or finding an enabled pipeline is not proof of production usage.
Use **Build and release** to refresh or confirm associations. Optional
`pipelineMatching` selectors and `pipelines` references belong to that same
manifest, not a second onboarding config. Unverified/historical links are kept
separate from verified results. Workspace records and verification caches are
derived; service configuration, pipeline YAML, and deployment artifacts are
read-only.

The dashboard opens before repository and SRM discovery finish. Failures appear
in a non-blocking discovery panel and can be retried or dismissed; interrupted
discovery resumes on launch. EV2 service-group discovery is on demand, since it
may open Edge for sign-in and require the selected cloud's network. Grounds
does not execute manifests or verify Service Tree registration or ownership.

Desktop data is kept in `%LOCALAPPDATA%\Grounds`, separate from this source
checkout. Existing private records are not automatically imported. The renderer
is sandboxed and uses a restricted preload/IPC bridge; no localhost server or
listening application port is required for the workspace. Azure CLI authenticates
Azure DevOps features; the troubleshooter connects separately to GitHub Copilot.
Browser authentication can use a temporary local callback.

```powershell
npm run test:desktop
npm run desktop:build
npm run test:desktop:smoke
npm run desktop:package
```

The last command creates a Windows NSIS installer under `release\`. Builds are
unsigned unless signing credentials are configured for electron-builder.
Production signing, managed distribution/updates, and integrated Microsoft
sign-in are not included in this initial desktop implementation.

## GitHub Copilot troubleshooting

Open a service's **Troubleshoot** page and choose **Connect GitHub Copilot**,
then follow **Open GitHub sign-in** in your browser. Use an approved GitHub.com
account with GitHub Copilot access; Microsoft 365 Copilot access alone is not
a GitHub Copilot entitlement. Connect explicitly each time Grounds starts.
Sign-out and account changes are unavailable while an investigation is running.

The bundled Copilot SDK manages authentication and its OS-protected credential
cache. Grounds does not collect passwords, copy access tokens into its database,
or permit a plaintext-storage fallback. It does not reuse ambient PATs or Azure
CLI/GitHub CLI credentials. The renderer receives connection state, not tokens.
On Windows, provider state lives under
`%LOCALAPPDATA%\Grounds\.grounds\copilot`; do not copy or commit that directory.

Questions, recent conversation, and selected service evidence are sent to GitHub
Copilot. Only use repositories and operational data approved for that provider;
do not paste secrets. Evidence includes catalog/troubleshooting records, captured
deployment snapshots, and bounded text matches in the service's local repository
paths. This is not comprehensive repository indexing or live telemetry access.
The model has no execution, editing, deployment, or autonomous repository tools.
Answers cite supplied evidence; provider failures surface as errors, never canned
replacement answers.

Connection status and model requests use the same explicitly authenticated SDK
session. Its temporary conversation is cleared after every request; Grounds
supplies only the selected investigation's bounded history on the next request.
Expired or rejected authentication disables sending immediately and asks you to
reconnect, retaining your draft and selected investigation for the same account.
Network, policy, and quota failures do not by themselves sign you out.

Conversations remain locally in Grounds' database, partitioned by the connected
GitHub account. Recent turns and their saved environment/release context are
replayed on subsequent questions; older turns remain available locally but may
be omitted from the model's bounded context. Old ownerless conversations are
read-only and are never sent to Copilot. Failed questions retain their draft
without persisting an incomplete exchange. Account partitioning is application
isolation, not protection against someone with access to your Windows account.

This first integration does not train a model or publish shared knowledge.
ADO Boards/IcM ingestion, cross-team knowledge sharing, reviewed operator memory,
and streaming responses are not connected yet.

## Service architecture flows

Architecture belongs to each service rather than a global **Flows** menu.
Open a service and choose **Create Flow** to open its architecture workspace.
Connect Copilot through **Troubleshoot**, then explicitly choose **Create Flow**
in the architecture workspace to start analysis. Opening a service or saved flow
never triggers generation or repository scanning.

Generation reads bounded tracked-file matches inside the service's cataloged
repository paths, catalog dependencies, and selected operational knowledge.
It uses the same authenticated, tool-free Copilot session as troubleshooting.
Only one Copilot task runs at a time. Progress and cancellation are available;
leaving the page does not cancel a running job, but closing Grounds does.

Copilot returns schema-validated logical graph JSON, not executable diagram
markup. React Flow renders it with ELK layout/routing, directional labeled
arrows, consistent component types, an accessible contents list, and selectable
source evidence. This first view is a logical system overview, not a network,
deployment, or threat-model DFD. Unsupported topology remains uncertain;
sharing a repository or Service Tree never establishes ownership.

Successful generation atomically replaces that operator's saved flow for the
service in `%LOCALAPPDATA%\Grounds\.grounds\grounds.db`. Failed or cancelled
generation leaves the previous artifact intact. Source excerpts, revision and
working-state metadata, evidence fingerprint, uncertainties, and draft/review
status are retained locally. **Mark reviewed** records operator review, not
independent architectural verification. Regeneration creates a new draft.
Catalog changes are flagged; repository changes are not monitored, so regenerate
to include later changes. No service artifacts or manifests are modified.

The troubleshooter automatically receives only the current service's saved flow
for the connected operator, including its provenance and limitations. No flow is
created automatically for a chat question. Account partitioning is application
isolation, not protection against access to the same Windows account.

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
