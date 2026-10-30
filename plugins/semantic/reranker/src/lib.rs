#[allow(warnings)]
mod bindings;

use bindings::exports::proprium::semantic_reranker::inference::{Guest, TensorRange};
use prost::Message;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokenizers::tokenizer::TruncationParams;
use tokenizers::Tokenizer;
use tract_onnx::data_resolver::ModelDataResolver;
use tract_onnx::pb::{
    tensor_proto, GraphProto, ModelProto, NodeProto, SparseTensorProto, TensorProto,
};
use tract_onnx::prelude::*;

const MODEL_ID: &str = "mogolloni/bge-reranker-v2-m3-onnx";
const MODEL_REVISION: &str = "e5023553f6c47f09057da7a19cdd79ef850a4985";
const MODEL_GRAPH_BYTES: usize = 489_245;
const MODEL_GRAPH_SHA256: &str = "ed283424d9a40dbd6fe2f3081386848a88cc8057b7ab43e02d84077d6b69ba42";
const MODEL_DATA_PATH: &str = "model.onnx_data";
const MODEL_DATA_BYTES: usize = 2_271_088_656;
const MODEL_DATA_SHA256: &str = "9a748c82efb2079d24650c489e053dbb3c71d8acbbcf04d7b2340db66f2748f7";
const MODEL_DATA_TENSOR_BYTES: usize = MODEL_DATA_BYTES;
const TOKENIZER_BYTES: usize = 17_082_900;
const TOKENIZER_SHA256: &str = "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3";
const MAX_SEQUENCE_LENGTH: usize = 512;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_RPC_CHUNK_BYTES: usize = 256 * 1024;
const EXPECTED_EXTERNAL_TENSORS: usize = 393;

#[derive(Clone, Debug)]
struct ExternalTensor {
    index: u32,
    name: String,
    offset: u32,
    bytes: u32,
}

struct IncomingBuffer {
    index: u32,
    expected_bytes: usize,
    bytes: Vec<u8>,
}

struct RangeTensorResolver {
    buffers: Mutex<HashMap<(usize, usize), Vec<u8>>>,
}

impl RangeTensorResolver {
    fn new(buffers: HashMap<(usize, usize), Vec<u8>>) -> Self {
        Self {
            buffers: Mutex::new(buffers),
        }
    }

    fn remaining(&self) -> Result<usize, String> {
        self.buffers
            .lock()
            .map(|buffers| buffers.len())
            .map_err(|_| "model_unavailable: external tensor buffer lock is poisoned".to_string())
    }
}

impl ModelDataResolver for RangeTensorResolver {
    fn read_bytes_from_path(
        &self,
        buffer: &mut Vec<u8>,
        path: &Path,
        offset: usize,
        length: Option<usize>,
    ) -> TractResult<()> {
        if path.file_name().and_then(|name| name.to_str()) != Some(MODEL_DATA_PATH) {
            anyhow::bail!("external data path does not name the pinned BGE data file");
        }
        if !buffer.is_empty() {
            anyhow::bail!("tract requested external data into a non-empty buffer");
        }
        let length =
            length.ok_or_else(|| anyhow::anyhow!("external tensor has no pinned length"))?;
        let mut buffers = self
            .buffers
            .lock()
            .map_err(|_| anyhow::anyhow!("external tensor buffer lock is poisoned"))?;
        let mut bytes = buffers.remove(&(offset, length)).ok_or_else(|| {
            anyhow::anyhow!(
                "external tensor range {offset}..{} is missing or already consumed",
                offset.saturating_add(length)
            )
        })?;
        if bytes.len() != length {
            anyhow::bail!("external tensor range has the wrong length");
        }
        // Transfer ownership into tract's scratch Vec. load_tensor copies once
        // into aligned Tensor storage and then drops this raw buffer.
        std::mem::swap(buffer, &mut bytes);
        Ok(())
    }
}

