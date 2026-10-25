# Source provenance and licensing

Proprium was derived from the MIT-licensed [Scriptorium repository](https://github.com/yohn-jp/scriptorium) and preserves that repository's Git history. Some inherited owner-authored Scriptorium application code was previously extracted, with the owner's authorization, from **yohn-jp/arcadia-loom**. That authorization applies to the extracted application responsibilities; it does not license private manuscripts or unrelated material, and Arcadia Loom is not a Proprium runtime dependency.

| Inherited source | Source area in this fork |
| --- | --- |
| Manuscript formats and revision/mutation contracts | packages/contracts and packages/core |
| Original Node Git clone, synchronization and server HTTP integration | Historically inherited in `packages/core` and `packages/api`; `packages/api` was retired from the product runtime, while `packages/core` remains legacy source |
| Editing, Japanese typography, layout and browser recovery | app |
| Optional writing, search, diagnostics, models and assistant logic | modules |

The [repository MIT license](../../LICENSE) covers the application code subject to its terms; independent third-party packages, fonts, assets, datasets, model weights and plugin artifacts retain their respective licenses. Check license, attribution, provenance and redistribution rights **before** copying a model or plugin bundle to R2/CDN. Signing or hashing an artifact does not confer distribution rights.

Do not commit or publish user workspaces, manuscripts, private evaluation inputs, credentials, caches, downloaded private models or unrelated third-party materials. Historical verification evidence committed with the fork remains distinct from Proprium's normative product documents.
