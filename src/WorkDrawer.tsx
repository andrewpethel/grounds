import { useEffect, useMemo, useState } from "react";
import type {
  AdoWorkItemResult,
  CatalogService,
  Ev2ServiceGroup,
  WorkNote,
} from "./types";

interface WorkDraft {
  id?: string;
  title: string;
  body: string;
  serviceGroupIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface WorkSettings {
  adoBoardUrl: string;
  areaPath: string;
  iterationPath: string;
  assignToMe: boolean;
}

const emptyDraft: WorkDraft = {
  title: "",
  body: "",
  serviceGroupIds: [],
};

async function readApi<T>(response: Response): Promise<T> {
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Grounds Work request failed.");
  }
  return result;
}

export function WorkDrawer({
  open,
  onClose,
  service,
  serviceGroups,
}: {
  open: boolean;
  onClose: () => void;
  service: CatalogService;
  serviceGroups: Ev2ServiceGroup[];
}) {
  const [notes, setNotes] = useState<WorkNote[]>([]);
  const [draft, setDraft] = useState<WorkDraft>(emptyDraft);
  const [adoBoardUrl, setAdoBoardUrl] = useState("");
  const [areaPath, setAreaPath] = useState("");
  const [iterationPath, setIterationPath] = useState("");
  const [areaPaths, setAreaPaths] = useState<string[]>([]);
  const [iterationPaths, setIterationPaths] = useState<string[]>([]);
  const [assignToMe, setAssignToMe] = useState(false);
  const [workItemType, setWorkItemType] = useState("Task");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resolvingBoardContext, setResolvingBoardContext] = useState(false);
  const [creatingWorkItem, setCreatingWorkItem] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [createdWorkItem, setCreatedWorkItem] =
    useState<AdoWorkItemResult>();
  const selectedId = draft.id;
  const sortedServiceGroups = useMemo(
    () =>
      [...serviceGroups].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
    [serviceGroups],
  );

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError("");
    setStatus("");
    setCreatedWorkItem(undefined);
    Promise.all([
      fetch(
        `/__grounds/work/notes?serviceName=${encodeURIComponent(service.service.name)}`,
      ).then((response) => readApi<{ notes: WorkNote[] }>(response)),
      fetch(
        `/__grounds/work/settings?serviceName=${encodeURIComponent(service.service.name)}`,
      ).then((response) => readApi<WorkSettings>(response)),
    ])
      .then(([notesResult, settingsResult]) => {
        if (cancelled) return;
        setNotes(notesResult.notes);
        setAdoBoardUrl(settingsResult.adoBoardUrl);
        setAreaPath(settingsResult.areaPath);
        setIterationPath(settingsResult.iterationPath);
        setAssignToMe(settingsResult.assignToMe);
        setDraft(notesResult.notes[0] ?? emptyDraft);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load service notes.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, service.service.name]);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving && !creatingWorkItem) onClose();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [creatingWorkItem, onClose, open, saving]);

  function selectNote(note: WorkNote) {
    setDraft(note);
    setError("");
    setStatus("");
    setCreatedWorkItem(undefined);
  }

  function createNote() {
    setDraft(emptyDraft);
    setError("");
    setStatus("");
    setCreatedWorkItem(undefined);
  }

  async function saveNote() {
    const title = draft.title.trim();
    if (!title) {
      setError("Enter a note title before saving.");
      return undefined;
    }

    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(
        draft.id
          ? `/__grounds/work/notes/${encodeURIComponent(draft.id)}`
          : "/__grounds/work/notes",
        {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceName: service.service.name,
            title,
            body: draft.body,
            serviceGroupIds: draft.serviceGroupIds,
          }),
        },
      );
      const result = await readApi<{ note: WorkNote }>(response);
      setDraft(result.note);
      setNotes((current) => [
        result.note,
        ...current.filter((note) => note.id !== result.note.id),
      ]);
      setStatus("Note saved.");
      return result.note;
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Could not save note.",
      );
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  async function deleteNote() {
    if (!draft.id) {
      createNote();
      return;
    }
    if (!window.confirm(`Delete "${draft.title}"?`)) return;

    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/__grounds/work/notes/${encodeURIComponent(draft.id)}?serviceName=${encodeURIComponent(service.service.name)}`,
        { method: "DELETE" },
      );
      await readApi<{ status: string }>(response);
      const remaining = notes.filter((note) => note.id !== draft.id);
      setNotes(remaining);
      setDraft(remaining[0] ?? emptyDraft);
      setStatus("Note deleted.");
      setCreatedWorkItem(undefined);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete note.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveBoardSettings() {
    const response = await fetch("/__grounds/work/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceName: service.service.name,
        adoBoardUrl: adoBoardUrl.trim(),
        areaPath: areaPath.trim(),
        iterationPath: iterationPath.trim(),
        assignToMe,
      }),
    });
    return readApi<WorkSettings>(response);
  }

  async function resolveBoardContext(boardUrl = adoBoardUrl) {
    const normalizedBoardUrl = boardUrl.trim();
    if (!normalizedBoardUrl) {
      setError("Enter or paste an Azure DevOps team board URL.");
      return;
    }

    setResolvingBoardContext(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/__grounds/work/ado-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoBoardUrl: normalizedBoardUrl }),
      });
      const result = await readApi<{
        areaPath: string;
        areaPaths: string[];
        iterationPath: string;
        iterationPaths: string[];
        team: string;
      }>(response);
      setAreaPath(result.areaPath);
      setAreaPaths(result.areaPaths);
      setIterationPath(result.iterationPath);
      setIterationPaths(result.iterationPaths);
      setStatus(
        `Loaded ${result.areaPaths.length} Area Path and ${result.iterationPaths.length} Iteration Path options for ${result.team}.`,
      );
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "Could not resolve Azure DevOps board settings.",
      );
    } finally {
      setResolvingBoardContext(false);
    }
  }

  async function createWorkItem() {
    if (!adoBoardUrl.trim()) {
      setError("Enter the Azure DevOps board URL for this service.");
      return;
    }

    setCreatingWorkItem(true);
    setError("");
    setStatus("");
    setCreatedWorkItem(undefined);
    try {
      const savedNote = await saveNote();
      if (!savedNote) return;
      const settings = await saveBoardSettings();
      setAdoBoardUrl(settings.adoBoardUrl);
      setAreaPath(settings.areaPath);
      setIterationPath(settings.iterationPath);
      setAssignToMe(settings.assignToMe);
      const response = await fetch("/__grounds/work/ado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceName: service.service.name,
          noteId: savedNote.id,
          workItemType,
          adoBoardUrl: settings.adoBoardUrl,
          areaPath: settings.areaPath,
          iterationPath: settings.iterationPath,
          assignToMe: settings.assignToMe,
        }),
      });
      const result = await readApi<{ workItem: AdoWorkItemResult }>(response);
      setCreatedWorkItem(result.workItem);
      setStatus(`${result.workItem.type} ${result.workItem.id} created.`);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create the Azure DevOps work item.",
      );
    } finally {
      setCreatingWorkItem(false);
    }
  }

  function toggleServiceGroup(serviceGroupId: string) {
    setDraft((current) => ({
      ...current,
      serviceGroupIds: current.serviceGroupIds.includes(serviceGroupId)
        ? current.serviceGroupIds.filter((id) => id !== serviceGroupId)
        : [...current.serviceGroupIds, serviceGroupId],
    }));
  }

  if (!open) return null;

  return (
    <div className="work-layer">
      <button
        aria-label="Close Work"
        className="work-backdrop"
        disabled={saving || creatingWorkItem}
        onClick={onClose}
      />
      <section
        aria-labelledby="work-title"
        aria-modal="true"
        className="work-drawer"
        role="dialog"
      >
        <header className="work-header">
          <div>
            <span className="eyebrow">Service workspace</span>
            <h2 id="work-title">Work: {service.service.displayName}</h2>
            <p>Capture operator context and promote it into Azure DevOps when ready.</p>
          </div>
          <button
            aria-label="Close Work"
            disabled={saving || creatingWorkItem}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {loading ? (
          <div
            aria-busy="true"
            aria-live="polite"
            className="work-layout work-loading"
            role="status"
          >
            <span className="visually-hidden">
              Loading notes and Azure DevOps settings
            </span>
            <aside className="work-note-list work-skeleton-panel">
              <span className="skeleton-block skeleton-button" />
              <span className="skeleton-block skeleton-note" />
              <span className="skeleton-block skeleton-note" />
              <span className="skeleton-block skeleton-note short" />
            </aside>
            <div className="work-editor work-skeleton-panel">
              <span className="skeleton-block skeleton-label" />
              <span className="skeleton-block skeleton-input" />
              <span className="skeleton-block skeleton-label" />
              <span className="skeleton-block skeleton-textarea" />
              <span className="skeleton-block skeleton-action" />
            </div>
            <aside className="work-ado-panel work-skeleton-panel">
              <span className="skeleton-block skeleton-label" />
              <span className="skeleton-block skeleton-heading" />
              <span className="skeleton-block skeleton-copy" />
              <span className="skeleton-block skeleton-input" />
              <span className="skeleton-block skeleton-input" />
              <span className="skeleton-block skeleton-button" />
            </aside>
          </div>
        ) : (
          <div className="work-layout">
          <aside className="work-note-list">
            <button className="work-new-note" onClick={createNote} type="button">
              + New note
            </button>
            {notes.length === 0 ? (
              <p>No notes for this service yet.</p>
            ) : (
              notes.map((note) => (
                <button
                  className={note.id === selectedId ? "active" : ""}
                  key={note.id}
                  onClick={() => selectNote(note)}
                  type="button"
                >
                  <strong>{note.title}</strong>
                  <span>
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(note.updatedAt))}
                  </span>
                </button>
              ))
            )}
          </aside>

          <div className="work-editor">
            <label htmlFor="work-note-title">Title</label>
            <input
              id="work-note-title"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="Investigation or operator task"
              value={draft.title}
            />
            <label htmlFor="work-note-body">Notes</label>
            <textarea
              id="work-note-body"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  body: event.target.value,
                }))
              }
              placeholder="Record observations, hypotheses, links, commands, and next steps..."
              value={draft.body}
            />

            <details className="work-service-group-picker">
              <summary>
                Service-group tags
                <span>{draft.serviceGroupIds.length} selected</span>
              </summary>
              <div>
                {sortedServiceGroups.length === 0 ? (
                  <p>Get Service Groups before tagging this note.</p>
                ) : (
                  sortedServiceGroups.map((group) => (
                    <label key={group.serviceGroupId}>
                      <input
                        checked={draft.serviceGroupIds.includes(
                          group.serviceGroupId,
                        )}
                        onChange={() => toggleServiceGroup(group.serviceGroupId)}
                        type="checkbox"
                      />
                      <span>{group.displayName}</span>
                    </label>
                  ))
                )}
              </div>
            </details>

            {draft.serviceGroupIds.length > 0 && (
              <div className="work-tag-list">
                {draft.serviceGroupIds.map((id) => (
                  <button
                    key={id}
                    onClick={() => toggleServiceGroup(id)}
                    title={`Remove ${id}`}
                    type="button"
                  >
                    {id} ×
                  </button>
                ))}
              </div>
            )}

            <div className="work-editor-actions">
              <button
                disabled={saving || creatingWorkItem}
                onClick={deleteNote}
                type="button"
              >
                {draft.id ? "Delete" : "Clear"}
              </button>
              <button
                disabled={saving || creatingWorkItem}
                onClick={saveNote}
                type="button"
              >
                {saving ? "Saving..." : "Save note"}
              </button>
            </div>
          </div>

          <aside className="work-ado-panel">
            <span className="eyebrow">Azure DevOps</span>
            <h3>Create a work item</h3>
            <p>
              Grounds saves the current note, then sends its text and service-group
              tags through the local Azure CLI session.
            </p>
            <label htmlFor="work-board-url">Board endpoint</label>
            <input
              id="work-board-url"
              onChange={(event) => setAdoBoardUrl(event.target.value)}
              onPaste={(event) => {
                const pastedUrl = event.clipboardData.getData("text").trim();
                if (!pastedUrl) return;
                event.preventDefault();
                setAdoBoardUrl(pastedUrl);
                void resolveBoardContext(pastedUrl);
              }}
              placeholder="https://dev.azure.com/org/project/_boards/..."
              type="url"
              value={adoBoardUrl}
            />
            <button
              className="work-resolve-ado"
              disabled={resolvingBoardContext || creatingWorkItem}
              onClick={() => void resolveBoardContext()}
              type="button"
            >
              {resolvingBoardContext
                ? "Resolving board settings..."
                : "Resolve Area and Iteration paths"}
            </button>
            <label htmlFor="work-item-type">Work-item type</label>
            <select
              id="work-item-type"
              onChange={(event) => setWorkItemType(event.target.value)}
              value={workItemType}
            >
              <option>Task</option>
              <option>Bug</option>
              <option>User Story</option>
              <option>Issue</option>
            </select>
            <label htmlFor="work-area-path">Area Path</label>
            {areaPaths.length > 0 ? (
              <select
                id="work-area-path"
                onChange={(event) => setAreaPath(event.target.value)}
                value={areaPath}
              >
                {areaPaths.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="work-area-path"
                onChange={(event) => setAreaPath(event.target.value)}
                placeholder="Platform Engineering\\Azure Monitor and Alerts"
                type="text"
                value={areaPath}
              />
            )}
            <label htmlFor="work-iteration-path">Iteration Path</label>
            {iterationPaths.length > 0 ? (
              <select
                id="work-iteration-path"
                onChange={(event) => setIterationPath(event.target.value)}
                value={iterationPath}
              >
                <option value="">Project default</option>
                {iterationPaths.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="work-iteration-path"
                onChange={(event) => setIterationPath(event.target.value)}
                placeholder="Platform Engineering\\Iteration"
                type="text"
                value={iterationPath}
              />
            )}
            <label className="work-assignment-option">
              <input
                checked={assignToMe}
                onChange={(event) => setAssignToMe(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>Assign to me</strong>
                <small>
                  Uses the identity authenticated by the current Azure CLI session.
                </small>
              </span>
            </label>
            <button
              className="work-create-ado"
              disabled={saving || creatingWorkItem || resolvingBoardContext}
              onClick={createWorkItem}
              type="button"
            >
              {creatingWorkItem ? "Creating..." : `Create ${workItemType}`}
            </button>
            <small>
              Requires <code>az login</code> with access to the target project.
              Tokens are requested on demand and are never stored by Grounds.
            </small>
            {createdWorkItem && (
              <a href={createdWorkItem.url} rel="noreferrer" target="_blank">
                Open {createdWorkItem.type} {createdWorkItem.id}
              </a>
            )}
          </aside>
          </div>
        )}

        {(error || status) && (
          <div className={`work-message ${error ? "error" : "success"}`} role="status">
            {error || status}
          </div>
        )}
      </section>
    </div>
  );
}
