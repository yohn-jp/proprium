#[allow(warnings)]
mod bindings;

use bindings::exports::proprium::plugin::morphology::{EngineToken, Guest};
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera::tokenizer::Tokenizer;
use lindera_dictionary::decompress::{decompress, CompressedData};
use lindera_dictionary::dictionary::character_definition::CharacterDefinition;
use lindera_dictionary::dictionary::connection_cost_matrix::ConnectionCostMatrix;
use lindera_dictionary::dictionary::metadata::Metadata;
use lindera_dictionary::dictionary::prefix_dictionary::PrefixDictionary;
use lindera_dictionary::dictionary::unknown_dictionary::UnknownDictionary;
use lindera_dictionary::dictionary::Dictionary;
use rkyv::util::AlignedVec;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::BTreeMap;

const GROUP_ID: &str = "proprium.research.ipadic";
const MAX_ASSET_CHUNK_BYTES: usize = 256 * 1024;
const MAX_ANALYSIS_TEXT_BYTES: usize = 64 * 1024;

const METADATA_PATH: &str = "lindera-ipadic/metadata.json";
const METADATA_BYTES: usize = 791;
const METADATA_SHA256: &str = "3bf3d5ef582e6ef4c8ad409b013bdc511f32a852344d81a62afb97f2bab7155c";
const CHAR_DEF_PATH: &str = "lindera-ipadic/char_def.bin";
const CHAR_DEF_BYTES: usize = 764;
const CHAR_DEF_SHA256: &str = "cb7674fcd5a5c277a1aac27ace1b3977a5a13547574dab57c87157edcb351d41";
const WORDS_PATH: &str = "lindera-ipadic/dict.words";
const WORDS_BYTES: usize = 4_175_536;
const WORDS_SHA256: &str = "2563d4ec2e93085fef51b40242b895bdc42509b8fa65884fba35e8f366f79d44";
const WORDS_IDX_PATH: &str = "lindera-ipadic/dict.wordsidx";
const WORDS_IDX_BYTES: usize = 765_408;
const WORDS_IDX_SHA256: &str = "dd7df63ee77efa61249e116ffefb81dc53f052b1f3b21ef93fc115076656b912";
const MATRIX_PATH: &str = "lindera-ipadic/matrix.mtx";
const MATRIX_BYTES: usize = 1_692_436;
const MATRIX_SHA256: &str = "35737753b8f53ec692604d997521a513d8228453a71905a6aae242afb1ab414c";
const DA_PATH: &str = "lindera-ipadic/dict.da";
const DA_BYTES: usize = 3_307_616;
const DA_SHA256: &str = "b1e1d9a51aedf1a5150cef4cdeca5d1319a57c638a0200b12209fc48ca1b8d91";
const VALS_PATH: &str = "lindera-ipadic/dict.vals";
const VALS_BYTES: usize = 1_409_868;
const VALS_SHA256: &str = "5ff937a473b528fd1ce611c89247928aa71d40502aa07a0b3b7a2604e0081e91";
const UNKNOWN_PATH: &str = "lindera-ipadic/unk.bin";
const UNKNOWN_BYTES: usize = 356;
const UNKNOWN_SHA256: &str = "1821e73ee882b721269dcd15f56abe34592a25476e761a0c22ff259ddc9286cc";

const EXPECTED_ASSETS: &[(&str, usize, &str)] = &[
    (METADATA_PATH, METADATA_BYTES, METADATA_SHA256),
    (CHAR_DEF_PATH, CHAR_DEF_BYTES, CHAR_DEF_SHA256),
    (WORDS_PATH, WORDS_BYTES, WORDS_SHA256),
    (WORDS_IDX_PATH, WORDS_IDX_BYTES, WORDS_IDX_SHA256),
    (MATRIX_PATH, MATRIX_BYTES, MATRIX_SHA256),
    (DA_PATH, DA_BYTES, DA_SHA256),
    (VALS_PATH, VALS_BYTES, VALS_SHA256),
    (UNKNOWN_PATH, UNKNOWN_BYTES, UNKNOWN_SHA256),
];

struct IncomingAsset {
    file_path: &'static str,
    byte_length: usize,
    sha256: &'static str,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct MorphologyState {
    incoming: Option<IncomingAsset>,
    assets: BTreeMap<String, Vec<u8>>,
    tokenizer: Option<Tokenizer>,
}

thread_local! {
    static STATE: RefCell<MorphologyState> = RefCell::new(MorphologyState::default());
}

