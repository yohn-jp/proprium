export const RESEARCH_DICTIONARY_GROUP_ID = "proprium.research.ipadic";
// This is the immutable digest of the generated `proprium.assets/v1` manifest.
export const RESEARCH_DICTIONARY_MANIFEST_SHA256 = "66601c7e3f8ed946df567a97644135bfec786d79f5b28f2b5adbb54258fe5d07";
export const RESEARCH_TOKENIZER_ID = "lindera-wasm-nodejs-ipadic";
export const RESEARCH_TOKENIZER_VERSION = "2.0.0";
export const ASSET_READ_CHUNK_BYTES = 64 * 1024;

export interface PinnedDictionaryFile {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

export const RESEARCH_DICTIONARY_FILES: readonly PinnedDictionaryFile[] = [
  { path: "lindera-ipadic/metadata.json", byte_length: 791, sha256: "3bf3d5ef582e6ef4c8ad409b013bdc511f32a852344d81a62afb97f2bab7155c" },
  { path: "lindera-ipadic/char_def.bin", byte_length: 764, sha256: "cb7674fcd5a5c277a1aac27ace1b3977a5a13547574dab57c87157edcb351d41" },
  { path: "lindera-ipadic/dict.words", byte_length: 4_175_536, sha256: "2563d4ec2e93085fef51b40242b895bdc42509b8fa65884fba35e8f366f79d44" },
  { path: "lindera-ipadic/dict.wordsidx", byte_length: 765_408, sha256: "dd7df63ee77efa61249e116ffefb81dc53f052b1f3b21ef93fc115076656b912" },
  { path: "lindera-ipadic/matrix.mtx", byte_length: 1_692_436, sha256: "35737753b8f53ec692604d997521a513d8228453a71905a6aae242afb1ab414c" },
  { path: "lindera-ipadic/dict.da", byte_length: 3_307_616, sha256: "b1e1d9a51aedf1a5150cef4cdeca5d1319a57c638a0200b12209fc48ca1b8d91" },
  { path: "lindera-ipadic/dict.vals", byte_length: 1_409_868, sha256: "5ff937a473b528fd1ce611c89247928aa71d40502aa07a0b3b7a2604e0081e91" },
  { path: "lindera-ipadic/unk.bin", byte_length: 356, sha256: "1821e73ee882b721269dcd15f56abe34592a25476e761a0c22ff259ddc9286cc" },
];
