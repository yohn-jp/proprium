export type AspectId = "tempo" | "pov-shift" | "over-explain";

export interface AspectReviewScene {
  sceneId: string;
  sceneTitle: string;
  body: string;
  manuscriptPath: string;
  manuscriptRevision: string;
  metadataPath: string;
  metadataRevision: string;
  povId?: string;
  povName?: string;
}

export interface AspectReviewFinding {
  aspect: AspectId;
  aspectLabel: string;
  finding: string;
  quote?: string;
  sceneId?: string;
  evidence?: Array<{ path: string; revision: string; start: number; end: number; quote: string }>;
}

export const ALL_ASPECT_IDS: readonly AspectId[] = ["tempo", "pov-shift", "over-explain"];

const ASPECT_LABELS: Record<AspectId, string> = {
  tempo: "テンポ",
  "pov-shift": "視点の揺れ",
  "over-explain": "説明過多",
};

export function normalizeAspectIds(raw: unknown): AspectId[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...ALL_ASPECT_IDS];
  const supported = new Set<string>(ALL_ASPECT_IDS);
  const normalized = raw.filter((item): item is AspectId => typeof item === "string" && supported.has(item));
  return normalized.length ? [...new Set(normalized)] : [...ALL_ASPECT_IDS];
}

function clipQuote(text: string, max = 80): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

function paragraphLengths(body: string): number[] {
  return body.split(/\n{2,}/).map((paragraph) => paragraph.replace(/\s+/g, "").length).filter((length) => length > 0);
}

function dialogueRatio(body: string): number {
  const characters = body.replace(/\s+/g, "").length;
  if (characters === 0) return 0;
  let inDialogue = false;
  let dialogueCharacters = 0;
  for (const character of body) {
    if (character === "「") inDialogue = true;
    if (inDialogue) dialogueCharacters += 1;
    if (character === "」") inDialogue = false;
  }
  return dialogueCharacters / characters;
}

function reviewTempo(scenes: AspectReviewScene[]): AspectReviewFinding[] {
  const findings: AspectReviewFinding[] = [];
  if (scenes.length === 0) return findings;
  const lengths = scenes.map((scene) => scene.body.replace(/\s+/g, "").length);
  const mean = lengths.reduce((left, right) => left + right, 0) / lengths.length;
  const variance = lengths.reduce((total, length) => total + (length - mean) ** 2, 0) / lengths.length;
  const standardDeviation = Math.sqrt(variance);
  if (standardDeviation > mean * 0.55 && mean > 200) {
    const longest = scenes.reduce((left, right) => left.body.length >= right.body.length ? left : right);
    const shortest = scenes.reduce((left, right) => left.body.length <= right.body.length ? left : right);
    findings.push({
      aspect: "tempo", aspectLabel: ASPECT_LABELS.tempo,
      finding: `シーン間の分量差が大きい（平均約 ${Math.round(mean)} 字・標準偏差約 ${Math.round(standardDeviation)}）。長い場面と短い場面の切り替えが読者のテンポ感を左右しうる。`,
      quote: clipQuote(longest.body), sceneId: longest.sceneId,
    });
    if (shortest.sceneId !== longest.sceneId) findings.push({
      aspect: "tempo", aspectLabel: ASPECT_LABELS.tempo,
      finding: `短い側のシーン「${shortest.sceneTitle}」は約 ${shortest.body.replace(/\s+/g, "").length} 字。前後の尺との落差を意図どおりか確認するとよい。`,
      quote: clipQuote(shortest.body), sceneId: shortest.sceneId,
    });
  }
  for (const scene of scenes) {
    const longParagraphs = paragraphLengths(scene.body).filter((length) => length >= 280);
    const ratio = dialogueRatio(scene.body);
    if (longParagraphs.length >= 2 && ratio < 0.12) {
      const longBlock = scene.body.split(/\n{2,}/).find((paragraph) => paragraph.replace(/\s+/g, "").length >= 280) ?? scene.body;
      findings.push({
        aspect: "tempo", aspectLabel: ASPECT_LABELS.tempo,
        finding: `「${scene.sceneTitle}」に長い地の文が連続し、台詞比率が低い（約 ${Math.round(ratio * 100)}%）。息継ぎや場面転換の有無を点検できる。`,
        quote: clipQuote(longBlock), sceneId: scene.sceneId,
      });
    }
  }
  if (findings.length === 0) findings.push({
    aspect: "tempo", aspectLabel: ASPECT_LABELS.tempo,
    finding: "シーン分量と台詞比率から見たテンポの極端な偏りは検出されなかった。必要なら特定場面を手で読み返して検算するとよい。",
  });
  return findings;
}

const FIRST_PERSON = /(?:^|[^\u3040-\u30ff\u3400-\u9fff])(?:私|俺|僕|あたし|わし)(?:[はがのをにでと]|の)/;
const THIRD_PERSON_HEAVY = /(?:彼|彼女|その男|その女)(?:[はがのをに]|の)/;

