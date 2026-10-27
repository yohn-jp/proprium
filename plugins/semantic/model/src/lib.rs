#[allow(warnings)]
mod bindings;

use bindings::exports::proprium::plugin::inference::Guest;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::io::Cursor;
use std::sync::Arc;
use tokenizers::Tokenizer;
use unicode_segmentation::UnicodeSegmentation;
use tract_onnx::prelude::*;

const GROUP_ID: &str = "proprium.semantic.embedding.e5-small";
const MODEL_PATH: &str = "proprium/semantic/embedding/e5-small/onnx/model.onnx";
const MODEL_BYTES: u32 = 470_268_533;
const MODEL_SHA256: &str = "4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff";
const TOKENIZER_PATH: &str = "proprium/semantic/embedding/e5-small/tokenizer.json";
const TOKENIZER_BYTES: u32 = 17_082_730;
const TOKENIZER_SHA256: &str = "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39";
const EMBEDDING_DIMENSIONS: usize = 384;
const MAX_SEQUENCE_LENGTH: usize = 512;
const MAX_BATCH: usize = 32;
const MAX_TEXT_BYTES: usize = 32 * 1024;

struct IncomingAsset {
    file_path: &'static str,
    byte_length: u32,
    sha256: &'static str,
    bytes: Vec<u8>,
}

impl IncomingAsset {
    fn new(file_path: &'static str, byte_length: u32, sha256: &'static str) -> Result<Self, String> {
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(byte_length as usize).map_err(|_| "capacity: unable to reserve model asset memory".to_string())?;
        Ok(Self { file_path, byte_length, sha256, bytes })
    }
}

struct InferenceState {
    model_asset: Option<IncomingAsset>,
    tokenizer_asset: Option<IncomingAsset>,
    model: Option<Arc<TypedRunnableModel>>,
    tokenizer: Option<Tokenizer>,
    input_count: usize,
    input_ids_slot: usize,
    attention_mask_slot: Option<usize>,
    token_type_ids_slot: Option<usize>,
    hidden_output_slot: usize,
}

impl Default for InferenceState {
    fn default() -> Self {
        Self {
            model_asset: None,
            tokenizer_asset: None,
            model: None,
            tokenizer: None,
            input_count: 0,
            input_ids_slot: 0,
            attention_mask_slot: None,
            token_type_ids_slot: None,
            hidden_output_slot: 0,
        }
    }
}

thread_local! {
    static STATE: RefCell<InferenceState> = RefCell::new(InferenceState::default());
}

fn expected_asset(file_path: &str) -> Result<(&'static str, u32, &'static str), String> {
    match file_path {
        MODEL_PATH => Ok((MODEL_PATH, MODEL_BYTES, MODEL_SHA256)),
        TOKENIZER_PATH => Ok((TOKENIZER_PATH, TOKENIZER_BYTES, TOKENIZER_SHA256)),
        _ => Err("model_unavailable: asset path is not part of the pinned E5 release".to_string()),
    }
}

fn finish_asset(state: &mut InferenceState, file_path: &str) -> Result<(), String> {
    let slot = match file_path {
        MODEL_PATH => &mut state.model_asset,
        TOKENIZER_PATH => &mut state.tokenizer_asset,
        _ => return Err("model_unavailable: asset path is not part of the pinned E5 release".to_string()),
    };
    let asset = slot.as_ref().ok_or_else(|| "model_unavailable: asset transfer was not started".to_string())?;
    if asset.file_path != file_path {
        return Err("model_unavailable: model asset path changed during transfer".to_string());
    }
    if asset.bytes.len() != asset.byte_length as usize {
        return Err("model_unavailable: model asset transfer is incomplete".to_string());
    }
    let digest = format!("{:x}", Sha256::digest(&asset.bytes));
    if digest != asset.sha256 {
        *slot = None;
        return Err("model_unavailable: model asset digest does not match the signed release".to_string());
    }
    Ok(())
}

