import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ids = [
  'proprium.narrative', 'proprium.knowledge', 'proprium.research', 'proprium.paired-writing',
  'proprium.diagnostics', 'proprium.speaker', 'proprium.semantic', 'proprium.publishing',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rawPublicKey = pair => Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('base64');
const sourceRevision = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const temporary = await mkdtemp(join(tmpdir(), 'proprium-authoring-build-'));
const retainedOutput = process.env.PROPRIUM_SIGNED_AUTHORING_RELEASE_DIR;
const output = retainedOutput ? resolve(retainedOutput) : join(temporary, 'registry');
const registryKeys = generateKeyPairSync('ed25519');
const publisherKeys = generateKeyPairSync('ed25519');
const env = {
  ...process.env,
  PROPRIUM_PLUGIN_OUTPUT_DIR: output,
  PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR: '',
  PROPRIUM_PLUGIN_REGISTRY_VERSION: '1.0.0',
  PROPRIUM_PLUGIN_ARTIFACT_BASE: process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE ?? 'https://authoring-build.invalid/plugins/',
  PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY: registryKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY: publisherKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: rawPublicKey(registryKeys),
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'unknown'}`);
}

try {
  if (retainedOutput) {
    const keyPath = process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_KEY_FILE;
    if (!keyPath || resolve(keyPath).startsWith(`${root}/`) || resolve(keyPath).startsWith(`${output}/`)) throw new Error('Retained test fixtures require a private key path outside the repository and served artifacts');
    await writeFile(keyPath, registryKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), { flag: 'wx', mode: 0o600 });
  }
  await mkdir(output, { recursive: true });
  run(process.execPath, ['scripts/build-plugin-registry.mjs', 'authoring']);
  run(process.execPath, ['scripts/verify-plugin-registry.mjs', 'authoring']);

  const registryBytes = await readFile(join(output, 'registry.json'));
  const registry = JSON.parse(registryBytes.toString('utf8'));
  assert.equal(registry.schema, 'proprium.registry/v1');
  assert.equal(registry.version, '1.0.0');
  assert.deepEqual(registry.plugins.map(plugin => plugin.id).sort(), [...ids].sort());
  assert.equal(new Set(registry.plugins.map(plugin => `${plugin.id}@${plugin.version}`)).size, ids.length);

  const releases = [];
  for (const entry of registry.plugins) {
    const manifestBytes = await readFile(join(output, entry.manifestPath));
    assert.equal(sha256(manifestBytes), entry.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.schema, 'proprium.plugin/v2');
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.version, entry.version);
    assert.ok(manifest.actions.length > 0, `${entry.id} must publish implemented actions`);
    const artifact = manifest.artifacts.find(value => value.path === manifest.entrypoint && value.mediaType === 'application/wasm');
    assert.ok(artifact, `${entry.id} must publish its component entrypoint`);
    releases.push({
      id: entry.id,
      version: entry.version,
      manifest_sha256: sha256(manifestBytes),
      manifest_signature_sha256: sha256(Buffer.from(entry.manifestSignature, 'base64')),
      publisher_key_sha256: sha256(Buffer.from(entry.publisherKey, 'base64')),
      component_sha256: artifact.sha256,
      component_bytes: artifact.bytes,
      action_count: manifest.actions.length,
    });
  }

  const evidence = {
    schema: 'proprium.acceptance-evidence/v1',
    source_revision: sourceRevision,
    workflow_url: process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    records: [{
      id: 'R02',
      status: 'NOT_CHECKED',
      canon: ['R02'],
      checks: {
        actual_component_build_and_signature_integrity: 'PASS',
        signed_registry_dependency_graph: 'PASS',
        browser_discovery_install_enable_reload_update_disable_rollback: 'NOT_CHECKED',
      },
      fixture: 'The eight canonical repository plugin packages built as actual v2 WebAssembly components.',
      test_command: 'node scripts/test-authoring-plugin-build.mjs',
      source_sha: sourceRevision,
      registry_sha256: sha256(registryBytes),
      registry_signature_sha256: sha256(await readFile(join(output, 'registry.json.sig'))),
      workflow_artifact: process.env.GITHUB_SHA ? `proprium-authoring-build-evidence-${process.env.GITHUB_SHA}` : null,
      signing_keys: 'Ephemeral Ed25519 keys generated by this verification run; this is not a release signature.',
      browser_platform: 'Not exercised by this build verification.',
      input: ids,
      output: releases,
      receipt: 'All eight signed manifests, component digests, and the signed registry index and dependency graph passed the registry verifier.',
      limitation: 'Install, enable, reload, update, disable, rollback, and authoring behavior require separate real-browser acceptance evidence.',
    }],
  };
  const evidencePath = process.env.PROPRIUM_AUTHORING_BUILD_EVIDENCE_PATH;
  if (evidencePath) {
    await mkdir(join(evidencePath, '..'), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(`Built and verified ${releases.length} canonical authoring components; acceptance status remains NOT_CHECKED.`);
  for (const release of releases) console.log(`${release.id}@${release.version} ${release.component_sha256} (${release.component_bytes} bytes)`);
  console.log(`Signed registry SHA-256: ${sha256(registryBytes)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
