# Mobile writing interactions — Scriptorium

The Ionic React mobile shell is selected by the explicit `/mobile/` route. Desktop and mobile share Git, approval and recovery services.

## Intended moment

A writer resumes a recoverable Japanese draft, checks which scene comes next, inspects publication state, then continues the same sentence. Supporting information should be available **without first leaving or unmounting the active manuscript**.

| Stage | User action | Interaction and authoritative outcome |
| --- | --- | --- |
| Write | Type/convert/select Japanese text | CodeMirror keeps native IME, caret, selection, undo and scrolling. No custom swipe handlers are attached to manuscript content. |
| Refer | Tap **構成を参照** or **保存状態を参照** above the Mobile bottom navigation | First run the existing `beforeLayoutChange` flush/recovery preflight. Only on success open an Ionic sheet, leaving `Workspace` and `SceneEditor` mounted. |
| Expand | Swipe the Ionic sheet's handle | Native Ionic breakpoints are 0, 0.56, 0.88 and 1. A visible Close button and tab/keyboard navigation are equivalent access paths. |
| Inspect | Show the Core-owned Outline or Inspector panel in the sheet | Only registered panels are rendered. Inspector also displays the controller's real Draft / Checkpoint / publication-unknown / GitHub-confirmed state. Nothing is auto-published. |
| Continue | Close the sheet by button, backdrop, hardware back or dragging to 0 | No document route or editor mount changes. Focus returns to the invoking button if the same scene/view is still active; the editor caret remains with CodeMirror, and the keyboard is not reopened by surprise. |
| Change scene | Tap a scene in the outline | Reuse existing guarded scene navigation; close the sheet after the actual document route changes. Do not claim success from the sheet animation. |
| Blocked | Preflight detects incomplete composition or unprotected draft | Keep the sheet closed, preserve the text, show an actionable error on the writing screen, and allow an ordinary retry after the user resolves the condition. |

## Gesture ownership

- **Manuscript:** editing, selection, vertical scroll, IME and existing reader swipe gestures remain with CodeMirror / MobileReadingPager / browser.
- **Sheet:** Ionic owns drag-to-snap, dismiss, modal focus trap and back-button behavior. The writing screen does not install competing global touch listeners.
- **Bottom navigation:** ordinary explicit tap targets remain for library, writing, inspection, tools and settings. The sheet is a temporary glance, not a second canonical workspace or persisted panel placement.
- **Soft keyboard:** Mobile may shrink chrome only when the editor is focused and the visible viewport loses substantial height; tiny browser-bar changes, orientation and pinch zoom do not by themselves select a different frontend. Hiding navigation is visual only; the editor and recovery controller remain mounted.

## Evidence boundaries

Source-level implementation is in `MobileShell.tsx`, `mobile.css` and `mobileKeyboard.ts`. Unit checks cover keyboard-occlusion predicates. Browser acceptance additions cover a real draft across sheet open/tab switch/dismiss, and scene selection through the sheet. A composition-denial scenario checks that the modal does not open while its preflight rejects the transition.

Device acceptance must exercise physical keyboards, IME, long-press, haptics and native gestures as appropriate. Browser automation proves its named browser and viewport cases; source review does not establish physical-device behavior. See [verification](../verification/README.md).
