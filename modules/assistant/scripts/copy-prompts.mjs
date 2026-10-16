import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(moduleDirectory, "prompts");
const targetDirectory = path.join(moduleDirectory, "dist", "prompts");
const promptFiles = [
  "aspectReview.prompt.md",
  "chapterSummary.prompt.md",
  "common.prompt.md",
  "continuationOptions.prompt.md",
  "dialogueSketchLine.prompt.md",
  "dialogueSketchLines.prompt.md",
  "firstReadReaction.prompt.md",
  "sceneSummary.prompt.md",
  "settingQa.prompt.md",
];

await mkdir(targetDirectory, { recursive: true });
for (const file of promptFiles) await copyFile(path.join(sourceDirectory, file), path.join(targetDirectory, file));
