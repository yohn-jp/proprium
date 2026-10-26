import type { ClusterTrailCollector } from "../clusterAssignmentTrail.js";
import type { SpeakerAttribution } from "../speakerAttribution.js";
import { keyEntityId } from "./anchors.js";
import type { DialogueRecord } from "./types.js";
import { speakerClusterId } from "./types.js";

/**
 * 空クラスタを埋める。同一キャラを複数クラスタに割るのは禁止なので、
 * speakerEntityId 付きの行は絶対に動かさない（未ラベル行だけをドナーにする）。
 * 未ラベルの余剰が無ければ空のまま残し、後段で ID を詰め直す。
 */
export function fillEmptyClusters(
  result: SpeakerAttribution[],
  assignment: Array<string | null>,
  clusterIds: string[],
  _entityToCluster: Map<string, string>,
): void {
  const members = new Map<string, number[]>();
  for (const id of clusterIds) members.set(id, []);
  for (let i = 0; i < assignment.length; i++) {
    const gid = assignment[i];
    if (gid === null) continue;
    members.get(gid)?.push(i);
  }
  for (const emptyId of clusterIds) {
    const emptyMembers = members.get(emptyId);
    if (emptyMembers === undefined || emptyMembers.length > 0) continue;
    let donorId: string | null = null;
    let unlabeled = 0;
    for (const [id, idxs] of members) {
      const unlabeledCount = idxs.filter((j) => result[j].speakerEntityId === null).length;
      if (unlabeledCount > unlabeled && idxs.length > 1) {
        unlabeled = unlabeledCount;
        donorId = id;
      }
    }
    if (donorId === null) break;
    const donor = members.get(donorId);
    if (donor === undefined) continue;
    let moveIdx = -1;
    for (let d = donor.length - 1; d >= 0; d--) {
      const idx = donor[d];
      if (result[idx].speakerEntityId !== null) continue;
      moveIdx = idx;
      donor.splice(d, 1);
      break;
    }
    if (moveIdx < 0) break;
    assignment[moveIdx] = emptyId;
    emptyMembers.push(moveIdx);
  }
}

/**
 * 1キャラ ≤ 1クラスタを強制する。同じ speakerEntityId の行を先頭グループへ合流させ、
 * 公開 ID を登場順の cluster-1… に詰め直す（空クラスタは落とす）。
 */
export function consolidateEntityClusters(
  attributions: SpeakerAttribution[],
): SpeakerAttribution[] {
  const result = attributions.map((attribution) => ({ ...attribution }));
  const groupByEntity = new Map<string, string>();
  for (const attribution of result) {
    if (attribution.speakerEntityId === null || attribution.speakerGroupId === null) continue;
    if (!groupByEntity.has(attribution.speakerEntityId)) {
      groupByEntity.set(attribution.speakerEntityId, attribution.speakerGroupId);
    }
  }
  for (const attribution of result) {
    if (attribution.speakerEntityId === null) continue;
    const groupId = groupByEntity.get(attribution.speakerEntityId);
    if (groupId) attribution.speakerGroupId = groupId;
  }

  return renumberClusters(result);
}

/**
 * クラスタ数を最大 n まで拡張する（削減は呼び出し側の partition が担う）。
 * 同一キャラを割らず、大きいクラスタから **未ラベル行だけ** を剥がして新クラスタにする。
 *
 * 自動／手動ラベル付きの行は剥がさない。ラベルを外して「不明」スロットを製造すると、
 * ユーザーが不明を直すたびに別行が不明になる往復が起きるため。
 * 未ラベルが足りず n に届かない場合はそのまま返す（appears のみのキャラは一覧の別行で表す）。
 */
export function expandClustersToN(
  attributions: SpeakerAttribution[],
  n: number,
): SpeakerAttribution[] {
  if (attributions.length === 0 || n <= 0) return attributions.map((a) => ({ ...a }));
  const target = Math.min(n, attributions.length);
  let result = consolidateEntityClusters(attributions);

  const groupMembers = () => {
    const map = new Map<string, number[]>();
    for (let i = 0; i < result.length; i++) {
      const groupId = result[i].speakerGroupId;
      if (!groupId) continue;
      const list = map.get(groupId) ?? [];
      list.push(i);
      map.set(groupId, list);
    }
    return map;
  };

  while (groupMembers().size < target) {
    const members = groupMembers();
    // 未ラベルを含む最大クラスタから剥がす（ラベル付きだけのクラスタはドナーにしない）
    let donorGroup: string | null = null;
    let donorUnlabeled = 0;
    for (const [groupId, idxs] of members) {
      if (idxs.length < 2) continue;
      const unlabeled = idxs.filter((i) => result[i].speakerEntityId === null).length;
      if (unlabeled > donorUnlabeled) {
        donorUnlabeled = unlabeled;
        donorGroup = groupId;
      }
    }
    if (donorGroup === null || donorUnlabeled < 1) break;

    const idxs = members.get(donorGroup);
    if (idxs === undefined) break;
    const peelIdx = [...idxs].reverse().find((i) => result[i].speakerEntityId === null) ?? -1;
    if (peelIdx < 0) break;

    const nextId = speakerClusterId(members.size + 1);
    result[peelIdx].speakerGroupId = nextId;
    result = renumberClusters(result);
  }

  return result;
}

/**
 * speakerGroupId が欠けた行を埋め、クラスタなしを禁止する。
 * 同一 entity の既存クラスタへ寄せ、無ければ既存の先頭クラスタへ入れる。
 */