pub struct Reranker {
    graph: Option<ModelProto>,
    ranges: Vec<ExternalTensor>,
    raw_tensors: HashMap<(usize, usize), Vec<u8>>,
    next_tensor_index: usize,
    incoming_tensor: Option<IncomingBuffer>,
    data_hasher: Option<Sha256>,
    data_verified: bool,
    tokenizer_hasher: Option<Sha256>,
    tokenizer_bytes: usize,
    incoming_tokenizer: Vec<u8>,
    tokenizer: Option<Tokenizer>,
    model: Option<Arc<TypedRunnableModel>>,
}

impl Default for Reranker {
    fn default() -> Self {
        Self {
            graph: None,
            ranges: Vec::new(),
            raw_tensors: HashMap::new(),
            next_tensor_index: 0,
            incoming_tensor: None,
            data_hasher: None,
            data_verified: false,
            tokenizer_hasher: None,
            tokenizer_bytes: 0,
            incoming_tokenizer: Vec::new(),
            tokenizer: None,
            model: None,
        }
    }
}

impl Reranker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn inspect_graph(
        &mut self,
        bytes: &[u8],
        claimed_sha256: &str,
    ) -> Result<Vec<(u32, String, u32, u32)>, String> {
        if self.graph.is_some() || self.model.is_some() {
            return Err("invalid_input: reranker graph is already initialized".into());
        }
        if bytes.len() != MODEL_GRAPH_BYTES
            || claimed_sha256 != MODEL_GRAPH_SHA256
            || digest_hex(bytes) != MODEL_GRAPH_SHA256
        {
            return Err(
                "model_unavailable: graph bytes do not match the pinned fp32 BGE model".into(),
            );
        }
        let proto = ModelProto::decode(bytes)
            .map_err(|error| format!("model_unavailable: pinned ONNX graph is invalid: {error}"))?;
        let graph = proto
            .graph
            .as_ref()
            .ok_or_else(|| "model_unavailable: pinned ONNX graph has no graph body".to_string())?;
        validate_model_interface(graph)?;

        let mut ranges = Vec::new();
        collect_graph_external_tensors(graph, &mut ranges)?;
        ranges.sort_by_key(|range| range.0);
        if ranges.len() != EXPECTED_EXTERNAL_TENSORS {
            return Err(format!("model_unavailable: expected {EXPECTED_EXTERNAL_TENSORS} external tensors, found {}", ranges.len()));
        }
        let mut next_offset = 0usize;
        let mut descriptors = Vec::with_capacity(ranges.len());
        for (index, (offset, bytes, name)) in ranges.into_iter().enumerate() {
            if offset as usize != next_offset {
                return Err(
                    "model_unavailable: external tensor ranges contain a gap or overlap".into(),
                );
            }
            next_offset = next_offset.checked_add(bytes as usize).ok_or_else(|| {
                "capacity: external tensor range overflows address space".to_string()
            })?;
            descriptors.push(ExternalTensor {
                index: u32::try_from(index)
                    .map_err(|_| "capacity: too many external tensors".to_string())?,
                name,
                offset,
                bytes,
            });
        }
        if next_offset != MODEL_DATA_TENSOR_BYTES {
            return Err(
                "model_unavailable: external tensor ranges do not match the pinned data layout"
                    .into(),
            );
        }

        self.ranges = descriptors;
        self.graph = Some(proto);
        Ok(self
            .ranges
            .iter()
            .map(|range| (range.index, range.name.clone(), range.offset, range.bytes))
            .collect())
    }

    pub fn begin_data(&mut self, total_bytes: u32, sha256: &str) -> Result<(), String> {
        if self.graph.is_none() || self.data_hasher.is_some() || self.data_verified {
            return Err("invalid_input: reranker data transfer is not ready".into());
        }
        if total_bytes as usize != MODEL_DATA_BYTES || sha256 != MODEL_DATA_SHA256 {
            return Err(
                "model_unavailable: external data metadata does not match the pinned BGE model"
                    .into(),
            );
        }
        self.raw_tensors.clear();
        self.raw_tensors
            .try_reserve(self.ranges.len())
            .map_err(|_| "capacity: unable to reserve external tensor map".to_string())?;
        self.data_hasher = Some(Sha256::new());
        self.next_tensor_index = 0;
        Ok(())
    }

    pub fn begin_tensor(&mut self, index: u32) -> Result<(), String> {
        if self.data_hasher.is_none() || self.incoming_tensor.is_some() {
            return Err("invalid_input: external tensor transfer is not ready".into());
        }
        let expected = self.ranges.get(self.next_tensor_index).ok_or_else(|| {
            "invalid_input: all external tensors have already been received".to_string()
        })?;
        if expected.index != index {
            return Err("invalid_input: external tensors must be sent in signed file order".into());
        }
        let expected_bytes = expected.bytes as usize;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(expected_bytes).map_err(|_| {
            "capacity: unable to reserve memory for the next BGE tensor".to_string()
        })?;
        self.incoming_tensor = Some(IncomingBuffer {
            index,
            expected_bytes,
            bytes,
        });
        Ok(())
    }

    pub fn append_tensor(&mut self, index: u32, offset: u32, chunk: &[u8]) -> Result<(), String> {
        if chunk.is_empty() || chunk.len() > MAX_RPC_CHUNK_BYTES {
            return Err("capacity: tensor chunk must contain 1 to 262144 bytes".into());
        }
        let incoming = self
            .incoming_tensor
            .as_mut()
            .ok_or_else(|| "invalid_input: no external tensor transfer is active".to_string())?;
        if incoming.index != index
            || offset as usize != incoming.bytes.len()
            || offset as usize + chunk.len() > incoming.expected_bytes
        {
            self.incoming_tensor = None;
            return Err(
                "model_unavailable: external tensor chunk offset or length is invalid".into(),
            );
        }
        self.data_hasher
            .as_mut()
            .ok_or_else(|| "invalid_input: external data transfer was not started".to_string())?
            .update(chunk);
        incoming.bytes.extend_from_slice(chunk);
        Ok(())
    }

    pub fn finish_tensor(&mut self, index: u32) -> Result<(), String> {
        let incoming = self
            .incoming_tensor
            .take()
            .ok_or_else(|| "invalid_input: no external tensor transfer is active".to_string())?;
        if incoming.index != index || incoming.bytes.len() != incoming.expected_bytes {
            return Err("model_unavailable: external tensor transfer is incomplete".into());
        }
        let range = self
            .ranges
            .get(self.next_tensor_index)
            .ok_or_else(|| "invalid_input: external tensor index is out of range".to_string())?;
        self.raw_tensors.insert(
            (range.offset as usize, range.bytes as usize),
            incoming.bytes,
        );
        self.next_tensor_index += 1;
        Ok(())
    }

    pub fn finish_data(&mut self) -> Result<(), String> {
        if self.next_tensor_index != self.ranges.len() || self.incoming_tensor.is_some() {
            return Err("model_unavailable: external data transfer is incomplete".into());
        }
        let hasher = self
            .data_hasher
            .take()
            .ok_or_else(|| "invalid_input: external data transfer was not started".to_string())?;
        let digest = format!("{:x}", hasher.finalize());
        if digest != MODEL_DATA_SHA256 {
            self.raw_tensors.clear();
            return Err(
                "model_unavailable: external data digest does not match the pinned BGE model"
                    .into(),
            );
        }
        if self.raw_tensors.len() != self.ranges.len() {
            return Err("model_unavailable: an external tensor range is missing".into());
        }
        self.data_verified = true;
        Ok(())
    }

    pub fn begin_tokenizer(&mut self, total_bytes: u32, sha256: &str) -> Result<(), String> {
        if !self.data_verified || self.tokenizer_hasher.is_some() || self.tokenizer.is_some() {
            return Err("invalid_input: tokenizer transfer is not ready".into());
        }
        if total_bytes as usize != TOKENIZER_BYTES || sha256 != TOKENIZER_SHA256 {
            return Err(
                "model_unavailable: tokenizer metadata does not match the pinned BGE model".into(),
            );
        }
        self.incoming_tokenizer = Vec::new();
        self.incoming_tokenizer
            .try_reserve_exact(TOKENIZER_BYTES)
            .map_err(|_| "capacity: unable to reserve tokenizer memory".to_string())?;
        self.tokenizer_bytes = TOKENIZER_BYTES;
        self.tokenizer_hasher = Some(Sha256::new());
        Ok(())
    }

    pub fn append_tokenizer(&mut self, offset: u32, chunk: &[u8]) -> Result<(), String> {
        if chunk.is_empty() || chunk.len() > MAX_RPC_CHUNK_BYTES {
            return Err("capacity: tokenizer chunk must contain 1 to 262144 bytes".into());
        }
        if offset as usize != self.incoming_tokenizer.len()
            || offset as usize + chunk.len() > self.tokenizer_bytes
        {
            self.incoming_tokenizer.clear();
            self.tokenizer_hasher = None;
            return Err("model_unavailable: tokenizer chunk offset or length is invalid".into());
        }
        self.tokenizer_hasher
            .as_mut()
            .ok_or_else(|| "invalid_input: tokenizer transfer was not started".to_string())?
            .update(chunk);
        self.incoming_tokenizer.extend_from_slice(chunk);
        Ok(())
    }

    pub fn finish_tokenizer(&mut self) -> Result<(), String> {
        if self.incoming_tokenizer.len() != self.tokenizer_bytes {
            return Err("model_unavailable: tokenizer transfer is incomplete".into());
        }
        let hasher = self
            .tokenizer_hasher
            .take()
            .ok_or_else(|| "invalid_input: tokenizer transfer was not started".to_string())?;
        if format!("{:x}", hasher.finalize()) != TOKENIZER_SHA256 {
            self.incoming_tokenizer.clear();
            return Err(
                "model_unavailable: tokenizer digest does not match the pinned BGE model".into(),
            );
        }
        Ok(())
    }

    pub fn load_model(&mut self, model_dir: &str) -> Result<(), String> {
        if !self.data_verified
            || self.incoming_tokenizer.len() != TOKENIZER_BYTES
            || self.model.is_some()
        {
            return Err("provider_unavailable: verified BGE assets are not ready".into());
        }
        let mut tokenizer = Tokenizer::from_bytes(&self.incoming_tokenizer).map_err(|error| {
            format!("model_unavailable: BGE tokenizer could not be loaded: {error}")
        })?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_SEQUENCE_LENGTH,
                ..Default::default()
            }))
            .map_err(|error| {
                format!(
                    "model_unavailable: BGE tokenizer truncation could not be configured: {error}"
                )
            })?;

        let proto = self
            .graph
            .as_ref()
            .ok_or_else(|| "model_unavailable: pinned BGE graph is missing".to_string())?;
        let resolver = Arc::new(RangeTensorResolver::new(std::mem::take(
            &mut self.raw_tensors,
        )));
        let mut onnx = tract_onnx::onnx();
        onnx.provider = resolver.clone();
        let parsed = onnx.parse(proto, Some(model_dir)).map_err(|error| {
            format!("model_unavailable: BGE ONNX graph could not be parsed: {error:#}")
        })?;
        if resolver.remaining()? != 0 {
            return Err(
                "model_unavailable: tract did not consume every pinned external tensor".into(),
            );
        }
        self.graph = None;
        self.incoming_tokenizer.clear();
        self.incoming_tokenizer.shrink_to_fit();
        let runnable = parsed
            .model
            .into_optimized()
            .and_then(|model| model.into_runnable())
            .map_err(|error| {
                format!("model_unavailable: BGE ONNX graph could not be optimized: {error:#}")
            })?;
        self.tokenizer = Some(tokenizer);
        self.model = Some(runnable);
        Ok(())
    }

    pub fn score_pair(&self, query: &str, passage: &str) -> Result<f32, String> {
        if query.len() > MAX_TEXT_BYTES || passage.len() > MAX_TEXT_BYTES {
            return Err("capacity: reranker query or passage exceeds 32768 bytes".into());
        }
        let model = self.model.as_ref().ok_or_else(|| {
            "provider_unavailable: canonical BGE reranker is not loaded".to_string()
        })?;
        let tokenizer = self.tokenizer.as_ref().ok_or_else(|| {
            "provider_unavailable: canonical BGE tokenizer is not loaded".to_string()
        })?;
        let encoding = tokenizer
            .encode((query, passage), true)
            .map_err(|error| format!("invalid_input: BGE pair tokenization failed: {error}"))?;
        let ids = encoding
            .get_ids()
            .iter()
            .map(|id| *id as i64)
            .collect::<Vec<_>>();
        let attention = encoding
            .get_attention_mask()
            .iter()
            .map(|mask| *mask as i64)
            .collect::<Vec<_>>();
        if ids.is_empty() || ids.len() > MAX_SEQUENCE_LENGTH || ids.len() != attention.len() {
            return Err("model_unavailable: BGE tokenizer produced an unsupported sequence".into());
        }
        let input_ids = Tensor::from_shape(&[1, ids.len()], &ids)
            .map_err(|error| format!("capacity: unable to allocate BGE input ids: {error}"))?;
        let attention_mask = Tensor::from_shape(&[1, attention.len()], &attention)
            .map_err(|error| format!("capacity: unable to allocate BGE attention mask: {error}"))?;
        let outputs = model
            .run(tvec!(input_ids.into(), attention_mask.into()))
            .map_err(|error| format!("model_unavailable: BGE inference failed: {error}"))?;
        let logits = outputs
            .first()
            .ok_or_else(|| "model_unavailable: BGE graph produced no logits".to_string())?
            .to_plain_array_view::<f32>()
            .map_err(|error| format!("model_unavailable: BGE logits are not fp32: {error}"))?;
        if logits.shape() != [1, 1] {
            return Err(format!(
                "model_unavailable: unexpected BGE logits shape {:?}",
                logits.shape()
            ));
        }
        let score = logits[[0, 0]];
        if !score.is_finite() {
            return Err("model_unavailable: BGE produced a non-finite relevance score".into());
        }
        Ok(score)
    }

    pub fn release(&mut self) {
        *self = Self::default();
    }
}

