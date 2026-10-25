export type WorkspacePreset = "writing" | "research" | "review" | "custom";
export type SplitDirection = "horizontal" | "vertical";
export type DockSide = "left" | "right" | "top" | "bottom";

export interface WorkspaceLeaf {
  type: "leaf";
  panelId: string;
}

export interface WorkspaceStack {
  type: "stack";
  id: string;
  activePanelId: string;
  children: WorkspaceLeaf[];
}

export interface WorkspaceSplit {
  type: "split";
  id: string;
  direction: SplitDirection;
  /** Percentage for each child, in the same order as `children`. */
  sizes: number[];
  children: WorkspaceNode[];
}

export type WorkspaceNode = WorkspaceLeaf | WorkspaceStack | WorkspaceSplit;

export interface WorkspaceLayout {
  version: 1;
  preset: WorkspacePreset;
  root: WorkspaceNode;
  hiddenPanelIds: string[];
}

export type LayoutIssue = "shape" | "version" | "depth" | "size" | "duplicate" | "identifier" | "empty";

const PANEL_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,159}$/;
const NODE_ID = /^(split|stack)-[A-Za-z0-9-]{1,80}$/;
const MAX_DEPTH = 12;
const MAX_NODES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validPanelId(value: unknown): value is string {
  return typeof value === "string" && PANEL_ID.test(value);
}

function validNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID.test(value);
}

/** Validate persisted declarative layout data before it reaches the renderer. */
export function validateWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "preset", "root", "hiddenPanelIds"]) || value.version !== 1 ||
      (value.preset !== "writing" && value.preset !== "research" && value.preset !== "review" && value.preset !== "custom") ||
      !Array.isArray(value.hiddenPanelIds) || value.hiddenPanelIds.length > MAX_NODES) return false;

  const panelIds = new Set<string>();
  const nodeIds = new Set<string>();
  let nodeCount = 0;

  const visit = (node: unknown, depth: number): boolean => {
    if (!isRecord(node) || depth > MAX_DEPTH || ++nodeCount > MAX_NODES) return false;
    if (node.type === "leaf") {
      if (!hasOnlyKeys(node, ["type", "panelId"]) || !validPanelId(node.panelId) || panelIds.has(node.panelId)) return false;
      panelIds.add(node.panelId);
      return true;
    }
    if ((node.type !== "stack" && node.type !== "split") || !validNodeId(node.id) || nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);

    if (node.type === "stack") {
      if (!hasOnlyKeys(node, ["type", "id", "activePanelId", "children"]) ||
          !Array.isArray(node.children) || node.children.length < 2 || !validPanelId(node.activePanelId)) return false;
      let activeFound = false;
      for (const child of node.children) {
        if (!isRecord(child) || child.type !== "leaf" || !visit(child, depth + 1)) return false;
        if (child.panelId === node.activePanelId) activeFound = true;
      }
      return activeFound;
    }

    if (!hasOnlyKeys(node, ["type", "id", "direction", "sizes", "children"]) ||
        (node.direction !== "horizontal" && node.direction !== "vertical") ||
        !Array.isArray(node.children) || node.children.length < 2 || !Array.isArray(node.sizes) ||
        node.sizes.length !== node.children.length) return false;
    const sizes = node.sizes;
    if (sizes.some((size) => typeof size !== "number" || !Number.isFinite(size) || size < 1 || size > 99) ||
        Math.abs(sizes.reduce((sum, size) => sum + (size as number), 0) - 100) > 1) return false;
    return node.children.every((child) => visit(child, depth + 1));
  };

  if (!visit(value.root, 0)) return false;
  for (const hidden of value.hiddenPanelIds) {
    if (!validPanelId(hidden) || panelIds.has(hidden)) return false;
    panelIds.add(hidden);
  }
  return panelIds.size > 0 && panelIds.size <= MAX_NODES;
}

function nextNodeId(root: WorkspaceNode, kind: "split" | "stack"): string {
  const used = new Set<string>();
  const visit = (node: WorkspaceNode): void => {
    if (node.type !== "leaf") {
      used.add(node.id);
      node.children.forEach(visit);
    }
  };
  visit(root);
  let sequence = 1;
  while (used.has(`${kind}-${sequence}`)) sequence++;
  return `${kind}-${sequence}`;
}

