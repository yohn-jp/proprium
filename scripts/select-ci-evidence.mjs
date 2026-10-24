#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { validateVerificationPlan } from './ci-impact.mjs';
import { selectLatestEvidenceArtifacts } from './ci-artifact-selection.mjs';

const { GITHUB_OUTPUT, SCRIPTORIUM_EXPECTED_SHA } = process.env;
assert.ok(GITHUB_OUTPUT, 'GitHub output path is required');
const planPath = process.env.SCRIPTORIUM_CI_PLAN_PATH ?? 'ci-plan.json';
const inventoryPath = process.env.SCRIPTORIUM_CI_INVENTORY_PATH;
assert.ok(inventoryPath, 'Artifact inventory path is required');
const plan = validateVerificationPlan(JSON.parse(await readFile(planPath, 'utf8')));
assert.equal(plan.sha, SCRIPTORIUM_EXPECTED_SHA, 'Impact plan source SHA mismatch');
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
assert.equal(inventory.identity.runId, process.env.GITHUB_RUN_ID, 'Artifact inventory run ID mismatch');
assert.equal(inventory.identity.sourceSha, SCRIPTORIUM_EXPECTED_SHA, 'Artifact inventory source SHA mismatch');
const selected = selectLatestEvidenceArtifacts(plan, inventory.artifacts, inventory.jobs, inventory.identity);
const artifactIds = selected.map(artifact => artifact.id).join(',');
assert.ok(artifactIds.length > 0, 'No selected CI evidence artifact IDs');
await appendFile(GITHUB_OUTPUT, `artifact-ids=${artifactIds}\n`);
console.log(`Selected latest exact-run CI evidence for ${selected.map(artifact => artifact.name.slice('ci-evidence-'.length)).join(', ')} at ${SCRIPTORIUM_EXPECTED_SHA}.`);
