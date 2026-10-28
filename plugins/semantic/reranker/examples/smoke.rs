use proprium_semantic_reranker::Reranker;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Instant;

const GRAPH_SHA256: &str = "ed283424d9a40dbd6fe2f3081386848a88cc8057b7ab43e02d84077d6b69ba42";
const DATA_SHA256: &str = "9a748c82efb2079d24650c489e053dbb3c71d8acbbcf04d7b2340db66f2748f7";
const TOKENIZER_SHA256: &str = "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3";
const DATA_BYTES: u64 = 2_271_088_656;
const TOKENIZER_BYTES: u64 = 17_082_900;
const CHUNK_BYTES: usize = 256 * 1024;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err(
            "usage: cargo run --release --example smoke -- GRAPH DATA TOKENIZER MODEL_DIR".into(),
        );
    }
    let graph_path = Path::new(&args[0]);
    let data_path = Path::new(&args[1]);
    let tokenizer_path = Path::new(&args[2]);
    let model_dir = &args[3];
    let start = Instant::now();
    let mut engine = Reranker::new();
    let graph = fs::read(graph_path)?;
    let graph_digest = format!("{:x}", Sha256::digest(&graph));
    if graph_digest != GRAPH_SHA256 {
        return Err("graph digest mismatch".into());
    }
    let ranges = engine.inspect_graph(&graph, &graph_digest)?;
    println!(
        "graph_bytes={} external_tensors={}",
        graph.len(),
        ranges.len()
    );
    print_memory("graph");

    let data_size = fs::metadata(data_path)?.len();
    if data_size != DATA_BYTES {
        return Err(format!("external data size mismatch: {data_size}").into());
    }
    engine.begin_data(data_size as u32, DATA_SHA256)?;
    let mut data_file = File::open(data_path)?;
    for (index, _name, offset, bytes) in &ranges {
        engine.begin_tensor(*index)?;
        data_file.seek(SeekFrom::Start(*offset as u64))?;
        let mut tensor_offset = 0usize;
        let mut chunk = Vec::new();
        while tensor_offset < *bytes as usize {
            let count = (*bytes as usize - tensor_offset).min(CHUNK_BYTES);
            chunk.resize(count, 0);
            data_file.read_exact(&mut chunk)?;
            engine.append_tensor(*index, tensor_offset as u32, &chunk)?;
            tensor_offset += count;
        }
        engine.finish_tensor(*index)?;
    }
    engine.finish_data()?;
    println!(
        "external_data_sha256=verified streamed_bytes={} elapsed={:?}",
        data_size,
        start.elapsed()
    );
    print_memory("data");

    let tokenizer_size = fs::metadata(tokenizer_path)?.len();
    if tokenizer_size != TOKENIZER_BYTES {
        return Err(format!("tokenizer size mismatch: {tokenizer_size}").into());
    }
    engine.begin_tokenizer(tokenizer_size as u32, TOKENIZER_SHA256)?;
    let mut tokenizer_file = File::open(tokenizer_path)?;
    let mut offset = 0usize;
    let mut chunk = Vec::new();
    while offset < tokenizer_size as usize {
        let count = (tokenizer_size as usize - offset).min(CHUNK_BYTES);
        chunk.resize(count, 0);
        tokenizer_file.read_exact(&mut chunk)?;
        engine.append_tokenizer(offset as u32, &chunk)?;
        offset += count;
    }
    engine.finish_tokenizer()?;
    let model_start = Instant::now();
    engine.load_model(model_dir)?;
    println!(
        "model_loaded elapsed={:?} total_elapsed={:?}",
        model_start.elapsed(),
        start.elapsed()
    );
    print_memory("model");

    let query = "Where is the Eiffel Tower located?";
    let positive = engine.score_pair(query, "The Eiffel Tower is in Paris, France.")?;
    let negative = engine.score_pair(query, "Berlin is the capital of Germany.")?;
    let repeated = engine.score_pair(query, "The Eiffel Tower is in Paris, France.")?;
    println!("positive={positive:.8} negative={negative:.8} repeated={repeated:.8}");
    if positive <= negative || (positive - repeated).abs() > 1e-6 {
        return Err("reranker ranking or repeatability check failed".into());
    }
    print_memory("scored");
    Ok(())
}

fn print_memory(stage: &str) {
    let Ok(status) = fs::read_to_string("/proc/self/status") else {
        return;
    };
    let rss = status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .unwrap_or("VmRSS: unavailable");
    let high_water = status
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .unwrap_or("VmHWM: unavailable");
    println!("memory stage={stage} {rss} {high_water}");
}