fn tensor_external_metadata(tensor: &TensorProto) -> Result<(String, u32, u32), String> {
    let mut location = None;
    let mut offset = None;
    let mut length = None;
    for item in &tensor.external_data {
        match item.key.as_str() {
            "location" => location = Some(item.value.as_str()),
            "offset" => {
                offset =
                    Some(item.value.parse::<u32>().map_err(|_| {
                        "model_unavailable: invalid external tensor offset".to_string()
                    })?)
            }
            "length" => {
                length =
                    Some(item.value.parse::<u32>().map_err(|_| {
                        "model_unavailable: invalid external tensor length".to_string()
                    })?)
            }
            _ => {}
        }
    }
    let location = location.ok_or_else(|| {
        format!(
            "model_unavailable: external tensor {} has no location",
            tensor.name
        )
    })?;
    let offset = offset.ok_or_else(|| {
        format!(
            "model_unavailable: external tensor {} has no offset",
            tensor.name
        )
    })?;
    let length = length.ok_or_else(|| {
        format!(
            "model_unavailable: external tensor {} has no length",
            tensor.name
        )
    })?;
    Ok((location.to_string(), offset, length))
}

fn collect_graph_external_tensors(
    graph: &GraphProto,
    ranges: &mut Vec<(u32, u32, String)>,
) -> Result<(), String> {
    for tensor in &graph.initializer {
        add_external_tensor(tensor, tensor.name.clone(), ranges)?;
    }
    for (index, sparse) in graph.sparse_initializer.iter().enumerate() {
        collect_sparse_external_tensors(sparse, &format!("sparse-initializer-{index}"), ranges)?;
    }
    for node in &graph.node {
        collect_node_external_tensors(node, ranges)?;
    }
    Ok(())
}

