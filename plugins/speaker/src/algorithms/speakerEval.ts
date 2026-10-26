import type { SpeakerAttribution, SpeakerOverride } from "./speakerAttribution.js";
import { hashDialogueText } from "./speakerAttribution.js";

export interface SceneEvalLine { gold: string | null; predicted: string | null; reason: string; confidence: SpeakerAttribution["confidence"] }
export interface SceneEvalResult { sceneId: string; textHashMatchedCount: number; textHashMismatchCount: number; lines: SceneEvalLine[] }
export interface SpeakerEvalReport {
  generatedAt: string;
  byReason: Record<string, { fired: number; correct: number }>;
  scenes: SceneEvalResult[];
  metrics: {
    highPrecision: number;
    attributionAccuracy: number;
    coverage: number;
    clusteringPairwiseF1: number;
    nMae: number;
    nWithin1Rate: number;
  };
}

/**
 * ゴールド突合の中間行（クラスタ F1・coverage 用に groupId を保持）。
 * `SceneEvalResult.lines` には `toSceneEvalLine` で落とす。
 */
export interface MatchedEvalLine {
  gold: string | null;
  predicted: string | null;
  reason: SpeakerAttribution["reason"];
  confidence: SpeakerAttribution["confidence"];
  /** 予測側クラスタ。coverage / pairwise F1 で使用 */
  predictedGroupId: string | null;
}

/** `MatchedEvalLine` をレポート用の `SceneEvalLine` に変換する。 */
export function toSceneEvalLine(line: MatchedEvalLine): SceneEvalLine {
  return {
    gold: line.gold,
    predicted: line.predicted,
    reason: line.reason,
    confidence: line.confidence,
  };
}

function isNewFormatOverride(override: SpeakerOverride): boolean {
  return override.sentenceIndex !== undefined && override.textHash !== undefined;
}

/**
 * ゴールド（speakerOverrides）と予測帰属を突合する。
 * 新形式は sentenceIndex + textHash（`applySpeakerOverrides` と同じ）。
 * textHash 不一致は mismatch に数え、`matched` / `lines` には入れない。
 */
export function matchGoldToPredictions(
  overrides: SpeakerOverride[],
  predictions: SpeakerAttribution[],
): {
  matched: MatchedEvalLine[];
  textHashMatchedCount: number;
  textHashMismatchCount: number;
} {
  const bySentenceIndex = new Map<number, SpeakerAttribution>();
  for (const prediction of predictions) {
    bySentenceIndex.set(prediction.sentenceIndex, prediction);
  }

  const matched: MatchedEvalLine[] = [];
  let textHashMatchedCount = 0;
  let textHashMismatchCount = 0;

  for (const override of overrides) {
    if (isNewFormatOverride(override)) {
      const prediction = bySentenceIndex.get(override.sentenceIndex as number);
      if (!prediction) {
        textHashMismatchCount += 1;
        continue;
      }
      if (override.textHash !== hashDialogueText(prediction.text)) {
        textHashMismatchCount += 1;
        continue;
      }
      textHashMatchedCount += 1;
      matched.push({
        gold: override.speakerEntityId,
        predicted: prediction.speakerEntityId,
        reason: prediction.reason,
        confidence: prediction.confidence,
        predictedGroupId: prediction.speakerGroupId,
      });
      continue;
    }

    // 旧形式: dialogueText 完全一致
    const prediction = predictions.find((p) => p.text === override.dialogueText);
    if (!prediction) continue;
    textHashMatchedCount += 1;
    matched.push({
      gold: override.speakerEntityId,
      predicted: prediction.speakerEntityId,
      reason: prediction.reason,
      confidence: prediction.confidence,
      predictedGroupId: prediction.speakerGroupId,
    });
  }

  return { matched, textHashMatchedCount, textHashMismatchCount };
}

/**
 * 1シーン分の `SceneEvalResult` を組み立てる。
 */
export function buildSceneEvalResult(
  sceneId: string,
  overrides: SpeakerOverride[],
  predictions: SpeakerAttribution[],
): { result: SceneEvalResult; matched: MatchedEvalLine[] } {
  const { matched, textHashMatchedCount, textHashMismatchCount } = matchGoldToPredictions(
    overrides,
    predictions,
  );
  return {
    result: {
      sceneId,
      textHashMatchedCount,
      textHashMismatchCount,
      lines: matched.map(toSceneEvalLine),
    },
    matched,
  };
}

/**
 * 規則別の発火数（分母）と正解数（分子）を集計する。
 */
export function aggregateByReason(
  lines: ReadonlyArray<Pick<MatchedEvalLine, "gold" | "predicted" | "reason">>,
): Record<string, { fired: number; correct: number }> {
  const byReason: Record<string, { fired: number; correct: number }> = {};
  for (const line of lines) {
    const key = line.reason;
    const bucket = byReason[key] ?? { fired: 0, correct: 0 };
    bucket.fired += 1;
    if (line.predicted === line.gold) bucket.correct += 1;
    byReason[key] = bucket;
  }
  return byReason;
}

/**
 * entity 未解決（predicted === null）の行同士について、
 * 同クラスタ判定を gold の同話者判定（null===null 含む）と対毎比較した pairwise F1。
 * 対象行が2未満、または TP+FP / TP+FN が両方0のときは 0。
 */
/**
 * 集計用のペアワイズ計数（シーン横断の micro-F1 用）。
 */
