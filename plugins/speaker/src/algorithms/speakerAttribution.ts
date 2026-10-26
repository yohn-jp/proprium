import type { MentionDictionary } from "./mentionIndex.js";
import { findMentions } from "./mentionIndex.js";
import type { Token, Tokenizer } from "../nlp/types.js";
import { isParticle, isVerb } from "../nlp/pos.js";
import { isDialogue, splitIntoSentences } from "./textAnalysis.js";
import { hashDialogueText } from "./textHash.js";
import type { Entity } from "./types.js";

export type { ResolvedSpeakerCount, ResolveSpeakerCountInput } from "./speakerCountEstimate.js";
export { resolveSpeakerCount } from "./speakerCountEstimate.js";
export type { SpeakerCorrectionInput, SpeakerOverride } from "./speakerOverrides.js";
export {
  alignOverrideClusters,
  applySpeakerOverrides,
  applySpeakerOverridesDetailed,
  speakerOverrideSource,
} from "./speakerOverrides.js";
export type { SoftSpeakerLabel } from "./speakerSoftLabels.js";
export {
  aggregateDialoguesBySpeaker,
  assertSpeakerClusterInvariants,
  countKnownSpeakers,
  detachSoftSpeakerLabels,
  isHardSpeakerAnchor,
  mergeDialogueMaps,
  reattachSoftSpeakerLabels,
} from "./speakerSoftLabels.js";
export { hashDialogueText };

export interface SpeakerAttribution {
  /** セリフの文番号（1始まり、textAnalysis.tsのsplitIntoSentencesと同じ分割基準） */
  sentenceIndex: number;
  /** セリフ本文（鉤括弧含む） */
  text: string;
  /** 推定された話者のエンティティID。推定不能ならnull */
  speakerEntityId: string | null;
  /** シーン内の話者クラスタID（`cluster-N`）。フルパイプライン後は全セリフに付与 */
  speakerGroupId: string | null;
  /**
   * 推定の根拠。
   * 自動規則の confidence は {@link confidenceForAutomaticReason}（G1）に従う。
   * `attribution-verb-subject` は主語判定つき厳格版（low）。
   * `attribution-verb` は近接のみ（low）。
   * `preceding-narration` のみ high（経験精度 ≥0.95）。
   * `strong-hint` は分割中のクラスタ用 entity 埋め（low のみ。規則Aの high にしない）。
   * `pov-reply` / `mob` は追加規則用。
   */
  reason:
    | "attribution-verb" // 直後の地の文に話者動詞＋候補1名の言及（近接・low）
    | "attribution-verb-subject" // 主語判定つき厳格版（規則A'・low）
    | "strong-hint" // 分割中 promoteStrongHintEntities の entity 埋め（クラスタ用・low）
    | "pov-reply" // 一人称語り手への返答（規則P）
    | "mob" // モブ話者として確定
    | "preceding-narration" // 直前の地の文ブロックで候補1名のみ言及（G1・high）
    | "vocative-other" // セリフ冒頭の呼びかけ先を除いた残り候補が1名
    | "addressed-by-next" // 次のセリフの呼びかけ先＝このセリフの話者
    | "alternating-turn" // 2名の交互パターンから推定
    | "rerank" // S7 学習済み再ランカーによる最終選択
    | "manual-override" // ユーザーが手動で話者を確定
    | "none";
  /** 信頼度: high（G1 高精密度理由）| low（弱い根拠のみ）| none */
  confidence: "high" | "low" | "none";
}

/**
 * G1 — high only for reasons with empirical precision ≥0.95; currently preceding-narration.
 * Automatic attribution may assign `confidence: "high"` only for these reasons.
 */
export const HIGH_PRECISION_ATTRIBUTION_REASONS: ReadonlySet<SpeakerAttribution["reason"]> =
  new Set(["preceding-narration"]);

/**
 * Automatic-rule confidence under the G1 highPrecision policy.
 * Returns `"high"` iff `reason` is in {@link HIGH_PRECISION_ATTRIBUTION_REASONS}.
 */
export function confidenceForAutomaticReason(reason: SpeakerAttribution["reason"]): "high" | "low" {
  return HIGH_PRECISION_ATTRIBUTION_REASONS.has(reason) ? "high" : "low";
}

/** `attributeSpeakers` の追加オプション（非破壊・未使用でも受け付ける）。 */
export interface AttributeSpeakersOptions {
  /** シーン YAML の pov。一人称語り手規則（規則P・規則A'）の主体 */
  povEntityId?: string;
  /** 主語判定（規則A'）・受け手/反応除外に使用。無ければ厳格版スキップ */
  tokenizer?: Tokenizer;
}