export function ensureAllClusterIds(
  attributions: SpeakerAttribution[],
  n: number,
): SpeakerAttribution[] {
  if (attributions.length === 0) return [];
  const result = attributions.map((attribution) => ({ ...attribution }));
  const targetN = Math.max(1, Math.min(n > 0 ? n : 1, result.length));

  const groupByEntity = new Map<string, string>();
  for (const attribution of result) {
    if (
      attribution.speakerEntityId &&
      typeof attribution.speakerGroupId === "string" &&
      attribution.speakerGroupId.length > 0
    ) {
      if (!groupByEntity.has(attribution.speakerEntityId)) {
        groupByEntity.set(attribution.speakerEntityId, attribution.speakerGroupId);
      }
    }
  }

  const existing = [
    ...new Set(
      result
        .map((attribution) => attribution.speakerGroupId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const fallback = existing[0] ?? speakerClusterId(1);

  for (const attribution of result) {
    if (typeof attribution.speakerGroupId === "string" && attribution.speakerGroupId.length > 0) {
      continue;
    }
    if (attribution.speakerEntityId) {
      const entityGroupId = groupByEntity.get(attribution.speakerEntityId);
      if (entityGroupId !== undefined) {
        attribution.speakerGroupId = entityGroupId;
        continue;
      }
    }
    attribution.speakerGroupId = fallback;
  }

  return expandClustersToN(consolidateEntityClusters(result), targetN);
}

export function renumberClusters(attributions: SpeakerAttribution[]): SpeakerAttribution[] {
  const result = attributions.map((attribution) => ({ ...attribution }));
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const attribution of result) {
    const groupId = attribution.speakerGroupId;
    if (groupId === null || seen.has(groupId)) continue;
    seen.add(groupId);
    orderedIds.push(groupId);
  }
  const remap = new Map<string, string>();
  for (let i = 0; i < orderedIds.length; i++) {
    remap.set(orderedIds[i], speakerClusterId(i + 1));
  }
  for (const attribution of result) {
    if (attribution.speakerGroupId === null) continue;
    attribution.speakerGroupId =
      remap.get(attribution.speakerGroupId) ?? attribution.speakerGroupId;
  }
  return result;
}

export function groupEntityId(
  key: string,
  records: DialogueRecord[],
  result: SpeakerAttribution[],
): string | null {
  const fromKey = keyEntityId(key);
  if (fromKey) return fromKey;
  for (const record of records) {
    if (record.key !== key) continue;
    const entityId = result[record.attributionIndex].speakerEntityId ?? record.strongEntityId;
    if (entityId) return entityId;
  }
  return null;
}

export function assignPublicClusterIds(
  records: DialogueRecord[],
  result: SpeakerAttribution[],
  n: number,
  trail?: ClusterTrailCollector,
): void {
  const hardEntityIds = new Set<string>();
  for (const attribution of result) {
    if (attribution.speakerEntityId !== null && attribution.confidence === "high") {
      hardEntityIds.add(attribution.speakerEntityId);
    }
  }

  const keysInOrder: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.key === null || seen.has(record.key)) continue;
    seen.add(record.key);
    keysInOrder.push(record.key);
  }

  // 既知話者（high）のキーを先に枠へ載せ、仮説キーが枠を食い潰さないようにする
  const isHardKey = (key: string): boolean => {
    const entityId = groupEntityId(key, records, result);
    return entityId !== null && hardEntityIds.has(entityId);
  };
  const orderedKeys = [
    ...keysInOrder.filter((key) => isHardKey(key)),
    ...keysInOrder.filter((key) => !isHardKey(key)),
  ];

  // 既知話者（hard）が指定 N を超えるときは折りたたまず N を広げる
  const hardKeyCount = orderedKeys.filter((key) => isHardKey(key)).length;
  const clusterCount = Math.max(n, hardKeyCount);

  const publicIds = new Map<string, string>();
  let nextPublic = 0;
  for (const key of orderedKeys) {
    if (nextPublic >= clusterCount) {
      // 未ラベル／仮説キーの余剰だけ既存クラスタへ吸収する
      publicIds.set(key, speakerClusterId(((nextPublic - 1) % clusterCount) + 1));
    } else {
      publicIds.set(key, speakerClusterId(++nextPublic));
    }
  }

  for (const record of records) {
    const key = record.key;
    if (key === null) continue;
    const groupId = publicIds.get(key);
    if (groupId) result[record.attributionIndex].speakerGroupId = groupId;
  }

  // 空クラスタを埋める
  const clusterIds = Array.from({ length: clusterCount }, (_, i) => speakerClusterId(i + 1));
  const assignment = result.map((attribution) => attribution.speakerGroupId);
  const entityToCluster = new Map<string, string>();
  for (let i = 0; i < result.length; i++) {
    const entityId = result[i].speakerEntityId;
    const groupId = assignment[i];
    if (entityId && groupId) entityToCluster.set(entityId, groupId);
  }
  for (let i = 0; i < assignment.length; i++) {
    if (assignment[i] === null) {
      assignment[i] = clusterIds[i % clusterCount];
      result[i].speakerGroupId = assignment[i];
    }
  }
  fillEmptyClusters(result, assignment, clusterIds, entityToCluster);
  for (let i = 0; i < result.length; i++) {
    result[i].speakerGroupId = assignment[i];
  }
  const consolidated = consolidateEntityClusters(result);
  for (let i = 0; i < result.length; i++) {
    result[i].speakerGroupId = consolidated[i].speakerGroupId;
  }

  if (trail) {
    for (const attribution of result) {
      if (attribution.speakerGroupId === null) continue;
      trail.push(attribution.sentenceIndex, {
        code: "assign-cluster-id",
        detail: attribution.speakerGroupId,
      });
    }
  }
}