function leaf(panelId: string): WorkspaceLeaf {
  return { type: "leaf", panelId };
}

function stack(root: WorkspaceNode, children: WorkspaceLeaf[], activePanelId: string): WorkspaceStack {
  return { type: "stack", id: nextNodeId(root, "stack"), activePanelId, children };
}

function split(root: WorkspaceNode, direction: SplitDirection, children: WorkspaceNode[], sizes: number[]): WorkspaceSplit {
  return { type: "split", id: nextNodeId(root, "split"), direction, sizes, children };
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + Math.max(1, size), 0);
  const normalized = sizes.map((size) => Math.max(1, size) * 100 / total);
  const remainder = 100 - normalized.reduce((sum, size) => sum + size, 0);
  normalized[normalized.length - 1] += remainder;
  return normalized;
}

export function visiblePanelIds(node: WorkspaceNode): string[] {
  if (node.type === "leaf") return [node.panelId];
  if (node.type === "stack") return node.children.map((child) => child.panelId);
  return node.children.flatMap(visiblePanelIds);
}

function preferredPanels(preset: Exclude<WorkspacePreset, "custom">, ids: string[]): string[] {
  const chosen = new Set<string>();
  const add = (id: string): void => { if (ids.includes(id)) chosen.add(id); };
  const primary = ids.includes("editor") ? "editor" : ids[0];
  if (primary) chosen.add(primary);

  if (preset === "writing") {
    add("outline");
    add("inspector");
  } else if (preset === "research") {
    add("outline");
    add("inspector");
    ids.filter((id) => id.startsWith("module:")).forEach(add);
  } else {
    add("review");
    add("history");
    add("inspector");
  }
  return [primary, ...[...chosen].filter((id) => id !== primary)].filter((id): id is string => Boolean(id));
}

export function createWorkspacePreset(preset: Exclude<WorkspacePreset, "custom">, panelIds: string[]): WorkspaceLayout {
  const ids = [...new Set(panelIds.filter(validPanelId))];
  const selected = preferredPanels(preset, ids);
  const root: WorkspaceNode = selected.length === 0
    ? leaf("editor")
    : selected.length === 1
      ? leaf(selected[0]!)
      : {
        type: "split",
        id: "split-preset-main",
        direction: "horizontal",
        children: [leaf(selected[0]!), selected.length === 2
          ? leaf(selected[1]!)
          : { type: "stack", id: "stack-preset-secondary", activePanelId: selected[1]!, children: selected.slice(1).map(leaf) }],
        sizes: [68, 32],
      };
  const layout: WorkspaceLayout = {
    version: 1,
    preset,
    root,
    hiddenPanelIds: ids.filter((id) => !selected.includes(id)),
  };
  return layout;
}

function removePanel(node: WorkspaceNode, panelId: string): WorkspaceNode | null {
  if (node.type === "leaf") return node.panelId === panelId ? null : node;
  if (node.type === "stack") {
    const children = node.children.filter((child) => child.panelId !== panelId);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return {
      ...node,
      children,
      activePanelId: node.activePanelId === panelId ? children[0]!.panelId : node.activePanelId,
    };
  }
  const children: WorkspaceNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const remaining = removePanel(child, panelId);
    if (remaining) {
      children.push(remaining);
      sizes.push(node.sizes[index]!);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children, sizes: normalizeSizes(sizes) };
}

function insertAsTab(node: WorkspaceNode, targetId: string, sourceId: string, root: WorkspaceNode): WorkspaceNode {
  if (node.type === "leaf") {
    if (node.panelId !== targetId) return node;
    return stack(root, [node, leaf(sourceId)], sourceId);
  }
  if (node.type === "stack") {
    const targetIndex = node.children.findIndex((child) => child.panelId === targetId);
    if (targetIndex >= 0) {
      const children = [...node.children];
      children.splice(targetIndex + 1, 0, leaf(sourceId));
      return { ...node, children, activePanelId: sourceId };
    }
    return node;
  }
  return { ...node, children: node.children.map((child) => insertAsTab(child, targetId, sourceId, root)) };
}

