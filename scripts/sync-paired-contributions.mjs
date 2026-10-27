#!/usr/bin/env node
// Run with `node --import tsx scripts/sync-paired-contributions.mjs`.
import { readFile, writeFile } from 'node:fs/promises';
import { descriptors as continuation, surfaces as continuationUi } from '../plugins/paired-writing/src/continuation-contribution.ts';
import { descriptors as adapters, surfaces as adapterUi } from '../plugins/paired-writing/src/adapter-contribution.ts';
import { descriptors as dialogue, surfaces as dialogueUi } from '../plugins/paired-writing/src/dialogue-zukan-contribution.ts';
import { summaryStateDescriptors, summaryStateSurfaces } from '../plugins/paired-writing/src/summary-state-contribution.ts';
import { assertAuthoringDeclarations } from './authoring-manifest-schema.mjs';

const file = new URL('../plugins/paired-writing/plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
const merge = (existing, additions, key) => {
  const entries = new Map(existing.map(row => [row[key], row]));
  for (const row of additions) entries.set(row[key], row);
  return [...entries.values()];
};
manifest.actions = merge(manifest.actions, [...continuation, ...adapters, ...dialogue, ...summaryStateDescriptors], 'action_id');
manifest.ui = merge(manifest.ui, [...continuationUi, ...adapterUi, ...dialogueUi, ...summaryStateSurfaces], 'id');
manifest.capabilities = [...new Set([...manifest.capabilities, ...manifest.actions.flatMap(action => action.required_capabilities)])];
await assertAuthoringDeclarations(manifest.id, manifest.capabilities, manifest.actions, manifest.ui);
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== expected) throw new Error('Paired contribution metadata is stale; run sync-paired-contributions.mjs');
} else await writeFile(file, expected);
console.log(`${manifest.id}: ${manifest.actions.length} actions, ${manifest.ui.length} surfaces`);
