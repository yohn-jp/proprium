# Source provenance and licensing

Scriptorium incorporates owner-authored application code extracted from `yohn-jp/arcadia-loom` with the repository owner's authorization for public MIT-licensed distribution. That authorization applies to the extracted application responsibilities; it does not grant rights to private works or unrelated third-party material. Arcadia Loom is not a runtime dependency or submodule, and its Git ancestry is not imported.

| Source responsibility | Scriptorium owner |
| --- | --- |
| Manuscript/scene types and format validation | `packages/contracts`, `packages/core` |
| Repository acquisition, ownership and synchronization | `packages/core`, `packages/api` |
| Authoring, snapshots and mutation | Core services and public action contracts |
| Editing, Japanese typography and recovery | `app` |
| Narrative analysis and provider integration | Optional `modules` packages |

The [MIT license](../../LICENSE) covers the Scriptorium application. Third-party dependencies retain their own licenses. Check publication rights for imported code, assets, dictionaries and model artifacts before distribution. Do not include manuscripts, private evaluation corpora, credentials, cached weights or user workspaces in public source or images.
