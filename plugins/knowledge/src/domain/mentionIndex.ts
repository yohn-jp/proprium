import type { StoryEntity } from "./types.js";

const MIN_TOKEN_LENGTH = 2;

interface TrieNode {
  children: Map<string, TrieNode>;
  entityIds: string[] | null;
}

export interface MentionDictionary {
  root: TrieNode;
}

function createTrieNode(): TrieNode {
  return { children: new Map(), entityIds: null };
}

function insertToken(root: TrieNode, token: string, entityId: string): void {
  let node = root;
  for (const character of token) {
    let next = node.children.get(character);
    if (!next) {
      next = createTrieNode();
      node.children.set(character, next);
    }
    node = next;
  }
  if (node.entityIds) {
    if (!node.entityIds.includes(entityId)) node.entityIds.push(entityId);
  } else {
    node.entityIds = [entityId];
  }
}

/** Builds the source's longest-match trie from entity names and aliases. */
export function buildMentionDictionary(entities: Iterable<StoryEntity>): MentionDictionary {
  const root = createTrieNode();
  for (const entity of entities) {
    const tokens = [...(entity.name ? [entity.name] : []), ...(entity.aliases ?? [])];
    for (const token of tokens) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      insertToken(root, token, entity.id);
    }
  }
  return { root };
}

/**
 * Finds all registered names. At a given start the longest match wins, matching
 * the source behavior for overlapping names such as a place and its region.
 */
export function findMentions(dictionary: MentionDictionary, text: string): string[] {
  const found = new Set<string>();
  const characters = Array.from(text);
  for (let start = 0; start < characters.length; start++) {
    let node = dictionary.root;
    let lastMatchIds: string[] | null = null;
    let lastMatchLength = 0;
    for (let index = start; index < characters.length; index++) {
      const next = node.children.get(characters[index]!);
      if (!next) break;
      node = next;
      if (node.entityIds) {
        lastMatchIds = node.entityIds;
        lastMatchLength = index - start + 1;
      }
    }
    if (lastMatchIds) {
      for (const entityId of lastMatchIds) found.add(entityId);
      start += lastMatchLength - 1;
    }
  }
  return [...found];
}
