export function installCore64RenderProbe(target = window) {
  const probeKey = "__scriptoriumCore64RenderProbe";
  const panelDefinitions = (value) => Array.isArray(value) && value.every((panel) => panel &&
    typeof panel.id === "string" && typeof panel.title === "string" && typeof panel.render === "function") ? value : null;
  const definitionRow = (current, previous) => {
    const previousById = previous?.byId ?? new Map();
    return {
      arrayChanged: previous ? previous.array !== current : null,
      entries: current.map((panel) => {
        const prior = previousById.get(panel.id);
        return {
          id: panel.id,
          objectChanged: prior ? prior.object !== panel : null,
          renderChanged: prior ? prior.render !== panel.render : null,
          titleChanged: prior ? prior.title !== panel.title : null,
        };
      }),
      next: { array: current, byId: new Map(current.map((panel) => [panel.id, {
        object: panel, render: panel.render, title: panel.title,
      }])) },
    };
  };
  const workspacePanelProps = (props) => {
    if (!props || typeof props.panelId !== "string" || !props.panel ||
        props.panel.id !== props.panelId || typeof props.panel.render !== "function") return null;
    return props;
  };
  const hook = target.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) throw new Error("React DevTools hook is not installed");
  if (target[probeKey]) return target[probeKey];

  const state = {
    schemaVersion: 1,
    phase: "startup",
    cohort: "startup",
    commits: [],
    measurements: [],
    mountEvents: [],
  };
  const renderProbe = {
    setPhase(name, cohort = name) {
      state.phase = String(name);
      state.cohort = String(cohort);
    },
    measure(name, durationMs, itemCount) {
      state.measurements.push({ phase: state.phase, cohort: state.cohort, at: target.performance.now(), name, durationMs, itemCount });
    },
    snapshot() {
      return {
        schemaVersion: state.schemaVersion,
        commits: state.commits,
        measurements: state.measurements,
        mountEvents: state.mountEvents,
      };
    },
  };
  target[probeKey] = renderProbe;

  const priorDefinitions = new Map();
  const priorVisiblePanels = new Map();
  // This replaces the aggregate harness traversal. The same pass records total fibers and
  // scopes flagged work to each visible Workspace panel, avoiding a second full-tree walk.
  hook.onCommitFiberRoot = (rendererId, root) => {
    const at = target.performance.now();
    const panelScopes = Object.create(null);
    const panelFrames = Object.create(null);
    let workspaceProps = null;
    let fibers = 0;
    let flaggedFibers = 0;

    const visit = (first, inheritedPanelId = null) => {
      for (let fiber = first; fiber; fiber = fiber.sibling) {
        fibers++;
        const flags = Number(fiber.flags) || 0;
        if (flags) flaggedFibers++;

        const stateNode = fiber.stateNode;
        const hostPanelId = typeof stateNode?.getAttribute === "function"
          ? stateNode.getAttribute("data-workspace-panel") : null;
        const panelId = hostPanelId || inheritedPanelId;
        if (panelId) {
          const row = panelScopes[panelId] ??= { fibers: 0, flaggedFibers: 0 };
          row.fibers++;
          if (flags) row.flaggedFibers++;
        }

        const props = fiber.memoizedProps;
        const definitions = panelDefinitions(props?.panels);
        if (definitions) workspaceProps = definitions;
        const frame = workspacePanelProps(props);
        if (frame) panelFrames[frame.panelId] = { flagged: Boolean(flags) };

        if (fiber.child) visit(fiber.child, panelId);
      }
    };
    if (root?.current) visit(root.current);

    let workspace = null;
    if (workspaceProps) {
      const definition = definitionRow(workspaceProps, priorDefinitions.get(rendererId));
      priorDefinitions.set(rendererId, definition.next);
      workspace = { panelsArrayChanged: definition.arrayChanged, entries: definition.entries };
    }

    const visiblePanelIds = Object.keys(panelScopes).sort();
    const previous = priorVisiblePanels.get(rendererId);
    const previousIds = previous ?? new Set();
    for (const id of visiblePanelIds) {
      if (!previousIds.has(id)) state.mountEvents.push({ phase: state.phase, at, panelId: id, kind: "mount" });
    }
    if (previous) {
      for (const id of previous) {
        if (!panelScopes[id]) state.mountEvents.push({ phase: state.phase, at, panelId: id, kind: "unmount" });
      }
    }
    priorVisiblePanels.set(rendererId, new Set(visiblePanelIds));

    const commit = {
      rendererId,
      phase: state.phase,
      cohort: state.cohort,
      at,
      fibers,
      flaggedFibers,
      panelScopes,
      panelFrames,
      visiblePanelIds,
      workspace,
    };
    state.commits.push(commit);
    if (target.__wave0?.reactCommits) {
      target.__wave0.reactCommits.push({ at, fibers, flaggedFibers });
    }
  };

  return renderProbe;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1] ?? sorted.at(-1) ?? null;
}

export function summarizeCore64RenderProbe(snapshot, phase = null, cohort = null) {
  const matches = (row) => (!phase || row.phase === phase) && (!cohort || row.cohort === cohort);
  const commits = snapshot.commits.filter(matches);
  const measurements = snapshot.measurements.filter(matches);
  const mountEvents = snapshot.mountEvents.filter(matches);
  const panels = new Map();
  const getPanel = (id) => {
    let row = panels.get(id);
    if (!row) {
      row = { touchedCommits: 0, flaggedFibers: 0, mountEvents: 0, unmountEvents: 0,
        panelObjectChanges: 0, renderRefChanges: 0, titleChanges: 0 };
      panels.set(id, row);
    }
    return row;
  };

  for (const commit of commits) {
    for (const [id, scope] of Object.entries(commit.panelScopes)) {
      const row = getPanel(id);
      if (scope.flaggedFibers > 0 || commit.panelFrames[id]?.flagged) row.touchedCommits++;
      row.flaggedFibers += scope.flaggedFibers;
    }
    for (const entry of commit.workspace?.entries ?? []) {
      const row = getPanel(entry.id);
      if (entry.objectChanged) row.panelObjectChanges++;
      if (entry.renderChanged) row.renderRefChanges++;
      if (entry.titleChanged) row.titleChanges++;
    }
  }
  for (const event of mountEvents) {
    const row = getPanel(event.panelId);
    if (event.kind === "mount") row.mountEvents++;
    else row.unmountEvents++;
  }

  const measurementSummary = Object.create(null);
  for (const name of new Set(measurements.map((row) => row.name))) {
    const rows = measurements.filter((row) => row.name === name);
    const durations = rows.map((row) => row.durationMs);
    measurementSummary[name] = {
      calls: rows.length,
      totalMs: durations.reduce((sum, value) => sum + value, 0),
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.length ? Math.max(...durations) : null,
      itemCounts: [...new Set(rows.map((row) => row.itemCount))],
    };
  }

  return {
    ...(phase ? { phase } : {}),
    ...(cohort ? { cohort } : {}),
    commitCount: commits.length,
    totalFibers: commits.reduce((sum, row) => sum + row.fibers, 0),
    flaggedFibers: commits.reduce((sum, row) => sum + row.flaggedFibers, 0),
    workspaceCommits: commits.filter((row) => row.workspace !== null).length,
    panelArrayChangedCommits: commits.filter((row) => row.workspace?.panelsArrayChanged === true).length,
    panels: Object.fromEntries([...panels].sort(([left], [right]) => left.localeCompare(right))),
    measurements: measurementSummary,
    mountEvents,
  };
}
