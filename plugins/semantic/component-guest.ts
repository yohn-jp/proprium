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

setInferenceBindings({ beginAsset, appendAsset, finishAsset, loadEmbedding, embedPassages, release, splitSentenceEnds });

export { guest } from "./guest.ts";