/** 話者動詞パターン（終止・連体・連用形を含む） */
const ATTRIBUTION_VERB_RE =
  /(言っ|言う|言い|答え|叫ん|叫ぶ|呟い|呟く|尋ね|返し|返す|問う|問い|囁い|続け|呼びかけ)/;

/** セリフ冒頭の呼びかけ語（「名前（＋敬称）、」。先頭のダッシュ・三点リーダは読み飛ばす）
 *  二人称の呼びかけ（「お前、」「あなた、」等）は誰宛か特定できないため、
 *  マッチしてもエンティティ照合で候補が絞れず vocative-other には使われない。 */
const VOCATIVE_RE =
  /^[「『][―…‥、\s]*([^、。！？」』\s]{1,15}?)(?:さん|くん|君|様|殿|ちゃん|よ|ね)?、/;

export function attributeSpeakers(
  text: string,
  candidateSpeakers: Entity[],
  mentionDict: MentionDictionary,
  options?: AttributeSpeakersOptions,
): SpeakerAttribution[] {
  const povEntityId = options?.povEntityId;
  const tokenizer = options?.tokenizer;
  const sentences = splitIntoSentences(text);
  const candidateIds = new Set(candidateSpeakers.map((e) => e.id));
  const candidatesById = new Map(candidateSpeakers.map((e) => [e.id, e]));
  const byIndex = new Map<number, SpeakerAttribution>();

  for (let i = 0; i < sentences.length; i++) {
    if (!isDialogue(sentences[i])) continue;
    byIndex.set(i, {
      sentenceIndex: i + 1,
      text: sentences[i],
      speakerEntityId: null,
      speakerGroupId: null,
      reason: "none",
      confidence: "none",
    });
  }

  if (candidateIds.size === 0) return [...byIndex.values()];

  // 規則A': 直後地の文で「候補言及 + が/は + 話者動詞」が成立 → low（tokenizer 必須・G1）
  if (tokenizer) {
    for (const [i, attribution] of byIndex.entries()) {
      const nextNonDialogueIndex = findNextNonDialogueIndex(sentences, i);
      if (nextNonDialogueIndex === -1) continue;
      const nextNonDialogue = sentences[nextNonDialogueIndex];
      if (!ATTRIBUTION_VERB_RE.test(nextNonDialogue)) continue;
      const tokens = tokenizer.tokenize(nextNonDialogue);
      const subjectIds = findAttributionVerbSubjects(tokens, candidatesById, candidateIds);
      if (subjectIds.length === 1) {
        attribution.speakerEntityId = subjectIds[0];
        attribution.reason = "attribution-verb-subject";
        attribution.confidence = confidenceForAutomaticReason("attribution-verb-subject");
      }
    }
  }

  // 規則A（近接・low）: 直後地の文に話者動詞＋候補1名の言及。
  // POV では受け手・反応文の言及を除外（tokenizer があるとき）。
  for (const [i, attribution] of byIndex.entries()) {
    if (attribution.reason !== "none") continue;
    const nextNonDialogueIndex = findNextNonDialogueIndex(sentences, i);
    if (nextNonDialogueIndex === -1) continue;
    const nextNonDialogue = sentences[nextNonDialogueIndex];
    if (!ATTRIBUTION_VERB_RE.test(nextNonDialogue)) continue;
    const candidateMentions = findMentions(mentionDict, nextNonDialogue).filter((id) =>
      candidateIds.has(id),
    );
    if (candidateMentions.length !== 1) continue;
    const mentionId = candidateMentions[0];
    if (povEntityId && tokenizer) {
      const tokens = tokenizer.tokenize(nextNonDialogue);
      const entity = candidatesById.get(mentionId);
      if (entity && isRecipientOrReactionMention(tokens, entity)) continue;
    }
    attribution.speakerEntityId = mentionId;
    attribution.reason = "attribution-verb";
    attribution.confidence = confidenceForAutomaticReason("attribution-verb");
  }

  // 規則P: POV シーンで直後地の文が「候補言及なし＋話者動詞」→ 話者 = pov（low）
  if (povEntityId && candidateIds.has(povEntityId)) {
    for (const [i, attribution] of byIndex.entries()) {
      if (attribution.reason !== "none") continue;
      const nextNonDialogueIndex = findNextNonDialogueIndex(sentences, i);
      if (nextNonDialogueIndex === -1) continue;
      const nextNonDialogue = sentences[nextNonDialogueIndex];
      if (!ATTRIBUTION_VERB_RE.test(nextNonDialogue)) continue;
      const candidateMentions = findMentions(mentionDict, nextNonDialogue).filter((id) =>
        candidateIds.has(id),
      );
      if (candidateMentions.length > 0) continue;
      attribution.speakerEntityId = povEntityId;
      attribution.reason = "pov-reply";
      attribution.confidence = confidenceForAutomaticReason("pov-reply");
    }
  }

  // 規則B: 直前の地の文ブロック（前のセリフ以降に連続する地の文）で候補1名のみ言及（G1・high）。
  // 話者動詞を含む文は直前のセリフの帰属根拠である可能性が高いため、言及の収集から除外する。
  for (const [i, attribution] of byIndex.entries()) {
    if (attribution.reason !== "none") continue;
    const mentioned = new Set<string>();
    for (let j = i - 1; j >= 0; j--) {
      const sentence = sentences[j];
      if (isDialogue(sentence)) break;
      if (ATTRIBUTION_VERB_RE.test(sentence)) continue;
      for (const id of findMentions(mentionDict, sentence)) {
        if (candidateIds.has(id)) mentioned.add(id);
      }
    }
    if (mentioned.size === 1) {
      attribution.speakerEntityId = [...mentioned][0];
      attribution.reason = "preceding-narration";
      attribution.confidence = confidenceForAutomaticReason("preceding-narration");
    }
  }

  // 規則C: セリフ冒頭の呼びかけ先は話者ではない。候補が2名ならもう一方を話者とする（low）
  if (candidateIds.size === 2) {
    for (const attribution of byIndex.values()) {
      if (attribution.reason !== "none") continue;
      const addressedId = findAddressedCandidate(attribution.text, candidateIds, mentionDict);
      if (addressedId !== null) {
        const other = [...candidateIds].find((id) => id !== addressedId);
        if (other) {
          attribution.speakerEntityId = other;
          attribution.reason = "vocative-other";
          attribution.confidence = confidenceForAutomaticReason("vocative-other");
        }
      }
    }
  }

  // 規則D: 次のセリフの冒頭に呼びかけ語があれば、呼びかけられた人物が現在のセリフの話者（low）
  for (const [i, attribution] of byIndex.entries()) {
    if (attribution.reason !== "none") continue;
    const nextDialogueIndex = findNextDialogueIndex(sentences, i);
    if (nextDialogueIndex === -1) continue;
    const addressedId = findAddressedCandidate(
      sentences[nextDialogueIndex],
      candidateIds,
      mentionDict,
    );
    if (addressedId !== null) {
      attribution.speakerEntityId = addressedId;
      attribution.reason = "addressed-by-next";
      attribution.confidence = confidenceForAutomaticReason("addressed-by-next");
    }
  }

  // 規則E: 候補が2名で交互パターン（A→B→?）なら、直前2セリフの話者から推定（low）。
  // 継続推定（旧規則F）は N クラスタ分割側へ移したためここでは行わない。
  if (candidateIds.size === 2) {
    const dialogueIndices = [...byIndex.keys()].sort((a, b) => a - b);
    for (let d = 2; d < dialogueIndices.length; d++) {
      const i = dialogueIndices[d];
      const attribution = byIndex.get(i);
      if (attribution === undefined || attribution.reason !== "none") continue;
      const prev1 = byIndex.get(dialogueIndices[d - 1]);
      const prev2 = byIndex.get(dialogueIndices[d - 2]);
      if (!prev1?.speakerEntityId || !prev2?.speakerEntityId) continue;
      if (prev1.speakerEntityId === prev2.speakerEntityId) continue;
      attribution.speakerEntityId = prev2.speakerEntityId;
      attribution.reason = "alternating-turn";
      attribution.confidence = confidenceForAutomaticReason("alternating-turn");
    }
  }

  return [...byIndex.values()];
}