function reviewPovShift(scenes: AspectReviewScene[]): AspectReviewFinding[] {
  const findings: AspectReviewFinding[] = [];
  const povIds = new Set(scenes.flatMap((scene) => scene.povId ? [scene.povId] : []));
  if (povIds.size >= 2) {
    const labels = scenes.filter((scene) => scene.povId).map((scene) => `${scene.sceneTitle}→${scene.povName ?? scene.povId}`).slice(0, 6);
    findings.push({
      aspect: "pov-shift", aspectLabel: ASPECT_LABELS["pov-shift"],
      finding: `章内で POV が ${povIds.size} 人に分かれている。視点切替の合図（空白・見出し・明確な導入）が足りているか確認できる。`,
      quote: labels.join(" / "),
    });
  }
  for (const scene of scenes) {
    const hasFirstPerson = FIRST_PERSON.test(scene.body);
    const hasThirdPerson = THIRD_PERSON_HEAVY.test(scene.body);
    if (hasFirstPerson && hasThirdPerson) {
      const match = scene.body.match(FIRST_PERSON) ?? scene.body.match(THIRD_PERSON_HEAVY);
      findings.push({
        aspect: "pov-shift", aspectLabel: ASPECT_LABELS["pov-shift"],
        finding: `「${scene.sceneTitle}」内に一人称表現と三人称寄りの指示語が混在している。意図的な揺れでなければ視点の統一を検討できる。`,
        ...(match ? { quote: clipQuote(match[0]) } : {}), sceneId: scene.sceneId,
      });
    }
  }
  if (findings.length === 0) findings.push({
    aspect: "pov-shift", aspectLabel: ASPECT_LABELS["pov-shift"],
    finding: "POV メタと人称マーカーから見た視点の大きな揺れは検出されなかった。細かい内面描写の視点は手読みでの確認が残る。",
  });
  return findings;
}

const EXPLAIN_MARKERS = /(?:つまり|なぜなら|というわけ|要するに|説明すると|なのである|だったのだ|のである。|のだ。|わけである)/g;

function reviewOverExplain(scenes: AspectReviewScene[]): AspectReviewFinding[] {
  const findings: AspectReviewFinding[] = [];
  for (const scene of scenes) {
    const characters = scene.body.replace(/\s+/g, "").length;
    if (characters < 120) continue;
    const matches = scene.body.match(EXPLAIN_MARKERS) ?? [];
    const density = matches.length / (characters / 500);
    if (matches.length >= 3 && density >= 1.2) {
      const index = scene.body.search(EXPLAIN_MARKERS);
      const quote = index >= 0 ? clipQuote(scene.body.slice(Math.max(0, index - 20), index + 60)) : undefined;
      findings.push({
        aspect: "over-explain", aspectLabel: ASPECT_LABELS["over-explain"],
        finding: `「${scene.sceneTitle}」で説明調の定型（つまり／なぜなら／〜のだ 等）が ${matches.length} 箇所。読者への説明過多になっていないか点検できる。`,
        ...(quote ? { quote } : {}), sceneId: scene.sceneId,
      });
    }
  }
  if (findings.length === 0) findings.push({
    aspect: "over-explain", aspectLabel: ASPECT_LABELS["over-explain"],
    finding: "説明調マーカーの密度から見た説明過多の強い兆候は検出されなかった。情報の出しすぎは伏線・設定説明の手読みでも検算できる。",
  });
  return findings;
}

export function runDeterministicAspectReview(
  chapterId: string,
  chapterName: string,
  scenes: AspectReviewScene[],
  aspects: AspectId[],
) {
  const findings: AspectReviewFinding[] = [];
  for (const aspect of aspects) {
    if (aspect === "tempo") findings.push(...reviewTempo(scenes));
    else if (aspect === "pov-shift") findings.push(...reviewPovShift(scenes));
    else if (aspect === "over-explain") findings.push(...reviewOverExplain(scenes));
  }
  const withEvidence = findings.map((finding): AspectReviewFinding => {
    if (finding.aspect === "pov-shift" && !finding.sceneId) {
      const rows = scenes.filter((scene) => scene.povId).map((scene) => ({ path: scene.metadataPath, revision: scene.metadataRevision, start: 0, end: 0, quote: "" }));
      return rows.length ? { ...finding, evidence: rows } : finding;
    }
    if (!finding.quote) return finding;
    const scene = scenes.find((candidate) => candidate.sceneId === finding.sceneId)
      ?? scenes.find((candidate) => normalizedText(candidate.body).includes(normalizedText(finding.quote!)));
    if (!scene) return finding;
    const location = locateQuote(scene.body, finding.quote);
    return location ? { ...finding, evidence: [{ path: scene.manuscriptPath, revision: scene.manuscriptRevision, start: location.start, end: location.end, quote: location.quote }] } : finding;
  });
  return {
    chapterId,
    chapterName,
    aspects,
    sceneCount: scenes.length,
    charCount: scenes.reduce((total, scene) => total + scene.body.replace(/\s+/g, "").length, 0),
    findings: withEvidence,
  };
}

function normalizedText(value: string): string { return value.replace(/\s+/gu, " ").trim(); }

function locateQuote(body: string, display: string): { start: number; end: number; quote: string } | undefined {
  const query = normalizedText(display).replace(/…$/u, "").trim();
  if (!query) return undefined;
  let normalized = "";
  const offsets: Array<{ start: number; end: number }> = [];
  let pendingSpace: { start: number; end: number } | undefined;
  for (let index = 0; index < body.length;) {
    const codePoint = body.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const end = index + character.length;
    if (/\s/u.test(character)) {
      if (normalized.length) pendingSpace = { start: pendingSpace?.start ?? index, end };
    } else {
      if (pendingSpace) { normalized += " "; offsets.push(pendingSpace); pendingSpace = undefined; }
      normalized += character;
      for (let unit = 0; unit < character.length; unit++) offsets.push({ start: index, end });
    }
    index = end;
  }
  const at = normalized.indexOf(query);
  if (at < 0 || query.length === 0) return undefined;
  const start = offsets[at]?.start;
  const end = offsets[at + query.length - 1]?.end;
  if (start === undefined || end === undefined) return undefined;
  return { start, end, quote: body.slice(start, end) };
}