fn expected_asset(path: &str) -> Option<(&'static str, usize, &'static str)> {
    EXPECTED_ASSETS.iter().copied().find(|(expected_path, _, _)| *expected_path == path)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fail(code: &str, message: impl AsRef<str>) -> String {
    format!("{code}: {}", message.as_ref())
}

fn maybe_decompress(bytes: &[u8], path: &str) -> Result<Vec<u8>, String> {
    let mut aligned = AlignedVec::<16>::new();
    aligned.extend_from_slice(bytes);
    match rkyv::from_bytes::<CompressedData, rkyv::rancor::Error>(&aligned) {
        Ok(compressed) => decompress(compressed)
            .map_err(|error| fail("model_unavailable", format!("Lindera asset {path} could not be decompressed: {error}"))),
        Err(_) => Ok(bytes.to_vec()),
    }
}

fn build_tokenizer(assets: &BTreeMap<String, Vec<u8>>) -> Result<Tokenizer, String> {
    if assets.len() != EXPECTED_ASSETS.len() || EXPECTED_ASSETS.iter().any(|(path, _, _)| !assets.contains_key(*path)) {
        return Err(fail("provider_unavailable", "The complete pinned IPADIC asset group is not available"));
    }
    let bytes = |path: &str| assets.get(path).map(Vec::as_slice)
        .ok_or_else(|| fail("model_unavailable", format!("The pinned IPADIC asset is missing: {path}")));
    let metadata = Metadata::load(bytes(METADATA_PATH)?).map_err(|error| fail("model_unavailable", format!("IPADIC metadata is invalid: {error}")))?;
    let char_definition = CharacterDefinition::load(&maybe_decompress(bytes(CHAR_DEF_PATH)?, CHAR_DEF_PATH)?)
        .map_err(|error| fail("model_unavailable", format!("IPADIC character definitions are invalid: {error}")))?;
    let connection_cost_matrix = ConnectionCostMatrix::load(maybe_decompress(bytes(MATRIX_PATH)?, MATRIX_PATH)?);
    let prefix_dictionary = PrefixDictionary::load(
        maybe_decompress(bytes(DA_PATH)?, DA_PATH)?,
        maybe_decompress(bytes(VALS_PATH)?, VALS_PATH)?,
        maybe_decompress(bytes(WORDS_IDX_PATH)?, WORDS_IDX_PATH)?,
        maybe_decompress(bytes(WORDS_PATH)?, WORDS_PATH)?,
        true,
    );
    let unknown_dictionary = UnknownDictionary::load(&maybe_decompress(bytes(UNKNOWN_PATH)?, UNKNOWN_PATH)?)
        .map_err(|error| fail("model_unavailable", format!("IPADIC unknown-word definitions are invalid: {error}")))?;

    let dictionary = Dictionary {
        prefix_dictionary,
        connection_cost_matrix,
        character_definition: char_definition,
        unknown_dictionary,
        metadata,
    };
    let segmenter = Segmenter::new(Mode::Normal, dictionary, None);
    Ok(Tokenizer::new(segmenter))
}

struct Component;

impl Guest for Component {
    fn begin_asset(group_id: String, file_path: String, total_bytes: u32, sha256: String) -> Result<(), String> {
        if group_id != GROUP_ID { return Err(fail("capability_denied", "asset group is not declared by Research")); }
        let (expected_path, expected_bytes, expected_sha256) = expected_asset(&file_path)
            .ok_or_else(|| fail("model_unavailable", "asset path is not part of the pinned Lindera IPADIC release"))?;
        if total_bytes as usize != expected_bytes || sha256 != expected_sha256 {
            return Err(fail("model_unavailable", "signed IPADIC metadata differs from the pinned Lindera release"));
        }
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            if state.tokenizer.is_some() { return Err(fail("invalid_input", "IPADIC tokenizer is already loaded")); }
            if state.incoming.is_some() || state.assets.contains_key(expected_path) {
                return Err(fail("invalid_input", "IPADIC asset transfer is duplicated or already active"));
            }
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(expected_bytes).map_err(|_| fail("capacity", "unable to reserve bounded IPADIC asset memory"))?;
            state.incoming = Some(IncomingAsset { file_path: expected_path, byte_length: expected_bytes, sha256: expected_sha256, bytes });
            Ok(())
        })
    }

    fn append_asset(group_id: String, file_path: String, offset: u32, bytes: Vec<u8>) -> Result<(), String> {
        if group_id != GROUP_ID { return Err(fail("capability_denied", "asset group is not declared by Research")); }
        if bytes.is_empty() || bytes.len() > MAX_ASSET_CHUNK_BYTES {
            return Err(fail("capacity", "IPADIC asset chunks must contain 1 to 262144 bytes"));
        }
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let Some(asset) = state.incoming.as_mut() else { return Err(fail("model_unavailable", "IPADIC asset transfer was not started")); };
            if asset.file_path != file_path || offset as usize != asset.bytes.len() ||
                asset.bytes.len().saturating_add(bytes.len()) > asset.byte_length {
                state.incoming = None;
                return Err(fail("model_unavailable", "IPADIC asset chunk path, offset or length is invalid"));
            }
            asset.bytes.extend_from_slice(&bytes);
            Ok(())
        })
    }

    fn finish_asset(group_id: String, file_path: String) -> Result<(), String> {
        if group_id != GROUP_ID { return Err(fail("capability_denied", "asset group is not declared by Research")); }
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let Some(asset) = state.incoming.take() else { return Err(fail("model_unavailable", "IPADIC asset transfer was not started")); };
            if asset.file_path != file_path || asset.bytes.len() != asset.byte_length || digest(&asset.bytes) != asset.sha256 {
                return Err(fail("model_unavailable", "IPADIC asset bytes differ from the pinned signed release"));
            }
            state.assets.insert(asset.file_path.to_string(), asset.bytes);
            Ok(())
        })
    }

    fn load_tokenizer() -> Result<(), String> {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            if state.tokenizer.is_some() { return Ok(()); }
            let tokenizer = build_tokenizer(&state.assets)?;
            state.assets.clear();
            state.tokenizer = Some(tokenizer);
            Ok(())
        })
    }

    fn tokenize(text: String) -> Result<Vec<EngineToken>, String> {
        if text.len() > MAX_ANALYSIS_TEXT_BYTES { return Err(fail("capacity", "analysis text exceeds 64 KiB UTF-8")); }
        STATE.with(|state| {
            let state = state.borrow();
            let tokenizer = state.tokenizer.as_ref().ok_or_else(|| fail("provider_unavailable", "the consented IPADIC tokenizer is not loaded"))?;
            let tokens = tokenizer.tokenize(&text).map_err(|error| fail("model_unavailable", format!("Lindera tokenization failed: {error}")))?;
            let mut output = Vec::with_capacity(tokens.len());
            for mut token in tokens {
                let byte_start = u32::try_from(token.byte_start).map_err(|_| fail("capacity", "token byte offset exceeds u32"))?;
                let byte_end = u32::try_from(token.byte_end).map_err(|_| fail("capacity", "token byte offset exceeds u32"))?;
                output.push(EngineToken {
                    surface: token.surface.to_string(),
                    details: token.details().into_iter().map(str::to_string).collect(),
                    byte_start,
                    byte_end,
                });
            }
            Ok(output)
        })
    }

    fn count_tokens(text: String) -> Result<u32, String> {
        if text.len() > MAX_ANALYSIS_TEXT_BYTES { return Err(fail("capacity", "token-count text exceeds 64 KiB UTF-8")); }
        STATE.with(|state| {
            let state = state.borrow();
            let tokenizer = state.tokenizer.as_ref().ok_or_else(|| fail("provider_unavailable", "the consented IPADIC tokenizer is not loaded"))?;
            let count = tokenizer.tokenize(&text).map_err(|error| fail("model_unavailable", format!("Lindera token counting failed: {error}")))?.len();
            u32::try_from(count).map_err(|_| fail("capacity", "token count exceeds u32"))
        })
    }

    fn release() {
        STATE.with(|state| *state.borrow_mut() = MorphologyState::default());
    }
}