fn load_model(state: &mut InferenceState) -> Result<(), String> {
    let model_asset = state.model_asset.take().ok_or_else(|| "provider_unavailable: the E5 model asset has not been admitted".to_string())?;
    let tokenizer_asset = state.tokenizer_asset.take().ok_or_else(|| "provider_unavailable: the E5 tokenizer asset has not been admitted".to_string())?;
    if model_asset.bytes.len() != MODEL_BYTES as usize || tokenizer_asset.bytes.len() != TOKENIZER_BYTES as usize {
        return Err("model_unavailable: model asset size is incomplete".to_string());
    }
    if format!("{:x}", Sha256::digest(&model_asset.bytes)) != MODEL_SHA256 ||
        format!("{:x}", Sha256::digest(&tokenizer_asset.bytes)) != TOKENIZER_SHA256 {
        return Err("model_unavailable: model asset digest does not match the signed release".to_string());
    }

    let mut tokenizer = Tokenizer::from_bytes(tokenizer_asset.bytes.as_slice())
        .map_err(|error| format!("model_unavailable: E5 tokenizer could not be loaded: {error}"))?;
    tokenizer.with_truncation(Some(tokenizers::utils::truncation::TruncationParams {
        max_length: MAX_SEQUENCE_LENGTH,
        ..Default::default()
    })).map_err(|error| format!("model_unavailable: E5 tokenizer truncation could not be configured: {error}"))?;

    let mut model = tract_onnx::onnx()
        .model_for_read(&mut Cursor::new(model_asset.bytes))
        .map_err(|error| format!("model_unavailable: E5 ONNX model could not be parsed: {error}"))?;

    // The pinned Xenova graph exposes these exact semantic input/output names.
    // Do not guess positional tensor order: validate the graph before running.
    let inputs = model.input_outlets().map_err(|error| format!("model_unavailable: E5 input graph is invalid: {error}"))?.to_vec();
    let mut input_ids_slot = None;
    let mut attention_mask_slot = None;
    let mut token_type_ids_slot = None;
    for (slot, outlet) in inputs.iter().enumerate() {
        let name = model.outlet_label(*outlet).unwrap_or_else(|| model.node(outlet.node).name.as_str());
        match name {
            "input_ids" => input_ids_slot = Some(slot),
            "attention_mask" => attention_mask_slot = Some(slot),
            "token_type_ids" => token_type_ids_slot = Some(slot),
            _ => return Err(format!("model_unavailable: unsupported E5 input `{name}`")),
        }
    }
    let input_ids_slot = input_ids_slot.ok_or_else(|| "model_unavailable: E5 input_ids tensor is missing".to_string())?;
    let output_outlets = model.output_outlets().map_err(|error| format!("model_unavailable: E5 output graph is invalid: {error}"))?.to_vec();
    let hidden_output_slot = output_outlets.iter().position(|outlet| {
        let name = model.outlet_label(*outlet).unwrap_or_else(|| model.node(outlet.node).name.as_str());
        name.contains("last_hidden_state") || name.contains("token_embeddings")
    }).unwrap_or(0);
    model.select_output_outlets(&[output_outlets[hidden_output_slot]])
        .map_err(|error| format!("model_unavailable: E5 hidden-state output is invalid: {error}"))?;
    let runnable = model
        .into_optimized()
        .and_then(|model| model.into_runnable())
        .map_err(|error| format!("model_unavailable: E5 ONNX model could not be prepared: {error}"))?;

    state.input_count = inputs.len();
    state.model = Some(runnable);
    state.tokenizer = Some(tokenizer);
    state.input_ids_slot = input_ids_slot;
    state.attention_mask_slot = attention_mask_slot;
    state.token_type_ids_slot = token_type_ids_slot;
    state.hidden_output_slot = hidden_output_slot;
    Ok(())
}

fn encode_and_embed(state: &mut InferenceState, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    if texts.len() > MAX_BATCH || texts.iter().any(|text| text.len() > MAX_TEXT_BYTES) {
        return Err("capacity: E5 batch exceeds the supported bounds".to_string());
    }
    let tokenizer = state.tokenizer.as_ref().ok_or_else(|| "provider_unavailable: E5 is not loaded".to_string())?;
    let encodings = texts.iter().map(|text| {
        let input = format!("passage: {text}");
        tokenizer.encode(input, true).map_err(|error| format!("invalid_input: E5 tokenization failed: {error}"))
    }).collect::<Result<Vec<_>, _>>()?;
    if encodings.is_empty() { return Ok(Vec::new()); }
    let sequence_length = encodings.iter().map(|encoding| encoding.get_ids().len()).max().unwrap_or(0);
    if sequence_length == 0 || sequence_length > MAX_SEQUENCE_LENGTH {
        return Err("model_unavailable: E5 tokenizer produced an unsupported sequence length".to_string());
    }

    let mut ids = Vec::with_capacity(encodings.len() * sequence_length);
    let mut masks = Vec::with_capacity(encodings.len() * sequence_length);
    let mut types = Vec::with_capacity(encodings.len() * sequence_length);
    for encoding in &encodings {
        let padding = sequence_length - encoding.get_ids().len();
        ids.extend(encoding.get_ids().iter().map(|id| *id as i64));
        masks.extend(encoding.get_attention_mask().iter().map(|mask| *mask as i64));
        types.extend(encoding.get_type_ids().iter().map(|type_id| *type_id as i64));
        ids.extend(std::iter::repeat(0).take(padding));
        masks.extend(std::iter::repeat(0).take(padding));
        types.extend(std::iter::repeat(0).take(padding));
    }

    let input_count = state.input_count;
    let mut inputs = (0..input_count)
        .map(|_| Tensor::zero::<i64>(&[encodings.len(), sequence_length]))
        .collect::<TractResult<Vec<_>>>()
        .map_err(|error| format!("capacity: unable to allocate E5 input tensors: {error}"))?;
    inputs[state.input_ids_slot] = Tensor::from_shape(&[encodings.len(), sequence_length], &ids)
        .map_err(|error| format!("model_unavailable: invalid E5 input tensor: {error}"))?;
    if let Some(slot) = state.attention_mask_slot {
        inputs[slot] = Tensor::from_shape(&[encodings.len(), sequence_length], &masks)
            .map_err(|error| format!("model_unavailable: invalid E5 attention mask: {error}"))?;
    }
    if let Some(slot) = state.token_type_ids_slot {
        inputs[slot] = Tensor::from_shape(&[encodings.len(), sequence_length], &types)
            .map_err(|error| format!("model_unavailable: invalid E5 token type IDs: {error}"))?;
    }

    let input_values: TVec<TValue> = inputs.into_iter().map(Into::into).collect();
    let outputs = state.model.as_ref().unwrap().run(input_values)
        .map_err(|error| format!("model_unavailable: E5 inference failed: {error}"))?;
    let hidden = outputs.get(0).ok_or_else(|| "model_unavailable: E5 produced no hidden-state output".to_string())?;
    let hidden = hidden.to_plain_array_view::<f32>()
        .map_err(|error| format!("model_unavailable: E5 output is not f32: {error}"))?;
    if hidden.ndim() != 3 || hidden.shape()[0] != encodings.len() || hidden.shape()[1] != sequence_length || hidden.shape()[2] != EMBEDDING_DIMENSIONS {
        return Err(format!("model_unavailable: unexpected E5 output shape {:?}", hidden.shape()));
    }

    let mut vectors = Vec::with_capacity(encodings.len());
    for (batch_index, encoding) in encodings.iter().enumerate() {
        let mut vector = vec![0f32; EMBEDDING_DIMENSIONS];
        let mut token_count = 0f32;
        for token_index in 0..encoding.get_attention_mask().len() {
            if encoding.get_attention_mask()[token_index] == 0 { continue; }
            token_count += 1.0;
            for dimension in 0..EMBEDDING_DIMENSIONS {
                vector[dimension] += hidden[[batch_index, token_index, dimension]];
            }
        }
        if token_count == 0.0 { return Err("model_unavailable: E5 output had no non-padding tokens".to_string()); }
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
        if !norm.is_finite() || norm == 0.0 { return Err("model_unavailable: E5 produced a zero or non-finite embedding".to_string()); }
        for value in &mut vector { *value /= norm; }
        vectors.push(vector);
    }
    Ok(vectors)
}