fn collect_node_external_tensors(
    node: &NodeProto,
    ranges: &mut Vec<(u32, u32, String)>,
) -> Result<(), String> {
    let node_name = if node.name.is_empty() {
        node.output
            .first()
            .map(String::as_str)
            .unwrap_or(node.op_type.as_str())
    } else {
        node.name.as_str()
    };
    for attribute in &node.attribute {
        let label = format!("{node_name}:{}", attribute.name);
        if let Some(tensor) = &attribute.t {
            let name = if tensor.name.is_empty() {
                label.clone()
            } else {
                tensor.name.clone()
            };
            add_external_tensor(tensor, name, ranges)?;
        }
        for (index, tensor) in attribute.tensors.iter().enumerate() {
            let name = if tensor.name.is_empty() {
                format!("{label}[{index}]")
            } else {
                tensor.name.clone()
            };
            add_external_tensor(tensor, name, ranges)?;
        }
        if let Some(sparse) = &attribute.sparse_tensor {
            collect_sparse_external_tensors(sparse, &label, ranges)?;
        }
        for (index, sparse) in attribute.sparse_tensors.iter().enumerate() {
            collect_sparse_external_tensors(sparse, &format!("{label}[{index}]"), ranges)?;
        }
        if let Some(subgraph) = &attribute.g {
            collect_graph_external_tensors(subgraph, ranges)?;
        }
        for subgraph in &attribute.graphs {
            collect_graph_external_tensors(subgraph, ranges)?;
        }
    }
    Ok(())
}