export function clusteringPairwiseCounts(
  lines: ReadonlyArray<Pick<MatchedEvalLine, "gold" | "predicted" | "predictedGroupId">>,
): { tp: number; fp: number; fn: number } {
  const unresolved = lines.filter((line) => line.predicted === null);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < unresolved.length; i++) {
    for (let j = i + 1; j < unresolved.length; j++) {
      const a = unresolved[i];
      const b = unresolved[j];
      const goldSame = a.gold === b.gold;
      const predSame =
        a.predictedGroupId !== null &&
        b.predictedGroupId !== null &&
        a.predictedGroupId === b.predictedGroupId;
      if (goldSame && predSame) tp += 1;
      else if (!goldSame && predSame) fp += 1;
      else if (goldSame && !predSame) fn += 1;
    }
  }
  return { tp, fp, fn };
}

function f1FromCounts(tp: number, fp: number, fn: number): number {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * entity 未解決（predicted === null）の行同士について、
 * 同クラスタ判定を gold の同話者判定（null===null 含む）と対毎比較した pairwise F1。
 * 対象行が2未満、または TP+FP / TP+FN が両方0のときは 0。
 */
export function clusteringPairwiseF1(
  lines: ReadonlyArray<Pick<MatchedEvalLine, "gold" | "predicted" | "predictedGroupId">>,
): number {
  const unresolvedCount = lines.filter((line) => line.predicted === null).length;
  if (unresolvedCount < 2) return 0;
  const { tp, fp, fn } = clusteringPairwiseCounts(lines);
  return f1FromCounts(tp, fp, fn);
}

/** 手動 speakerCount があるシーンの N 評価用入力。 */
export interface SceneNEvalInput {
  /** YAML の手動 speakerCount（ゴールド N） */
  goldN: number;
  /** 自動推定の estimatedN（手動 speakerCount を渡さない resolve の結果） */
  estimatedN: number;
}

/**
 * 突合済み行と N 評価入力から `SpeakerEvalReport` を組み立てる。
 */
export function buildSpeakerEvalReport(
  scenes: SceneEvalResult[],
  matchedByScene: MatchedEvalLine[][],
  nEvals: SceneNEvalInput[],
  generatedAt: string = new Date().toISOString(),
): SpeakerEvalReport {
  const allMatched = matchedByScene.flat();
  const byReason = aggregateByReason(allMatched);

  let highTotal = 0;
  let highCorrect = 0;
  let attributionCorrect = 0;
  let covered = 0;

  for (const line of allMatched) {
    if (line.predicted === line.gold) attributionCorrect += 1;
    if (line.confidence === "high") {
      highTotal += 1;
      if (line.predicted === line.gold) highCorrect += 1;
    }
    // entity が付く、またはクラスタが付く行を coverage 分子にする
    if (line.predicted !== null || line.predictedGroupId !== null) covered += 1;
  }

  let pairTp = 0;
  let pairFp = 0;
  let pairFn = 0;
  for (const matched of matchedByScene) {
    const counts = clusteringPairwiseCounts(matched);
    pairTp += counts.tp;
    pairFp += counts.fp;
    pairFn += counts.fn;
  }

  let nAbsErrorSum = 0;
  let nWithin1 = 0;
  for (const nEval of nEvals) {
    const abs = Math.abs(nEval.estimatedN - nEval.goldN);
    nAbsErrorSum += abs;
    if (abs <= 1) nWithin1 += 1;
  }

  const lineCount = allMatched.length;
  return {
    generatedAt,
    scenes,
    byReason,
    metrics: {
      highPrecision: highTotal > 0 ? highCorrect / highTotal : 0,
      attributionAccuracy: lineCount > 0 ? attributionCorrect / lineCount : 0,
      coverage: lineCount > 0 ? covered / lineCount : 0,
      clusteringPairwiseF1: f1FromCounts(pairTp, pairFp, pairFn),
      nMae: nEvals.length > 0 ? nAbsErrorSum / nEvals.length : 0,
      nWithin1Rate: nEvals.length > 0 ? nWithin1 / nEvals.length : 0,
    },
  };
}

/**
 * `SpeakerEvalReport` を Markdown 表（全体指標 + byReason）に整形する。
 */
export function formatSpeakerEvalReportMarkdown(report: SpeakerEvalReport): string {
  const { metrics, byReason } = report;
  const lines: string[] = [
    `# Speaker eval report`,
    ``,
    `generatedAt: ${report.generatedAt}`,
    `scenes: ${report.scenes.length}`,
    ``,
    `## Overall metrics`,
    ``,
    `| metric | value |`,
    `| --- | ---: |`,
    `| highPrecision | ${metrics.highPrecision.toFixed(4)} |`,
    `| attributionAccuracy | ${metrics.attributionAccuracy.toFixed(4)} |`,
    `| coverage | ${metrics.coverage.toFixed(4)} |`,
    `| clusteringPairwiseF1 | ${metrics.clusteringPairwiseF1.toFixed(4)} |`,
    `| nMae | ${metrics.nMae.toFixed(4)} |`,
    `| nWithin1Rate | ${metrics.nWithin1Rate.toFixed(4)} |`,
    ``,
    `## byReason`,
    ``,
    `| reason | fired | correct | precision |`,
    `| --- | ---: | ---: | ---: |`,
  ];

  const reasons = Object.keys(byReason).sort((a, b) => a.localeCompare(b));
  for (const reason of reasons) {
    const { fired, correct } = byReason[reason];
    const precision = fired > 0 ? correct / fired : 0;
    lines.push(`| ${reason} | ${fired} | ${correct} | ${precision.toFixed(4)} |`);
  }
  lines.push(``);
  return lines.join("\n");
}
