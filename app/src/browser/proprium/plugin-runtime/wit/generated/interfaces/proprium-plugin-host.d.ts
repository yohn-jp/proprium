/** @module Interface proprium:plugin/host@1.0.0 **/
export function snapshotList(): Array<SnapshotEntry>;
export function snapshotRead(path: string): string | undefined;
export function proposeChange(proposal: ChangeProposal): void;
export function uiContribute(contribution: UiContribution): void;
export interface SnapshotEntry {
  path: string,
  revision: string,
}
export interface FileChange {
  path: string,
  expectedRevision?: string,
  content: string,
}
export interface ReadRevision {
  path: string,
  revision?: string,
}
export interface ChangeProposal {
  snapshotId: string,
  snapshotRevision: string,
  readSet: Array<ReadRevision>,
  changes: Array<FileChange>,
}
/**
 * # Variants
 *
 * ## `"panel"`
 *
 * ## `"command"`
 */
export type ContributionKind = 'panel' | 'command';
export interface UiContribution {
  kind: ContributionKind,
  id: string,
  title: string,
}
