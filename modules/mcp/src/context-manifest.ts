import { z } from "zod";

export const MCP_WRITING_CONTEXT_MAX_CHARACTERS = 50_000;
export const MCP_WRITING_CONTEXT_MAX_SELECTION_CHARACTERS = 5_000;

export const mcpWritingContextSelectionSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();

export type McpWritingContextSelection = z.infer<typeof mcpWritingContextSelectionSchema>;

export interface McpWritingContextInput {
  projectId: string;
  sceneId: string;
  sceneRevision?: string;
  sceneTitle?: string;
  manuscriptId: string;
  manuscriptRevision: string;
  manuscriptText: string;
  selection?: McpWritingContextSelection;
  manifestOnly?: boolean;
  capturedAt?: number;
}

export class McpWritingContextInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpWritingContextInputError";
  }
}

function characterCount(text: string): number {
  let count = 0;
  for (const _character of text) count++;
  return count;
}

function byteCount(text: string): number {
  return new TextEncoder().encode(text).length;
}

function takeCharacters(text: string, maximum: number): { text: string; trimmed: boolean } {
  let codeUnits = 0;
  let characters = 0;
  for (const character of text) {
    if (characters === maximum) return { text: text.slice(0, codeUnits), trimmed: true };
    codeUnits += character.length;
    characters++;
  }
  return { text, trimmed: false };
}

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Keep the source MCP context identity, limits, and manifest fields intact. */
export function createMcpWritingContext(input: McpWritingContextInput) {
  const { selection } = input;
  const manifestOnly = input.manifestOnly === true;
  if (
    selection &&
    (selection.to < selection.from ||
      selection.to - selection.from !== selection.text.length ||
      selection.text.length > MCP_WRITING_CONTEXT_MAX_SELECTION_CHARACTERS)
  ) {
    throw new McpWritingContextInputError(
      "Selection range is invalid or text exceeds the 5000 character limit",
    );
  }

  const boundedTitle =
    input.sceneTitle === undefined ? undefined : takeCharacters(input.sceneTitle, 512);
  const title = boundedTitle?.text;
  const boundedSavedText = takeCharacters(input.manuscriptText, MCP_WRITING_CONTEXT_MAX_CHARACTERS);
  const savedText = boundedSavedText.text;
  const savedTextTrimmed = boundedSavedText.trimmed;
  const savedContentHash = fnv1aHash(input.manuscriptText);
  const selectionContentHash = selection ? fnv1aHash(selection.text) : undefined;
  const sceneTitleIncluded = !manifestOnly && title !== undefined;
  const sceneTrimmed = boundedTitle?.trimmed ?? false;

  const parts = [
    {
      kind: "scene" as const,
      source: "arcadia" as const,
      source_identity: { project_id: input.projectId, scene_id: input.sceneId },
      revision: input.sceneRevision ?? null,
      inclusion_reason: "Requested scene identity",
      metadata_included: true,
      size: {
        source_character_count: characterCount(input.sceneTitle ?? ""),
        included_character_count: sceneTitleIncluded ? characterCount(title ?? "") : 0,
        included_byte_count: sceneTitleIncluded ? byteCount(title ?? "") : 0,
        token_count: null,
        token_count_status: "not_measured",
      },
      dropped: title !== undefined && !sceneTitleIncluded,
      trimmed: sceneTitleIncluded && sceneTrimmed,
    },
    {
      kind: "saved_manuscript" as const,
      source: "arcadia" as const,
      source_identity: {
        project_id: input.projectId,
        scene_id: input.sceneId,
        manuscript_id: input.manuscriptId,
        content_hash: savedContentHash,
      },
      revision: input.manuscriptRevision,
      inclusion_reason: manifestOnly
        ? "Saved manuscript omitted by manifest-only response"
        : "Requested saved scene manuscript",
      metadata_included: true,
      size: {
        source_character_count: characterCount(input.manuscriptText),
        included_character_count: manifestOnly ? 0 : characterCount(savedText),
        included_byte_count: manifestOnly ? 0 : byteCount(savedText),
        token_count: null,
        token_count_status: "not_measured",
      },
      dropped: manifestOnly,
      trimmed: !manifestOnly && savedTextTrimmed,
    },
    ...(selection
      ? [
          {
            kind: "selection" as const,
            source: "mcp_client" as const,
            source_identity: {
              project_id: input.projectId,
              scene_id: input.sceneId,
              from: selection.from,
              to: selection.to,
              content_hash: selectionContentHash,
            },
            revision: null,
            inclusion_reason: manifestOnly
              ? "Caller selection omitted by manifest-only response"
              : "Explicitly provided as an MCP selection argument",
            metadata_included: true,
            size: {
              source_character_count: characterCount(selection.text),
              included_character_count: manifestOnly ? 0 : characterCount(selection.text),
              included_byte_count: manifestOnly ? 0 : byteCount(selection.text),
              token_count: null,
              token_count_status: "not_measured",
            },
            dropped: manifestOnly,
            trimmed: false,
          },
        ]
      : []),
  ];

  return {
    captured_at: input.capturedAt ?? Date.now(),
    scene: {
      id: input.sceneId,
      ...(title === undefined ? {} : { title }),
      revision: input.sceneRevision ?? null,
    },
    saved_manuscript: {
      id: input.manuscriptId,
      revision: input.manuscriptRevision,
      content_hash: savedContentHash,
      text: savedText,
    },
    selection: selection
      ? {
          status: "client_provided" as const,
          from: selection.from,
          to: selection.to,
          text: selection.text,
          content_hash: selectionContentHash,
        }
      : { status: "not_provided" as const },
    draft: { status: "not_shared" as const },
    manifest: {
      scope: "arcadia_provided_context" as const,
      external_host_final_prompt_observed: false as const,
      draft: { status: "not_shared" as const },
      parts,
    },
  };
}
