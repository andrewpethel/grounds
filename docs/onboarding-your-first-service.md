# Onboard your first service

Grounds keeps organization-specific service and deployment data local. Private
records are loaded by the application but ignored by Git.

## Windows desktop onboarding

For the Electron application, run `az login` and `npm run desktop`.

1. Choose a repositories folder, such as `C:\Development\Repos`. Grounds checks
   immediate child Git repositories, or the selected repository itself, for
   `GroundsManifest.json`. It remembers this folder on the Windows account.
2. Select services from the responsive **Available services** grid, choose the
   deployment cloud in **Setup options**, and click the sticky **Open workspace**
   footer. The setup sidebar starts open and can be collapsed; on narrow screens
   it moves above the catalog. Already-added service keys appear checked and
   cannot be overwritten. Service domains come from each manifest's optional
   `domain` title, falling back to the service's display name.
3. Use the dashboard immediately. Pipeline verification runs automatically in
   the background; review its results in each service's **Build and release**
   section. Repository and SRM discovery run in a
   non-blocking panel. Retry failed operations or dismiss the panel and refresh
   later. You can add more services while discovery runs or displays errors;
   neither completion nor dismissal is required. EV2 discovery remains on demand
   because it can open Edge for sign-in.

### Repository manifest

Put one `GroundsManifest.json` at the Git repository root:

```json
{
  "schemaVersion": 1,
  "services": [
    {
      "name": "azure-alerts-one-rp",
      "displayName": "OneRP",
      "domain": "Azure Alerts Control Plane",
      "serviceTreeId": "11111111-2222-4333-8444-555555555555",
      "description": "Operator-facing alert resource control plane.",
      "deploymentMatching": {
        "serviceGroupNameContains": [".AlertsRP"]
      },
      "sourcePaths": ["src/OneRP"],
      "pipelines": {
        "build": [
          {
            "name": "OneRP Official",
            "provider": "azure-devops",
            "url": "https://dev.azure.com/example/Project/_build?definitionId=42"
          }
        ],
        "release": [
          {
            "name": "OneRP Release",
            "provider": "azure-devops",
            "url": "https://dev.azure.com/example/Project/_release?definitionId=73"
          }
        ]
      }
    }
  ]
}
```

Only `name`, `displayName`, and `serviceTreeId` are required for each service.
The name is a stable lowercase, hyphen-separated Grounds key, not a Service Tree
GUID. The display name is what operators call the service; it need not match
the repository or Service Tree name. Description defaults to the display name.
The schema is in `grounds_manifest_schema.json`.

Service domains are dynamic, not a fixed Control Plane/Data Plane taxonomy.
Use the same optional `domain` title to group related services; only domains
present in your workspace appear in navigation and filters. Sharing a Service
Tree ID does not automatically group services. Without a domain title, the
service's display name is used, including older records stored in an
`ungrouped` directory. Domain titles can contain spaces and punctuation and must
be at most 150 characters with no control characters.

Open a service and select **Edit service domain** to change its workspace-local
title. Clear the field to restore the display-name fallback. These edits preserve
other metadata and do not move files or modify repository manifests. Set
`domain` in the manifest separately to give new workspaces the same grouping.

Repositories can declare multiple services, and a service can appear in multiple
repositories. Grounds groups by **service key**, never Service Tree ID.
Declarations for the same key must agree on display name, Service Tree ID,
description, effective domain title, and deployment matching. Source paths and
pipeline contributions can differ by repository.
Conflicts are visible and block that service, rather than silently merging
different components. For example, OneRP and LAMI can have different keys and
deployment selectors while sharing a Service Tree ID.

Optional deployment matching fields:

| Field | Behavior |
|---|---|
| `deploymentMatching.serviceGroupNames` | Exact service-group names. |
| `deploymentMatching.serviceGroupNameContains` | Literal substrings of service-group names; not regex or globs. |
| `sourcePaths` | Literal repository-relative files/directories for troubleshooting code search and existing cataloged-path comparisons; not deployment selectors. Use `/` or `\` separators. No absolute paths, traversal, or globs. |

Deployment matching first scopes by Service Tree ID. Selectors are
case-insensitive: entries within a list are alternatives, and when both lists
exist, both constraints must match. Ambiguous ownership stays unresolved.
An explicit EV2 association cannot override a selector that excludes the group.
Existing `serviceGroupPatterns` records remain supported as substring selectors.
If selectors are absent, Grounds labels candidate data **Service Tree scope -
not narrowed to this service** and does not infer ownership even if only one
catalog service uses the ID. Zero selector matches never falls back to all
Service Tree deployments.

### Automatic build and release discovery

Azure DevOps repositories resolve automatically using Azure CLI authentication.
Grounds verifies the Git origin and Azure DevOps repository ID, finds registered
build/YAML definitions, and reads their YAML/templates from their registered Git
branches without executing them. Classic releases must reference build artifacts
from that repository/project or a Git artifact bound to that repository.
Build IDs and classic release IDs are separate namespaces. YAML deployments are
Release-role links to `_build`, never fabricated `_release` IDs.

Single-service manifests can infer a role from parsed build/deployment steps.
For shared repositories, a declared `pipelineFile` can associate a registered
YAML definition with the service; otherwise supply selectors or confirm an
association. All services in the manifest count when determining whether a
repository is shared, including those not onboarded. Filenames, Service Tree
membership, and the number of onboarded services do not prove ownership.
Unknown roles and classic releases require selectors/confirmation. A template
file becomes a link only if it is actually registered as a pipeline.

Optional service selectors:

```json
"pipelineMatching": {
  "build": { "names": ["Component-Official"] },
  "release": {
    "namePrefixes": ["Component-Release-"],
    "yamlPaths": [".pipelines/Release.Global.yml"]
  }
}
```

Each role accepts `names` (exact), `namePrefixes` (literal prefix), `yamlPaths`
(literal repository-relative paths), and `definitionKeys`. Names/paths compare
case-insensitively; all entries and selector fields are alternatives, not
intersections. Selectors apply only to contributions from that repository.
Setting a role's selector disables inference for other definitions in that role.
Matching both roles stays ambiguous. Multiple global/regional definitions can
all be selected; Grounds does not arbitrarily pick one.

Expand **Review pipeline associations** and choose **Use as build/release** to
confirm a specific definition. Grounds rechecks it live and writes only that
service's manifest selector, using a stable `definitionKeys` entry such as
`build:42` (YAML/classic build namespace) or `release:73` (classic release
namespace). This avoids confusing similarly named definitions or colliding IDs.
For renamed/replaced definitions, edit these optional selectors in the manifest.

Verified results are cached in `%LOCALAPPDATA%\Grounds\pipeline-discovery.json`
for 15 minutes. **Refresh pipelines** bypasses the cache. Manifest changes
invalidate the associated results. Offline/auth/permission failures are visible
and retain only previously verified links for an unchanged manifest; unavailable
definitions are not silently replaced by historical links. Definitions/YAML
are verified as of the displayed timestamp, not continuously monitored. A
successful check does not certify production usage or show live run status.
GitHub and other providers remain unverified references in this desktop flow.

Requests use HTTPS, bounded pagination/response sizes, timeouts, and no redirect
following. YAML/templates are read-only and bounded; external templates and
scripts are never executed. Discovery runs independently of onboarding, so
adding another service does not wait for authentication or network requests.

### Optional pipeline references

`pipelines.build` and `pipelines.release` are optional lists, with at most 100
links each. Every link needs `name`, `provider`, and an HTTPS `url` without
embedded credentials. Providers are `azure-devops`, `github-actions`, `ev2`,
`cloudseed`, and `other`. Optional metadata reuses the catalog's pipeline model:
`definitionId`, `pipelineFile`, `artifactName`, `environments`, and `description`.
Azure DevOps links containing `definitionId` supply that ID automatically; if
you also specify an ID, it must agree. Prefer pipeline definition/run pages;
source-file links are references, not live run status.

For a manifest-backed service, **GroundsManifest.json is the only manually
maintained onboarding configuration**. Grounds derives its local service record
from it; do not maintain a second service config just to display pipelines.
Opening/reloading the desktop workspace loads cached verified links and starts
discovery for already onboarded services. Declarations alone are not labeled
verified: historical links, name-filter listings, and source references appear
under **Unverified manifest references**. Removing a reference does not disable
otherwise selected/inferred definitions; refine/remove `pipelineMatching` to
change those associations. Service data and workspace-local domain edits remain
intact.

Open the service's **Build and release** section and expand **Edit pipeline
links** to create, read, update, or remove links. Choose the associated repository
manifest, then **Save pipeline links**. Drafts are retained when switching
repositories; save applies only to the selected repository. Reopen the editor to
reload, or use **Reload manifests and discard drafts** after an error. Concurrent
manifest changes are rejected rather than overwritten. New manifests can also
include links through **Build and release links (optional)** during setup.

Contributions from associated manifests are combined by stage, provider, and
URL; identical declarations deduplicate, and conflicting metadata is reported.
Shared Service Tree membership never assigns a pipeline to another service.
Saving reference edits changes only the selected service's manifest pipeline
field. Grounds never modifies service configuration, pipeline YAML, service
models, or deployment artifacts. A `pipelineFile` helps discovery match the
registered YAML path; it is not itself a live pipeline URL.

### Creating and keeping manifests local

Expand **Set up another repository** in the **Setup options** sidebar to create a manifest for an unconfigured
checkout. The form creates one service; edit the manifest to add more. The
**Add /GroundsManifest.json to this repository's .gitignore** checkbox explicitly
controls that edit. Existing manifests are never overwritten. Invalid manifests
show an error and require correction and a rescan.

Local ignored manifests are not distributed to teammates or fresh checkouts.
Do not put credentials, tokens, local absolute paths, selected-service state,
cloud preferences, or cached operational data in the manifest. Grounds stores
workspace state separately. The manifest is declarative and never executed.
This repository ignores the exact manifest filename by default.

Discovery reads ignored manifests directly, rather than scanning all repository
configuration. It does not follow directory symlinks, recurse below immediate
child repositories, or inspect dependency directories. Discovery is limited to
3,000 folder entries and 100 repositories; manifests must be regular files no
larger than 256 KB. Unsupported versions, fields, duplicate service keys, and
invalid literal Service Tree GUIDs produce visible errors.

Manifest declarations and Git origins/default branches are rechecked before
saving. Changes require a rescan. Records retain manifest file/field provenance.
A failed batch save rolls back records it created; existing records are not
renamed, overwritten, or merged automatically.

Git origins must identify Azure DevOps or GitHub repositories; supported SSH
origins are converted to HTTPS catalog links. These checks establish local
declarations, not registry ownership or live Service Tree validation. Ownership,
dependencies, pipelines, and operational impact still need service-owner review.

Records, intelligence, and SQLite data live under `%LOCALAPPDATA%\Grounds`.
Grounds defaults to light mode, including onboarding. Previously saved dark-mode
and high-contrast preferences are still respected.
Fresh desktop initialization creates empty operational snapshots and does not
import source-checkout records or bundled sample observations. Existing user
records are preserved on subsequent starts.
Saved setup survives application restarts, including interruption during discovery.
Use **Add service** to reopen service selection at any time. Newly selected
services join the pending discovery scope without overwriting existing records.
In-flight backend requests can finish independently while the refreshed workspace
opens. Successful discovery clears its restart marker automatically; failures
remain available for retry, including after restarting Grounds. **Dismiss discovery**
only hides the panel and clears its restart marker, not running requests or cached
results. There is no timer that silently dismisses failures.
The source checkout's
private records are not bundled into the installer or automatically migrated.

### Windows startup messages

Grounds invokes the Windows Azure CLI MSI installation's bundled Python directly,
without a command shell, avoiding Node's `DEP0190` warning while preserving
arguments literally. Install or repair Azure CLI if its bundled runtime is missing.

Chromium may report `Failed to start Media Foundation` when Windows lacks
`mf.dll`. Grounds' catalog and operational workflows do not require media
playback, so this message is non-fatal. On Windows N, install Microsoft's
[Media Feature Pack](https://support.microsoft.com/windows/media-feature-pack-for-windows-n-8622b390-4ce6-43c9-9b42-549e5328e407)
for your Windows version if media features are needed. Grounds does not disable
hardware acceleration or hide startup errors to suppress this OS-component warning.

The instructions below apply to the browser-based development application.

## 1. Start Grounds

Install the prerequisites:

- Node.js 22 or later
- Azure CLI
- Microsoft Edge
- Visual Studio Code for local repository actions

Then run:

```powershell
npm install
az login
npm run dev
```

Use the URL printed by Vite. The first server normally uses
`http://127.0.0.1:5173`; another running instance causes Vite to select the next
available port.