fn collect_sparse_external_tensors(
    sparse: &SparseTensorProto,
    label: &str,
    ranges: &mut Vec<(u32, u32, String)>,
) -> Result<(), String> {
    if let Some(values) = &sparse.values {
        let name = if values.name.is_empty() {
            format!("{label}:values")
        } else {
            values.name.clone()
        };
        add_external_tensor(values, name, ranges)?;
    }
    if let Some(indices) = &sparse.indices {
        let name = if indices.name.is_empty() {
            format!("{label}:indices")
        } else {
            indices.name.clone()
        };
        add_external_tensor(indices, name, ranges)?;
    }
    Ok(())
}

fn add_external_tensor(
    tensor: &TensorProto,
    name: String,
    ranges: &mut Vec<(u32, u32, String)>,
) -> Result<(), String> {
    if tensor.data_location != Some(tensor_proto::DataLocation::External as i32) {
        return Ok(());
    }
    let (location, offset, bytes) = tensor_external_metadata(tensor)?;
    if location != MODEL_DATA_PATH {
        return Err("model_unavailable: ONNX graph references an unexpected external file".into());
    }
    let data_type = tensor_proto::DataType::try_from(tensor.data_type).map_err(|_| {
        format!("model_unavailable: external tensor {name} has an unknown data type")
    })?;
    let element_bytes = match data_type {
        tensor_proto::DataType::Float => 4,
        tensor_proto::DataType::Int64 => 8,
        _ => {
            return Err(format!(
                "model_unavailable: external tensor {name} has an unsupported data type"
            ))
        }
    };
    let element_count = tensor
        .dims
        .iter()
        .try_fold(1usize, |count, dimension| {
            let dimension = usize::try_from(*dimension).ok()?;
            count.checked_mul(dimension)
        })
        .ok_or_else(|| format!("model_unavailable: invalid tensor shape for {name}"))?;
    if element_count.checked_mul(element_bytes) != Some(bytes as usize) {
        return Err(format!(
            "model_unavailable: external tensor {name} byte length does not match its shape"
        ));
    }
    ranges.push((offset, bytes, name));
    Ok(())
}

