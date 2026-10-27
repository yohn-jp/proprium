import {test} from "node:test";
import assert from "node:assert/strict";
import {renderReaderReactionPrompt} from "../src/reader-reaction.js";
test("reader reaction prompt preserves supplied chapter order and exact summary text",()=>{
 const prompt=renderReaderReactionPrompt("c2",[{chapterId:"c1",summaryLines:["一章"]},{chapterId:"c2",summaryLines:["二章"]}]);
 assert.match(prompt,/いま読んだ章: c2/u);assert.match(prompt,/chapter_id: c1\n- 一章\n\nchapter_id: c2\n- 二章/u);
});
