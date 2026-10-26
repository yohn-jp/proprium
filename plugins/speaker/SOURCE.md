# Speaker source provenance

This independent plugin ports the pure Speaker algorithms from Scriptorium
`source@95a66c2c985a66bc2d535392dcc450d8c9df18d5`, with interaction and
presentation behavior mapped from Arcadia Loom
`source@edc033c2c9466274a334299dadfa426661d957d9`. The canonical recovery map is
[`docs/canon/plugins/SPEAKER.md`](../../docs/canon/plugins/SPEAKER.md), which
lists the pinned source paths for each SPK feature.

The copied algorithm files are kept inside this plugin so the signed component
does not depend on the retired Scriptorium module runtime. Imports formerly
provided by Scriptorium's Story, NLP, and Diagnostics modules are replaced by
small typed local adapters in `src/nlp/`, `src/algorithms/types.ts`, and
`src/algorithms/stylometryCompat.ts`. These adapters carry no repository access
or persistence authority.

Loom's React components are not copied into the component. Their workflows are
represented by the Host-validated surfaces in `plugin.json`; the Host renders
those declarations inside the existing workspace UI.

`src/migration.ts` inventories the two canonical legacy Speaker files and
compiles absent-only, byte-preserving restore operations into a normal reviewed
ChangeSet. SPK-11 has no stable migration action in the typed action table, so
the helper is not bound to a plugin action or exposed in a surface until the
Host provides an explicit migration route.