fn validate_model_interface(graph: &tract_onnx::pb::GraphProto) -> Result<(), String> {
    let inputs = graph
        .input
        .iter()
        .map(|input| input.name.as_str())
        .collect::<Vec<_>>();
    let outputs = graph
        .output
        .iter()
        .map(|output| output.name.as_str())
        .collect::<Vec<_>>();
    if inputs != ["input_ids", "attention_mask"] || outputs != ["logits"] {
        return Err("model_unavailable: pinned BGE graph input/output contract changed".into());
    }
    Ok(())
}

fn digest_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(target_arch = "wasm32")]
pub fn wasm_linear_memory_bytes() -> u64 {
    (core::arch::wasm32::memory_size(0) as u64) * 65_536
}

#[cfg(not(target_arch = "wasm32"))]
pub fn wasm_linear_memory_bytes() -> u64 {
    0
}

thread_local! { static RERANKER: Mutex<Reranker> = Mutex::new(Reranker::new()); }

struct Component;

impl Guest for Component {
    fn inspect_graph(graph: Vec<u8>, sha256: String) -> Result<Vec<TensorRange>, String> {
        with_reranker(|engine| engine.inspect_graph(&graph, &sha256)).map(|ranges| {
            ranges
                .into_iter()
                .map(|(index, name, offset, bytes)| TensorRange {
                    index,
                    name,
                    offset,
                    bytes,
                })
                .collect()
        })
    }

