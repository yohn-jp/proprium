import {
  appendAsset,
  beginAsset,
  embedPassages,
  finishAsset,
  loadEmbedding,
  release,
} from "proprium:plugin/inference@2.0.0";
import { setInferenceBindings } from "./inference.ts";

setInferenceBindings({ beginAsset, appendAsset, finishAsset, loadEmbedding, embedPassages, release });

export { guest } from "./guest.ts";