Authenticated features run through local Node middleware, so use `npm run dev`
rather than opening `dist/index.html` directly.

## 2. Create the service record

### URL onboarding

From the Service Catalog, select **Add service** and enter an Azure DevOps or
GitHub repository URL. Grounds reads available repository metadata, lets you
review the service fields, and writes a private service record under:

```text
services/<domain>/<service-name>.json
```

The repository initially appears as **Remote only**.

### Manual onboarding

Alternatively, copy:

```text
services/control-plane/example-service.json
```

Rename it and replace the example values. Important fields include:

- `service.name`: stable lowercase identifier.
- `service.displayName`: operator-facing name.
- `service.domain`: optional operator-defined grouping title; defaults to
  `service.displayName`, independently of the storage directory.
- `service.serviceTreeId`: exact Service Tree GUID used to join SRM and EV2
  data.
- `service.serviceGroupPatterns`: unique substrings used to associate
  deployments when several services share a Service Tree.
- `repositories`: source repository metadata.
- `operationalImpact`: customer and dependency impact used by reports.

Validate the record:

```powershell
npm run validate:services
```

Grounds watches `services/` and reloads valid records automatically.

## 3. Discover deployment data

### Refresh deployment status

This feature uses the active Azure CLI identity to request a token for the SRM
Kusto cluster. The signed-in identity must have database access.

