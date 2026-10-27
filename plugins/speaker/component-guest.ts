import { splitSentenceEnds } from "proprium:plugin/sentence-segmentation@2.0.0";
import { setSentenceEnds } from "./src/nlp/sentenceSplit.js";

setSentenceEnds(splitSentenceEnds);
export { guest } from "./guest.js";
