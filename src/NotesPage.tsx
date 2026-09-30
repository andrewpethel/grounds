import { useEffect, useMemo, useState } from "react";
import { ev2ServiceGroups, services } from "./data";
import type { Ev2ServiceGroup, WorkNote } from "./types";

interface NoteDraft {
  id?: string;
  serviceName: string;
  title: string;
  body: string;
  serviceGroupIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

async function readApi<T>(response: Response): Promise<T> {
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Grounds Notes request failed.");
  }
  return result;
}

function emptyDraft(serviceName = services[0]?.service.name ?? ""): NoteDraft {
  return {
    serviceName,
    title: "",
    body: "",
    serviceGroupIds: [],
  };
}

function serviceGroupsFor(serviceName: string): Ev2ServiceGroup[] {
  const service = services.find(
    (candidate) => candidate.service.name === serviceName,
  );
  const serviceTreeId = service?.service.serviceTreeId;
  if (!serviceTreeId) return [];

  return [
    ...new Map(
      ev2ServiceGroups.observations
        .filter(
          (observation) =>
            observation.serviceTreeId.toLowerCase() ===
            serviceTreeId.toLowerCase(),
        )
        .flatMap((observation) => observation.serviceGroups)
        .map((group) => [group.serviceGroupId, group]),
    ).values(),
  ].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function NotesPage() {
  const [notes, setNotes] = useState<WorkNote[]>([]);
  const [draft, setDraft] = useState<NoteDraft>(() => emptyDraft());
  const [query, setQuery] = useState("");
  const [serviceFilter, setServiceFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const availableServiceGroups = useMemo(
    () => serviceGroupsFor(draft.serviceName),
    [draft.serviceName],
  );
  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return notes.filter((note) => {
      if (serviceFilter !== "all" && note.serviceName !== serviceFilter) {
        return false;
      }
      if (!normalizedQuery) return true;
      const service = services.find(
        (candidate) => candidate.service.name === note.serviceName,
      );
      return [
        note.title,
        note.body,
        note.serviceName,
        service?.service.displayName ?? "",
        ...note.serviceGroupIds,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [notes, query, serviceFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/__grounds/work/notes")
      .then((response) => readApi<{ notes: WorkNote[] }>(response))
      .then((result) => {
        if (cancelled) return;
        setNotes(result.notes);
        setDraft(result.notes[0] ?? emptyDraft());
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load saved notes.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function selectNote(note: WorkNote) {
    setDraft(note);
    setError("");
    setStatus("");
  }

  function createNote() {
    const preferredService =
      serviceFilter !== "all" ? serviceFilter : draft.serviceName;
    setDraft(emptyDraft(preferredService));
    setError("");
    setStatus("");
  }

  function toggleServiceGroup(serviceGroupId: string) {
    setDraft((current) => ({
      ...current,
      serviceGroupIds: current.serviceGroupIds.includes(serviceGroupId)
        ? current.serviceGroupIds.filter((id) => id !== serviceGroupId)
        : [...current.serviceGroupIds, serviceGroupId],
    }));
  }

  async function saveNote() {
    const title = draft.title.trim();
    if (!title) {
      setError("Enter a note title before saving.");
      return;
    }
    if (!draft.serviceName) {
      setError("Select a service for this note.");
      return;
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
            serviceName: draft.serviceName,
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
      setStatus(draft.id ? "Note updated." : "Note created.");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Could not save note.",
      );
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
    setStatus("");
    try {
      const response = await fetch(
        `/__grounds/work/notes/${encodeURIComponent(draft.id)}?serviceName=${encodeURIComponent(draft.serviceName)}`,
        { method: "DELETE" },
      );
      await readApi<{ status: string }>(response);
      const remaining = notes.filter((note) => note.id !== draft.id);
      setNotes(remaining);
      setDraft(remaining[0] ?? emptyDraft(draft.serviceName));
      setStatus("Note deleted.");
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

  const selectedService = services.find(
    (service) => service.service.name === draft.serviceName,
  );

  return (
    <main className="content notes-content">
      <section className="notes-hero">
        <div>
          <span className="eyebrow">Operator workspace</span>
          <h1>Saved notes</h1>
          <p>
            Search and maintain operator context captured across the Grounds
            service catalog.
          </p>
        </div>
        <button onClick={createNote} type="button">
          + New note
        </button>
      </section>

      <section className="notes-toolbar" aria-label="Filter saved notes">
        <label>
          <span>Search notes</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles, content, services, or Service Groups..."
            type="search"
            value={query}
          />
        </label>
        <label>
          <span>Service</span>
          <select
            onChange={(event) => setServiceFilter(event.target.value)}
            value={serviceFilter}
          >
            <option value="all">All services</option>
            {services.map((service) => (
              <option
                key={service.service.name}
                value={service.service.name}
              >
                {service.service.displayName}
              </option>
            ))}
          </select>
        </label>
        <span>
          {filteredNotes.length} of {notes.length} notes
        </span>
      </section>

      {loading ? (
        <section className="notes-loading" aria-busy="true" role="status">
          Loading saved notes...
        </section>
      ) : (
        <section className="notes-workspace">
          <aside className="notes-list" aria-label="Saved notes">
            {filteredNotes.length === 0 ? (
              <div className="notes-empty">
                <strong>No notes found</strong>
                <span>
                  {notes.length === 0
                    ? "Create the first saved note."
                    : "Adjust the search or service filter."}
                </span>
              </div>
            ) : (
              filteredNotes.map((note) => {
                const service = services.find(
                  (candidate) =>
                    candidate.service.name === note.serviceName,
                );
                return (
                  <button
                    className={draft.id === note.id ? "active" : ""}
                    key={note.id}
                    onClick={() => selectNote(note)}
                    type="button"
                  >
                    <span>{service?.service.displayName ?? note.serviceName}</span>
                    <strong>{note.title}</strong>
                    <small>
                      {new Intl.DateTimeFormat("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(note.updatedAt))}
                    </small>
                  </button>
                );
              })
            )}
          </aside>

          <div className="notes-editor">
            <div className="notes-editor-heading">
              <div>
                <span className="eyebrow">
                  {draft.id ? "Edit saved note" : "New saved note"}
                </span>
                <h2>{draft.id ? draft.title || "Untitled note" : "Capture context"}</h2>
              </div>
              {draft.id && selectedService && (
                <a href={`#/service/${selectedService.service.name}`}>
                  Open service
                </a>
              )}
            </div>

            <label htmlFor="notes-service">Service</label>
            <select
              disabled={Boolean(draft.id)}
              id="notes-service"
              onChange={(event) =>
                setDraft({
                  ...emptyDraft(event.target.value),
                  title: draft.title,
                  body: draft.body,
                })
              }
              value={draft.serviceName}
            >
              {services.map((service) => (
                <option
                  key={service.service.name}
                  value={service.service.name}
                >
                  {service.service.displayName}
                </option>
              ))}
            </select>

            <label htmlFor="notes-title">Title</label>
            <input
              id="notes-title"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="Investigation or operator task"
              value={draft.title}
            />

            <label htmlFor="notes-body">Notes</label>
            <textarea
              id="notes-body"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  body: event.target.value,
                }))
              }
              placeholder="Record observations, hypotheses, links, commands, and next steps..."
              value={draft.body}
            />

            <details className="notes-service-groups">
              <summary>
                Service-group tags
                <span>{draft.serviceGroupIds.length} selected</span>
              </summary>
              <div>
                {availableServiceGroups.length === 0 ? (
                  <p>No discovered Service Groups are available for this service.</p>
                ) : (
                  availableServiceGroups.map((group) => (
                    <label key={group.serviceGroupId}>
                      <input
                        checked={draft.serviceGroupIds.includes(
                          group.serviceGroupId,
                        )}
                        onChange={() =>
                          toggleServiceGroup(group.serviceGroupId)
                        }
                        type="checkbox"
                      />
                      <span>{group.displayName}</span>
                    </label>
                  ))
                )}
              </div>
            </details>

            {draft.serviceGroupIds.length > 0 && (
              <div className="notes-tags">
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

            <div className="notes-editor-actions">
              <button disabled={saving} onClick={deleteNote} type="button">
                {draft.id ? "Delete note" : "Clear"}
              </button>
              <button disabled={saving} onClick={saveNote} type="button">
                {saving ? "Saving..." : draft.id ? "Save changes" : "Create note"}
              </button>
            </div>
          </div>
        </section>
      )}

      {(error || status) && (
        <div className={`notes-message ${error ? "error" : "success"}`} role="status">
          {error || status}
        </div>
      )}
    </main>
  );
}
