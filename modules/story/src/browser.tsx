import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActionResult, BrowserModuleContext, BrowserModuleDefinition, SnapshotId } from "@scriptorium/contracts";
import { normalizeNotes, type NotesBlock, type NotesSection, type StructuredNotes } from "./notes.js";

type DataResult = Extract<ActionResult, { ok: true }>;
type Entity = {
  id: string;
  type: string;
  name?: string;
  status?: string;
  aliases?: string[];
  tags?: string[];
  raw: Record<string, unknown>;
  revision?: string;
  filePath?: string;
};
type SeriesOverlay = { entities: Entity[]; workEntities: Entity[]; bibleEntities: Entity[]; workSnapshot: SnapshotId; bibleSnapshot: SnapshotId };
type SceneContext = {
  scene: Entity;
  sceneRevision?: string;
  appears: Entity[];
  mentions: Entity[];
  items: Entity[];
  threadsPlanted: Entity[];
  threadsAdvanced: Entity[];
  manuscriptBody?: string;
};
type VolumeTree = Array<{ volume: Entity; chapters: Array<{ chapter: Entity; scenes: Entity[] }> }>;
type ThreadLifecycleResult = {
  snapshots: Array<{
    threadId: string;
    state: "unset" | "planted" | "recalled" | "resolved";
    mentions: Array<{ sceneId: string; matchedKeywords: string[]; via: "keyword" | "embedding" }>;
    plantedSceneId?: string;
    recalledSceneIds: string[];
    resolvedSceneId?: string;
    scenesSinceLastMention: number;
  }>;
  warnings: Array<{ threadId: string; code: string; message: string; severity: "warning"; filePath?: string }>;
};
type ReaderKnowledgeModel = {
  chapterId: string;
  disclosures: Array<{ sceneId: string; order: number; entityId: string; disclosureKind: string; evidence: string; source: string }>;
  knowledgeGaps: Array<{ kind: string; characterId: string; entityId: string; characterKnewAtSceneId: string | null; readerDisclosedAtSceneId: string | null }>;
  forgetRisks: Array<{ threadId: string; plantedSceneId?: string; resolvedSceneId?: string; sceneDistance: number; disclosureCountBetween: number; forgetRisk: number }>;
  firstReadReaction: null;
};
type StoryMap = { nodes: Array<{ id: string; name: string }>; edges: Array<{ from: string; to: string; kind: string; days?: number }> };
type StoryTimelineEntry = { sceneId: string; order: number; title: string; cumulativeDayOffset: number | null; deltaFromPrevious: number | null; relation: string; confidence: string; expressionSurfaces: string[]; locationName?: string; chapterName?: string; characters?: Array<{ id: string; name: string }> };
type WorldStateWorkbench = {
  scenes: Entity[];
  events: Array<{ sceneId: string; order: number; kind: string; subject: string; object?: string | null; payload?: Record<string, unknown> }>;
  proposals: Array<{ id: string; status: string; event: Record<string, unknown>; history?: Array<Record<string, unknown>> }>;
};
type ZukanSuggestion = {
  id: string;
  entityId: string;
  entityName?: string;
  entityRevision?: string;
  blockPath: string;
  proposedText: string;
  evidence: Array<{ quote: string; sceneId?: string }>;
  source: string;
  kind: string | null;
  createdAt: string;
};

const panelStyle: React.CSSProperties = { display: "grid", gap: "0.75rem", padding: "0.9rem", color: "var(--story-fg, #222)" };
const rowStyle: React.CSSProperties = { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" };
const mutedStyle: React.CSSProperties = { opacity: 0.72, fontSize: "0.9em" };
const buttonStyle: React.CSSProperties = { minHeight: "2.25rem", padding: "0.35rem 0.65rem" };

type EditableField = { key: string; label: string; kind?: "text" | "textarea" | "list" | "number" };
type RelationChoice = { kind: string; targetType?: string };
function relationChoicesFor(entityType: string): RelationChoice[] {
  if (entityType === "scene") return [
    { kind: "plants", targetType: "thread" },
    { kind: "advances", targetType: "thread" },
    { kind: "payoff", targetType: "thread" },
    { kind: "related" },
  ];
  if (entityType === "thread") return [
    { kind: "planted", targetType: "scene" },
    { kind: "payoff", targetType: "scene" },
    { kind: "related" },
  ];
  if (entityType === "character" || entityType === "faction") return [{ kind: "related" }, { kind: "affiliated" }];
  return [{ kind: "related" }];
}
const EDITABLE_FIELDS: Record<string, EditableField[]> = {
  character: [{ key: "aliases", label: "Aliases", kind: "list" }, { key: "status", label: "Status" }, { key: "folder", label: "Folder" }],
  location: [{ key: "region", label: "Region" }, { key: "description", label: "Description", kind: "textarea" }, { key: "tags", label: "Tags", kind: "list" }],
  item: [{ key: "category", label: "Category" }, { key: "owner", label: "Owner ID" }, { key: "status", label: "Status" }, { key: "tags", label: "Tags", kind: "list" }],
  faction: [{ key: "leader", label: "Leader ID" }, { key: "members", label: "Member IDs", kind: "list" }, { key: "status", label: "Status" }, { key: "tags", label: "Tags", kind: "list" }],
  event: [{ key: "date", label: "Story date" }, { key: "location", label: "Location ID" }, { key: "summary", label: "Summary", kind: "textarea" }, { key: "tags", label: "Tags", kind: "list" }],
  thread: [{ key: "status", label: "Status" }, { key: "resolution", label: "Resolution scene ID" }, { key: "keywords", label: "Keywords", kind: "list" }, { key: "tags", label: "Tags", kind: "list" }],
  scene: [{ key: "title", label: "Title" }, { key: "goal", label: "Scene goal", kind: "textarea" }, { key: "conflict", label: "Conflict", kind: "textarea" }, { key: "date", label: "Story date" }, { key: "pov", label: "POV character ID" }, { key: "location", label: "Location ID" }, { key: "appears", label: "Appears (entity IDs)", kind: "list" }, { key: "mentions", label: "Mentions (entity IDs)", kind: "list" }, { key: "tags", label: "Tags", kind: "list" }],
  chapter: [{ key: "title", label: "Title" }, { key: "summary", label: "Summary", kind: "textarea" }, { key: "order", label: "Order", kind: "number" }],
  volume: [{ key: "title", label: "Title" }, { key: "summary", label: "Summary", kind: "textarea" }, { key: "order", label: "Order", kind: "number" }],
  arc: [{ key: "status", label: "Status" }, { key: "resolution", label: "Resolution" }, { key: "threads", label: "Thread IDs", kind: "list" }, { key: "tags", label: "Tags", kind: "list" }],
  lore: [{ key: "aliases", label: "Aliases", kind: "list" }, { key: "summary", label: "Summary", kind: "textarea" }, { key: "tags", label: "Tags", kind: "list" }],
  dialogue_sketch: [{ key: "title", label: "Title" }, { key: "tags", label: "Tags", kind: "list" }],
};

function patchSectionTree(sections: NotesSection[], path: number[], update: (section: NotesSection) => NotesSection): NotesSection[] {
  const [head, ...rest] = path;
  if (head === undefined) return sections;
  return sections.map((section, index) => index !== head ? section : rest.length ? { ...section, children: patchSectionTree(section.children, rest, update) } : update(section));
}

function StructuredNotesEditor({ value, onChange }: { value: StructuredNotes; onChange: (next: StructuredNotes) => void }) {
  const updateLead = (index: number, update: (block: NotesBlock) => NotesBlock) => onChange({
    ...value,
    lead: value.lead.map((block, blockIndex) => blockIndex === index ? update(block) : block),
  });
  const updateSectionBlock = (path: number[], index: number, update: (block: NotesBlock) => NotesBlock) => onChange({
    ...value,
    sections: patchSectionTree(value.sections, path, (section) => ({ ...section, body: section.body.map((block, blockIndex) => blockIndex === index ? update(block) : block) })),
  });
  const renderBlocks = (blocks: NotesBlock[], update: (index: number, change: (block: NotesBlock) => NotesBlock) => void, prefix: string) => blocks.map((block, index) => block.type === "paragraph"
    ? <label key={`${prefix}-${index}`} style={{ display: "grid", gap: "0.2rem" }}>Paragraph <textarea value={block.text} onChange={(event) => update(index, (prior) => prior.type === "paragraph" ? { ...prior, text: event.target.value } : prior)} /></label>
    : <fieldset key={`${prefix}-${index}`}><legend>{block.type === "steps" ? "Steps" : "Definitions"}</legend>{block.items.map((item, itemIndex) => <div key={itemIndex} style={rowStyle}><input aria-label="Term" placeholder="Term" value={item.term} onChange={(event) => update(index, (prior) => prior.type === "paragraph" ? prior : { ...prior, items: prior.items.map((value, i) => i === itemIndex ? { ...value, term: event.target.value } : value) })} /><input aria-label="Description" placeholder="Description" value={item.description} onChange={(event) => update(index, (prior) => prior.type === "paragraph" ? prior : { ...prior, items: prior.items.map((value, i) => i === itemIndex ? { ...value, description: event.target.value } : value) })} /></div>)}</fieldset>);
  const renderSection = (section: NotesSection, path: number[]) => <fieldset key={path.join(".")} style={{ marginLeft: `${Math.min(path.length, 3) * 0.45}rem` }}>
    <legend>Nested note section</legend>
    <input aria-label="Note section heading" value={section.heading} onChange={(event) => onChange({ ...value, sections: patchSectionTree(value.sections, path, (prior) => ({ ...prior, heading: event.target.value })) })} />
    {renderBlocks(section.body, (index, change) => updateSectionBlock(path, index, change), `section-${path.join("-")}`)}
    <div style={rowStyle}>
      <button type="button" style={buttonStyle} onClick={() => onChange({ ...value, sections: patchSectionTree(value.sections, path, (prior) => ({ ...prior, body: [...prior.body, { type: "paragraph", text: "" }] })) })}>Add paragraph</button>
      <button type="button" style={buttonStyle} onClick={() => onChange({ ...value, sections: patchSectionTree(value.sections, path, (prior) => ({ ...prior, children: [...prior.children, { heading: "", body: [], children: [] }] })) })}>Add nested section</button>
      <button type="button" style={buttonStyle} onClick={() => onChange({ ...value, sections: path.length === 1 ? value.sections.filter((_, i) => i !== path[0]) : patchSectionTree(value.sections, path.slice(0, -1), (parent) => ({ ...parent, children: parent.children.filter((_, i) => i !== path[path.length - 1]) })) })}>Remove section</button>
    </div>
    {section.children.map((child, index) => renderSection(child, [...path, index]))}
  </fieldset>;
  return <section aria-label="Structured notes editor">
    <h4>Nested notes</h4>
    {renderBlocks(value.lead, (index, change) => updateLead(index, change), "lead")}
    <button type="button" style={buttonStyle} onClick={() => onChange({ ...value, lead: [...value.lead, { type: "paragraph", text: "" }] })}>Add lead paragraph</button>
    {value.sections.map((section, index) => renderSection(section, [index]))}
    <button type="button" style={buttonStyle} onClick={() => onChange({ ...value, sections: [...value.sections, { heading: "", body: [], children: [] }] })}>Add note section</button>
  </section>;
}

function resultData<T>(result: ActionResult): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data as T;
}

