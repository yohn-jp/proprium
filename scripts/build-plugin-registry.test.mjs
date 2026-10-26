import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rawPublicKey = pair => Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('base64');
const rawSha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('compute-sum producer emits a signed registry and a real content-addressed WASM component', async () => {
  const output = await mkdtemp(join(tmpdir(), 'proprium-registry-test-'));
  const registryKeys = generateKeyPairSync('ed25519');
  const publisherKeys = generateKeyPairSync('ed25519');
  const registryPublic = rawPublicKey(registryKeys);
  const env = {
    ...process.env,
    PROPRIUM_PLUGIN_OUTPUT_DIR: output,
    PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR: '',
    PROPRIUM_PLUGIN_VERSION: '1.0.0',
    PROPRIUM_PLUGIN_ARTIFACT_BASE: 'https://plugins.example.test/plugins/',
    PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY: registryKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY: publisherKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: registryPublic,
  };
  try {
    const build = spawnSync(process.execPath, ['scripts/build-plugin-registry.mjs', 'example'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    assert.match(build.stdout, /proprium\.compute-sum@1\.0\.0/u);

    const verify = spawnSync(process.execPath, ['scripts/verify-plugin-registry.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
    assert.match(verify.stdout, /Verified 1 signed plugin release/u);

    const registry = JSON.parse(await readFile(join(output, 'registry.json'), 'utf8'));
    const entry = registry.plugins[0];
    const manifest = JSON.parse(await readFile(join(output, entry.manifestPath), 'utf8'));
    const componentPath = join(output, manifest.entrypoint);
    const component = await readFile(componentPath);
    assert.deepEqual([...component.subarray(0, 4)], [0, 0x61, 0x73, 0x6d]);
    assert.match(manifest.entrypoint, new RegExp(`/${manifest.artifacts[0].sha256}/`, 'u'));

    await writeFile(componentPath, Buffer.concat([component, Buffer.from([0])]));
    const tampered = spawnSync(process.execPath, ['scripts/verify-plugin-registry.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(tampered.status, 0);
    assert.match(`${tampered.stdout}\n${tampered.stderr}`, /Artifact digest mismatch/u);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('authoring producer independently componentizes and signs all eight v2 products', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'proprium-authoring-registry-test-'));
  const output = join(temporary, 'registry');
  const sourceRoot = join(temporary, 'plugins');
  const registryKeys = generateKeyPairSync('ed25519');
  const publisherKeys = generateKeyPairSync('ed25519');
  const registryPublic = rawPublicKey(registryKeys);
  const ids = [
    'proprium.narrative', 'proprium.knowledge', 'proprium.research', 'proprium.paired-writing',
    'proprium.diagnostics', 'proprium.speaker', 'proprium.semantic', 'proprium.publishing',
  ];
  const actionIds = [
    'proprium.narrative.hierarchy.tree', 'knowledge.entities.list', 'research.query', 'paired.context.read',
    'diagnostics.scan', 'speaker.attribute', 'semantic.passages.query', 'proprium.publishing.export.text',
  ];
  const guestSource = `export const guest = {
  initialize(_context: { pluginId: string; version: string; workspaceId: string }): void {},
  invoke(request: string): string { return request; },
  dispose(): void {},
};\n`;
  const emptyObject = { type: 'object', properties: {}, additionalProperties: false };
  try {
    for (let index = 0; index < ids.length; index++) {
      const pluginId = ids[index];
      const slug = pluginId.slice('proprium.'.length);
      const directory = join(sourceRoot, slug);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'guest.ts'), guestSource);
      if (pluginId === 'proprium.semantic') {
        await writeFile(join(directory, 'build.mjs'), `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
execFileSync(process.env.PROPRIUM_PLUGIN_JCO_BIN, [
  'componentize', fileURLToPath(new URL('./guest.ts', import.meta.url)),
  '--wit', process.env.PROPRIUM_PLUGIN_V2_WIT,
  '--world-name', process.env.PROPRIUM_PLUGIN_V2_WORLD,
  '--disable', 'all', '--bundle', '-o', process.env.PROPRIUM_PLUGIN_BUILD_OUTPUT,
], { stdio: 'inherit' });
console.log('synthetic-semantic-custom-build');
`);
      }
      let assetGroups = [];
      if (pluginId === 'proprium.semantic') {
        const payload = Buffer.from('synthetic deterministic asset fixture');
        const payloadDigest = rawSha256(payload);
        const chunkPath = `proprium/semantic/assets/chunks/${payloadDigest}/fixture.bin`;
        const sourceChunkPath = join(directory, chunkPath.slice('proprium/semantic/'.length));
        await mkdir(join(sourceChunkPath, '..'), { recursive: true });
        await writeFile(sourceChunkPath, payload);
        const assetManifestBytes = Buffer.from(JSON.stringify({
          schema: 'proprium.assets/v1',
          id: 'semantic-test-asset',
          version: '1.0.0',
          license: 'CC0-1.0',
          files: [{
            path: 'fixture.bin',
            bytes: payload.byteLength,
            sha256: payloadDigest,
            chunks: [{ path: chunkPath, offset: 0, bytes: payload.byteLength, sha256: payloadDigest }],
          }],
        }));
        const assetManifestDigest = rawSha256(assetManifestBytes);
        const manifestPath = `proprium/semantic/assets/manifests/${assetManifestDigest}/manifest.json`;
        const sourceManifestPath = join(directory, manifestPath.slice('proprium/semantic/'.length));
        await mkdir(join(sourceManifestPath, '..'), { recursive: true });
        await writeFile(sourceManifestPath, assetManifestBytes);
        assetGroups = [{
          id: 'semantic-test-asset',
          manifest_path: manifestPath,
          sha256: assetManifestDigest,
          bytes: assetManifestBytes.byteLength,
          role: 'embedding',
        }];
      }
      await writeFile(join(directory, 'plugin.json'), JSON.stringify({
        schema: 'proprium.plugin/v2',
        id: pluginId,
        version: '1.0.0',
        abi: 'proprium.component/v2',
        capabilities: [],
        actions: [{
          plugin_id: pluginId,
          action_id: actionIds[index],
          schema_version: 1,
          effect: 'read',
          input_schema: emptyObject,
          output_schema: emptyObject,
          required_capabilities: [],
          callers: ['ui'],
          requires_user_gesture: false,
        }],
        ui: [],
        asset_groups: assetGroups,
        dependencies: pluginId === 'proprium.knowledge' ? [{ id: 'proprium.narrative', range: '^1.0.0' }] : [],
      }));
    }
    const env = {
      ...process.env,
      PROPRIUM_PLUGIN_OUTPUT_DIR: output,
      PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR: '',
      PROPRIUM_AUTHORING_PLUGIN_SOURCE_DIR: sourceRoot,
      PROPRIUM_PLUGIN_REGISTRY_VERSION: '1.0.0',
      PROPRIUM_PLUGIN_ARTIFACT_BASE: 'https://plugins.example.test/plugins/',
      PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY: registryKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY: publisherKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: registryPublic,
    };
    const build = spawnSync(process.execPath, ['scripts/build-plugin-registry.mjs', 'authoring'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    assert.match(build.stdout, /synthetic-semantic-custom-build/u);
    for (const pluginId of ids) assert.ok(build.stdout.includes(`Built signed ${pluginId}@1.0.0`), `${pluginId} was not built`);

    const verify = spawnSync(process.execPath, ['scripts/verify-plugin-registry.mjs', 'authoring'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
    assert.match(verify.stdout, /Verified 8 signed plugin release/u);

    const registry = JSON.parse(await readFile(join(output, 'registry.json'), 'utf8'));
    assert.deepEqual(new Set(registry.plugins.map(entry => entry.id)), new Set(ids));
    for (const entry of registry.plugins) {
      const manifest = JSON.parse(await readFile(join(output, entry.manifestPath), 'utf8'));
      assert.equal(manifest.schema, 'proprium.plugin/v2');
      assert.equal(manifest.abi, 'proprium.component/v2');
      assert.equal(manifest.actions.length, 1);
      if (entry.id === 'proprium.semantic') {
        assert.equal(manifest.asset_groups.length, 1);
        const assetManifest = JSON.parse(await readFile(join(output, manifest.asset_groups[0].manifest_path), 'utf8'));
        assert.equal(assetManifest.files[0].bytes, assetManifest.files[0].chunks[0].bytes);
      }
    }

    const nextVersion = '1.0.1';
    for (const pluginId of ids) {
      const slug = pluginId.slice('proprium.'.length);
      const metadataPath = join(sourceRoot, slug, 'plugin.json');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      metadata.version = nextVersion;
      await writeFile(metadataPath, JSON.stringify(metadata));
    }
    env.PROPRIUM_PLUGIN_REGISTRY_VERSION = nextVersion;
    env.PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR = output;
    const rebuild = spawnSync(process.execPath, ['scripts/build-plugin-registry.mjs', 'authoring'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(rebuild.status, 0, `${rebuild.stdout}\n${rebuild.stderr}`);
    assert.match(rebuild.stdout, /Preserved 8 prior version\(s\); registry contains 16 immutable entry\/entries/u);

    const updatedVerify = spawnSync(process.execPath, ['scripts/verify-plugin-registry.mjs', 'authoring'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(updatedVerify.status, 0, `${updatedVerify.stdout}\n${updatedVerify.stderr}`);
    assert.match(updatedVerify.stdout, /Verified 16 signed plugin release\(s\)/u);
    const updatedRegistry = JSON.parse(await readFile(join(output, 'registry.json'), 'utf8'));
    assert.equal(updatedRegistry.plugins.length, 16);
    for (const pluginId of ids) {
      const versions = updatedRegistry.plugins.filter(entry => entry.id === pluginId).map(entry => entry.version).sort();
      assert.deepEqual(versions, ['1.0.0', nextVersion]);
    }
    const previousSemantic = updatedRegistry.plugins.find(entry => entry.id === 'proprium.semantic' && entry.version === '1.0.0');
    const previousSemanticManifest = JSON.parse(await readFile(join(output, previousSemantic.manifestPath), 'utf8'));
    assert.equal(previousSemanticManifest.asset_groups.length, 1);
    const preservedAssetManifestPath = join(output, previousSemanticManifest.asset_groups[0].manifest_path);
    assert.equal(rawSha256(await readFile(preservedAssetManifestPath)), previousSemanticManifest.asset_groups[0].sha256);

    const invalidDependencyIndex = Buffer.from(JSON.stringify({
      ...updatedRegistry,
      plugins: updatedRegistry.plugins.map(entry => entry.id === 'proprium.knowledge' && entry.version === nextVersion
        ? { ...entry, dependencies: [{ id: 'proprium.missing', range: '*' }] }
        : entry),
    }));
    await writeFile(join(output, 'registry.json'), invalidDependencyIndex);
    await writeFile(join(output, 'registry.json.sig'), sign(null, invalidDependencyIndex, registryKeys.privateKey));
    const invalidDependencyVerify = spawnSync(process.execPath, ['scripts/verify-plugin-registry.mjs', 'authoring'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(invalidDependencyVerify.status, 0);
    assert.match(`${invalidDependencyVerify.stdout}\n${invalidDependencyVerify.stderr}`, /No signed proprium\.missing release satisfies/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authoring producer rejects unsigned manifest extensions before producing a registry', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'proprium-authoring-invalid-registry-test-'));
  const output = join(temporary, 'registry');
  const sourceRoot = join(temporary, 'plugins');
  const directory = join(sourceRoot, 'narrative');
  const registryKeys = generateKeyPairSync('ed25519');
  const publisherKeys = generateKeyPairSync('ed25519');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'guest.ts'), `export const guest = {
  initialize(_context: { pluginId: string; version: string; workspaceId: string }): void {},
  invoke(request: string): string { return request; },
  dispose(): void {},
};\n`);
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({
    schema: 'proprium.plugin/v2',
    id: 'proprium.narrative',
    version: '1.0.0',
    abi: 'proprium.component/v2',
    capabilities: [],
    actions: [],
    ui: [],
    asset_groups: [],
    dependencies: [],
    unexpected: true,
  }));
  const env = {
    ...process.env,
    PROPRIUM_PLUGIN_OUTPUT_DIR: output,
    PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR: '',
    PROPRIUM_AUTHORING_PLUGIN_SOURCE_DIR: sourceRoot,
    PROPRIUM_PLUGIN_REGISTRY_VERSION: '1.0.0',
    PROPRIUM_PLUGIN_ARTIFACT_BASE: 'https://plugins.example.test/plugins/',
    PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY: registryKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY: publisherKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: rawPublicKey(registryKeys),
  };
  try {
    const build = spawnSync(process.execPath, ['scripts/build-plugin-registry.mjs', 'authoring'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(build.status, 0);
    assert.match(`${build.stdout}\n${build.stderr}`, /missing or unknown fields/u);
    assert.equal(await readFile(join(output, 'registry.json')).then(() => true, error => error?.code === 'ENOENT'), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authoring producer applies the canonical Host schema safety bounds to action JSON schemas', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'proprium-authoring-schema-registry-test-'));
  const output = join(temporary, 'registry');
  const sourceRoot = join(temporary, 'plugins');
  const directory = join(sourceRoot, 'narrative');
  const registryKeys = generateKeyPairSync('ed25519');
  const publisherKeys = generateKeyPairSync('ed25519');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'guest.ts'), `export const guest = {
  initialize(_context: { pluginId: string; version: string; workspaceId: string }): void {},
  invoke(request: string): string { return request; },
  dispose(): void {},
};\n`);
  const emptyObject = { type: 'object', properties: {}, additionalProperties: false };
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({
    schema: 'proprium.plugin/v2', id: 'proprium.narrative', version: '1.0.0', abi: 'proprium.component/v2',
    capabilities: [],
    actions: [{
      plugin_id: 'proprium.narrative', action_id: 'proprium.narrative.test', schema_version: 1, effect: 'read',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      output_schema: emptyObject, required_capabilities: [], callers: ['ui'], requires_user_gesture: false,
    }],
    ui: [], asset_groups: [], dependencies: [],
  }));
  const env = {
    ...process.env,
    PROPRIUM_PLUGIN_OUTPUT_DIR: output,
    PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR: '',
    PROPRIUM_AUTHORING_PLUGIN_SOURCE_DIR: sourceRoot,
    PROPRIUM_PLUGIN_REGISTRY_VERSION: '1.0.0',
    PROPRIUM_PLUGIN_ARTIFACT_BASE: 'https://plugins.example.test/plugins/',
    PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY: registryKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY: publisherKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: rawPublicKey(registryKeys),
  };
  try {
    const build = spawnSync(process.execPath, ['scripts/build-plugin-registry.mjs', 'authoring'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(build.status, 0);
    assert.match(`${build.stdout}\n${build.stderr}`, /Unbounded string schema/u);
    assert.equal(await readFile(join(output, 'registry.json')).then(() => true, error => error?.code === 'ENOENT'), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