function entityMentionTerms(entity: Entity): string[] {
  const terms: string[] = [];
  if (entity.name && entity.name.length >= 2) terms.push(entity.name);
  for (const alias of entity.aliases ?? []) {
    if (alias.length >= 2) terms.push(alias);
  }
  return terms;
}

/** term が tokens[index] から連結一致するとき、消費トークン数を返す。 */
function matchTermAt(tokens: Token[], index: number, term: string): number {
  let built = "";
  for (let i = index; i < tokens.length; i++) {
    built += tokens[i].surface;
    if (built === term) return i - index + 1;
    if (!term.startsWith(built)) return 0;
  }
  return 0;
}

function isAttributionVerbToken(token: Token): boolean {
  if (ATTRIBUTION_VERB_RE.test(token.surface)) return true;
  return token.baseForm != null && ATTRIBUTION_VERB_RE.test(token.baseForm);
}

function isGaOrWa(token: Token): boolean {
  return isParticle(token) && (token.surface === "が" || token.surface === "は");
}

function isNiOrHe(token: Token): boolean {
  return isParticle(token) && (token.surface === "に" || token.surface === "へ");
}

/** 名前と格助詞の間に挟まりうる敬称（表層一致）。 */
const HONORIFIC_SURFACES = new Set(["さん", "くん", "君", "様", "殿", "ちゃん", "氏"]);