function operationId(): string {
  return `story-ui-${globalThis.crypto.randomUUID()}`;
}

function matchesEntitySearch(entity: Entity, query: string): boolean {
  const aliases = Array.isArray(entity.raw.aliases) ? entity.raw.aliases.filter((value): value is string => typeof value === "string") : [];
  const tags = Array.isArray(entity.raw.tags) ? entity.raw.tags.filter((value): value is string => typeof value === "string") : [];
  const haystack = [entity.id, entity.type, entity.name, ...aliases, ...tags].join(" ").toLocaleLowerCase();
  return haystack.includes(query.trim().toLocaleLowerCase());
}

function ReadOnlyNotes({ value }: { value: StructuredNotes | null }) {
  if (!value) return <p style={mutedStyle}>No structured notes.</p>;
  const renderBlocks = (blocks: NotesBlock[]) => <ul>{blocks.map((block, index) => <li key={index}>
    {block.type === "paragraph" ? block.text : <ul>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item.term ? <><strong>{item.term}: </strong>{item.description}</> : item.description}</li>)}</ul>}
  </li>)}</ul>;
  const renderSections = (sections: NotesSection[]) => sections.map((section, index) => <section key={`${section.heading}-${index}`}>
    {section.heading && <h5>{section.heading}</h5>}{renderBlocks(section.body)}{renderSections(section.children)}
  </section>);
  return <div aria-label="Bible entity notes">{renderBlocks(value.lead)}{renderSections(value.sections)}</div>;
}

