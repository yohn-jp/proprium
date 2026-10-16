export interface RewriteSentenceSplitSuggestion {
  text: string;
  rationale: string;
}

export interface RewriteTellToShowSuggestion {
  text: string;
  rationale: string;
  source: "heuristic" | "corpus";
}

export interface RewriteLocalSuggestions {
  sentenceSplit?: RewriteSentenceSplitSuggestion;
  tellToShow?: RewriteTellToShowSuggestion;
}

export interface RewriteFallbackCandidate {
  text: string;
  strategy: "concise" | "contextual" | "voice";
  rationale: string;
}

const CONCISE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/とても|非常に|本当に|すごく/g, ""],
  [/することができた/g, "できた"],
  [/することができる/g, "できる"],
  [/ということ/g, "こと"],
  [/のである([。！？]?)/g, "のだ$1"],
];
const PARAPHRASE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/歩いていった/g, "歩みを進めた"], [/歩いた/g, "歩みを進めた"], [/走った/g, "駆け出した"],
  [/見つめた/g, "視線を注いだ"], [/見た/g, "目を向けた"], [/言った/g, "言葉を返した"], [/思った/g, "胸の内でそう考えた"],
];

const TELL_TO_SHOW_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/悲しかった/g, "喉の奥が詰まり、視線が足元へ落ちた"],
  [/悲しい/g, "喉の奥が詰まり、視線が足元へ落ちる"],
  [/怒っていた/g, "奥歯を噛み、握った拳に力を込めていた"],
  [/怒った/g, "奥歯を噛み、握った拳に力を込めた"],
  [/怖かった/g, "背筋が冷え、足がその場に縫い止められた"],
  [/怖い/g, "背筋が冷え、足がその場に縫い止められる"],
  [/嬉しかった/g, "頬がゆるみ、弾む息がこぼれた"],
  [/嬉しい/g, "頬がゆるみ、弾む息がこぼれる"],
  [/緊張していた/g, "浅い呼吸を整えようと、指先を握り込んでいた"],
  [/緊張した/g, "浅い呼吸を整えようと、指先を握り込んだ"],
];

function applyReplacements(
  sentence: string,
  replacements: ReadonlyArray<readonly [RegExp, string]>,
): string {
  return replacements
    .reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), sentence)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripTerminalPunctuation(sentence: string): { body: string; punctuation: string } {
  const match = sentence.match(/^(.*?)([。！？!?」』]*)$/u);
  return { body: match?.[1]?.trim() ?? sentence.trim(), punctuation: match?.[2] || "。" };
}

function contextualFallback(sentence: string, intendedTone?: string): string {
  let candidate = applyReplacements(sentence, PARAPHRASE_REPLACEMENTS);
  const tone = intendedTone?.toLowerCase();
  if (tone && /suspense|緊張|不穏|恐怖/.test(tone)) {
    candidate = candidate.replace(/歩みを進めた/g, "足音を殺して進んだ").replace(/目を向けた/g, "息を詰めて目を凝らした");
  } else if (tone && /joy|喜|明る|軽快/.test(tone)) {
    candidate = candidate.replace(/歩みを進めた/g, "軽やかに歩みを進めた");
  }
  if (candidate === sentence) {
    const { body, punctuation } = stripTerminalPunctuation(sentence);
    candidate = `ふと、${body}${punctuation}`;
  }
  return candidate;
}

function voiceFallback(sentence: string, preferredFirstPerson?: string): string {
  if (preferredFirstPerson && /私|僕|俺|わたし/.test(sentence) && !sentence.includes(preferredFirstPerson)) {
    return sentence.replace(/私|僕|俺|わたし/, preferredFirstPerson);
  }
  const { body, punctuation } = stripTerminalPunctuation(sentence);
  return /た$/.test(body) ? `${body}のだった${punctuation}` : `${body}のだ${punctuation}`;
}

/** Pinned source heuristic provider used to fill missing/duplicate LLM candidates. */
export function buildRewriteFallbackSuggestions(input: {
  sentence: string;
  intendedTone?: string;
  preferredFirstPerson?: string;
}): RewriteFallbackCandidate[] {
  const concise = applyReplacements(input.sentence, CONCISE_REPLACEMENTS);
  const candidates: RewriteFallbackCandidate[] = [
    {
      text: concise === input.sentence ? applyReplacements(input.sentence, PARAPHRASE_REPLACEMENTS) : concise,
      strategy: "concise",
      rationale: "冗長な語句を抑え、意味を保ったまま文を引き締めます。",
    },
    {
      text: contextualFallback(input.sentence, input.intendedTone),
      strategy: "contextual",
      rationale: input.intendedTone ? `シーンの意図されたトーン「${input.intendedTone}」に寄せた表現です。` : "動作や視線を具体化して、文の焦点を明確にします。",
    },
    {
      text: voiceFallback(input.sentence, input.preferredFirstPerson),
      strategy: "voice",
      rationale: input.preferredFirstPerson ? "POV キャラクターの登録済み口調プロファイルを反映します。" : "語尾のリズムを変え、地の文に余韻を加えます。",
    },
  ];
  const seen = new Set<string>();
  return candidates.map((candidate, index) => {
    let text = candidate.text.trim() || input.sentence.trim();
    if (seen.has(text)) {
      const { body, punctuation } = stripTerminalPunctuation(text);
      text = index === 1 ? `そのとき、${body}${punctuation}` : `${body}――その感覚が残った${punctuation}`;
    }
    seen.add(text);
    return { ...candidate, text };
  });
}

function createSentenceSplitSuggestion(sentence: string): RewriteSentenceSplitSuggestion | undefined {
  const { body } = stripTerminalPunctuation(sentence);
  const separators = ["、しかし", "、だが", "、けれど", "、そして", "、それでも", "、"];
  const separator = separators.find((value) => {
    const index = body.indexOf(value);
    return index >= 6 && body.length - index - value.length >= 6;
  });
  if (!separator) return undefined;

  const index = body.indexOf(separator);
  const second = body.slice(index + separator.length).trim();
  const connective = separator === "、" ? "" : separator.slice(1);
  return {
    text: `${body.slice(0, index)}。${connective}${second}。`,
    rationale: "長い一文を意味の切れ目で二文に分け、読みやすさを上げます。",
  };
}

function createTellToShowSuggestion(
  sentence: string,
  corpusActionDescriptions: string[] = [],
): RewriteTellToShowSuggestion | undefined {
  const hasTellExpression = TELL_TO_SHOW_REPLACEMENTS.some(([pattern]) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(sentence),
  );
  if (corpusActionDescriptions.length > 0 && hasTellExpression) {
    return {
      text: corpusActionDescriptions[0]!,
      rationale: "自作品コーパスにある所作描写を、tell→show の参考候補として提示します。",
      source: "corpus",
    };
  }

  const text = applyReplacements(sentence, TELL_TO_SHOW_REPLACEMENTS);
  if (text === sentence) return undefined;
  return {
    text,
    rationale: "感情を直接説明せず、身体反応と所作で示します。",
    source: "heuristic",
  };
}

/** Build the source-compatible local sentence-split and tell-to-show alternatives. */
export function buildRewriteLocalSuggestions(
  sentence: string,
  corpusActionDescriptions: string[] = [],
): RewriteLocalSuggestions {
  const sentenceSplit = createSentenceSplitSuggestion(sentence);
  const tellToShow = createTellToShowSuggestion(sentence, corpusActionDescriptions);
  return {
    ...(sentenceSplit ? { sentenceSplit } : {}),
    ...(tellToShow ? { tellToShow } : {}),
  };
}