/**
 * term 直後から が/は までのオフセット（term 消費分を含む）。
 * 任意の引用の「と」は match 開始位置の手前に来るだけなのでここでは扱わない。
 * 敬称（さん等）は名前と助詞の間を許可する。
 */
function subjectParticleOffset(tokens: Token[], termIndex: number, termConsumed: number): number {
  let offset = termConsumed;
  const honorific = tokens[termIndex + offset];
  if (honorific && HONORIFIC_SURFACES.has(honorific.surface)) {
    offset += 1;
  }
  const particle = tokens[termIndex + offset];
  if (!particle || !isGaOrWa(particle)) return 0;
  return offset;
}

/** 主語助詞の後、次の が/は までに話者動詞があるか（修飾動詞・誤分割を跨いでよい）。 */
function hasAttributionVerbAfterSubject(tokens: Token[], afterParticleIndex: number): boolean {
  const limit = Math.min(tokens.length, afterParticleIndex + 32);
  for (let j = afterParticleIndex; j < limit; j++) {
    const token = tokens[j];
    if (isGaOrWa(token)) break;
    // POS が動詞でなくても surface/baseForm が話者動詞なら採用（誤タグ耐性）
    if (isAttributionVerbToken(token)) return true;
  }
  return false;
}

/**
 * トークン列上で「entity言及 + が/は +（修飾を挟んでも）話者動詞」の候補を列挙する。
 * 係り受け木は未使用（S-3 未採用）。同一節内の表層パターンで近似する。
 *
 * white-sigil 調では「Xが、呆れたように、言った」「Xが、ぼそりと言った」のように
 * が/は と話者動詞の間に別動詞・誤分割トークンが入りうるため、非話者動詞で打ち切らない。
 */
function findAttributionVerbSubjects(
  tokens: Token[],
  candidatesById: Map<string, Entity>,
  candidateIds: Set<string>,
): string[] {
  const subjects = new Set<string>();
  for (const entityId of candidateIds) {
    const entity = candidatesById.get(entityId);
    if (!entity) continue;
    for (const term of entityMentionTerms(entity)) {
      for (let i = 0; i < tokens.length; i++) {
        const consumed = matchTermAt(tokens, i, term);
        if (consumed === 0) continue;
        const particleOffset = subjectParticleOffset(tokens, i, consumed);
        if (particleOffset === 0) continue;
        if (hasAttributionVerbAfterSubject(tokens, i + particleOffset + 1)) {
          subjects.add(entityId);
        }
      }
    }
  }
  return [...subjects];
}

/**
 * POV 近接規則の除外: 言及が受け手（〜に/へ + 話者動詞）または
 * 反応主語（が/は + 非話者動詞）のとき true。
 */
function isRecipientOrReactionMention(tokens: Token[], entity: Entity): boolean {
  for (const term of entityMentionTerms(entity)) {
    for (let i = 0; i < tokens.length; i++) {
      const consumed = matchTermAt(tokens, i, term);
      if (consumed === 0) continue;
      const particle = tokens[i + consumed];
      if (!particle) continue;
      if (isNiOrHe(particle)) {
        for (let j = i + consumed + 1; j < tokens.length; j++) {
          const token = tokens[j];
          if (isVerb(token) && isAttributionVerbToken(token)) return true;
          if (isVerb(token)) break;
        }
      }
      if (isGaOrWa(particle)) {
        for (let j = i + consumed + 1; j < tokens.length; j++) {
          const token = tokens[j];
          if (isGaOrWa(token)) break;
          if (isVerb(token) && isAttributionVerbToken(token)) break;
          if (isVerb(token) && !isAttributionVerbToken(token)) return true;
        }
      }
    }
  }
  return false;
}

/** セリフ冒頭の呼びかけ語が候補キャラ1名に解決できればそのIDを返す。 */
function findAddressedCandidate(
  dialogue: string,
  candidateIds: Set<string>,
  mentionDict: MentionDictionary,
): string | null {
  const match = dialogue.trim().match(VOCATIVE_RE);
  if (!match) return null;
  const addressed = findMentions(mentionDict, match[1]).filter((id) => candidateIds.has(id));
  return addressed.length === 1 ? addressed[0] : null;
}

/** 次の空でない文が地の文ならそのインデックスを返す。先にセリフが現れたら-1（跨いで探さない）。 */
function findNextNonDialogueIndex(sentences: string[], currentIndex: number): number {
  for (let i = currentIndex + 1; i < sentences.length; i++) {
    const trimmed = sentences[i].trim();
    if (trimmed.length === 0) continue;
    return isDialogue(trimmed) ? -1 : i;
  }
  return -1;
}

function findNextDialogueIndex(sentences: string[], currentIndex: number): number {
  for (let i = currentIndex + 1; i < sentences.length; i++) {
    if (isDialogue(sentences[i])) return i;
  }
  return -1;
}