function useAction(context: BrowserModuleContext) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const invoke = async <T,>(id: string, input: unknown): Promise<T> => {
    setBusy(true);
    setMessage("");
    try {
      const result = await context.invoke(id, input);
      return resultData<T>(result);
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? ` (${String((error as { code: string }).code)})` : "";
      setMessage(`${error instanceof Error ? error.message : String(error)}${code}`);
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const status = message ? <p role="alert">{message}</p> : busy ? <p role="status">Loading…</p> : null;
  return { invoke, busy, setMessage, status };
}

function StoryNavigator({ context }: { context: BrowserModuleContext }) {
  const { invoke, busy, status, setMessage } = useAction(context);
  const [tree, setTree] = useState<VolumeTree>([]);
  const [treeRevision, setTreeRevision] = useState("");
  const [sceneId, setSceneId] = useState("");
  const [scene, setScene] = useState<SceneContext | null>(null);
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const refresh = async () => {
    const result = await invoke<{ tree: VolumeTree; revision: string }>("story.volumes.tree", {});
    setTree(result.tree);
    setTreeRevision(result.revision);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [context.snapshot.repository.repositoryId, context.snapshot.remoteCommit, context.snapshot.overlayCommit]);
  const selectScene = async (id: string) => {
    setSceneId(id);
    try {
      const selected = await invoke<SceneContext | null>("story.scene.context", { sceneId: id });
      setScene(selected);
      if (selected) setMetadata({
        title: String(selected.scene.raw.title ?? selected.scene.name ?? ""),
        goal: String(selected.scene.raw.goal ?? ""), conflict: String(selected.scene.raw.conflict ?? ""),
        date: String(selected.scene.raw.date ?? ""), pov: String(selected.scene.raw.pov ?? ""),
        location: String(selected.scene.raw.location ?? ""),
        appears: Array.isArray(selected.scene.raw.appears) ? selected.scene.raw.appears.join(", ") : "",
        mentions: Array.isArray(selected.scene.raw.mentions) ? selected.scene.raw.mentions.join(", ") : "",
      });
    }
    catch { setScene(null); }
  };
  const saveMetadata = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!scene) return;
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "goal", "conflict", "date", "pov", "location"] as const) patch[key] = metadata[key]?.trim() || null;
    for (const key of ["appears", "mentions"] as const) patch[key] = (metadata[key] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    try {
      await invoke("story.scene.metadata.update", { sceneId: scene.scene.id, patch, base_revision: scene.sceneRevision, operation_id: operationId() });
      setMessage(`Proposed metadata update for ${scene.scene.id}.`);
    } catch { /* The panel displays the machine error. */ }
  };
  const moveSibling = async (type: "chapter" | "scene", parentId: string, siblings: Entity[], index: number, delta: -1 | 1) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= siblings.length) return;
    const orderedIds = siblings.map((item) => item.id);
    [orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex]!, orderedIds[index]!];
    try {
      await invoke("story.entities.reorder", { type, parentId, orderedIds, base_revision: treeRevision, operation_id: operationId() });
      setMessage(`Proposed ${type} order change. The outline updates after the proposal is accepted and checkpointed.`);
    } catch { /* The panel displays the machine error. */ }
  };
  return <section style={panelStyle} aria-label="Story navigator">
    <h2>Volumes and scenes</h2>
    <button style={buttonStyle} onClick={() => void refresh().catch(() => undefined)}>Refresh outline</button>
    {tree.length === 0 ? <p style={mutedStyle}>No volume hierarchy is available in this snapshot.</p> : tree.map(({ volume, chapters }) => <section key={volume.id}>
      <h3>{volume.name ?? String(volume.raw.title ?? volume.id)}</h3>
      {chapters.map(({ chapter, scenes }, chapterIndex) => <div key={chapter.id}>
        <div style={rowStyle}><h4>{chapter.name ?? String(chapter.raw.title ?? chapter.id)}</h4>
          <button type="button" style={buttonStyle} disabled={busy || chapterIndex === 0} aria-label={`Move chapter ${chapter.id} up`} onClick={() => void moveSibling("chapter", volume.id, chapters.map((item) => item.chapter), chapterIndex, -1)}>Move up</button>
          <button type="button" style={buttonStyle} disabled={busy || chapterIndex === chapters.length - 1} aria-label={`Move chapter ${chapter.id} down`} onClick={() => void moveSibling("chapter", volume.id, chapters.map((item) => item.chapter), chapterIndex, 1)}>Move down</button>
        </div>
        <ol>{scenes.map((item, sceneIndex) => <li key={item.id}>
          <button type="button" aria-pressed={sceneId === item.id} onClick={() => void selectScene(item.id)}>{item.name ?? String(item.raw.title ?? item.id)}</button>
          <button type="button" style={buttonStyle} disabled={busy || sceneIndex === 0} aria-label={`Move scene ${item.id} up`} onClick={() => void moveSibling("scene", chapter.id, scenes, sceneIndex, -1)}>↑</button>
          <button type="button" style={buttonStyle} disabled={busy || sceneIndex === scenes.length - 1} aria-label={`Move scene ${item.id} down`} onClick={() => void moveSibling("scene", chapter.id, scenes, sceneIndex, 1)}>↓</button>
        </li>)}</ol>
      </div>)}
    </section>)}
    {scene && <article aria-live="polite">
      <h3>{scene.scene.name ?? String(scene.scene.raw.title ?? scene.scene.id)}</h3>
      <p style={mutedStyle}>POV and location context is shown with the entity links below.</p>
      <p>Appears: {scene.appears.map((entity) => entity.name ?? entity.id).join(", ") || "none"}</p>
      <p>Mentions: {scene.mentions.map((entity) => entity.name ?? entity.id).join(", ") || "none"}</p>
      <p>Items: {scene.items.map((entity) => entity.name ?? entity.id).join(", ") || "none"}</p>
      <p>Threads planted: {scene.threadsPlanted.map((entity) => entity.name ?? entity.id).join(", ") || "none"}</p>
      <p>Threads advanced: {scene.threadsAdvanced.map((entity) => entity.name ?? entity.id).join(", ") || "none"}</p>
      {scene.manuscriptBody && <details><summary>Read scene text</summary><pre style={{ whiteSpace: "pre-wrap" }}>{scene.manuscriptBody}</pre></details>}
      <form style={panelStyle} onSubmit={(event) => void saveMetadata(event)}>
        <h4>Scene metadata</h4>
        {["title", "date", "pov", "location"].map((key) => <label key={key}>{key} <input value={metadata[key] ?? ""} onChange={(event) => setMetadata((value) => ({ ...value, [key]: event.target.value }))} /></label>)}
        {["goal", "conflict"].map((key) => <label key={key}>{key} <textarea value={metadata[key] ?? ""} onChange={(event) => setMetadata((value) => ({ ...value, [key]: event.target.value }))} /></label>)}
        {["appears", "mentions"].map((key) => <label key={key}>{key} entity IDs <input value={metadata[key] ?? ""} placeholder="Comma separated IDs" onChange={(event) => setMetadata((value) => ({ ...value, [key]: event.target.value }))} /></label>)}
        <button style={buttonStyle} disabled={busy}>Propose scene metadata</button>
      </form>
    </article>}
    {status}
  </section>;
}

