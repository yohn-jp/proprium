/** Refresh descriptions only. Execution results and immutable source mappings are never rewritten. */
export function refreshCanonMetadata(actual, required, ledgerRevision) {
  if (!/^[a-f0-9]{40}$/u.test(ledgerRevision)) throw new Error('Metadata history requires a full ledger revision');
  const result = structuredClone(actual);
  let changed = 0;
  function refresh(record, expected, fields) {
    if (!record || !expected) throw new Error('Cannot refresh a missing canonical record');
    const previous = Object.fromEntries(fields.filter(key => JSON.stringify(record[key]) !== JSON.stringify(expected[key]))
      .map(key => [key, structuredClone(record[key])]));
    if (!Object.keys(previous).length) return;
    if (record.status === 'PASS') throw new Error('Changed PASS requirements need explicit recertification, not metadata refresh');
    record.canon_metadata_history = [...(record.canon_metadata_history ?? []), { ledger_revision: ledgerRevision, fields: previous }];
    for (const key of Object.keys(previous)) record[key] = structuredClone(expected[key]);
    changed++;
  }
  for (const row of required.matrix) refresh(result.matrix.find(item => item.id === row.id), row, ['canon_title', 'required_proof']);
  for (const plugin of required.plugins) {
    const actualPlugin = result.plugins.find(item => item.plugin_id === plugin.plugin_id);
    if (!actualPlugin) throw new Error(`Missing plugin ${plugin.plugin_id}`);
    for (const row of plugin.features) refresh(actualPlugin.features.find(item => item.feature_id === row.feature_id), row,
      ['author_visible_result', 'source_disposition']);
    for (const row of plugin.acceptance_cases) refresh(actualPlugin.acceptance_cases.find(item => item.id === row.id), row,
      ['canon_title', 'canon_reference', 'canon_requirement']);
  }
  return { ledger: result, changed };
}
