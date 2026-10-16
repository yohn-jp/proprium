export type ClusterAssignmentEvent = {
  code: "entity-reason" | "partition-key" | "heuristic" | "promote-strong-hint" | "assign-cluster-id" | "consolidate" | "expand" | "voiceprint-relabel" | "override-align";
  detail?: string;
  relatedSentenceIndex?: number;
};

export interface ClusterAssignmentTrail { sentenceIndex: number; events: ClusterAssignmentEvent[] }

export interface ClusterTrailCollector {
  push(sentenceIndex: number, event: ClusterAssignmentEvent): void;
  toTrails(): ClusterAssignmentTrail[];
}

export function createClusterTrailCollector(): ClusterTrailCollector {
  const rows = new Map<number, ClusterAssignmentEvent[]>();
  return {
    push(sentenceIndex, event) {
      const events = rows.get(sentenceIndex) ?? [];
      events.push(event);
      rows.set(sentenceIndex, events);
    },
    toTrails() {
      return [...rows].sort(([a], [b]) => a - b).map(([sentenceIndex, events]) => ({ sentenceIndex, events: [...events] }));
    },
  };
}

export function pushGroupIdChangeEvents(
  collector: ClusterTrailCollector | undefined,
  before: Array<{ sentenceIndex: number; speakerGroupId: string | null }>,
  after: Array<{ sentenceIndex: number; speakerGroupId: string | null }>,
  code: "consolidate" | "expand",
): void {
  if (!collector) return;
  for (let index = 0; index < after.length; index++) {
    const prior = before[index];
    const next = after[index];
    if (prior && next && prior.speakerGroupId !== next.speakerGroupId) {
      collector.push(next.sentenceIndex, { code, detail: `${prior.speakerGroupId ?? "none"}->${next.speakerGroupId ?? "none"}` });
    }
  }
}
