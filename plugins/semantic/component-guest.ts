import {
  appendAsset,
  beginAsset,
  embedPassages,
  finishAsset,
  loadEmbedding,
  release,
  splitSentenceEnds,
} from "proprium:plugin/inference@2.0.0";
import { setInferenceBindings } from "./inference.ts";
import {
  appendTensor,
  appendTokenizer,
  beginData,
  beginTensor,
  beginTokenizer,
  finishData,
  finishTensor,
  finishTokenizer,
  inspectGraph,
  loadModel,
  memoryBytes,
  modelId,
  modelRevision,
  release as releaseReranker,
  scorePair,
} from "proprium:semantic-reranker/inference@1.0.0";
import { setBgeRerankerBindings } from "./reranker-inference.ts";

setInferenceBindings({ beginAsset, appendAsset, finishAsset, loadEmbedding, embedPassages, release, splitSentenceEnds });
setBgeRerankerBindings({ inspectGraph, beginData, beginTensor, appendTensor, finishTensor, finishData,
  beginTokenizer, appendTokenizer, finishTokenizer, loadModel, scorePair, modelId, modelRevision, memoryBytes,
  release: releaseReranker });

export { guest } from "./guest.ts";
