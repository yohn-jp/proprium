import type { Token } from "./types.js";

export function isNoun(token: Token): boolean { return token.pos === "名詞"; }
export function isPronoun(token: Token): boolean { return isNoun(token) && token.posDetail?.[0] === "代名詞"; }
export function isVerb(token: Token): boolean { return token.pos === "動詞"; }
export function isParticle(token: Token): boolean { return token.pos === "助詞"; }
export function isSymbol(token: Token): boolean { return token.pos === "記号"; }
export function isFinalParticle(token: Token): boolean { return isParticle(token) && (token.posDetail ?? []).includes("終助詞"); }
export function isAdjective(token: Token): boolean { return token.pos === "形容詞" || token.pos === "形容動詞"; }
export function isAdverb(token: Token): boolean { return token.pos === "副詞"; }
export function isComma(token: Token): boolean { return isSymbol(token) && token.posDetail?.[0] === "読点"; }
export function tokenBase(token: Token): string { return token.baseForm ?? token.surface; }