function StoryInspector({ context }: { context: BrowserModuleContext }) {
  const { invoke, busy, status, setMessage } = useAction(context);
  const [id, setId] = useState("");
  const [entity, setEntity] = useState<Entity | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<StructuredNotes | null>(null);
  const [notesDirty, setNotesDirty] = useState(false);
  const [relations, setRelations] = useState<Array<Record<string, unknown>>>([]);
  const [relationTarget, setRelationTarget] = useState("");
  const [relationKind, setRelationKind] = useState("related");
  const [availableEntities, setAvailableEntities] = useState<Entity[]>([]);
  const [seriesOverlay, setSeriesOverlay] = useState<SeriesOverlay | null>(null);
  const [selectedBibleEntityId, setSelectedBibleEntityId] = useState("");
  const [workSearch, setWorkSearch] = useState("");
  const [workTypeFilter, setWorkTypeFilter] = useState("");
  const [bibleSearch, setBibleSearch] = useState("");
  const [bibleTypeFilter, setBibleTypeFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState("character");
  const [createId, setCreateId] = useState("");
  const [createName, setCreateName] = useState("");
  const [createTags, setCreateTags] = useState("");
  const [createFields, setCreateFields] = useState<Record<string, string>>({});
  const [createNotes, setCreateNotes] = useState<StructuredNotes>({ lead: [], sections: [] });
  const [createVolume, setCreateVolume] = useState("");
  const [createChapter, setCreateChapter] = useState("");
  const [createCharacters, setCreateCharacters] = useState<string[]>([]);
  const [backlinks, setBacklinks] = useState<Array<{ entity: Entity; link: { kind: string } }>>([]);
  const [appearances, setAppearances] = useState<Array<{ scene: Entity; kinds: string[] }>>([]);
  useEffect(() => {
    void invoke<Entity[]>("story.entities.list", {}).then(setAvailableEntities).catch(() => setAvailableEntities([]));
    void invoke<SeriesOverlay | null>("story.series.overlay", {}).then(setSeriesOverlay).catch(() => setSeriesOverlay(null));
  }, [context.snapshot.repository.repositoryId, context.snapshot.remoteCommit, context.snapshot.overlayCommit]);
  const openEntity = async (entityId: string) => {
    const found = await invoke<Entity | null>("story.entities.get", { id: entityId.trim() });
    setEntity(found);
    if (!found) { setBacklinks([]); setAppearances([]); setNotes(null); return; }
    setName(found?.name ?? String(found?.raw.title ?? ""));
    setTags((found?.tags ?? []).join(", "));
    setFields(Object.fromEntries((EDITABLE_FIELDS[found.type] ?? []).map(({ key }) => {
      const value = found.raw[key];
      return [key, Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(", ") : value == null ? "" : String(value)];
    })));
    setNotes(normalizeNotes(found.raw.notes));
    setNotesDirty(false);
    setRelations(Array.isArray(found.raw.relations) ? found.raw.relations.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)).map((item) => ({ ...item })) : []);
    setRelationKind(relationChoicesFor(found.type)[0]?.kind ?? "related");
    const [links, scenes] = await Promise.all([
      invoke<typeof backlinks>("story.entities.backlinks", { id: found.id }),
      invoke<typeof appearances>("story.entities.appearances", { id: found.id }),
    ]);
    setBacklinks(links);
    setAppearances(scenes);
  };
  const open = async (event?: React.FormEvent) => {
    event?.preventDefault();
    await openEntity(id);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!entity) return;
    const patch: Record<string, unknown> = {};
    if (entity.name !== undefined || entity.raw.title === undefined) patch.name = name;
    else patch.title = name;
    patch.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    for (const field of EDITABLE_FIELDS[entity.type] ?? []) {
      if (field.key === "tags") continue;
      const value = fields[field.key] ?? "";
      if (field.kind === "list") patch[field.key] = value.split(",").map((item) => item.trim()).filter(Boolean);
      else if (field.kind === "number") patch[field.key] = value.trim() ? Number(value) : null;
      else patch[field.key] = value.trim() ? value : null;
    }
    if (notesDirty && notes) patch.notes = notes;
    patch.relations = relations;
    try {
      const updated = await invoke<Entity>("story.entities.update", {
        id: entity.id,
        patch,
        base_revision: entity.revision,
        operation_id: operationId(),
      });
      setEntity(updated);
      setMessage(`Proposed update for ${entity.id}. Review it in pending changes before checkpointing.`);
    } catch { /* The panel displays the machine error. */ }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload: Record<string, unknown> = {
      type: createType,
      ...(createId.trim() ? { id: createId.trim() } : {}),
      ...(createType === "scene" ? { title: createName.trim(), volume: createVolume, chapter: createChapter, characters: createCharacters } : { name: createName.trim() }),
      tags: createTags.split(",").map((tag) => tag.trim()).filter(Boolean),
      operation_id: operationId(),
    };
    for (const field of EDITABLE_FIELDS[createType] ?? []) {
      if (["tags", "title"].includes(field.key)) continue;
      const value = createFields[field.key] ?? "";
      if (field.kind === "list") payload[field.key] = value.split(",").map((item) => item.trim()).filter(Boolean);
      else if (field.kind === "number") payload[field.key] = value.trim() ? Number(value) : undefined;
      else if (value.trim()) payload[field.key] = value;
    }
    if (createNotes.lead.length || createNotes.sections.length) payload.notes = createNotes;
    if (createType === "chapter") payload.volume = createVolume;
    try {
      const created = await invoke<{ id: string; type: string }>("story.entities.create", payload);
      setId(created.id);
      setCreateName(""); setCreateId(""); setCreateTags(""); setCreateFields({});
      setCreateNotes({ lead: [], sections: [] }); setShowCreate(false);
      setMessage(`Proposed ${created.type} ${created.id}. Review it in pending changes before checkpointing.`);
    } catch { /* The panel displays the machine error. */ }
  };
  const createFieldsForType = EDITABLE_FIELDS[createType] ?? [];
  const volumes = availableEntities.filter((item) => item.type === "volume");
  const chapters = availableEntities.filter((item) => item.type === "chapter" && item.raw.volume === createVolume);
  const relationChoices = entity ? relationChoicesFor(entity.type) : [];
  const selectedRelation = relationChoices.find((choice) => choice.kind === relationKind) ?? relationChoices[0];
  const relationTargets = availableEntities.filter((item) => item.id !== entity?.id && (!selectedRelation?.targetType || item.type === selectedRelation.targetType));
  const bibleEntities = seriesOverlay?.bibleEntities ?? [];
  const workTypes = [...new Set(availableEntities.map((item) => item.type))].sort();
  const bibleTypes = [...new Set(bibleEntities.map((item) => item.type))].sort();
  const visibleWorkEntities = availableEntities.filter((item) => (!workTypeFilter || item.type === workTypeFilter) && matchesEntitySearch(item, workSearch));
  const visibleBibleEntities = bibleEntities.filter((item) => (!bibleTypeFilter || item.type === bibleTypeFilter) && matchesEntitySearch(item, bibleSearch));
  const selectedBibleEntity = bibleEntities.find((item) => item.id === selectedBibleEntityId);
  const workEntityIds = new Set(availableEntities.map((item) => item.id));
  return <section style={panelStyle} aria-label="Story entity inspector">
    <h2>Entity inspector</h2>
    <button type="button" style={buttonStyle} aria-expanded={showCreate} onClick={() => setShowCreate((value) => !value)}>{showCreate ? "Close create form" : "Create Story entity"}</button>
    {showCreate && <form style={panelStyle} onSubmit={(event) => void create(event)}>
      <h3>Create from a source entity type</h3>
      <label>Type <select value={createType} onChange={(event) => { setCreateType(event.target.value); setCreateFields({}); }}>
        {["character", "location", "item", "faction", "event", "thread", "scene", "chapter", "volume", "arc", "lore", "dialogue_sketch"].map((type) => <option key={type} value={type}>{type}</option>)}
      </select></label>
      <label>{createType === "scene" ? "Scene title" : "Name"} <input required value={createName} onChange={(event) => setCreateName(event.target.value)} /></label>
      <label>Stable ID (optional) <input value={createId} onChange={(event) => setCreateId(event.target.value)} /></label>
      <label>Tags <input value={createTags} onChange={(event) => setCreateTags(event.target.value)} placeholder="Comma separated" /></label>
      {createType === "scene" && <>
        <label>Volume <select required value={createVolume} onChange={(event) => { setCreateVolume(event.target.value); setCreateChapter(""); }}><option value="">Choose a volume</option>{volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.name ?? String(volume.raw.title ?? volume.id)}</option>)}</select></label>
        <label>Chapter <select required value={createChapter} onChange={(event) => setCreateChapter(event.target.value)}><option value="">Choose a chapter</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name ?? String(chapter.raw.title ?? chapter.id)}</option>)}</select></label>
        <label>Characters appearing in this scene <select multiple value={createCharacters} onChange={(event) => setCreateCharacters(Array.from(event.target.selectedOptions, (option) => option.value))}>{availableEntities.filter((item) => item.type === "character").map((character) => <option key={character.id} value={character.id}>{character.name ?? character.id}</option>)}</select></label>
      </>}
      {createType === "chapter" && <label>Volume <select required value={createVolume} onChange={(event) => setCreateVolume(event.target.value)}><option value="">Choose a volume</option>{volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.name ?? String(volume.raw.title ?? volume.id)}</option>)}</select></label>}
      {createFieldsForType.filter((field) => field.key !== "tags" && field.key !== "title").map((field) => <label key={field.key}>{field.label}{field.kind === "textarea" ? <textarea value={createFields[field.key] ?? ""} onChange={(event) => setCreateFields((value) => ({ ...value, [field.key]: event.target.value }))} /> : <input type={field.kind === "number" ? "number" : "text"} value={createFields[field.key] ?? ""} onChange={(event) => setCreateFields((value) => ({ ...value, [field.key]: event.target.value }))} />}</label>)}
      <StructuredNotesEditor value={createNotes} onChange={setCreateNotes} />
      <button style={buttonStyle} disabled={busy || !createName.trim() || (createType === "scene" && (!createVolume || !createChapter)) || (createType === "chapter" && !createVolume)}>Propose entity creation</button>
    </form>}
    <form style={rowStyle} onSubmit={(event) => void open(event)}>
      <label>Entity ID <input value={id} onChange={(event) => setId(event.target.value)} /></label>
      <button style={buttonStyle} disabled={busy || !id.trim()}>Open</button>
    </form>
    <label>Find a work entity <input type="search" value={workSearch} onChange={(event) => setWorkSearch(event.target.value)} placeholder="Name, alias, tag, or ID" /></label>
    <label>Work entity type <select value={workTypeFilter} onChange={(event) => setWorkTypeFilter(event.target.value)}><option value="">All types</option>{workTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
    <label>Browse work entities <select value={entity && workEntityIds.has(entity.id) && visibleWorkEntities.some((item) => item.id === entity.id) ? entity.id : ""} onChange={(event) => { const selectedId = event.target.value; setId(selectedId); if (selectedId) void openEntity(selectedId); }}>
      <option value="">Choose a work entity by name</option>{workTypes.map((type) => <optgroup key={type} label={type}>{visibleWorkEntities.filter((item) => item.type === type).map((item) => <option key={item.id} value={item.id}>{item.name ?? String(item.raw.title ?? item.id)} · {item.id}</option>)}</optgroup>)}
    </select></label>
    <section aria-label="Read-only linked Bible overlay">
      <h3>Linked Bible reference (read-only)</h3>
      {seriesOverlay ? <>
        <p style={mutedStyle}>Work snapshot {seriesOverlay.workSnapshot.repository.repositoryId}@{seriesOverlay.workSnapshot.remoteCommit}; Bible snapshot {seriesOverlay.bibleSnapshot.repository.repositoryId}@{seriesOverlay.bibleSnapshot.remoteCommit}.</p>
        <label>Find a Bible entity <input type="search" value={bibleSearch} onChange={(event) => setBibleSearch(event.target.value)} placeholder="Name, alias, tag, or ID" /></label>
        <label>Bible entity type <select value={bibleTypeFilter} onChange={(event) => setBibleTypeFilter(event.target.value)}><option value="">All types</option>{bibleTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <label>Bible entity <select value={visibleBibleEntities.some((item) => item.id === selectedBibleEntityId) ? selectedBibleEntityId : ""} onChange={(event) => setSelectedBibleEntityId(event.target.value)}>
          <option value="">Choose a linked Bible entity</option>{bibleTypes.map((type) => <optgroup key={type} label={type}>{visibleBibleEntities.filter((item) => item.type === type).map((item) => <option key={item.id} value={item.id}>{item.name ?? String(item.raw.title ?? item.id)} · {item.id}</option>)}</optgroup>)}
        </select></label>
        {selectedBibleEntity ? <article aria-label="Linked Bible entity details">
          <strong>{selectedBibleEntity.name ?? String(selectedBibleEntity.raw.title ?? selectedBibleEntity.id)}</strong>
          <p>{selectedBibleEntity.type} · {selectedBibleEntity.id} · {selectedBibleEntity.filePath} · revision {selectedBibleEntity.revision}</p>
          {Array.isArray(selectedBibleEntity.raw.aliases) && selectedBibleEntity.raw.aliases.length > 0 && <p>Aliases: {selectedBibleEntity.raw.aliases.filter((value): value is string => typeof value === "string").join(", ")}</p>}
          {Array.isArray(selectedBibleEntity.raw.tags) && selectedBibleEntity.raw.tags.length > 0 && <p>Tags: {selectedBibleEntity.raw.tags.filter((value): value is string => typeof value === "string").join(", ")}</p>}
          <ReadOnlyNotes value={normalizeNotes(selectedBibleEntity.raw.notes)} />
          {workEntityIds.has(selectedBibleEntity.id) && <p style={mutedStyle}>A work entity has this ID and takes precedence in the combined overlay. The linked Bible record remains unchanged and read-only here.</p>}
        </article> : <p style={mutedStyle}>No Bible entity matches the current search and type filters.</p>}
      </> : <p style={mutedStyle}>No linked Bible overlay is available for this series binding.</p>}
    </section>
    {entity && <>
      <p style={mutedStyle}>{entity.type} · {entity.filePath} · {entity.status ?? "no status"}</p>
      <form style={panelStyle} onSubmit={(event) => void save(event)}>
        <label>Name or title <input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Tags, separated by commas <input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
        {(EDITABLE_FIELDS[entity.type] ?? []).filter((field) => field.key !== "tags").map((field) => <label key={field.key}>{field.label}
          {field.kind === "textarea" ? <textarea value={fields[field.key] ?? ""} onChange={(event) => setFields((value) => ({ ...value, [field.key]: event.target.value }))} /> : <input type={field.kind === "number" ? "number" : "text"} value={fields[field.key] ?? ""} onChange={(event) => setFields((value) => ({ ...value, [field.key]: event.target.value }))} />}
        </label>)}
        {notes ? <StructuredNotesEditor value={notes} onChange={(next) => { setNotes(next); setNotesDirty(true); }} /> : entity.raw.notes === undefined ? <p style={mutedStyle}>No structured notes are attached to this entity.</p> : <details><summary>Unrecognized source notes (preserved)</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(entity.raw.notes, null, 2)}</pre></details>}
        {notesDirty && notes && <p style={mutedStyle}>Nested note edits will be included in this metadata proposal.</p>}
        <fieldset><legend>Entity references</legend>
          <ul>{relations.map((relation, index) => <li key={`${String(relation.target ?? relation.to)}-${String(relation.kind)}-${index}`}>
            {String(relation.kind ?? "related")} → {String(relation.target ?? relation.to ?? "unknown")}
            <button type="button" style={buttonStyle} aria-label={`Remove ${String(relation.kind)} reference`} onClick={() => setRelations((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
          </li>)}</ul>
          <div style={rowStyle}>
            <label>Target <select value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)}><option value="">Choose an entity</option>{relationTargets.map((item) => <option key={item.id} value={item.id}>{item.name ?? item.id} ({item.type})</option>)}</select></label>
            <label>Relation <select value={selectedRelation?.kind ?? "related"} onChange={(event) => { setRelationKind(event.target.value); setRelationTarget(""); }}>{relationChoices.map(({ kind }) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
            <button type="button" style={buttonStyle} disabled={!relationTarget} onClick={() => { setRelations((items) => [...items, { target: relationTarget, kind: relationKind }]); setRelationTarget(""); }}>Add reference</button>
          </div>
        </fieldset>
        <button style={buttonStyle} disabled={busy}>Propose metadata update</button>
      </form>
      <details><summary>Source metadata</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(entity.raw, null, 2)}</pre></details>
      <h3>Backlinks</h3>{backlinks.length ? <ul>{backlinks.map(({ entity: from, link }, index) => <li key={`${from.id}-${link.kind}-${index}`}>{from.name ?? from.id} · {link.kind}</li>)}</ul> : <p style={mutedStyle}>No entities currently link here.</p>}
      <h3>Appearances</h3>{appearances.length ? <ul>{appearances.map(({ scene, kinds }) => <li key={scene.id}>{scene.name ?? String(scene.raw.title ?? scene.id)} · {kinds.join(", ")}</li>)}</ul> : <p style={mutedStyle}>No scene appearances are recorded.</p>}
    </>}
    {status}
  </section>;
}

function ContinuityPanel({ context }: { context: BrowserModuleContext }) {
  const { invoke, busy, status } = useAction(context);
  const [threads, setThreads] = useState<Entity[]>([]);
  const [tree, setTree] = useState<VolumeTree>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selected, setSelected] = useState("");
  const [lifecycle, setLifecycle] = useState<ThreadLifecycleResult | null>(null);
  const [timeline, setTimeline] = useState<StoryTimelineEntry[]>([]);
  const [map, setMap] = useState<StoryMap | null>(null);
  const [chapterId, setChapterId] = useState("");
  const [readerModel, setReaderModel] = useState<ReaderKnowledgeModel | null>(null);
  const [graph, setGraph] = useState<{ nodes: Array<{ id: string; name: string; type: string }>; edges: Array<{ from: string; to: string; kind: string }> } | null>(null);
  const [showCooccurrence, setShowCooccurrence] = useState(false);
  const [cooccurrence, setCooccurrence] = useState<{ edges: Array<{ a: string; b: string; sceneCount: number; jaccard: number; pmi: number }>; gaps: Array<{ a: string; b: string; issue: string; sceneCount: number }> } | null>(null);
  useEffect(() => {
    void invoke<Entity[]>("story.entities.list", { type: "thread" }).then(setThreads).catch(() => undefined);
    void invoke<Entity[]>("story.entities.list", {}).then(setEntities).catch(() => undefined);
    void invoke<{ tree: VolumeTree }>("story.volumes.tree", {}).then((result) => {
      setTree(result.tree);
      setChapterId((current) => current || result.tree[0]?.chapters[0]?.chapter.id || "");
    }).catch(() => setTree([]));
    void invoke<StoryTimelineEntry[]>("story.timeline.query", {}).then(setTimeline).catch(() => undefined);
    void invoke<StoryMap>("story.map.query", {}).then(setMap).catch(() => setMap(null));
    void invoke<typeof graph>("story.graph.query", { types: ["character"] }).then(setGraph).catch(() => setGraph(null));
    setReaderModel(null);
  }, [context.snapshot.repository.repositoryId, context.snapshot.remoteCommit, context.snapshot.overlayCommit]);
  useEffect(() => {
    if (!showCooccurrence) { setCooccurrence(null); return; }
    let cancelled = false;
    void invoke<typeof cooccurrence>("story.cooccurrence", {}).then((data) => {
      if (!cancelled) setCooccurrence(data);
    }).catch(() => { if (!cancelled) setCooccurrence(null); });
    return () => { cancelled = true; };
  }, [showCooccurrence, context.snapshot.repository.repositoryId, context.snapshot.remoteCommit, context.snapshot.overlayCommit]);
  const openThread = async (threadId: string) => {
    setSelected(threadId);
    try { setLifecycle(await invoke("story.threads.lifecycle", { threadId })); } catch { setLifecycle(null); }
  };
  const buildReaderModel = async () => {
    if (!chapterId) return;
    try { setReaderModel(await invoke("story.reader-model.build", { chapterId })); }
    catch { setReaderModel(null); }
  };
  const entityName = (id: string) => {
    const entity = entities.find((item) => item.id === id);
    return entity?.name ?? String(entity?.raw.title ?? id);
  };
  const sceneName = (id?: string | null) => id ? entityName(id) : "not yet disclosed";
  const chapters = tree.flatMap(({ volume, chapters: rows }) => rows.map(({ chapter }) => ({ volume, chapter })));
  return <section style={panelStyle} aria-label="Story continuity">
    <h2>Threads and chronology</h2>
    <label>Thread <select value={selected} onChange={(event) => void openThread(event.target.value)}>
      <option value="">Choose a thread</option>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.name ?? thread.id}</option>)}
    </select></label>
    {lifecycle && <section aria-label="Thread lifecycle"><h3>Lifecycle</h3>
      {lifecycle.snapshots.map((item) => <article key={item.threadId}>
        <h4>{entityName(item.threadId)} · {item.state}</h4>
        <p style={mutedStyle}>Planted: {sceneName(item.plantedSceneId)} · Recalled in {item.recalledSceneIds.length} scene(s) · Payoff: {sceneName(item.resolvedSceneId)} · Scenes since last mention: {item.scenesSinceLastMention}</p>
        {item.mentions.length > 0 && <ul>{item.mentions.map((mention) => <li key={`${item.threadId}-${mention.sceneId}`}>{sceneName(mention.sceneId)} · {mention.matchedKeywords.join(", ") || mention.via}</li>)}</ul>}
      </article>)}
      {lifecycle.warnings.length > 0 && <ul aria-label="Thread lifecycle warnings">{lifecycle.warnings.map((warning, index) => <li key={`${warning.threadId}-${warning.code}-${index}`}>{entityName(warning.threadId)}: {warning.message}</li>)}</ul>}
    </section>}
    <h3>Scene chronology</h3><p>{timeline.length} scene entries</p>
    {timeline.length ? <ol>{timeline.map((item) => <li key={item.sceneId}>
      <strong>{item.title}</strong> · {item.confidence} · {item.relation === "unknown" ? "time unknown" : `day ${item.cumulativeDayOffset ?? "?"}`}
      {item.chapterName ? ` · ${item.chapterName}` : ""}{item.locationName ? ` · ${item.locationName}` : ""}
      {item.expressionSurfaces.length ? <span> · {item.expressionSurfaces.join(", ")}</span> : null}
    </li>)}</ol> : <p style={mutedStyle}>No scene chronology is available.</p>}
    <h3>Location map</h3>
    {map?.edges.length ? <ul>{map.edges.map((edge, index) => {
      const names = new Map(map.nodes.map((node) => [node.id, node.name]));
      return <li key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}>{names.get(edge.from) ?? edge.from} ↔ {names.get(edge.to) ?? edge.to} · {edge.kind}{edge.days === undefined ? "" : ` · ${edge.days} day(s)`}</li>;
    })}</ul> : <p style={mutedStyle}>No connected locations are recorded.</p>}
    <section aria-label="Reader knowledge">
      <h3>Reader knowledge and continuity</h3>
      <div style={rowStyle}>
        <label>Chapter <select value={chapterId} onChange={(event) => { setChapterId(event.target.value); setReaderModel(null); }}>
          <option value="">Choose a chapter</option>{chapters.map(({ volume, chapter }) => <option key={chapter.id} value={chapter.id}>{volume.name ?? volume.id} · {chapter.name ?? String(chapter.raw.title ?? chapter.id)}</option>)}
        </select></label>
        <button type="button" style={buttonStyle} disabled={busy || !chapterId} onClick={() => void buildReaderModel()}>Build reader knowledge</button>
      </div>
      {readerModel && <>
        <p>{readerModel.disclosures.length} reader disclosures · {readerModel.knowledgeGaps.length} knowledge gaps · {readerModel.forgetRisks.length} thread forget-risk checks</p>
        <h4>What the reader has learned</h4>
        {readerModel.disclosures.length ? <ol>{readerModel.disclosures.map((item) => <li key={`${item.sceneId}-${item.entityId}`}>{entityName(item.entityId)} first appears in {sceneName(item.sceneId)} · “{item.evidence}”</li>)}</ol> : <p style={mutedStyle}>No registered entities are disclosed before the selected chapter ends.</p>}
        <h4>Character and reader knowledge gaps</h4>
        {readerModel.knowledgeGaps.length ? <ul>{readerModel.knowledgeGaps.map((gap, index) => <li key={`${gap.kind}-${gap.characterId}-${gap.entityId}-${index}`}>
          {gap.kind === "character_knows_reader_does_not"
            ? `${entityName(gap.characterId)} knows about ${entityName(gap.entityId)} in ${sceneName(gap.characterKnewAtSceneId)} before the reader sees it (${sceneName(gap.readerDisclosedAtSceneId)}).`
            : `The reader has learned about ${entityName(gap.entityId)} in ${sceneName(gap.readerDisclosedAtSceneId)}, but ${entityName(gap.characterId)} has not.`}
        </li>)}</ul> : <p style={mutedStyle}>No knowledge gaps were detected.</p>}
        <h4>Thread forget risk</h4>
        {readerModel.forgetRisks.length ? <ul>{readerModel.forgetRisks.map((risk) => <li key={risk.threadId}>
          {entityName(risk.threadId)} · {Math.round(risk.forgetRisk * 100)}% · {risk.sceneDistance} scene(s) since planting · {risk.disclosureCountBetween} intervening disclosures
        </li>)}</ul> : <p style={mutedStyle}>No planted threads need a forget-risk check.</p>}
        <p style={mutedStyle}>These checks use canonical scene summaries, appearances, and state events from this snapshot. The module’s first-read reaction remains a separate optional assistant flow.</p>
      </>}
    </section>
    <h3>Character relationship graph</h3>
    <button type="button" style={buttonStyle} aria-pressed={showCooccurrence} onClick={() => setShowCooccurrence((value) => !value)}>
      {showCooccurrence ? "Hide co-occurrence overlay" : "Show co-occurrence overlay"}
    </button>
    {showCooccurrence && graph && cooccurrence && <CharacterGraphOverlay graph={graph} cooccurrence={cooccurrence} />}
    {status}
  </section>;
}

