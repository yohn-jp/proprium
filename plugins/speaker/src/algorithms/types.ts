/** Read-only narrative record shape supplied by the Host's pinned adapters. */
export interface Entity {
  id: string;
  type: string;
  name?: string;
  aliases?: string[];
  raw: Record<string, unknown>;
}
