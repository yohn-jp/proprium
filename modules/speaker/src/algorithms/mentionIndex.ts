import type { Entity } from "./types.js";

interface TrieNode {
  children: Map<string, TrieNode>;
  entityIds: string[] | null;
}

export interface MentionDictionary { root: TrieNode }

function node(): TrieNode { return { children: new Map(), entityIds: null }; }

export function buildMentionDictionary(entities: Map<string, Entity>): MentionDictionary {
  const root = node();
  for (const entity of entities.values()) {
    const terms = [entity.name, ...(entity.aliases ?? [])];
    for (const term of terms) {
      if (!term || term.length < 2) continue;
      let current = root;
      for (const character of term) {
        let next = current.children.get(character);
        if (!next) { next = node(); current.children.set(character, next); }
        current = next;
      }
      current.entityIds ??= [];
      if (!current.entityIds.includes(entity.id)) current.entityIds.push(entity.id);
    }
  }
  return { root };
}

export function findMentions(dictionary: MentionDictionary, text: string): string[] {
  const found = new Set<string>();
  const characters = Array.from(text);
  for (let start = 0; start < characters.length; start++) {
    let current = dictionary.root;
    let match: string[] | null = null;
    let matchLength = 0;
    for (let index = start; index < characters.length; index++) {
      const next = current.children.get(characters[index]);
      if (!next) break;
      current = next;
      if (current.entityIds) { match = current.entityIds; matchLength = index - start + 1; }
    }
    if (match) {
      for (const id of match) found.add(id);
      start += matchLength - 1;
    }
  }
  return [...found];
}
