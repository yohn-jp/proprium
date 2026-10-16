---
version: aspect-review@1
---

次の章を指定された観点で下読みし、章単位の所見を提案してください。
各所見には根拠となる引用断片（quote）を付けてください。引用できない所見は出さないでください。
chapter_id: {{chapterId}}
chapter_name: {{chapterName}}
観点:
{{aspectLines}}
シーン本文:
{{sceneBlocks}}
JSONのみを返してください。形式: {"findings":[{"aspect":"tempo","finding":"...","quote":"...","sceneId":"..."}]}