function CharacterGraphOverlay({
  graph,
  cooccurrence,
}: {
  graph: { nodes: Array<{ id: string; name: string; type: string }>; edges: Array<{ from: string; to: string; kind: string }> };
  cooccurrence: { edges: Array<{ a: string; b: string; sceneCount: number; jaccard: number; pmi: number }>; gaps: Array<{ a: string; b: string; issue: string; sceneCount: number }> };
}) {
  const nodes = graph.nodes.filter((node) => node.type === "character").slice(0, 80);
  const positions = useMemo(() => {
    const byId = new Map<string, { x: number; y: number }>();
    const radius = Math.min(130, 22 + nodes.length * 4);
    nodes.forEach((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
      byId.set(node.id, { x: 210 + Math.cos(angle) * radius, y: 160 + Math.sin(angle) * radius });
    });
    return byId;
  }, [nodes]);
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  const cooccurrenceKeys = new Set(cooccurrence.edges.map((edge) => [edge.a, edge.b].sort().join("|")));
  return <div aria-label="Character co-occurrence graph">
    <p style={mutedStyle}>Solid lines show registered character relations; orange lines show shared scene appearances. The latter use Jaccard strength.</p>
    <svg viewBox="0 0 420 320" role="img" aria-label="Character relations with co-occurrence overlay" style={{ width: "100%", maxHeight: "24rem", border: "1px solid currentColor", borderRadius: "0.4rem" }}>
      {graph.edges.filter((edge) => names.has(edge.from) && names.has(edge.to) && edge.kind === "related").map((edge, index) => {
        const from = positions.get(edge.from)!; const to = positions.get(edge.to)!;
        return <line key={`relation-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" />;
      })}
      {cooccurrence.edges.filter((edge) => positions.has(edge.a) && positions.has(edge.b)).map((edge) => {
        const from = positions.get(edge.a)!; const to = positions.get(edge.b)!;
        return <line key={`cooccurrence-${edge.a}-${edge.b}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#d97706" strokeOpacity="0.8" strokeWidth={Math.max(1.5, Math.min(6, edge.jaccard * 6))} strokeDasharray={cooccurrenceKeys.has(`${edge.a}|${edge.b}`) ? undefined : "5 3"}><title>{names.get(edge.a)} × {names.get(edge.b)}: {edge.sceneCount} scenes, Jaccard {edge.jaccard.toFixed(2)}</title></line>;
      })}
      {nodes.map((node) => {
        const point = positions.get(node.id)!;
        return <g key={node.id}><circle cx={point.x} cy={point.y} r="5" fill="currentColor" /><text x={point.x + 8} y={point.y + 4} fontSize="10" fill="currentColor">{node.name.length > 18 ? `${node.name.slice(0, 17)}…` : node.name}</text></g>;
      })}
    </svg>
    <p>{cooccurrence.edges.length} co-occurring character pairs · {cooccurrence.gaps.length} relation gaps</p>
    <ul aria-label="Co-occurrence pairs">{cooccurrence.edges.slice(0, 30).map((edge) => <li key={`${edge.a}-${edge.b}`}>{names.get(edge.a) ?? edge.a} × {names.get(edge.b) ?? edge.b} · {edge.sceneCount} scenes · Jaccard {edge.jaccard.toFixed(2)} · PMI {edge.pmi.toFixed(2)}</li>)}</ul>
    {cooccurrence.gaps.length > 0 && <section aria-label="Character relation gaps"><h4>Relation gaps</h4><ul>{cooccurrence.gaps.map((gap) => <li key={`${gap.a}-${gap.b}-${gap.issue}`}>{names.get(gap.a) ?? gap.a} × {names.get(gap.b) ?? gap.b}: {gap.issue === "registered-but-no-cooccurrence" ? "registered but no shared scenes" : `unregistered relation across ${gap.sceneCount} scenes`}</li>)}</ul></section>}
  </div>;
}

function WorldStatePanel({ context }: { context: BrowserModuleContext }) {
  const { invoke, busy, status, setMessage } = useAction(context);
  const [workbench, setWorkbench] = useState<WorldStateWorkbench | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const refresh = async () => {
    const [nextWorkbench, nextEntities] = await Promise.all([
      invoke<WorldStateWorkbench>("story.world-state.workbench", {}),
      invoke<Entity[]>("story.entities.list", {}),
    ]);
    setWorkbench(nextWorkbench);
    setEntities(nextEntities);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [context.snapshot.repository.repositoryId, context.snapshot.remoteCommit, context.snapshot.overlayCommit]);
  const act = async (action: "approve" | "reject", id: string) => {
    try {
      await invoke(`story.state-proposals.${action}`, { id, operation_id: operationId() });
      await refresh();
    } catch { /* The panel displays the machine error. */ }
  };
  const saveEdit = async (id: string) => {
    try {
      const event = JSON.parse(draft) as Record<string, unknown>;
      const updated = await invoke<{ id: string; status: string; event: Record<string, unknown>; history: Array<Record<string, unknown>> }>("story.state-proposals.update", { id, event, operation_id: operationId() });
      setWorkbench((previous) => previous ? { ...previous, proposals: previous.proposals.map((proposal) => proposal.id === id ? { ...proposal, ...updated } : proposal) } : previous);
      setEditingId(null);
      setDraft("");
      setMessage(`Proposed edit to world-state event ${id}.`);
    } catch { /* The panel displays parse or action errors. */ }
  };
  const entityName = (id: unknown) => {
    if (typeof id !== "string") return "unknown";
    const entity = entities.find((item) => item.id === id);
    return entity?.name ?? String(entity?.raw.title ?? id);
  };
  return <section style={panelStyle} aria-label="Story world state">
    <h2>World state</h2>
    <button style={buttonStyle} disabled={busy} onClick={() => void refresh().catch(() => undefined)}>Refresh state</button>
    {workbench && <>
      <p>{workbench.scenes.length} scenes · {workbench.events.length} confirmed events · {workbench.proposals.length} proposals</p>
      <h3>Confirmed state changes</h3>
      {workbench.events.length ? <ul>{workbench.events.map((event, index) => <li key={`${event.sceneId}-${event.order}-${index}`}>
        {entityName(event.subject)} {event.kind}{event.object ? ` → ${entityName(event.object)}` : ""} · {entityName(event.sceneId)}
      </li>)}</ul> : <p style={mutedStyle}>No confirmed world-state events are recorded.</p>}
      <h3>Pending event proposals</h3>
      <ul>{workbench.proposals.map((proposal) => <li key={proposal.id}>
        <strong>{proposal.status}</strong> · {String(proposal.event.kind ?? "event")} for {entityName(proposal.event.subject)}{proposal.event.object ? ` → ${entityName(proposal.event.object)}` : ""} · {entityName(proposal.event.sceneId)}
        {editingId === proposal.id ? <div style={panelStyle}>
          <label>Edit event proposal <textarea aria-label="World-state event JSON" rows={10} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          <div style={rowStyle}>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => void saveEdit(proposal.id)}>Propose event edit</button>
            <button type="button" style={buttonStyle} onClick={() => { setEditingId(null); setDraft(""); }}>Cancel edit</button>
          </div>
        </div> : null}
        {proposal.history?.length ? <details><summary>Proposal history ({proposal.history.length})</summary><ul>{proposal.history.map((entry, index) => <li key={index}>{String(entry.action ?? "update")} · {String(entry.at ?? "")}</li>)}</ul></details> : null}
        {proposal.status === "proposed" || proposal.status === "stale" ? <span style={rowStyle}>
          {editingId !== proposal.id && <button style={buttonStyle} disabled={busy} onClick={() => { setEditingId(proposal.id); setDraft(JSON.stringify(proposal.event, null, 2)); }}>Edit event</button>}
          <button style={buttonStyle} disabled={busy} onClick={() => void act("approve", proposal.id)}>Propose event confirmation</button>
          <button style={buttonStyle} disabled={busy} onClick={() => void act("reject", proposal.id)}>Propose rejection</button>
        </span> : null}
      </li>)}</ul>
    </>}
    {status}
  </section>;
}

