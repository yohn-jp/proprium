import type { Token, Tokenizer } from "@scriptorium/module-nlp";
import type { StylometricProfile } from "@scriptorium/module-diagnostics";
import { createClusterTrailCollector, pushGroupIdChangeEvents } from "./clusterAssignmentTrail.js";
import { buildMentionDictionary } from "./mentionIndex.js";
import {
  alignOverrideClusters,
  applySpeakerOverrides,
  attributeSpeakers,
  countKnownSpeakers,
  type SpeakerAttribution,
  type SpeakerOverride,
} from "./speakerAttribution.js";
import {
  consolidateEntityClusters,
  ensureAllClusterIds,
  expandClustersToN,
  partitionDialoguesIntoN,
} from "./speakerClustering.js";
import { detectSceneBreakHints, estimateSpeakerCount } from "./speakerCount.js";
import { labelGroupsByVoiceprint } from "./speakerGroupLabeling.js";
import { applySpeakerReranker, type SpeakerModel, type SpeakerRerankContext } from "./speakerReranker.js";
import { applyGatesToAttributions, emptySpeakerRuleGates, type SpeakerRuleGates } from "./speakerRuleStats.js";
import { splitIntoSentences } from "./textAnalysis.js";
import type { Entity } from "./types.js";
import { extractVoiceProfiles } from "./voice/index.js";
import type { ClusterAssignmentTrail } from "./clusterAssignmentTrail.js";

/** JSON-safe input prepared by the host. Morphology is always obtained through the NLP lease. */
export interface SpeakerPipelineInput {
  scene: Entity;
  text: string;
  entities: Entity[];
  candidates: Entity[];
  tokenCache: Record<string, Token[]>;
  gates?: SpeakerRuleGates;
  model?: SpeakerModel | null;
  stylometricProfiles?: StylometricProfile[];
  ignoreOverrides?: boolean;
  skipReranker?: boolean;
}

export interface SpeakerPipelineResult {
  attributions: SpeakerAttribution[];
  estimatedN: number;
  fromManual: boolean;
  evidence: { knownFloor: number; vocativeCensus: number };
  clusterTrails: ClusterAssignmentTrail[];
}

function cachedTokenizer(cache: Record<string, Token[]>): Tokenizer {
  return {
    tokenize(text) {
      const tokens = cache[text];
      if (!tokens) throw new Error(`Speaker worker received no shared-tokenizer result for ${JSON.stringify(text.slice(0, 80))}`);
      return tokens;
    },
  };
}

function overridesFor(scene: Entity, ignoreOverrides: boolean): SpeakerOverride[] {
  if (ignoreOverrides || !Array.isArray(scene.raw.speakerOverrides)) return [];
  return scene.raw.speakerOverrides.filter((value): value is SpeakerOverride => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row.dialogueText === "string" &&
      (row.speakerEntityId === null || typeof row.speakerEntityId === "string");
  });
}

