# Scriptorium Core — 64候補の実装・検証・判断契約（固定Goal）

**作成:** 2026-10-20 JST。**照合main:** `8ffacfaf9eea0685bf0cf8b5bb1d97e8caeb49ce`。  
**根拠:** [64件静的監査](../architecture/CORE-PERFORMANCE-AUDIT.md)、[Wave 0候補対応表](CANDIDATE-MAP.md)、[実測Baseline](BASELINE.md)、[W1 Editor/Journal](WAVE1-EDITOR-JOURNAL.md)、[W1 Git](WAVE1-GIT-ENGINE.md)。今後の実装では必ず最新mainとの差分と契約を再照合する。

## 固定Goalと終了状態

1. **対象IDはC01–C64の64件で固定**。各IDに対し、(a)実装・同一fixtureによる改善/安全性の検証、(b)既存実装・契約で達成済みの証拠、(c)根拠付き見送り（測定上利益なし、コスト超過、危険な契約変更、別Product Goalの責務）を記録する。数を埋めるためのコード変更は禁止。
2. 全件を決着させ、候補ID、before/after SHA、対象owner、変更の有無、測定条件/実値、focus tests、required verification、PASS/FAIL/NOT_CHECKEDを行単位で残す。見送りは実験/コード根拠と再検討条件を記載する。環境ブロックは**未検証**とし、PASSに変換しない。
3. 性能の主要KPIは長文入力・カーソル、scene切替、Git/Snapshot読取、search/stats、API poll/status、Core-onlyビルド/起動/idle。利益はp50/p95/p99、Git fork、IDB、network、CPU、RSS、bundleを**同一条件**で示す。効果がない・安全性を損なう変更は採用しない。異なる実験の測定値を加算して「Goal改善率」としない。
4. 歴史的計測を扱う: W0の10kファイルcold revisions 24.30秒 (n=1)、W1新baseline比較23.61秒→442.45ms (n=5)、warm25.66ms→44.34ms (n=5)。W1 Browserの1MiB入力はC04 513.2/536.7/547.4ms、C13 521.8/551.1/620.7ms (各n=20; p99は最大値)。C13ではIDB reads 74→31だがLong Tasksは増えた。**W1は改善済みと未解決が共存**。古いAuditの「計測未実施」は作成時点のみの説明。
5. **保護する正本:** GitHub-authoritative、Browser IndexedDB strict recovery、Draft→Checkpoint→confirmed Publish、Operation ID/Generation、read-set/write-set/expected revision、単一Writer/epoch、unknown/conflict、project/author認可、path/symlink、snapshot pinning、Core-only closure。性能改善を口実にこれらを弱めない。
6. **対象外:** 新しい公開Plugin Platform (外部SDK/WASI/iframe/OCI composition/Marketplace)、Praetorium変更、個別NLP/LLMアルゴリズム、別repo、未要求機能、GitHub Actions/CI追加や起動。既存ModuleのCore境界は性能証明対象だが、[公開Plugin Platform設計](../architecture/PLUGIN-PLATFORM.md)の実装は別Goal。
7. **実行方式:** Coordinatorだけが`main`の統合Writer。独立Workerは分離worktree/branchで実装、検証後Coordinatorが順次mainへコミット/プッシュ。PR/マージレビュー/CI待ちを新しい必須工程にしない。既存文書・Issue/AGENTSの適用条件とユーザーの最新指示を遵守。各有効な成果は随時永続化し、失敗で無関係な作業を止めない。

## 実測の運用と受入ゲート