function ZukanReviewPanel({ context }: { context: BrowserModuleContext }) {
  const { invoke, busy, status, setMessage } = useAction(context);
  const [suggestions, setSuggestions] = useState<ZukanSuggestion[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const submitted = useRef(new Set<string>());
  const refresh = async () => {
    const result = await invoke<{ pendingCount: number; suggestions: ZukanSuggestion[] }>("story.zukan-suggestions.list", { status: "pending" });
    setPendingCount(result.pendingCount);
    setSuggestions(result.suggestions.filter((item) => !submitted.current.has(item.id)));
  };
  useEffect(() => { submitted.current.clear(); void refresh().catch(() => undefined); }, [context.snapshot.repository.repositoryId, context.snapshot.remoteCommit, context.snapshot.overlayCommit]);
  const decide = async (decision: "approve" | "reject", item: ZukanSuggestion) => {
    try {
      await invoke(`story.zukan-suggestions.${decision}`, {
        id: item.id,
        ...(decision === "approve" && item.entityRevision ? { entityRevision: item.entityRevision } : {}),
        operation_id: operationId(),
      });
      submitted.current.add(item.id);
      setSuggestions((previous) => previous.filter((candidate) => candidate.id !== item.id));
      setPendingCount((previous) => Math.max(0, previous - 1));
      setMessage(`Proposed ${decision} for Zukan suggestion ${item.id}. Review the proposal before checkpointing.`);
    } catch { /* The panel displays the machine error. */ }
  };
  return <section style={panelStyle} aria-label="Zukan suggestion review">
    <h2>Zukan suggestions</h2>
    <p>{pendingCount} pending suggestion(s)</p>
    <button type="button" style={buttonStyle} disabled={busy} onClick={() => void refresh().catch(() => undefined)}>Refresh suggestions</button>
    {suggestions.length ? <ul>{suggestions.map((item) => <li key={item.id}>
      <strong>{item.entityName ?? item.entityId}</strong> · {item.kind ?? "note"} · {item.source} · {item.blockPath}
      <p>{item.proposedText}</p>
      {item.evidence.length > 0 && <details><summary>Evidence ({item.evidence.length})</summary><ul>{item.evidence.map((evidence, index) => <li key={`${evidence.sceneId ?? "quote"}-${index}`}>{evidence.sceneId ? `${evidence.sceneId}: ` : ""}{evidence.quote}</li>)}</ul></details>}
      <div style={rowStyle}>
        <button type="button" style={buttonStyle} disabled={busy || !item.entityRevision} onClick={() => void decide("approve", item)}>Propose approval</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void decide("reject", item)}>Propose rejection</button>
      </div>
    </li>)}</ul> : <p style={mutedStyle}>No pending suggestions are available in this snapshot.</p>}
    {status}
  </section>;
}

