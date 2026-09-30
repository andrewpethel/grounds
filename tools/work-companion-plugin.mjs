import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isLocalRequest } from "./local-request.mjs";

const azureDevOpsResource = "499b84ac-1321-427f-aa17-267ca6975798";
const serviceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 250_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function requireServiceName(value) {
  if (typeof value !== "string" || !serviceNamePattern.test(value)) {
    throw new Error("A valid Grounds service name is required.");
  }
  return value;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    throw new Error("Service-group tags must be an array.");
  }

  const tags = value.map((tag) => {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > 300) {
      throw new Error("Every service-group tag must be a non-empty string.");
    }
    return tag;
  });
  return [...new Set(tags)];
}

function parseNote(row) {
  return {
    id: row.id,
    serviceName: row.service_name,
    title: row.title,
    body: row.body,
    serviceGroupIds: JSON.parse(row.service_group_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseBoardUrl(value) {
  let boardUrl;
  try {
    boardUrl = new URL(value);
  } catch {
    throw new Error("Enter a valid Azure DevOps Boards URL.");
  }

  if (boardUrl.protocol !== "https:") {
    throw new Error("The Azure DevOps Boards URL must use HTTPS.");
  }

  const segments = boardUrl.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  let organization;
  let project;
  let team;

  if (boardUrl.hostname === "dev.azure.com") {
    [organization, project] = segments;
  } else if (boardUrl.hostname.endsWith(".visualstudio.com")) {
    organization = boardUrl.hostname.slice(0, -".visualstudio.com".length);
    [project] = segments;
  }
  const boardsIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === "_boards",
  );
  const teamMarkerIndex = segments.findIndex(
    (segment, index) =>
      index > boardsIndex && segment.toLowerCase() === "t",
  );
  if (teamMarkerIndex >= 0) {
    team = segments[teamMarkerIndex + 1];
  }

  if (!organization || !project) {
    throw new Error(
      "Use an Azure DevOps Boards URL such as https://dev.azure.com/{organization}/{project}/_boards/....",
    );
  }

  return {
    boardUrl: boardUrl.toString(),
    organization,
    project,
    team,
  };
}

function normalizeClassificationPath(value, label) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > 400 || /[\r\n]/.test(normalized)) {
    throw new Error(`${label} must be a single path of 400 characters or fewer.`);
  }
  return normalized;
}

function getAzureDevOpsToken() {
  return new Promise((resolve, reject) => {
    const azureCliArguments = [
      "account",
      "get-access-token",
      "--resource",
      azureDevOpsResource,
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ];
    const windowsAzureCli =
      [
        process.env["ProgramFiles(x86)"],
        process.env.PROGRAMFILES,
        "C:\\Program Files (x86)",
      ]
        .filter(Boolean)
        .map((root) =>
          path.join(
            root,
            "Microsoft",
            "SDKs",
            "Azure",
            "CLI2",
            "wbin",
            "az.cmd",
          ),
        )
        .find((candidate) => existsSync(candidate)) ?? "az.cmd";
    const command =
      process.platform === "win32"
        ? windowsAzureCli
        : "az";
    const child = spawn(
      command,
      azureCliArguments,
      {
        shell: process.platform === "win32",
        windowsHide: true,
      },
    );
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Azure CLI authentication timed out."));
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          error.code === "ENOENT"
            ? "Azure CLI is not installed. Install it and run az login."
            : error.message,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const token = output.trim();
      if (code === 0 && token) {
        resolve(token);
        return;
      }
      reject(
        new Error(
          errorOutput.trim() ||
            "Azure CLI could not acquire an Azure DevOps token. Run az login and try again.",
        ),
      );
    });
  });
}