function insertBeside(node: WorkspaceNode, targetId: string, sourceId: string, side: DockSide, root: WorkspaceNode): WorkspaceNode {
  const direction: SplitDirection = side === "left" || side === "right" ? "horizontal" : "vertical";
  const sourceBefore = side === "left" || side === "top";
  const combine = (target: WorkspaceNode): WorkspaceSplit => split(
    root,
    direction,
    sourceBefore ? [leaf(sourceId), target] : [target, leaf(sourceId)],
    [50, 50],
  );
  if (node.type === "leaf") return node.panelId === targetId ? combine(node) : node;
  if (node.type === "stack") {
    if (node.children.some((child) => child.panelId === targetId)) return combine(node);
    return node;
  }
  return { ...node, children: node.children.map((child) => insertBeside(child, targetId, sourceId, side, root)) };
}

export function moveWorkspacePanel(
  layout: WorkspaceLayout,
  sourceId: string,
  targetId: string,
  placement: "tab" | DockSide,
): WorkspaceLayout {
  if (sourceId === targetId || !visiblePanelIds(layout.root).includes(sourceId) ||
      !visiblePanelIds(layout.root).includes(targetId)) return layout;
  const remaining = removePanel(layout.root, sourceId);
  if (!remaining) return layout;
  const root = placement === "tab"
    ? insertAsTab(remaining, targetId, sourceId, remaining)
    : insertBeside(remaining, targetId, sourceId, placement, remaining);
  const updated = { ...layout, preset: "custom" as const, root };
  return validateWorkspaceLayout(updated) ? updated : layout;
}

export function hideWorkspacePanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  if (!visiblePanelIds(layout.root).includes(panelId) || visiblePanelIds(layout.root).length <= 1) return layout;
  const root = removePanel(layout.root, panelId);
  if (!root) return layout;
  return { ...layout, preset: "custom", root, hiddenPanelIds: [...layout.hiddenPanelIds, panelId] };
}

function addToFirstPanel(node: WorkspaceNode, panelId: string, root: WorkspaceNode): WorkspaceNode {
  if (node.type === "leaf") return stack(root, [node, leaf(panelId)], panelId);
  if (node.type === "stack") return { ...node, children: [...node.children, leaf(panelId)], activePanelId: panelId };
  return { ...node, children: [addToFirstPanel(node.children[0]!, panelId, root), ...node.children.slice(1)] };
}

export function showWorkspacePanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  if (visiblePanelIds(layout.root).includes(panelId) || !validPanelId(panelId)) return layout;
  const root = addToFirstPanel(layout.root, panelId, layout.root);
  const updated = {
    ...layout,
    preset: "custom" as const,
    root,
    hiddenPanelIds: layout.hiddenPanelIds.filter((id) => id !== panelId),
  };
  return validateWorkspaceLayout(updated) ? updated : layout;
}

export function resizeWorkspaceSplit(layout: WorkspaceLayout, splitId: string, sizes: number[]): WorkspaceLayout {
  const update = (node: WorkspaceNode): WorkspaceNode => {
    if (node.type !== "split") return node;
    if (node.id === splitId && sizes.length === node.children.length &&
        sizes.every((size) => Number.isFinite(size) && size >= 1 && size <= 99)) {
      return { ...node, sizes: normalizeSizes(sizes) };
    }
    return { ...node, children: node.children.map(update) };
  };
  const updated = { ...layout, preset: "custom" as const, root: update(layout.root) };
  return validateWorkspaceLayout(updated) ? updated : layout;
}

export function activateWorkspacePanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  const update = (node: WorkspaceNode): WorkspaceNode => {
    if (node.type === "leaf") return node;
    if (node.type === "stack") return node.children.some((child) => child.panelId === panelId)
      ? { ...node, activePanelId: panelId }
      : node;
    return { ...node, children: node.children.map(update) };
  };
  const updated = { ...layout, preset: "custom" as const, root: update(layout.root) };
  return validateWorkspaceLayout(updated) ? updated : layout;
}
