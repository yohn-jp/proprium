import assert from "node:assert/strict";
import test from "node:test";
import { installCore64RenderProbe, summarizeCore64RenderProbe } from "./core64-render-probe.mjs";

function linked(rows) {
  rows.forEach((row, index) => { row.sibling = rows[index + 1] ?? null; });
  return rows[0] ?? null;
}

function sceneRoot(definitions, visible, flaggedPanels = []) {
  const frames = visible.map((id) => {
    const panel = definitions.find((item) => item.id === id);
    const host = {
      stateNode: { getAttribute: (name) => name === "data-workspace-panel" ? id : null },
      flags: flaggedPanels.includes(id) ? 1 : 0,
      child: { flags: flaggedPanels.includes(id) ? 1 : 0, child: null, sibling: null },
      sibling: null,
    };
    return {
      memoizedProps: { panelId: id, panel },
      flags: flaggedPanels.includes(id) ? 1 : 0,
      child: host,
      sibling: null,
    };
  });
  const workspace = {
    memoizedProps: { panels: definitions },
    flags: 1,
    child: linked(frames),
    sibling: null,
  };
  return { current: { flags: 0, child: workspace, sibling: null } };
}

function definitions() {
  return ["editor", "outline", "inspector"].map((id) => ({
    id,
    title: id,
    render() {},
  }));
}

test("attributes panel commits, render-closure churn, derivation costs, and panel mounts by phase", () => {
  let now = 100;
  const hook = { onCommitFiberRoot() {}, onCommitFiberUnmount() {} };
  const target = {
    performance: { now: () => now++ },
    __wave0: { reactCommits: [] },
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
  };
  const probe = installCore64RenderProbe(target);

  probe.setPhase("startup");
  hook.onCommitFiberRoot(1, sceneRoot(definitions(), ["editor", "outline"]));
  probe.measure("workspace.catalog", 0.03, 3);

  probe.setPhase("input.typing", "scene.1MiB");
  probe.measure("workspace.catalog", 0.03, 3);
  hook.onCommitFiberRoot(1, sceneRoot(definitions(), ["editor", "outline"], ["editor"]));
  probe.setPhase("input.cursor", "scene.1MiB");
  hook.onCommitFiberRoot(1, sceneRoot(definitions(), ["editor", "outline"], ["editor"]));
  const cursor = summarizeCore64RenderProbe(probe.snapshot(), "input.cursor");
  assert.equal(cursor.commitCount, 1);
  assert.equal(cursor.panelArrayChangedCommits, 1);
  assert.equal(cursor.panels.editor.touchedCommits, 1);
  assert.equal(cursor.panels.outline.touchedCommits, 0);
  assert.equal(cursor.panels.outline.renderRefChanges, 1);
  assert.equal(cursor.measurements["workspace.catalog"], undefined);
  const input = summarizeCore64RenderProbe(probe.snapshot(), null, "scene.1MiB");
  assert.equal(input.commitCount, 2);
  assert.equal(input.measurements["workspace.catalog"].totalMs, 0.03);
  assert.deepEqual(input.measurements["workspace.catalog"].itemCounts, [3]);
  assert.equal(summarizeCore64RenderProbe(probe.snapshot(), "input.typing", "scene.1MiB").commitCount, 1);
  assert.equal(summarizeCore64RenderProbe(probe.snapshot(), "input.cursor", "scene.1KiB").commitCount, 0);

  probe.setPhase("workspace.activate.inspector");
  hook.onCommitFiberRoot(1, sceneRoot(definitions(), ["editor", "inspector"]));
  const activation = summarizeCore64RenderProbe(probe.snapshot(), "workspace.activate.inspector");
  assert.deepEqual(activation.mountEvents.map((event) => [event.panelId, event.kind]), [
    ["inspector", "mount"], ["outline", "unmount"],
  ]);
  assert.equal(target.__wave0.reactCommits.length, 4);
});
