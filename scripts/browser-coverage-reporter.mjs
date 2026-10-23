import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeBrowserCoverage } from "./browser-shards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default class BrowserCoverageReporter {
  constructor({ outputFile }) {
    if (typeof outputFile !== "string" || outputFile.length === 0) {
      throw new Error("The browser coverage reporter requires an outputFile");
    }
    this.outputFile = path.resolve(outputFile);
    this.discovered = [];
  }

  onBegin(_config, suite) {
    this.discovered = suite.allTests();
  }

  async onEnd(result) {
    const outcomes = this.discovered.map((test) => {
      if (test.results.length === 0) return "notRun";
      return test.outcome();
    });
    const profile = process.env.SCRIPTORIUM_E2E_PROFILE ?? "";
    const shard = process.env.SCRIPTORIUM_E2E_SHARD ?? "";
    const project = process.env.SCRIPTORIUM_E2E_PROJECT ?? "";
    const file = process.env.SCRIPTORIUM_E2E_TEST_FILE ?? "";
    let summary;
    let error;
    try {
      summary = summarizeBrowserCoverage({ expected: this.discovered.length, outcomes });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const complete = Boolean(summary)
      && result.status === "passed"
      && summary.failed === 0
      && summary.notRun === 0;
    const report = {
      schemaVersion: 1,
      outcome: complete ? "PASS" : "FAIL",
      runStatus: result.status,
      profile,
      shard,
      project,
      file,
      ...summary,
      ...(error ? { error } : {}),
      tests: this.discovered.map((test, index) => ({
        title: test.titlePath().join(" › "),
        file: path.relative(root, test.location.file),
        line: test.location.line,
        outcome: outcomes[index],
      })),
    };
    await mkdir(path.dirname(this.outputFile), { recursive: true });
    await writeFile(this.outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`BROWSER_COVERAGE ${JSON.stringify(report)}\n`);
    if (!complete) return { status: "failed" };
  }
}
