import { getGraphData, type GraphNode } from "./graph.js";
import {
  snapshotResult,
  type StoryEntity,
  type StoryGraphInput,
  type StorySnapshotResult,
} from "./types.js";

export interface LocationMapEdge {
  from: string;
  to: string;
  kind: string;
  days?: number;
}

export interface LocationMapData {
  nodes: GraphNode[];
  edges: LocationMapEdge[];
}

function travelData(entity: StoryEntity): Record<string, unknown> | null {
  const value = entity.raw.travel;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Source location-map projection: graph relations plus reciprocal raw.travel links. */
export function buildLocationMap(input: StoryGraphInput): StorySnapshotResult<LocationMapData> {
  const graph = getGraphData({ ...input, types: ["location"] }).data;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const locations = [...input.entities.values()]
    .filter((entity) => entity.type === "location")
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, "ja"));
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const edges: LocationMapEdge[] = [];
  const undirectedKeys = new Set<string>();

  const pushUndirected = (from: string, to: string, kind: string, days?: number): void => {
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}|${b}|${kind}`;
    if (undirectedKeys.has(key)) {
      if (days != null) {
        const existing = edges.find((edge) => edge.from === a && edge.to === b && edge.kind === kind);
        if (existing && existing.days == null) existing.days = days;
      }
      return;
    }
    undirectedKeys.add(key);
    edges.push(days != null ? { from: a, to: b, kind, days } : { from: a, to: b, kind });
  };

  for (const edge of graph.edges) pushUndirected(edge.from, edge.to, edge.kind);
  for (const location of locations) {
    const travel = travelData(location);
    if (!travel) continue;
    const daysTo =
      travel.daysTo && typeof travel.daysTo === "object" && !Array.isArray(travel.daysTo)
        ? (travel.daysTo as Record<string, unknown>)
        : {};
    const resolveDays = (otherId: string): number | undefined => {
      const forward = daysTo[otherId];
      if (typeof forward === "number" && Number.isFinite(forward) && forward >= 0) return forward;
      const otherTravel = locationById.get(otherId);
      const reciprocal = otherTravel ? travelData(otherTravel)?.daysTo : undefined;
      if (!reciprocal || typeof reciprocal !== "object" || Array.isArray(reciprocal)) return undefined;
      const backward = (reciprocal as Record<string, unknown>)[location.id];
      if (typeof backward === "number" && Number.isFinite(backward) && backward >= 0) return backward;
      return undefined;
    };

    if (Array.isArray(travel.adjacent)) {
      for (const adjacent of travel.adjacent) {
        if (typeof adjacent === "string") {
          pushUndirected(location.id, adjacent, "adjacent", resolveDays(adjacent));
        }
      }
    }
    if (Array.isArray(travel.sameAs)) {
      for (const same of travel.sameAs) {
        if (typeof same === "string") pushUndirected(location.id, same, "sameAs", resolveDays(same));
      }
    }
  }
  return snapshotResult(input.snapshot, { nodes: graph.nodes, edges });
}