```powershell
az account show
```

Grounds queries SRM by the `serviceTreeId` in the service record. SRM supplies the
visible group list even when no EV2 snapshot or portal link is configured.
Optional EV2 metadata enriches the display names, associations, and captured
details; it is not required to display current deployments.

Deployment views default to **All current**, including completed and failed
records. Groups without uniquely established ownership appear explicitly as
**Unattributed Service Tree scope**, including in single-service views. Sharing a
Service Tree never assigns a group to a service; deployment selectors still
restrict which records can appear.

The browser response cache is reused for up to five minutes when opening these
views. Older entries trigger a fresh query. The refresh button bypasses the
server cache as well.

### Enrich from EV2

This feature opens a dedicated Grounds Edge profile and navigates to EV2. Sign
in interactively if requested. Grounds captures the EV2 Service Group response
and writes it to:

```text
intelligence/ev2/service-groups.json
```

If the private file does not exist, Grounds initializes it from the sanitized
example. Changes are reloaded automatically.

Pinned SRM release details are stored similarly in:

```text
intelligence/srm/release-observations.json
```

These operational files are intentionally excluded from Git.

## 4. Enlist the repository locally

URL onboarding is sufficient for catalog metadata and remote links. A local
checkout enables the richer repository-backed features:

- branch freshness and pull recommendations on Local Repos
- dirty, ahead, and behind status
- Git history
- deployment build and commit comparisons
- bounded source-code searches during service troubleshooting
- **Open in VS Code**

Clone the repository, then update its service record:

```json
{
  "checkoutStatus": "available",
  "localPath": "C:\\Development\\Repos\\example-service"
}
```

Use an absolute path and keep the repository URL and default branch accurate.
Grounds displays **Local** after the service record reloads.

## 5. Optional troubleshooting knowledge

Copy the troubleshooting example and make `serviceName` match the catalog
service:

```text
troubleshooting/control-plane/example-service.json
```

Add known components, monitors, telemetry locations, search terms, and
playbooks. Validate with:

```powershell
npm run validate:troubleshooting
```

Do not place credentials, access tokens, private keys, or connection strings in
service, intelligence, or troubleshooting records.

In **Troubleshoot**, connect your approved GitHub Copilot account to get AI
answers using these records, bounded service-path code matches, captured
deployments, and recent investigation history. Questions and supplied evidence
are sent to GitHub Copilot; only include data approved for that provider.
Authentication is provider-managed with OS-protected storage, never a manifest
field. Conversation history is local and scoped to the connected GitHub account;
this does not yet ingest ADO Boards or IcMs or train shared operator knowledge.
See [GitHub Copilot troubleshooting](../README.md#github-copilot-troubleshooting)
for connection and data-handling details.

## 6. Create a service architecture flow on demand

Open the service and choose **Create Flow**. Connect an approved GitHub Copilot
account through **Troubleshoot**, then choose **Create Flow** in the service's
architecture workspace. A local checkout must be available. This explicit action
collects bounded tracked-file evidence from the service's cataloged source paths;
onboarding and opening a saved diagram do not perform architecture analysis.

Review the logical system overview, its directed relationships, source evidence,
and uncertainties. **Mark reviewed** records your review without claiming that
the diagram is independently verified or represents live deployed topology.
Use **Regenerate Flow** after source changes. Failed or cancelled generation
preserves the previous saved flow.

Flows are stored in Grounds' local database, scoped to service and connected
operator, not in `GroundsManifest.json` or service deployment artifacts.
The troubleshooter automatically uses that same service/operator flow, retaining
its draft/review status, source snapshot, and limitations. See
[Service architecture flows](../README.md#service-architecture-flows).
