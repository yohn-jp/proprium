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

function stripTerminalPunctuation(sentence: string): { body: string } {
  const match = sentence.match(/^(.*?)([。！？!?」』]*)$/u);
  return { body: match?.[1]?.trim() ?? sentence.trim() };
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