function SeriesSettingsPanel({ context }: { context: BrowserModuleContext }) {
  const { invoke, busy, status, setMessage } = useAction(context);
  const [series, setSeries] = useState<Array<{ id: string; name: string; bibleRepositoryId?: string; bibleProjectId?: string }>>([]);
  const [repositories, setRepositories] = useState<Array<{ repository: { repositoryId: string; url: string; defaultBranch: string } }>>([]);
  const [name, setName] = useState("");
  const [bibleRepositoryId, setBibleRepositoryId] = useState("");
  const [selected, setSelected] = useState("");
  const [binding, setBinding] = useState<unknown>(null);
  const refresh = async () => {
    const [seriesRows, repoList, currentBinding] = await Promise.all([
      invoke<typeof series>("story.series.list", {}),
      invoke<{ repositories: typeof repositories }>("core.repositories.list", {}),
      invoke("story.series.binding.get", {}),
    ]);
    setSeries(seriesRows);
    setRepositories(repoList.repositories);
    setBinding(currentBinding);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [context.snapshot.repository.repositoryId, context.snapshot.remoteCommit, context.snapshot.overlayCommit]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const created = await invoke<{ id: string }>("story.series.create", { name, bibleRepositoryId, operation_id: operationId() });
      setName(""); setSelected(created.id); await refresh();
      setMessage(`Proposed series ${created.id}.`);
    } catch { /* The panel displays the machine error. */ }
  };
  const bind = async () => {
    if (!selected) return;
    try {
      await invoke("story.series.binding.update", { seriesId: selected, operation_id: operationId() });
      await refresh();
      setMessage("Proposed this repository’s series binding. The linked Bible remains read-only.");
    } catch { /* The panel displays the machine error. */ }
  };
  const selectedSeries = useMemo(() => series.find((item) => item.id === selected), [series, selected]);
  return <section style={panelStyle} aria-label="Story series settings">
    <h2>Series and Bible binding</h2>
    <form style={panelStyle} onSubmit={(event) => void create(event)}>
      <label>Series name <input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Bible repository <select required value={bibleRepositoryId} onChange={(event) => setBibleRepositoryId(event.target.value)}>
        <option value="">Choose a registered repository</option>{repositories.map(({ repository }) => <option key={repository.repositoryId} value={repository.repositoryId}>{repository.url} ({repository.defaultBranch})</option>)}
      </select></label>
      <button style={buttonStyle} disabled={busy || !name.trim() || !bibleRepositoryId}>Propose series</button>
    </form>
    <label>Series <select value={selected} onChange={(event) => setSelected(event.target.value)}>
      <option value="">Choose a series</option>{series.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    {selectedSeries?.bibleRepositoryId ? <p style={mutedStyle}>Bible: {selectedSeries.bibleRepositoryId}</p> : selectedSeries?.bibleProjectId ? <p role="status">This series has a legacy project binding that needs author review.</p> : null}
    <div style={rowStyle}>
      <button style={buttonStyle} disabled={busy || !selected} onClick={() => void bind()}>Propose work binding</button>
      <button style={buttonStyle} disabled={busy} onClick={() => void refresh().catch(() => undefined)}>Refresh series</button>
    </div>
    <details><summary>Current binding status</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(binding, null, 2)}</pre></details>
    {status}
  </section>;
}

const components: Record<string, React.ComponentType<{ context: BrowserModuleContext }>> = {
  "story.navigator": StoryNavigator,
  "story.inspector": StoryInspector,
  "story.continuity": ContinuityPanel,
  "story.world-state": WorldStatePanel,
  "story.zukan-review": ZukanReviewPanel,
  "story.series": SeriesSettingsPanel,
};

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId, element, context) {
    const Component = components[contributionId];
    if (!Component) throw new TypeError(`Unknown Story UI contribution: ${contributionId}`);
    const root: Root = createRoot(element);
    root.render(<Component context={context} />);
    return () => root.unmount();
  },
};