/** Source SpeakerService pipeline, with persistence and model/tokenizer ownership at the host boundary. */
export function runSpeakerPipeline(input: SpeakerPipelineInput): SpeakerPipelineResult {
  const tokenizer = cachedTokenizer(input.tokenCache);
  const allEntities = new Map(input.entities.map((entity) => [entity.id, entity]));
  const mentionDictionary = buildMentionDictionary(allEntities);
  const overrides = overridesFor(input.scene, input.ignoreOverrides === true);
  const povEntityId = typeof input.scene.raw.pov === "string" ? input.scene.raw.pov : undefined;
  const gates = input.gates ?? emptySpeakerRuleGates();

  const attributed = attributeSpeakers(input.text, input.candidates, mentionDictionary, {
    ...(povEntityId ? { povEntityId } : {}),
    tokenizer,
  });
  const gated = applyGatesToAttributions(attributed, gates);
  const anchored = applySpeakerOverrides(gated, overrides);
  const trailCollector = createClusterTrailCollector();
  for (const attribution of anchored) {
    if (attribution.reason !== "none") {
      trailCollector.push(attribution.sentenceIndex, { code: "entity-reason", detail: attribution.reason });
    }
  }

  const sentences = splitIntoSentences(input.text);
  const partitionContext = {
    sentences,
    tokenizer,
    candidateEntities: input.candidates,
    voiceProfiles: input.candidates.flatMap((candidate) => extractVoiceProfiles(candidate) ?? []),
    sceneBreakHints: detectSceneBreakHints(input.text),
    trailCollector,
  };
  const estimate = estimateSpeakerCount({
    speakerCount: input.scene.raw.speakerCount,
    dialogueCount: anchored.length,
    appearsEntities: input.candidates,
    text: input.text,
    knownSpeakerCount: countKnownSpeakers(anchored),
    attributions: anchored,
    partitionContext,
  });
  const { n, estimatedN, fromManual, evidence } = estimate;
  const clustered = partitionDialoguesIntoN(anchored, n, partitionContext);
  const profiles = input.stylometricProfiles ?? [];
  const labeled = profiles.length > 0
    ? labelGroupsByVoiceprint(clustered, profiles, tokenizer, input.candidates.map((candidate) => candidate.id))
    : clustered;
  if (labeled !== clustered) {
    for (let i = 0; i < labeled.length; i++) {
      const before = clustered[i];
      const after = labeled[i];
      if (before && after && (after.speakerEntityId !== before.speakerEntityId || after.speakerGroupId !== before.speakerGroupId)) {
        trailCollector.push(after.sentenceIndex, { code: "voiceprint-relabel", detail: after.speakerEntityId ?? after.speakerGroupId ?? undefined });
      }
    }
  }
  const repartitioned = profiles.length > 0
    ? partitionDialoguesIntoN(labeled, n, partitionContext)
    : labeled;
  const overridden = applySpeakerOverrides(repartitioned, overrides);
  const beforeAlign = overridden.map(({ sentenceIndex, speakerGroupId }) => ({ sentenceIndex, speakerGroupId }));
  const aligned = alignOverrideClusters(overridden, overrides);
  for (let i = 0; i < aligned.length; i++) {
    const before = beforeAlign[i]?.speakerGroupId;
    const after = aligned[i];
    if (after && after.speakerGroupId !== null && after.speakerGroupId !== before) {
      trailCollector.push(after.sentenceIndex, { code: "override-align", detail: before ? `${before}->${after.speakerGroupId}` : after.speakerGroupId });
    } else if (after?.reason === "manual-override") {
      trailCollector.push(after.sentenceIndex, { code: "override-align", detail: after.speakerGroupId ?? undefined });
    }
  }
  const beforeConsolidate = aligned.map(({ sentenceIndex, speakerGroupId }) => ({ sentenceIndex, speakerGroupId }));
  const consolidated = consolidateEntityClusters(aligned);
  pushGroupIdChangeEvents(trailCollector, beforeConsolidate, consolidated, "consolidate");
  const beforeExpand = consolidated.map(({ sentenceIndex, speakerGroupId }) => ({ sentenceIndex, speakerGroupId }));
  const expanded = expandClustersToN(consolidated, n);
  pushGroupIdChangeEvents(trailCollector, beforeExpand, expanded, "expand");
  const finalized = ensureAllClusterIds(expanded, n);
  let attributions = applyGatesToAttributions(finalized, gates);
  if (input.skipReranker !== true && input.model) {
    const reasonPrecision: Record<string, number> = {};
    for (const [reason, gate] of Object.entries(gates.gates)) reasonPrecision[reason] = gate.measuredPrecision;
    const context: SpeakerRerankContext = {
      candidateIds: input.candidates.map((candidate) => candidate.id),
      ...(povEntityId ? { povEntityId } : {}),
      reasonPrecision,
    };
    attributions = applySpeakerReranker(attributions, input.model, context);
  }
  return { attributions, estimatedN, fromManual, evidence, clusterTrails: trailCollector.toTrails() };
}