- 計測コマンド/fixtureは`scripts/performance/`とW0/W1にある正本を再利用。初手で**最新mainのW1統合後baseline**を固定し、その後は変更直前/直後を同一ホスト・同一ツール/Node/Chromium・同一seed・同一シナリオで比較する。メモリは端点RSSとpeak、Node CPUとchild Git CPUを区別する。
- Git/Nodeはfresh workerのcold/warm、10/1k/10k/100k files、1/10/100 writes、1/100/1k drafts、長い履歴を必要な項目で選択。Browserは1KiB/100KiB/1MiBとcomposition、cursor、paste、undo、recovery、scene switch。無関係な重負荷テストを全IDへ毎回課さない。タイムアウトした規模は`NOT_CHECKED`。
- 1MiB入力の既存1worker/n20、p99実質最大値、W1の暖機/OS cache状態、long-task/commit増加は限界として記録する。正式な数値予算は比較可能な反復計測後にだけ策定する。失敗で数値や閾値を後付けしない。
- 変更のあるleafは必要なfocused regression後に`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`SCRIPTORIUM_PROFILE=core pnpm build`、`pnpm audit:core`。依存・runtime/profileを変更したleafは`SCRIPTORIUM_PROFILE=full pnpm build`、関連Chromium E2E・Core/full OCIも実施。端末や認証がない外部GitHub実証・native iPhone/IME・長時間idleは`NOT_CHECKED`と明示。
- ドキュメントだけの見送りで全テストをやり直さない。**正本・入力・回復・Publish・プラットフォーム認証**に接する実装は競合/旧世代/通信損失・crash・cleanupを対象とする。コードで証明不能なら性能が良くても採用しない。
- 共有パスを同時編集しない: `SharedApplication.tsx`はG1単一integration owner、`packages/core/src/index.ts`はG2単一owner、`server.ts`はG3単一owner。C30/C31/C63・C46/C47・C48/C57・C21/C22/C35/C54・C32/C33/C36は**単一契約/実装で重複を解消**し、二重フレームワークを作らない。
- 各候補の採否判定は「正確性と復旧の同等性」「計測条件と効果の明示」「修正の局所性」で行う。未測定の性能予想、抽象化への美的好み、将来のPlugin SDK都合だけでは実装しない。

## 固定順序 / 依存

| Gate | 対象 | 統合境界・完了条件 |
| --- | --- | --- |
| **G0 — actual baseline** | C58再実測と全件差分突合 | W1後mainの環境/fixture/検証状況を保存。最初の次Wave以降の比較基準。 |
| **G1 — Editor・Browser Journal** | C01–C19 | 先にhot-pathとstrict IDBの計測、続いて合格する局所変更。C01/C04/C13は再実装せずW1の残差を評価。 |
| **G2 — Git / Snapshot / 派生情報** | C20–C36、C54 | pinned read・locksの前提を確認後、Git fork/scan規模で実装判定。C22の実装を保持する。 |
| **G3 — API・Network・Startup** | C38–C47 | C41のplatform確認は別の権威判定でありpoll削減のついでに変更しない。C46/C47を統合判断。 |
| **G4 — 汎用File・拡張契約評価** | C37、C48–C57 | 前Gateで必要性が判明した契約だけ実装。Invariantは検証、SDK/外部Plugin新設は禁止。 |
| **G5 — 配信・リソース・最終認証** | C58–C64 と全件総括 | UI3 entrypoint、Core/full、実OCI、cache予算、同一条件再測定、全IDの最終stateを保存。GitHub CIを追加しない。 |

G1/G2/G3の計測やファイル非競合leafは並行可能だが、**受け渡し型・CAS/freshnessの変更は統合前に最小実物のend-to-endを一度成立**させる。統合時点でproducerが存在しなければconsumerを見切り発車しない。固定ID以外の仕事を連鎖発見してGoalを拡大しない。

## 候補別の実行契約（64件）

各項目の「作業」は**調査と採否決定を含む候補**であり、記述された新機構すべてを無条件に実装する命令ではない。「判定証拠」は最低限の確認軸で、候補ごとに前後値・セマンティクス・検証不能を報告する。ソースリンクは監査時SHAに固定されており、実作業は最新mainから確認する。

### C01 — CodeMirrorのdocChangedで文書全体をtoString()している

- **優先/段階/基準時状態:** P0 / G1 / W1一部統合（全文生成は残存）。Wave0分類: W1-A、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/editor/ManuscriptInput.tsx#L151-L169)
- **具体化した作業:** CodeMirrorのChangeSet/rangeを編集通知の入力にし、全文文字列化は互換境界でのみ実行。既存C01文字列再利用を壊さず、必要になる完全operationの生成時期を計測して決める。
- **判定証拠:** 1KiB/100KiB/1MiB入力、IME composition、paste、undo/redo。materialization回数・allocation・p50/p95/p99をW1最終版と比較。

### C02 — カーソル移動でも全文toString()・文章内文位置の再計算

- **優先/段階/基準時状態:** P0 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/editor/ManuscriptInput.tsx#L151-L169)
- **具体化した作業:** カーソルだけの更新ではdoc.toString()を避け、CodeMirror documentの行/区間でsentence positionを限定計算。全文索引は選択変更時に同期更新しない。
- **判定証拠:** 矢印キー、長文選択、段落改行、サロゲートペア、日本語句読点、scroll復元で既存結果と一致。選択のみの全文化回数とp95を比較。

### C03 — editTextが毎回完全なChangeOperationを構築・検証

- **優先/段階/基準時状態:** P0 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L1574-L1605)
- **具体化した作業:** editTextのChangeOperationを完全構築する箇所のCPU/allocを分解計測。変更世代と本文だけを入力経路に置く場合もstrict IndexedDB確定前に現行と同じ完全検証を実施。
- **判定証拠:** 操作ID/generation/read-set/write-set/expected revisionと失敗時draftStored=falseが維持。入力p95・GCと永続化直前の検証結果を比較。

### C04 — 編集ごとにAuthorWorkspace全体のWorkStateをsetState

- **優先/段階/基準時状態:** P0 / G1 / W1一部統合（状態配信に残課題）。Wave0分類: W1-B、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L383-L478)
- **具体化した作業:** 既存の通知coalesce/status専用境界を維持し、WorkStateの購読をeditor text/command/auxiliary panelへ安全に分離。独立購読により他sceneの状態が混入しない設計を優先。
- **判定証拠:** React Profilerで文字入力・保存status更新時の対象外panel commit数、CM mount回数、IME/print/history/restoreを比較。W1の大容量Long Tasks増大を検証。

### C05 — CodeMirror value同期時の全文比較とフルレンジ置換の可能性

- **優先/段階/基準時状態:** P0 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/editor/ManuscriptInput.tsx#L188-L201)
- **具体化した作業:** 外部value同期をrevision/originで絞り、全長比較と全面range置換を本当に必要なscene/recovery切替だけに限定。cursor/historyを意図せず上書きしない。
- **判定証拠:** 通常キー入力ではフルdispatch 0、外部更新・Undo/Redo・競合後復元・IME中の外部変更で正しい履歴。dispatch bytesのA/B。

### C06 — 巨大SharedApplicationにログイン/更新/編集/復旧/描画が共存

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L383-L478)
- **具体化した作業:** SharedApplicationのUI状態・認可・復旧・非同期通信の所有者境界を調べ、C04の単一購読に効果がなければ責務とselectorを最小単位で抽出。
- **判定証拠:** 抽出前後のrender flamegraph、依存循環、navigation generation/author scope/error handlingとテスト同等性。速度改善のない大規模分割は見送り。

### C07 — Workspaceへ毎描画で新たなpanel配列・render closureを渡す

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L2404-L2423)
- **具体化した作業:** Workspaceへ渡すpanel配列とrender closureの参照を安定化。現在表示中のpanelだけ該当stateを購読させ、非表示panelは起動しない。
- **判定証拠:** typing時のpanel再render・allocation・heavy module activation数、再配置・有効化/無効化・レイアウト保存を確認。

### C08 — Workspaceがpanel prop identityでcatalog/mapを再生成

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/workspace/Workspace.tsx#L260-L280)
- **具体化した作業:** PanelCatalog/map生成をpanel IDsと貢献versionをキーにmemoizeし、props identity変化ではlayout stateを破棄しない。
- **判定証拠:** panel mount/unmount countとlayout computation、追加/撤去時のfallback、保存済layout再開とキーボード移動の同値性。

### C09 — 分割ペインのresizeが全レイアウトの状態更新を起こす

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/workspace/Workspace.tsx#L425-L430)
- **具体化した作業:** resize時の連続state反映とlayout永続化の回数を分離。rAF単位の視覚更新と操作終了時の確定を比較し、ドラッグ中の座標を失わない。
- **判定証拠:** ドラッグ中fps/Long Taskと最終幅、キーボードresize、モバイルsafe-area、layout persistenceの結果を確認。

### C10 — scene切替時にdraft flush→remote/effective fetch→IDB lookupを順に待つ

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L870-L964)
- **具体化した作業:** scene切替経路のflush、remote/effective read、IndexedDB lookupをtraceし、immutable snapshotならプリフェッチ。未保護draftのscene破棄は禁止。
- **判定証拠:** 10/1k/10kファイル切替p95、HTTP/Git数、競合・回復・rapid navigation・Abort順序・同一repoのauthor scopeを検証。

### C11 — シーン/読書/スクラッチ/履歴が単一Editor画面のpropsを拡大

- **優先/段階/基準時状態:** P2 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/editor/SceneEditor.tsx#L48-L145)
- **具体化した作業:** SceneEditorの可視subtreeを境界化し必要ならlazy load。初期画面とreader/preview/scratch/historyを遅延化するが入力中のCMは再mountしない。
- **判定証拠:** desktop/mobileの初期JS bytes、TTI、tab初回待ち、theme/vertical-writingと既存操作の回帰。

### C12 — 350ms autosaveが厳密IndexedDBトランザクションを使用

- **優先/段階/基準時状態:** P0 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L1574-L1605)
- **具体化した作業:** 350ms strict journalのトランザクション数と未完了キュー長を計測。batch/deltaはtransaction atomicityと明示された保存状態が一致する場合だけ導入。
- **判定証拠:** 入力burstのIDB readwrite数/完了時間、QuotaExceeded/Tab crash/ブラウザ終了、複数タブ競合、draft Stored表示の正確性。

### C13 — autosaveのたびにrefreshJournalが全entries/proposalsを取得

- **優先/段階/基準時状態:** P0 / G1 / W1一部統合（局所merge）。Wave0分類: W1-C、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L1519-L1553)
- **具体化した作業:** W1で導入した成功時の局所mergeを保持し、full refreshは明示inventory/他タブ復元時のみ。必要な変更通知をdocumentKey/authorで局所化。
- **判定証拠:** W1の1MiB IDB reads 74→31を退行させず、entry保護/新旧世代/two-tab衝突/削除復旧を検証。

### C14 — JournalEntryはtext、baseText、operation.writes.contentの全文を重複保持

- **優先/段階/基準時状態:** P0 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L186-L267)
- **具体化した作業:** JournalEntry内のtext/baseText/write.content重複を実バイトで確認。削減が有益ならversioned payload+digest/差分を導入し旧スキーマの読込を維持。
- **判定証拠:** 同一100KiB/1MiB draftのIDB bytes/restore時間、旧データmigration、transaction失敗、response lossで完全復元。証明不能なら現行維持。

### C15 — putLatestDraftがdocumentKeyで全件取得し全文JSONで世代を比較

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/storage/journal.ts#L219-L285)
- **具体化した作業:** putLatestDraftが全件を読み比べる箇所にdocument+author+generation向け索引またはkeyed readを採用する前に現行atomicityを解析。
- **判定証拠:** 1/100/1k draftsでput p95・IDB getAll数、equal-generation-different-operation、stale tab衝突を判定。

### C16 — getAllEntries/getAllProposalsが全Repository情報を全走査

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/storage/journal.ts#L284-L326)
- **具体化した作業:** entries/proposals一覧のauthor/repositoryキー検索を実装する場合はスキーマversionとtransaction移行を一体化。旧recordは失わず一意性とscopeを保つ。
- **判定証拠:** 1k cross-repo entriesで起動p95/転送bytes、異repo/異authorの漏洩なし、旧schema再開、途中停止復旧。

### C17 — ドラフトの書込キューは単一で、移動・復旧待ちが長くなり得る

- **優先/段階/基準時状態:** P1 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L1519-L1553)
- **具体化した作業:** 単一draftQueueの待ち時間を可視化。文書キー別並列化はIndexedDB競合・同じ操作世代・checkpoint依存を証明できた場合のみ。
- **判定証拠:** 複数scene切替連打/同時タブ/restoreとpending draftのordering、保存p95、最終entryの一意性。

### C18 — ブラウザとローカルGitの二つの永続化段階がある

- **優先/段階/基準時状態:** P1 / G1 / 契約固定。Wave0分類: Invariant、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/storage/journal.ts#L19-L71)
- **具体化した作業:** Draft→Checkpoint→GitHub-confirmedの現行state/receiptを一元に型付けする必要を確認。状態機械の改変は観測上の混乱が実証された場合に限定。
- **判定証拠:** ネット切断・publish unknown・response loss・旧writer、保存済み誤表示が0。現行が十分なら契約テストのみ。

### C19 — ページ離脱で未完了保存をbest-effort起動

- **優先/段階/基準時状態:** P2 / G1 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L1378-L1392)
- **具体化した作業:** pagehide/visibilityでのbest-effort処理を実端末依存の同期保証と混同しない。既にdurableなentryのみを保存済み表示し未完了を明示。
- **判定証拠:** 強制終了・reload・pagehide直後のrecoverability、未完了残留のUI/ログをテスト。削減しないdurability契約。

### C20 — readTree/reader/search等もmutation file lockを取得

- **優先/段階/基準時状態:** P0 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L4348-L4424)
- **具体化した作業:** mutating ref/indexとimmutable pinned tree/blob読み取りのロック境界を分析し、不可変オブジェクトのみ短い固定snapshot後に並列化。
- **判定証拠:** 重いCheckpoint/Publish中のread p95とlock wait、gc/ref mutation/clone reconstruct/symlink/旧writer fencingの並行試験。

### C21 — snapshotFileのパス階層ごとにgit ls-tree subprocessを起動

- **優先/段階/基準時状態:** P0 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L1442-L1485)
- **具体化した作業:** treeEntryのパス階層ごとのls-tree発行を、検証済みcommit-keyed tree/object indexまたはbounded tree walkで置換。
- **判定証拠:** 階層の深いパス10k件でGit subprocess、binary/exec mode/symlink/non-directory parent/過去commit pinnedの同値性。

### C22 — snapshotFileRevisionsが変更なしでも全ls-treeと未cached blobごとのcat-fileを実行

- **優先/段階/基準時状態:** P0 / G2 / W1統合（cold改善 / warm退行記録）。Wave0分類: W1-D、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L1502-L1538)
- **具体化した作業:** W1のbatch-check/batch取得とwarm fast pathを維持。cold 442ms、warm 44msを新mainで再測定し、必要ならtree OID差分とwarm allocationを最小変更で改善。
- **判定証拠:** 10k cold/warmを同一fixtureの独立workerで比較。FileRevisionはbytes SHA-256、24MiB/4096件境界とsymlink検証不変。

### C23 — createCommitがファイルごとにtreeEntry・hash-object・update-indexを実行

- **優先/段階/基準時状態:** P0 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L1633-L1679)
- **具体化した作業:** createCommitの1ファイルごとのhash/index/tree実行数を複数file operationで測り、Git indexを使う部分のbounded batch化を検討。
- **判定証拠:** 1/10/100 filesのcheckpoint p50/p95/Git forks、原子的CAS/read-set、rollback、競合・中断時のindex汚染0。

### C24 — CoreStoreがGit/Registry/Proposal/Sync/History/Lockを一つに持つ

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L1059-L1118)
- **具体化した作業:** CoreStore分割はホットパス改善に必要な責務だけ。ProjectRegistry/Snapshot/Mutation/Transport/Publicationを実装上の境界候補として比較。
- **判定証拠:** 循環依存・API契約・実行時間が改善する小規模抽出以外は根拠付き見送り。既存20以上のcontract/integration testsを維持。

### C25 — getProjectが呼び出しごとにJSON registryをFSから読む

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L1124-L1185)
- **具体化した作業:** getProjectごとのregistry JSON読込数を測り、必要時のみprocess-local cacheとversion/mtime/atomic writer invalidationを実装。
- **判定証拠:** 外部編集/再起動/複数client/stale cacheで正しいrepository scope。lookup p95、FS read数。

### C26 — selectedSnapshotでobservation/reconcile/ref参照が重複する場合がある

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L2358-L2382)
- **具体化した作業:** 1 API requestで同じcommit/observationの参照を重複解決する箇所にrequest-scope pinned contextを渡す。リモート観測のfresh要件は削らない。
- **判定証拠:** 1 scene read/requestあたりGit process数とp95、競合remote head/overlay変化時のfail closed。

### C27 — localDurabilityCensusがrev-list --all --reflog・status・履歴検証を行う

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L2507-L2597)
- **具体化した作業:** durability censusを1/100/10k operations履歴で測定。補助索引は可逆・再構築可能でrev-list/reflogの未公開commit検知を維持できる場合のみ。
- **判定証拠:** lost response/GC/restart/unknown publication/未公開commitによる偽completeが0。census p95/RSSを検証。

### C28 — publishでreconcile・history・local operation scanを複数回行う

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L3943-L4037)
- **具体化した作業:** Publishでcommit-keyed immutable recordをrequest内memo化するが、確認観測/remote CAS/retryは毎回新しい値を確認。
- **判定証拠:** 1/10/100 pending operationsのpublish p95・Git呼出し数、remote競合/unknown/error後のreceipt整合。

### C29 — status()が毎回fetchRemoteを呼ぶ

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L5025-L5051)
- **具体化した作業:** status表示用のlocal statusとauthoritative remote refreshの呼び出し契約を区別。既存明示observeとpublish前再確認は省略しない。
- **判定証拠:** status APIのネットワーク/応答時間、remote changed後unknown/stale表示、外部push検知とユーザー操作の安全性。

### C30 — git execFile上限32MBが大きなBinary/Treeに合わない場合がある

- **優先/段階/基準時状態:** P2 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L845-L945)
- **具体化した作業:** 32MiB Git execFile限界を越えるfixtureで実測し、必要なBlob読取にのみbounded streamを追加。HTTP/Operation JSONの上限と独立判断。
- **判定証拠:** >32MiB blob、binary/NUL、partial output、abort、RSS上限とrevisionの同値性。測定不能はNOT_CHECKED。

### C31 — fileRevisionCache 16,384件/hierarchy cache16MB/history cache64MBを別々に管理

- **優先/段階/基準時状態:** P2 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L1068-L1086)
- **具体化した作業:** fileRevision/hierarchy/historyの各cacheでrepo別hit/eviction/実RSSを測り、C63と統合して予算化。ヒットコスト悪化も記録。
- **判定証拠:** 10k/100k repo、複数repo、idle/pressure、memory peak/heap/reader p95。容量一律縮小による退行を禁止。

### C32 — Core searchSnapshotがHierarchy/Sceneを全走査し本文を順次読む

- **優先/段階/基準時状態:** P0 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L2890-L3015)
- **具体化した作業:** Coreの全件searchSnapshotとoptional search moduleを区別。Snapshot/Blob-keyedの再構築可能な検索indexを、実測で全件scanが問題となる経路だけに実装。
- **判定証拠:** 1k/10k件の検索p95/初回index時間、未索引fall-back、snapshot変更・削除・unicode/日本語・repo scope/結果一致。

### C33 — writingStatsSnapshotが毎回シーンを全走査して本文を読む

- **優先/段階/基準時状態:** P0 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L3016-L3115)
- **具体化した作業:** writingStatsSnapshotにGit Blob IDまたは内容digest→文字数等の派生統計cacheを検討。commitごとの変更分だけ更新し不変生成物として扱う。
- **判定証拠:** 1k/10k件・数万sceneでstats p95/cold build/RSS、集計の一致・削除/rename・checkpoint vs remoteの区別。

### C34 — hierarchySnapshotがvolume→chapter loopsでfiles.flatMap/filterを反復

- **優先/段階/基準時状態:** P0 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L2611-L2699)
- **具体化した作業:** hierarchySnapshot内のvolumes/chapters/scenes反復filter/flatMapを1回のtree walkによるparent→children mapに変更する試験。
- **判定証拠:** 10/1k/10k件のtree build CPUとcomplexity、重複ID判定、order/title、欠落/不正YAML時の同値性。

### C35 — readHierarchyYamlには既にbounded cat-file batchとrevision cacheがある

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L2700-L2792)
- **具体化した作業:** 既存readHierarchyYamlのbounded cat-file batchを守りつつ、Snapshot/File汎用読取で同様のAPIが有益かC21/C54に統合。
- **判定証拠:** batch前後のfork count/peak RSS、byte exact revision、binary/path validation。別の汎用batch engineを重複実装しない。

### C36 — 複数の派生機能で同じ文件を個別に走査する余地

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/contracts/src/index.ts#L84-L99)
- **具体化した作業:** 同じcommit/blobを検索・統計・索引が重複走査する場合のみ、軽量なderived-value cacheか変更イベントを共有。常駐全文Indexerはデフォルトにしない。
- **判定証拠:** 同一変更後の累積CPU/read件数、inactive module時timer/worker=0、古いsnapshot/result混入なし。

### C37 — ファイル階層はvolume/chapter/sceneに強く結合している

- **優先/段階/基準時状態:** P2 / G4 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L2611-L2699)
- **具体化した作業:** 一般ファイル階層の必要性をCore File APIと既存Scene Adapterの差分で評価。機能追加が性能Goalの実測改善に不要なら今回コード変更しない。
- **判定証拠:** 必要時のみ.md以外のFile list/read/writeを回帰確認。Arcadia YAML/Markdownと既存Scene API完全互換。

### C38 — Remote観測を表示中15秒間隔でGET

- **優先/段階/基準時状態:** P0 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L1286-L1376)
- **具体化した作業:** 15秒remote observationのvisible/hidden/focus/外部push契約を実測。条件付き取得/バックオフ/SSE local hintsを比較し、fresh表示/authoritative verifyを省略しない。
- **判定証拠:** 35秒/長時間idleのrequest count、外部push検知遅延、focus復帰後unknown、編集・publish前のfresh CAS。

### C39 — Recent Activityも15秒間隔GET、hidden除外なし

- **優先/段階/基準時状態:** P0 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/resume/useRecentActivityResume.ts#L122-L179)
- **具体化した作業:** Recent Activity pollingでhiddenのIntervalを止めvisibility復帰時refresh。現在のscope/refreshSequence/Abortを保持する最小変更を優先。
- **判定証拠:** visible/hidden request数、複数タブ/端末の最新位置、navigate後古いresponse混入0、cleanup timer=0。

### C40 — カーソル移動後2秒でPUT recent activity

- **優先/段階/基準時状態:** P0 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/resume/useRecentActivityResume.ts#L189-L228)
- **具体化した作業:** カーソルPUTの変更判定/semantic dedupeを追加するならlast-write-winsの要件を明確にする。最後の未送信位置は離脱時もbest-effort処理。
- **判定証拠:** 入力50回/scroll連打でPUT数と位置遅延、2端末での最終値、logout/project切替のscope漏れなし。

### C41 — /api/platform/v1/statusでremote modeの場合2度GitHub observe、persistence scanを実行

- **優先/段階/基準時状態:** P0 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/server.ts#L1153-L1235)
- **具体化した作業:** hosted /api/platform/v1/statusのremote before/after observationは一貫性証明なので無条件に1回へ削らない。scanとactivityの条件分岐をinstrumentし速いlocal表示とauthoritative censusを分離可能か検討。
- **判定証拠:** k3s probe/reconcileの完了時間、API GitHub回数、remote更新中は必ずunknown、誤complete=0。hosted fixtureなしはNOT_CHECKED。

### C42 — Server recent-activity upsertが全state read/modify/fsync/rename/dir sync

- **優先/段階/基準時状態:** P1 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/recent-activity-store.ts#L93-L132)
- **具体化した作業:** recent-activity-storeのrename/fsyncコストをtraceし、必要なら既存fsync安全性を保つbounded append/compactionを比較。SQLite等を前提にしない。
- **判定証拠:** 連続PUT/多端末時のp95/IO、kill -9直後の復元、partial record処理、author key永続性。

### C43 — Coreには既にproject/events SSEが存在しクライアントは購読していない

- **優先/段階/基準時状態:** P1 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/server.ts#L1610-L1619)
- **具体化した作業:** 既存project events SSEにローカル変更通知だけを限定適用できるか評価。GitHub外部pushはSSEの権威とせず独立remote freshnessを維持。
- **判定証拠:** poll/request削減、resume/reconnect/scope切替、subscription cleanup、missing event時の外部変更検知。

### C44 — /api/version→session→projects→details→tree のbootstrapウォーターフォール

- **優先/段階/基準時状態:** P1 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/application/SharedApplication.tsx#L682-L765)
- **具体化した作業:** version→session→project→tree waterfallをnetwork traceし、情報重複の小さなbootstrap readだけ統合。巨大な全Tree/全文レスポンスにしない。
- **判定証拠:** loopback+RTT追加環境でTTI/API count/bytes、認可切替/権限否認/abort時の同値性。

### C45 — FastifyだがrouteHandlerが巨大な1ファイルに集中

- **優先/段階/基準時状態:** P1 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/server.ts#L1450-L2240)
- **具体化した作業:** server.tsの機能別route分割は検証容易性またはrequest hot costの根拠がある範囲に限定。横断的なauth/error hookを勝手に再実装しない。
- **判定証拠:** router path/contract/permission/error serializationテスト、request p95比較。サイズだけが理由なら見送り。

### C46 — 静的ファイルGETで毎回realpath/lstat/readFileしている

- **優先/段階/基準時状態:** P1 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/server.ts#L292-L374)
- **具体化した作業:** 静的asset handlerのrealpath/lstat/readFile経路を測定。deploy時のfixed manifestとsafe canonical pathを利用する場合もsymlink越境防止を保持。
- **判定証拠:** asset 1000 GETのFS syscall/TTFB、CSP nonce/404/unsafe pathsと更新されたassetの正しさ。

### C47 — Assetのエントリ名main.js/styles.cssはURLが固定である

- **優先/段階/基準時状態:** P1 / G3 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/vite.config.ts#L1-L117)
- **具体化した作業:** Viteの固定main.js/styles.cssをcontent-hash assetにするときmanifest・HTML nonce・version/rollback時のキャッシュ整合を一緒に扱う。C46と統合実施。
- **判定証拠:** 初回/2回目load転送bytes、古いキャッシュの起動/upgrade、コアとmobile/desktopの両variant、CSP安全性。

### C48 — HTTP JSONが12MiB上限でbase64ファイルを含む

- **優先/段階/基準時状態:** P2 / G4 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/server.ts#L47-L55)
- **具体化した作業:** 12MiB JSONに対するbase64 attachmentの実際の失敗条件を確認。C30/C57と一体でbounded blob API設計し、未要求の任意サイズアップロードを先行実装しない。
- **判定証拠:** JSON limit境界/画像10MiBでピークRSS、拒否コード、token/path/revision、原稿と添付の部分保存不整合0。

### C49 — APIにはjob SSEとproject SSEの二系統が存在

- **優先/段階/基準時状態:** P2 / G4 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/server.ts#L1610-L1645)
- **具体化した作業:** job/project二系統SSEを接続数・replay/queueで測り、共通Envelopeが実際に必要か判定。unobservedならprotocol rewriteは実施しない。
- **判定証拠:** reconnect/backpressure/unknown cursor/author scope/切断後タイマー回収の挙動、既存API互換。

### C50 — Scene/Manuscript中心の操作型がCore全体を規定

- **優先/段階/基準時状態:** P0 / G4 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/contracts/src/index.ts#L46-L64)
- **具体化した作業:** Scene/Manuscript特化をCore汎用File/Snapshot APIに薄くadaptする費用を評価。公開Plugin SDKや実行隔離の実装は別契約として扱う。
- **判定証拠:** 旧scene端末の全read/write/save/history同値、任意ファイル用途が実在しないなら設計決着のみ。

### C51 — Mutationを単なるファイルwriteに落とすとWriter安全性を失う

- **優先/段階/基準時状態:** P0 / G4 / 契約固定。Wave0分類: Invariant、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/contracts/src/index.ts#L49-L108)
- **具体化した作業:** 既存Snapshot+read-set+write-set+expected revision+receipt、単一Writer、epoch/fenceを改善対象ではなく強制不変条件として台帳に固定。
- **判定証拠:** stale read/write・別author・lossy publish/unknown・writer replacementで失敗閉鎖、FileRevisionと受理時の世代一致。

### C52 — 有効/無効機能はコンパイルprofileで分離済

- **優先/段階/基準時状態:** P0 / G4 / 契約固定（全profile未認証）。Wave0分類: Invariant、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/scripts/profile-build.mjs#L10-L58)
- **具体化した作業:** Core/full profileのclosure確認を強制不変条件化。disabledのmoduleはimport/timer/network/workerが発生しない証拠を収集。
- **判定証拠:** profile build/audit:core、network idle/worker count、toggle後cleanup。測定がない組合せはNOT_CHECKED。

### C53 — ModuleIdとbuild generatorが9種をハードコード

- **優先/段階/基準時状態:** P1 / G4 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/contracts/src/index.ts#L1-L7)
- **具体化した作業:** 9種hardcodeをManifestへ一般化する変更は追加Module時の実コスト/保守障害が根拠。Plugin Platform P0-P5は本Goalに引き込まない。
- **判定証拠:** manifest schema/duplicate/unknown capability/disabled build gate、既存9 module起動同値。未必要なら見送り。

### C54 — SnapshotReaderはread/list/listRevisionsのみ

- **優先/段階/基準時状態:** P1 / G2 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/contracts/src/index.ts#L84-L99)
- **具体化した作業:** SnapshotReaderのbounded paging/bulk readが必要なconsumerを特定。C21/C22/C35を再利用し、pagination tokenをsnapshot/revisionに固定。
- **判定証拠:** 10k list/readの呼出し回数/p95、後続pageの同一snapshot性・scope/path/symlink・binary semantics。

### C55 — BrowserのPanelContributionはlazy mount + AbortController実装済

- **優先/段階/基準時状態:** P1 / G4 / 契約固定。Wave0分類: Invariant、工数: Medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/contributions/ContributionHost.tsx#L94-L174)
- **具体化した作業:** PanelContributionのlazy mount/AbortController/disposeを保護。stable capabilityが必要な未実装consumerがあれば最小Adapterで提供。
- **判定証拠:** disable/scene切替後に非表示timer/worker/network 0、late callbackで旧authorのstate上書きなし。

### C56 — Coreローカルファイル操作を外部機能に無制限に公開しない契約がある

- **優先/段階/基準時状態:** P1 / G4 / 契約固定。Wave0分類: Invariant、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/contracts/src/index.ts#L177-L194)
- **具体化した作業:** 権限のない外部機能がCore FS/Git内部へ触れない既存境界を不変条件とする。trusted moduleとuntrusted external pluginを混同しない。
- **判定証拠:** 異repo/read/propose/fs越境拒否、permission revocation後アクセス不能、token/secret露出なし。

### C57 — Binary画像はChangeOperationのbase64 contentに入り得る

- **優先/段階/基準時状態:** P2 / G4 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/contracts/src/index.ts#L46-L52)
- **具体化した作業:** binary base64の大容量化はC30/C48と同じblob stream問題として統合。小さな既存ChangeOperationは変更せず、参照hash/stream版の必要性を実測判断。
- **判定証拠:** 10MiB attachment/32MiB boundary、途中abort/復元、hash一致、snapshot/receipt、サイズ上限・memoryを測定。

### C58 — 起動時のJS量・Core-only RSS/CPU計測の自動回帰が見当たらない

- **優先/段階/基準時状態:** P0 / G0/G5 / Wave 0計測基盤導入済。Wave0分類: Wave 0 delivered、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/scripts/audit-runtime-deps.mjs#L1-L127)
- **具体化した作業:** 既存Wave 0のBrowser/Node synthetic harnessと外部raw archiveを正本にし、W1現行mainで再計測。未実施のhidden/OCI/native IMEはNOT_CHECKEDのまま。
- **判定証拠:** same host/fixtures/toolchainでp50/p95/p99/JS gzip/RSS/CPU/fork/network比較。予算は測定後に決め、CIを新設しない。

### C59 — Viteはlauncher / desktop / mobileを独立buildするがlauncherでAppを静的import

- **優先/段階/基準時状態:** P1 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/src/main.tsx#L1-L12)
- **具体化した作業:** launcherがAppをstatic importしている経路でDesktop/Mobileコードの初期配信closureを計測し、必要ならdynamic importでentrypoint分割。
- **判定証拠:** launcher/desktop/mobileのgzip bytes・初回描画/戻りロード、theme/theme nonce、direct routing、Core/full build同値。

### C60 — Vite cssCodeSplitがfalse

- **優先/段階/基準時状態:** P1 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Defer、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/app/vite.config.ts#L1-L117)
- **具体化した作業:** cssCodeSplit=falseの切替試験をし、above-fold CSS減の利益とstyle recalculation/FOUCを比較。単にファイルを増やさない。
- **判定証拠:** 初期CSS gzip, 1st paint, desktop/mobile/light/dark/paper、route transitionと印刷の表示差異。

### C61 — root pnpm buildがCore profileでも全moduleをbuild

- **優先/段階/基準時状態:** P1 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: Low–medium。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/package.json#L1-L38)
- **具体化した作業:** root pnpm buildがcoreでも全moduleをbuildする現状を時間計測。production dependency closureを変えずcore専用target build graphを検討。
- **判定証拠:** clean build seconds/cache hit、typecheck/tests/contracts/core/full profile/audit:core。source importを残す偽削減禁止。

### C62 — Dockerfile runtimeはnode:24 slim+git+tiniで複数段OCIを使用

- **優先/段階/基準時状態:** P1 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Measure next、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/Dockerfile#L55-L93)
- **具体化した作業:** Dockerfile/node:24-slim/git/tini Core imageのcold start、size、idle RSS/CPUを実機測定。不要ファイル削減はuser/volume/signal semanticsを保てる場合に限る。
- **判定証拠:** Podman/Docker core/full local OCI health/readiness/assets、UID、/dataと/history、SIGTERM drain、image bytes・起動p95。

### C63 — 各CoreStore cacheが独立上限・全体制限なし

- **優先/段階/基準時状態:** P2 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/core/src/index.ts#L1069-L1086)
- **具体化した作業:** C31と同一cache-budget課題として処理し二重のcache governorは作らない。pressure-aware evictionを検証できる場合のみ追加。
- **判定証拠:** 多repo/100k files/idle時のpeak RSS、cache hit/p95、OOM behavior、C31の同一測定表を使用。

### C64 — エラー/ログと性能トレースが共通のrequest IDで統合されていない可能性

- **優先/段階/基準時状態:** P2 / G5 / 未決着（Wave0分類に従って要調査）。Wave0分類: Investigate、工数: High。 [監査時のコード](https://github.com/yohn-jp/scriptorium/blob/546882f05a5f4b4a412e64c7aec868d401ce8ca9/packages/api/src/server.ts#L483-L561)
- **具体化した作業:** instrumentationだけが必要なら既存request/context IDでBrowser↔API↔Git/IDB correlationを追加。秘密情報・原稿本文はトレースに含めない。
- **判定証拠:** 主要p95原因をspanに紐付けられた割合、overhead/RSS、trace off時のCPU、error/conflict時のscope保護。

## 結果台帳と停止条件

最後に同じRepository内の`docs/performance/CORE-64-RESULTS.md`へ64行を保存する（**未着手の時点で偽の完了行を埋めない**）。必須列: ID、GATE、判断（IMPLEMENTED / VERIFIED_EXISTING / DECLINED / BLOCKED）、baseline/head、変更したpath、比較scenario、before→after値、semantic regression、実行した検証command/result、証拠への相対link、残留リスク/再検討条件。1件に複数コミットがあれば最終統合HEADから追跡可能にする。

最後の合格条件: (1) 64/64に根拠ある決着（BLOCKEDは未完了として分離）、(2) 採用した変更は全件mainにcommit/push、(3) Core/Fullの必要な検証と安全性ゲートを報告、(4) 不採用は元に戻すか未採用として明示、(5) 性能改善値は各fixture単位で比較し、別条件の数字を混ぜない。(6) public Plugin Platformや新CIなどスコープ外実装がない。**必要な実機/外部実証がBLOCKEDならGoal完了とは主張せず、独立候補の前進成果を保存して具体的阻害要因のみ報告する。**

C01/C04/C13/C22/C58の既存W1/W0統合事実を「再コミット予定」のように書き直してはいけない。C22のwarm regression、C04/C13のLong Task tradeoff、W0/W1の測定限界は、改善判断が変わらない限りそのまま記録し続ける。