async function getAuthenticatedAzureDevOpsIdentity(target, token) {
  const response = await fetch(
    `https://dev.azure.com/${encodeURIComponent(target.organization)}/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      result?.message ||
        `Azure DevOps returned ${response.status} while resolving the signed-in identity.`,
    );
  }

  const identity = result.authenticatedUser ?? result.authorizedUser;
  const uniqueName =
    identity?.properties?.Account?.$value ??
    identity?.properties?.Mail?.$value ??
    identity?.uniqueName;
  if (!uniqueName) {
    throw new Error(
      "Azure DevOps could not resolve the signed-in identity for self-assignment.",
    );
  }
  return uniqueName;
}

async function resolveAzureDevOpsBoardContext(boardUrl) {
  const target = parseBoardUrl(boardUrl);
  if (!target.team) {
    throw new Error(
      "Use a team board URL containing /_boards/board/t/{team}/... to resolve Area and Iteration paths.",
    );
  }

  const token = await getAzureDevOpsToken();
  const organization = encodeURIComponent(target.organization);
  const project = encodeURIComponent(target.project);
  const team = encodeURIComponent(target.team);
  const headers = { Authorization: `Bearer ${token}` };
  const [areaResponse, iterationResponse, settingsResponse] = await Promise.all([
    fetch(
      `https://dev.azure.com/${organization}/${project}/${team}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`,
      { headers },
    ),
    fetch(
      `https://dev.azure.com/${organization}/${project}/${team}/_apis/work/teamsettings/iterations?api-version=7.1`,
      { headers },
    ),
    fetch(
      `https://dev.azure.com/${organization}/${project}/${team}/_apis/work/teamsettings?api-version=7.1`,
      { headers },
    ),
  ]);
  const [areaResult, iterationResult, settingsResult] = await Promise.all([
    areaResponse.json(),
    iterationResponse.json(),
    settingsResponse.json(),
  ]);
  if (!areaResponse.ok) {
    throw new Error(
      areaResult?.message ||
        `Azure DevOps returned ${areaResponse.status} while resolving the team Area Path.`,
    );
  }
  if (!iterationResponse.ok) {
    throw new Error(
      iterationResult?.message ||
        `Azure DevOps returned ${iterationResponse.status} while resolving the current Iteration Path.`,
    );
  }
  if (!settingsResponse.ok) {
    throw new Error(
      settingsResult?.message ||
        `Azure DevOps returned ${settingsResponse.status} while resolving the team defaults.`,
    );
  }

  const areaPaths = [
    ...new Set(
      [
        areaResult.defaultValue,
        ...(areaResult.values ?? []).map((item) => item.value),
      ]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const iterationPaths = [
    ...new Set(
      (iterationResult.value ?? [])
        .map((item) => String(item.path ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const areaPath = String(areaResult.defaultValue ?? areaPaths[0] ?? "").trim();
  const defaultIterationPath = String(
    settingsResult.defaultIteration?.path ?? "",
  ).trim();
  const resolvedDefaultIterationPath = iterationPaths.find(
    (path) =>
      path === defaultIterationPath ||
      path.endsWith(defaultIterationPath.replace(/^\\/, "\\")),
  );
  const iterationPath =
    resolvedDefaultIterationPath ||
    String(
      iterationResult.value?.find((item) => item.timeFrame === "current")
        ?.path ??
        iterationPaths.at(-1) ??
        "",
    ).trim();
  if (!areaPath) {
    throw new Error(
      `Azure DevOps did not return a default Area Path for the ${target.team} team.`,
    );
  }

  return {
    areaPath,
    areaPaths,
    iterationPath,
    iterationPaths,
    team: target.team,
  };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function noteDescription(note) {
  const groups =
    note.serviceGroupIds.length > 0
      ? `<p><strong>Service groups:</strong> ${note.serviceGroupIds.map(escapeHtml).join(", ")}</p>`
      : "";
  return [
    `<p><strong>Grounds service:</strong> ${escapeHtml(note.serviceName)}</p>`,
    groups,
    `<div>${escapeHtml(note.body).replaceAll("\n", "<br>")}</div>`,
  ].join("");
}

async function createAdoWorkItem({
  areaPath,
  assignToMe,
  boardUrl,
  iterationPath,
  note,
  workItemType,
}) {
  const target = parseBoardUrl(boardUrl);
  const normalizedAreaPath = normalizeClassificationPath(areaPath, "Area Path");
  const normalizedIterationPath = normalizeClassificationPath(
    iterationPath,
    "Iteration Path",
  );
  if (
    typeof workItemType !== "string" ||
    workItemType.length === 0 ||
    workItemType.length > 80
  ) {
    throw new Error("Select a valid Azure DevOps work-item type.");
  }

  const token = await getAzureDevOpsToken();
  const assignedTo = assignToMe
    ? await getAuthenticatedAzureDevOpsIdentity(target, token)
    : "";
  const apiUrl =
    `https://dev.azure.com/${encodeURIComponent(target.organization)}/` +
    `${encodeURIComponent(target.project)}/_apis/wit/workitems/` +
    `${encodeURIComponent(`$${workItemType}`)}?api-version=7.1`;
  const operations = [
    {
      op: "add",
      path: "/fields/System.Title",
      value: note.title,
    },
    {
      op: "add",
      path: "/fields/System.Description",
      value: noteDescription(note),
    },
    {
      op: "add",
      path: "/fields/System.Tags",
      value: [
        "Grounds",
        note.serviceName,
        ...note.serviceGroupIds.map((group) => `ServiceGroup:${group}`),
      ].join("; "),
    },
    ...(normalizedAreaPath
      ? [
          {
            op: "add",
            path: "/fields/System.AreaPath",
            value: normalizedAreaPath,
          },
        ]
      : []),
    ...(normalizedIterationPath
      ? [
          {
            op: "add",
            path: "/fields/System.IterationPath",
            value: normalizedIterationPath,
          },
        ]
      : []),
    ...(assignedTo
      ? [
          {
            op: "add",
            path: "/fields/System.AssignedTo",
            value: assignedTo,
          },
        ]
      : []),
  ];
  const response = await fetch(apiUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json-patch+json",
    },
    body: JSON.stringify(operations),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      result?.message ||
        `Azure DevOps returned ${response.status} while creating the work item.`,
    );
  }

  return {
    id: result.id,
    title: result.fields?.["System.Title"] ?? note.title,
    type: result.fields?.["System.WorkItemType"] ?? workItemType,
    url:
      result._links?.html?.href ??
      `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(target.project)}/_workitems/edit/${result.id}`,
  };
}

function initializeDatabase(root, DatabaseSync) {
  const dataDirectory = path.join(root, ".grounds");
  mkdirSync(dataDirectory, { recursive: true });
  const database = new DatabaseSync(path.join(dataDirectory, "grounds.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS service_notes (
      id TEXT PRIMARY KEY,
      service_name TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      service_group_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_notes_service_updated
      ON service_notes(service_name, updated_at DESC);
    CREATE TABLE IF NOT EXISTS service_work_settings (
      service_name TEXT PRIMARY KEY,
      ado_board_url TEXT NOT NULL DEFAULT '',
      ado_area_path TEXT NOT NULL DEFAULT '',
      ado_iteration_path TEXT NOT NULL DEFAULT '',
      assign_to_me INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ado_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL REFERENCES service_notes(id) ON DELETE CASCADE,
      service_name TEXT NOT NULL,
      work_item_id INTEGER NOT NULL,
      work_item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(note_id, work_item_id)
    );
  `);
  const workSettingsColumns = new Set(
    database
      .prepare("PRAGMA table_info(service_work_settings)")
      .all()
      .map((column) => column.name),
  );
  if (!workSettingsColumns.has("ado_area_path")) {
    database.exec(
      "ALTER TABLE service_work_settings ADD COLUMN ado_area_path TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!workSettingsColumns.has("ado_iteration_path")) {
    database.exec(
      "ALTER TABLE service_work_settings ADD COLUMN ado_iteration_path TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!workSettingsColumns.has("assign_to_me")) {
    database.exec(
      "ALTER TABLE service_work_settings ADD COLUMN assign_to_me INTEGER NOT NULL DEFAULT 0",
    );
  }
  return database;
}

export function workCompanionPlugin() {
  let database;

  return {
    name: "grounds-work-companion",
    apply: "serve",
    async configResolved(config) {
      const { DatabaseSync } = await import("node:sqlite");
      database = initializeDatabase(config.root, DatabaseSync);
    },
    configureServer(server) {
      server.httpServer?.once("close", () => database?.close());
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        if (!requestUrl.pathname.startsWith("/__grounds/work/")) {
          next();
          return;
        }
        if (!isLocalRequest(request)) {
          sendJson(response, 403, { error: "Local Grounds origin required." });
          return;
        }

        try {
          const noteMatch = requestUrl.pathname.match(
            /^\/__grounds\/work\/notes\/([^/]+)$/,
          );
          if (requestUrl.pathname === "/__grounds/work/notes") {
            if (request.method === "GET") {
              const requestedServiceName =
                requestUrl.searchParams.get("serviceName");
              const rows = requestedServiceName
                ? database
                    .prepare(
                      `SELECT id, service_name, title, body, service_group_ids, created_at, updated_at
                       FROM service_notes
                       WHERE service_name = ?
                       ORDER BY updated_at DESC`,
                    )
                    .all(requireServiceName(requestedServiceName))
                : database
                    .prepare(
                      `SELECT id, service_name, title, body, service_group_ids, created_at, updated_at
                       FROM service_notes
                       ORDER BY updated_at DESC`,
                    )
                    .all();
              sendJson(response, 200, { notes: rows.map(parseNote) });
              return;
            }
            if (request.method === "POST") {
              const payload = await readJsonBody(request);
              const serviceName = requireServiceName(payload.serviceName);
              const title = String(payload.title ?? "").trim();
              const body = String(payload.body ?? "");
              if (!title) throw new Error("A note title is required.");
              const serviceGroupIds = normalizeTags(payload.serviceGroupIds ?? []);
              const timestamp = new Date().toISOString();
              const note = {
                id: randomUUID(),
                serviceName,
                title,
                body,
                serviceGroupIds,
                createdAt: timestamp,
                updatedAt: timestamp,
              };
              database
                .prepare(
                  `INSERT INTO service_notes
                   (id, service_name, title, body, service_group_ids, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  note.id,
                  note.serviceName,
                  note.title,
                  note.body,
                  JSON.stringify(note.serviceGroupIds),
                  note.createdAt,
                  note.updatedAt,
                );
              sendJson(response, 201, { note });
              return;
            }
          } else if (noteMatch) {
            const id = decodeURIComponent(noteMatch[1]);
            if (request.method === "PUT") {
              const payload = await readJsonBody(request);
              const serviceName = requireServiceName(payload.serviceName);
              const title = String(payload.title ?? "").trim();
              const body = String(payload.body ?? "");
              if (!title) throw new Error("A note title is required.");
              const serviceGroupIds = normalizeTags(payload.serviceGroupIds ?? []);
              const updatedAt = new Date().toISOString();
              const result = database
                .prepare(
                  `UPDATE service_notes
                   SET title = ?, body = ?, service_group_ids = ?, updated_at = ?
                   WHERE id = ? AND service_name = ?`,
                )
                .run(
                  title,
                  body,
                  JSON.stringify(serviceGroupIds),
                  updatedAt,
                  id,
                  serviceName,
                );
              if (result.changes === 0) throw new Error("Note not found.");
              const note = parseNote(
                database
                  .prepare(
                    `SELECT id, service_name, title, body, service_group_ids, created_at, updated_at
                     FROM service_notes WHERE id = ?`,
                  )
                  .get(id),
              );
              sendJson(response, 200, { note });
              return;
            }
            if (request.method === "DELETE") {
              const serviceName = requireServiceName(
                requestUrl.searchParams.get("serviceName"),
              );
              const result = database
                .prepare(
                  "DELETE FROM service_notes WHERE id = ? AND service_name = ?",
                )
                .run(id, serviceName);
              if (result.changes === 0) throw new Error("Note not found.");
              sendJson(response, 200, { status: "deleted" });
              return;
            }
          } else if (requestUrl.pathname === "/__grounds/work/settings") {
            if (request.method === "GET") {
              const serviceName = requireServiceName(
                requestUrl.searchParams.get("serviceName"),
              );
              const row = database
                .prepare(
                  `SELECT ado_board_url, ado_area_path, ado_iteration_path, assign_to_me
                   FROM service_work_settings WHERE service_name = ?`,
                )
                .get(serviceName);
              sendJson(response, 200, {
                adoBoardUrl: row?.ado_board_url ?? "",
                areaPath: row?.ado_area_path ?? "",
                iterationPath: row?.ado_iteration_path ?? "",
                assignToMe: Boolean(row?.assign_to_me),
              });
              return;
            }
            if (request.method === "PUT") {
              const payload = await readJsonBody(request);
              const serviceName = requireServiceName(payload.serviceName);
              const boardUrl = String(payload.adoBoardUrl ?? "").trim();
              const areaPath = normalizeClassificationPath(
                payload.areaPath,
                "Area Path",
              );
              const iterationPath = normalizeClassificationPath(
                payload.iterationPath,
                "Iteration Path",
              );
              const assignToMe = payload.assignToMe === true;
              if (boardUrl) parseBoardUrl(boardUrl);
              database
                .prepare(
                  `INSERT INTO service_work_settings
                   (service_name, ado_board_url, ado_area_path, ado_iteration_path, assign_to_me, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(service_name) DO UPDATE SET
                     ado_board_url = excluded.ado_board_url,
                     ado_area_path = excluded.ado_area_path,
                     ado_iteration_path = excluded.ado_iteration_path,
                     assign_to_me = excluded.assign_to_me,
                     updated_at = excluded.updated_at`,
                )
                .run(
                  serviceName,
                  boardUrl,
                  areaPath,
                  iterationPath,
                  assignToMe ? 1 : 0,
                  new Date().toISOString(),
                );
              sendJson(response, 200, {
                adoBoardUrl: boardUrl,
                areaPath,
                iterationPath,
                assignToMe,
              });
              return;
            }
          } else if (
            requestUrl.pathname === "/__grounds/work/ado-context" &&
            request.method === "POST"
          ) {
            const payload = await readJsonBody(request);
            const context = await resolveAzureDevOpsBoardContext(
              payload.adoBoardUrl,
            );
            sendJson(response, 200, context);
            return;
          } else if (
            requestUrl.pathname === "/__grounds/work/ado" &&
            request.method === "POST"
          ) {
            const payload = await readJsonBody(request);
            const serviceName = requireServiceName(payload.serviceName);
            const row = database
              .prepare(
                `SELECT id, service_name, title, body, service_group_ids, created_at, updated_at
                 FROM service_notes WHERE id = ? AND service_name = ?`,
              )
              .get(payload.noteId, serviceName);
            if (!row) throw new Error("Save the note before creating an ADO work item.");
            const note = parseNote(row);
            const workItem = await createAdoWorkItem({
              areaPath: payload.areaPath,
              assignToMe: payload.assignToMe === true,
              boardUrl: payload.adoBoardUrl,
              iterationPath: payload.iterationPath,
              note,
              workItemType: payload.workItemType,
            });
            database
              .prepare(
                `INSERT INTO ado_work_items
                 (note_id, service_name, work_item_id, work_item_type, title, url, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                note.id,
                serviceName,
                workItem.id,
                workItem.type,
                workItem.title,
                workItem.url,
                new Date().toISOString(),
              );
            sendJson(response, 201, { workItem });
            return;
          }

          sendJson(response, 405, { error: "Method not allowed." });
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
