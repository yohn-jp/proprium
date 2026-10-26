export interface EngineToken {
  surface: string;
  details: string[];
  byteStart: number;
  byteEnd: number;
}

export interface ResearchMorphologyBindings {
  beginAsset(groupId: string, filePath: string, totalBytes: number, sha256: string): void;
  appendAsset(groupId: string, filePath: string, offset: number, bytes: number[]): void;
  finishAsset(groupId: string, filePath: string): void;
  loadTokenizer(): void;
  tokenize(text: string): EngineToken[];
  countTokens(text: string): number;
  release(): void;
}

let bindings: ResearchMorphologyBindings | undefined;

export function setResearchMorphologyBindings(value: ResearchMorphologyBindings): void {
  bindings = value;
}

export function getResearchMorphologyBindings(): ResearchMorphologyBindings {
  if (!bindings) throw Object.assign(new Error("The statically composed Lindera tokenizer is unavailable"), { code: "dependency_unavailable" });
  return bindings;
}

export function releaseResearchMorphology(): void {
  bindings?.release();
}