bindings::export!(Component with_types_in bindings);

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn pinned_ipadic_201_tokenizes_with_lindera_201() {
        let directory = PathBuf::from(std::env::var("PROPRIUM_RESEARCH_IPADIC_TEST_DIR")
            .expect("set PROPRIUM_RESEARCH_IPADIC_TEST_DIR to the extracted Lindera v2.0.1 IPADIC directory"));
        let mut assets = BTreeMap::new();
        for (path, expected_bytes, expected_sha256) in EXPECTED_ASSETS {
            let relative = path.strip_prefix("lindera-ipadic/").unwrap();
            let bytes = std::fs::read(directory.join(relative)).expect("read pinned IPADIC test asset");
            assert_eq!(bytes.len(), *expected_bytes, "{relative} byte length");
            assert_eq!(digest(&bytes), *expected_sha256, "{relative} SHA-256");
            assets.insert((*path).to_string(), bytes);
        }
        let tokenizer = build_tokenizer(&assets).expect("load pinned IPADIC bytes without a filesystem loader");
        let tokens = tokenizer.tokenize("東京スカイツリーに行きました。🎐").expect("tokenize Japanese text");
        let surfaces: Vec<String> = tokens.iter().map(|token| token.surface.to_string()).collect();
        assert_eq!(surfaces, ["東京", "スカイ", "ツリー", "に", "行き", "まし", "た", "。", "🎐"]);
        assert_eq!(tokens.first().unwrap().byte_start, 0);
        assert_eq!(tokens.last().unwrap().surface, "🎐");
        assert_eq!(tokens.last().unwrap().byte_end, "東京スカイツリーに行きました。🎐".len());
    }
}
