# Onboard your first service

Grounds keeps organization-specific service and deployment data local. Private
records are loaded by the application but ignored by Git.

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

Grounds queries SRM by the `serviceTreeId` in the service record and caches the
response in browser storage. The refresh button bypasses the server cache.

### Get Service Groups

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
