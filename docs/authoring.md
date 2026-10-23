# Authoring and recovery

## Work repository

Connect a GitHub repository owned by the instance's author. The writing hierarchy uses YAML metadata and Markdown manuscripts:

```text
plot/volumes/<volume>/volume.yaml
plot/volumes/<volume>/chapters/<chapter>/chapter.yaml
plot/volumes/<volume>/chapters/<chapter>/scenes/<scene>.yaml
manuscript/<volume>/<chapter>/<scene>.md
```

Scene YAML names its manuscript with `manuscript: manuscript/.../scene.md`. The UI creates and reorders hierarchy entries through reviewed Core operations. Editing a manuscript preserves frontmatter, unsupported metadata and unrelated files.

## Draft, Checkpoint and Saved

| State | Meaning | Recovery boundary |
| --- | --- | --- |
| Draft | Text retained in the browser recovery journal | Same browser, author and origin |
| Checkpoint | Approved changes committed in the server's local Git checkout | Browser journal remains available until confirmed publication |
| Saved | Publication to GitHub confirmed | Recoverable from the remote Git history |

A checkpoint is not confirmation of remote storage. Use the explicit publication action to save to GitHub. An uncertain push result remains unknown until reconciliation establishes what reached the remote.

The browser reconciles its journal before presenting an editor as recovered and writable. Changing scenes, switching shells or refreshing must preserve recoverable input. A storage error is shown to the author; it is not reported as a saved draft. Clearing browser storage removes the browser recovery copy. Keep pending work in the same browser and origin until publication succeeds.

Remote observation follows the repository's default branch. Clean views can follow remote changes while local drafts and checkpoints remain separate. Conflicts preserve the author's text and require review. Scriptorium does not automatically merge conflicting manuscript prose or force-push history.

## Desktop and mobile

Choose Desktop or Mobile explicitly; the selection is remembered for this origin. The `/desktop/` and `/mobile/` routes select separately built shells sharing the same project, save, review and recovery services. Viewport size does not choose a shell.

The editor supports Japanese manuscript typography, ruby and vertical reading. Finish an IME composition before navigation that would unmount the editor; blocked navigation keeps the active text.

## Workspace layouts

Writing, Research and Review presets assemble independent Editor, Outline, Inspector, History and Review panels. Desktop panel grips and dock targets, plus keyboard-accessible move controls, support splits, tabs, ordering, resizing and visibility.

**Save layout** stores the arrangement for the author and desktop/mobile device class in this browser, separately from draft recovery and Git. A malformed layout falls back to a Core preset while preserving the stored value until an explicit replacement save. Missing optional contributions do not prevent other panels from working.

## Search and terminology

The optional Search/Terminology module indexes snapshot revisions, including local checkpoints. It supports lexical, exact, prefix and scoped queries. Dictionary changes use reviewable proposals.

Term links are temporary editor and reading decorations; they do not insert links into Markdown. Use Ctrl/Command-click or Ctrl/Command-Enter on an editor term to navigate. Ambiguous aliases remain plain text and can be inspected in the terminology panel.

Search can explicitly request NLP or Semantic capabilities. Ordinary lexical search does not load models. A Core-only build retains editing without the search module.

## Optional analysis

Module settings distinguish absent, disabled, enabled-idle and active modules. A missing package requires a compatible image; an enable toggle does not install executable code. Analysis results carry the snapshot that produced them. Applying a proposal requires author approval and revision validation.

Assistant provider execution requires configuration and explicit consent for external transmission. Selecting no provider keeps local writing and review available. Host-owned usage and job history is stored separately from work repositories; preserve the deployment's history volume when replacing a container.
