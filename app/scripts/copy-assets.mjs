import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../dist");
await mkdir(output, { recursive: true });
await Promise.all([
  copyFile(resolve(here, "../index.html"), resolve(output, "index.html")),
  copyFile(resolve(here, "../styles.css"), resolve(output, "styles.css")),
]);