    fn begin_data(total_bytes: u32, sha256: String) -> Result<(), String> {
        with_reranker(|engine| engine.begin_data(total_bytes, &sha256))
    }

    fn begin_tensor(index: u32) -> Result<(), String> {
        with_reranker(|engine| engine.begin_tensor(index))
    }

    fn append_tensor(index: u32, offset: u32, bytes: Vec<u8>) -> Result<(), String> {
        with_reranker(|engine| engine.append_tensor(index, offset, &bytes))
    }

    fn finish_tensor(index: u32) -> Result<(), String> {
        with_reranker(|engine| engine.finish_tensor(index))
    }

    fn finish_data() -> Result<(), String> {
        with_reranker(Reranker::finish_data)
    }

    fn begin_tokenizer(total_bytes: u32, sha256: String) -> Result<(), String> {
        with_reranker(|engine| engine.begin_tokenizer(total_bytes, &sha256))
    }

    fn append_tokenizer(offset: u32, bytes: Vec<u8>) -> Result<(), String> {
        with_reranker(|engine| engine.append_tokenizer(offset, &bytes))
    }

    fn finish_tokenizer() -> Result<(), String> {
        with_reranker(Reranker::finish_tokenizer)
    }

    fn load_model() -> Result<(), String> {
        with_reranker(|engine| engine.load_model("onnx"))
    }

    fn score_pair(query: String, passage: String) -> Result<f32, String> {
        with_reranker(|engine| engine.score_pair(&query, &passage))
    }

    fn model_id() -> String {
        MODEL_ID.into()
    }

    fn model_revision() -> String {
        MODEL_REVISION.into()
    }

    fn memory_bytes() -> u64 {
        wasm_linear_memory_bytes()
    }

    fn release() {
        let _ = with_reranker(|engine| {
            engine.release();
            Ok(())
        });
    }
}

fn with_reranker<T>(f: impl FnOnce(&mut Reranker) -> Result<T, String>) -> Result<T, String> {
    RERANKER.with(|state| {
        let mut state = state
            .lock()
            .map_err(|_| "guest_trap: reranker state lock is poisoned".to_string())?;
        f(&mut state)
    })
}

#[cfg(target_arch = "wasm32")]
bindings::export!(Component with_types_in bindings);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_moves_the_raw_range_without_copying_it() {
        let bytes = vec![1u8, 2, 3, 4];
        let original_pointer = bytes.as_ptr();
        let resolver = RangeTensorResolver::new(HashMap::from([((10, 4), bytes)]));
        let mut received = Vec::new();

        resolver
            .read_bytes_from_path(
                &mut received,
                Path::new("onnx/model.onnx_data"),
                10,
                Some(4),
            )
            .unwrap();

        assert_eq!(received.as_ptr(), original_pointer);
        assert_eq!(received, [1, 2, 3, 4]);
        assert_eq!(resolver.remaining().unwrap(), 0);
    }

    #[test]
    fn resolver_rejects_an_unpinned_external_file() {
        let resolver = RangeTensorResolver::new(HashMap::new());
        let error = resolver
            .read_bytes_from_path(
                &mut Vec::new(),
                Path::new("onnx/other.onnx_data"),
                0,
                Some(0),
            )
            .unwrap_err();
        assert!(error.to_string().contains("pinned BGE data file"));
    }
}