struct Component;

impl Guest for Component {
    fn begin_asset(group_id: String, file_path: String, total_bytes: u32, sha256: String) -> Result<(), String> {
        if group_id != GROUP_ID { return Err("capability_denied: asset group is not declared by Semantic".to_string()); }
        let (path, bytes, digest) = expected_asset(&file_path)?;
        if total_bytes != bytes || sha256 != digest {
            return Err("model_unavailable: signed asset metadata differs from the pinned E5 model release".to_string());
        }
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            if state.model.is_some() { return Err("model_unavailable: E5 model is already loaded".to_string()); }
            let asset = IncomingAsset::new(path, bytes, digest)?;
            match path {
                MODEL_PATH => state.model_asset = Some(asset),
                TOKENIZER_PATH => state.tokenizer_asset = Some(asset),
                _ => return Err("model_unavailable: unsupported E5 asset".to_string()),
            }
            Ok(())
        })
    }

    fn append_asset(group_id: String, file_path: String, offset: u32, bytes: Vec<u8>) -> Result<(), String> {
        if group_id != GROUP_ID { return Err("capability_denied: asset group is not declared by Semantic".to_string()); }
        if bytes.is_empty() || bytes.len() > 256 * 1024 { return Err("capacity: asset chunk must contain 1 to 262144 bytes".to_string()); }
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let slot = match file_path.as_str() {
                MODEL_PATH => &mut state.model_asset,
                TOKENIZER_PATH => &mut state.tokenizer_asset,
                _ => return Err("model_unavailable: asset path is not part of the pinned E5 release".to_string()),
            };
            let asset = slot.as_mut().ok_or_else(|| "model_unavailable: asset transfer was not started".to_string())?;
            if offset as usize != asset.bytes.len() || offset as usize + bytes.len() > asset.byte_length as usize {
                *slot = None;
                return Err("model_unavailable: asset chunk offset or length is invalid".to_string());
            }
            asset.bytes.extend_from_slice(&bytes);
            Ok(())
        })
    }

    fn finish_asset(group_id: String, file_path: String) -> Result<(), String> {
        if group_id != GROUP_ID { return Err("capability_denied: asset group is not declared by Semantic".to_string()); }
        STATE.with(|state| finish_asset(&mut state.borrow_mut(), &file_path))
    }

    fn load_embedding() -> Result<(), String> {
        STATE.with(|state| load_model(&mut state.borrow_mut()))
    }

    fn embed_passages(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        STATE.with(|state| encode_and_embed(&mut state.borrow_mut(), texts))
    }

    fn split_sentence_ends(text: String) -> Vec<u32> {
        let mut offset = 0u32;
        text.split_sentence_bounds().map(|sentence| {
            offset += sentence.encode_utf16().count() as u32;
            offset
        }).collect()
    }

    fn release() {
        STATE.with(|state| *state.borrow_mut() = InferenceState::default());
    }
}

bindings::export!(Component with_types_in bindings);
