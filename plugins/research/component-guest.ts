import {
  appendAsset,
  beginAsset,
  countTokens,
  finishAsset,
  loadTokenizer,
  release,
  tokenize,
} from "proprium:plugin/morphology@2.0.0";
import { setResearchMorphologyBindings } from "./morphology.ts";

setResearchMorphologyBindings({ beginAsset, appendAsset, finishAsset, loadTokenizer, tokenize, countTokens, release });

export { guest } from "./guest.ts";
