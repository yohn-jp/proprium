#[allow(warnings)]
mod bindings;
use bindings::exports::proprium::plugin::sentence_segmentation::Guest;
use unicode_segmentation::UnicodeSegmentation;

struct Component;
impl Guest for Component {
    fn split_sentence_ends(text: String) -> Vec<u32> {
        let mut offset = 0u32;
        text.split_sentence_bounds().map(|sentence| {
            offset += sentence.encode_utf16().count() as u32;
            offset
        }).collect()
    }
}
bindings::export!(Component with_types_in bindings);
