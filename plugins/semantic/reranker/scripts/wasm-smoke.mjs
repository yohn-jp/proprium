import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const [componentPath, graphPath, dataPath, tokenizerPath] = process.argv.slice(2);
if (!tokenizerPath) {
  throw new Error(
    'usage: node wasm-smoke.mjs COMPONENT_MODULE GRAPH.onnx GRAPH.onnx_data tokenizer.json',
  );
}

const { inference } = await import(pathToFileURL(resolve(componentPath)));
const graphSha = 'ed283424d9a40dbd6fe2f3081386848a88cc8057b7ab43e02d84077d6b69ba42';
const dataSha = '9a748c82efb2079d24650c489e053dbb3c71d8acbbcf04d7b2340db66f2748f7';
const tokenizerSha = '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3';
const graphBytesExpected = 489245;
const dataBytesExpected = 2271088656;
const tokenizerBytesExpected = 17082900;
const chunkLimit = 256 * 1024;
const startedAt = performance.now();

function report(stage) {
  console.log(
    JSON.stringify({
      stage,
      wasmLinearMemoryBytes: inference.memoryBytes().toString(),
      processRssBytes: process.memoryUsage().rss,
      elapsedSeconds: ((performance.now() - startedAt) / 1000).toFixed(3),
    }),
  );
}

function feedTensorRanges(fd, ranges) {
  const chunk = Buffer.allocUnsafe(chunkLimit);
  for (const range of ranges) {
    inference.beginTensor(range.index);
    for (let relative = 0; relative < range.bytes;) {
      const count = Math.min(chunkLimit, range.bytes - relative);
      const got = readSync(fd, chunk, 0, count, range.offset + relative);
      if (got !== count) {
        throw new Error(`short read at ${range.offset + relative}: ${got}/${count}`);
      }
      inference.appendTensor(
        range.index,
        relative,
        new Uint8Array(chunk.buffer, chunk.byteOffset, count),
      );
      relative += count;
    }
    inference.finishTensor(range.index);
    if ((range.index + 1) % 50 === 0 || range.index + 1 === ranges.length) {
      report(`tensor-${range.index + 1}/${ranges.length}`);
    }
  }
}

function readSha256(path, expectedBytes, expectedSha) {
  const bytes = readFileSync(path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== expectedBytes || digest !== expectedSha) {
    throw new Error(`pinned file mismatch: ${path}`);
  }
  return bytes;
}

try {
  const graph = readSha256(graphPath, graphBytesExpected, graphSha);
  const ranges = inference.inspectGraph(graph, graphSha);
  if (inference.modelId() !== 'mogolloni/bge-reranker-v2-m3-onnx') {
    throw new Error('component reported an unexpected model identity');
  }
  if (inference.modelRevision() !== 'e5023553f6c47f09057da7a19cdd79ef850a4985') {
    throw new Error('component reported an unexpected model revision');
  }
  console.log(
    JSON.stringify({
      model: inference.modelId(),
      revision: inference.modelRevision(),
      graphBytes: graph.length,
      externalTensorCount: ranges.length,
      first: ranges[0],
      last: ranges.at(-1),
    }),
  );
  report('graph-ready');

  if (statSync(dataPath).size !== dataBytesExpected) {
    throw new Error(`external data size mismatch: ${dataPath}`);
  }
  inference.beginData(dataBytesExpected, dataSha);
  const dataFd = openSync(dataPath, 'r');
  try {
    feedTensorRanges(dataFd, ranges);
  } finally {
    closeSync(dataFd);
  }
  inference.finishData();
  report('external-data-verified');

  if (statSync(tokenizerPath).size !== tokenizerBytesExpected) {
    throw new Error(`tokenizer size mismatch: ${tokenizerPath}`);
  }
  inference.beginTokenizer(tokenizerBytesExpected, tokenizerSha);
  const tokenizerFd = openSync(tokenizerPath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(chunkLimit);
    for (let offset = 0; offset < tokenizerBytesExpected;) {
      const count = Math.min(chunkLimit, tokenizerBytesExpected - offset);
      const got = readSync(tokenizerFd, chunk, 0, count, offset);
      if (got !== count) throw new Error(`short tokenizer read at ${offset}`);
      inference.appendTokenizer(
        offset,
        new Uint8Array(chunk.buffer, chunk.byteOffset, count),
      );
      offset += count;
    }
  } finally {
    closeSync(tokenizerFd);
  }
  inference.finishTokenizer();
  report('tokenizer-verified');

  const loadStartedAt = performance.now();
  inference.loadModel();
  console.log(
    JSON.stringify({
      stage: 'model-loaded',
      loadSeconds: ((performance.now() - loadStartedAt) / 1000).toFixed(3),
    }),
  );
  report('model-loaded');

  const query = 'Where is the Eiffel Tower located?';
  const positive = inference.scorePair(query, 'The Eiffel Tower is in Paris, France.');
  const negative = inference.scorePair(query, 'Berlin is the capital of Germany.');
  const repeated = inference.scorePair(query, 'The Eiffel Tower is in Paris, France.');
  const results = {
    positive,
    negative,
    repeated,
    finite: Number.isFinite(positive) && Number.isFinite(negative),
    ranking: positive > negative,
    reproducible: Math.abs(positive - repeated) <= 1e-6,
  };
  console.log(JSON.stringify(results));
  report('scored');
  if (!results.finite || !results.ranking || !results.reproducible) {
    throw new Error('BGE smoke inference did not pass ranking/repeatability checks');
  }
} finally {
  try {
    inference.release();
  } catch {
    // Preserve the original inference error if cleanup runs before initialization.
  }
}
