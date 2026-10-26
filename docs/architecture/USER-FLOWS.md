# Proprium 全機能の画面遷移

**Status: normative interaction contract, except F00 which maps the connected source surfaces.** [画面台帳](SCREEN-CATALOG.md)のIDを使う。F01以降は不足部分を含めた目標契約であり、存在しないボタン/APIを実装済みとは扱わない。[UIアーキテクチャ](UI-ARCHITECTURE.md)が状態と認可の所有者を定める。

矢印は「利用者操作／結果／guard」を表す。画面遷移だけではcommit、publish、権限付与、再送を起こさない。X04は呼出元に紐付く失敗状態であり、editorを置き換える万能error pageではない。成功・空・拒否・中止・失敗を同一のspinnerに潰さない。

## F00 — 接続済みソースの画面構成

```mermaid
flowchart TD
  Root["main.tsx / BrowserRouter / HostApp"] --> Mode{"HostAppのUI mode"}
  Mode --> Desktop["DesktopShell"]
  Mode --> Mobile["MobileShell / view query"]
  Desktop --> HeaderSettings["トップバー: 設定modal"]
  Desktop --> Empty{"Workspace選択済みか"}
  Empty -->|未選択| Picker["左: library内にrecents"]
  Empty -->|未選択| LocalStart["主領域: local Workspace作成"]
  Empty -->|未選択| Connect["右: Gateway設定・OAuth code・待機/中止・repository picker"]
  Empty -->|選択済み| Panels["Workspace: editor / outline / inspector / history / review"]
  Mobile -->|Workspace選択時| Views["library / writing / inspection / tools / settings"]
  Views --> Mapping["outline / editor / inspector / review / inspector"]
  Views -->|settings| SettingsCard["専用view: 外観・Git author・接続設定・Desktop切替"]
  Mapping --> Panels
  Panels --> Editor["RestoredEditor / SceneEditor / journal"]
  Panels --> Tools["PluginPanel + LiveMcpPanel / retained portal"]
  Root --> Recovery["StorageRecoveryDialog / shell外"]
```

Desktopの設定contentはトップバーから開くmodal、MobileはWorkspace navigation内の`view=settings`専用viewである。上図は表示の正常性ではなく接続関係である。local startもpickerから利用できる。認証の期限／再試行／復帰先を揃える部分などは引き続き目標契約である。

## F01 — 起動・ローカル開始・再訪

```mermaid
flowchart TD
  H00["H00 shell起動"] -->|利用可能| H01["H01 Home / Workspace一覧"]
  H00 -->|必須assetまたはstorage不可| X04["X04 原因と再試行 / 未保存保証なし"]
  X04 -->|利用可能性を再確認| H00
  H01 -->|ローカルで新規作成| H02["H02 local Workspace作成"]
  H02 -->|local identity・保存領域を検証| W01["W01 Workspace"]
  H02 -->|中止| H01
  H01 -->|この端末のWorkspaceを再開| LocalCheck{"local Gitを開けるか"}
  LocalCheck -->|可 / 認証不要| W01
  LocalCheck -->|storage_unknown| X02["X02 整合性検証 / F16"]
  LocalCheck -->|evicted・存在しない| X04
  H01 -->|GitHubから開く| A01["A01 接続 / F02"]
  W01 -->|Workspace一覧へ / dirtyならF04| H01
```

H02の作成とlocal再開はpickerから接続済みである。作成されるのはbrowser storageに保存する空のgeneric local Git Workspaceで、文書は別に作成する。これはnovel structureを認識したりWriter pluginを実装したりするものではない。remote identityを捏造せず、cached shell/local dataがないcold offlineと、既存Workspaceのoffline再開を分ける。GitHubからの再取得で未公開localデータが戻るとは説明しない。

## F02 — Gateway選択とGitHub Device OAuth

```mermaid
flowchart TD
  A01["A01 Gateway origin・信頼確認"] -->|明示的にGitHub接続| Begin{"設定とdevice-code応答"}
  Begin -->|有効| A02["A02 code・承認link・期限・中止"]
  Begin -->|未設定・不正・到達不可| X04["X04 接続設定または再試行"]
  X04 --> A01
  A02 -->|codeコピー / 承認先を開く| A03["A03 外部GitHub本人認証・承認"]
  A03 -->|承認待ち / Hostへ戻る| A02
  A02 -->|authorization_pending| A02
  A02 -->|slow_down / 指定intervalを守る| A02
  A02 -->|成功 / tokenから本人と権限を確認| H03["H03 repository選択 / F03"]
  A02 -->|拒否・期限切れ| Retry["理由表示 / 新しいcodeで再試行"]
  Retry -->|再試行| A01
  A02 -->|中止・戻る| Cancel["polling停止 / 遅延応答を無効化"]
  Retry -->|中止| Cancel
  Cancel --> Origin["元のH01・S01・G03へ / local入力維持"]
```

code、外部承認link、残り時間、状態、キャンセルを別の読み取れる領域に置く。popupがブロックされても通常linkとcopyで進める。Device Flowの期限付きpollingは[GitHub仕様](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)に従う。これはMCPや通常画面の定期pollingを許可するものではない。完了時に元の要求へ戻っても、publishを自動実行しない。

## F03 — repository・branch・Workspace選択

```mermaid
flowchart TD
  H03["H03 repository一覧・本人・branch"] -->|一覧0件・権限なし| Empty["空状態 / account・権限確認"]
  Empty -->|再認証| A01["A01 F02"]
  H03 -->|選択して開く| Check{"immutable repository ID・branch・pull権限"}
  Check -->|401| A01
  Check -->|403・404・branch不在| X04["X04 選択を維持して修正"]
  X04 --> H03
  Check -->|有効| Open["local領域を開く / 明示したremoteを取得"]
  Open -->|空repo・正常・local-ahead| W01["W01 Workspace / 状態を表示"]
  Open -->|分岐| G04["G04 conflict / F08"]
  Open -->|local Git不確実| X02["X02 F16"]
  Open -->|network失敗 / localデータあり| W01
  Open -->|network失敗 / localデータなし| X04
  H03 -->|中止| H01["H01 Home"]
```

local-only Workspaceをremoteへ結び付ける場合も選択されたID/branchと既存local内容を明示し、同意とrevision検証を行う。既存の別Workspaceを暗黙に上書きしない。bindingが未成立ならremote操作は利用不可と理由を示す。新規repository作成やbranch管理をこの選択画面に捏造しない。

## F04 — ファイル操作・編集・離脱guard

```mermaid
flowchart TD
  W01["W01 Workspace"] --> W02["W02 files / 新規path"]
  W02 -->|textを開く・新規path検証| E01["E01 editor"]
  W02 -->|binary| E05["E05 情報のみ / 編集不可"]
  W02 -->|path変更・rename/move| W02
  W02 -->|file・ZIP取込 / overwrite確認| Import["local worktreeへ適用"]
  Import --> W02
  W02 -->|保存済みfilesをZIP書出し| Archive["ファイルのみ / 履歴なし"]
  E01 -->|現在の文書を書出し| Document["現在のeditor本文"]
  E05 -->|戻る| W02
  E01 -->|入力・undo・IME| Dirty["editor dirty / journalは別途記録"]
  Dirty -->|Save draft / expected revision一致| E01
  Dirty -->|保存失敗・stale revision| X04["X04 入力保持 / 再確認"]
  X04 -->|再試行・比較| Dirty
  Dirty -->|file・Workspace変更 / 終了要求| X01["X01 保存して移動 / 破棄 / 留まる"]
  X01 -->|保存成功または明示破棄| Destination["選択先へ / Workspace終了ならLive失効"]
  X01 -->|保存失敗・留まる| Dirty
  E01 -->|削除要求| Confirm["path・未保存入力・local削除を確認"]
  Confirm -->|中止| E01
  Confirm -->|承認 / revision一致| W02
  Confirm -->|stale・失敗| X04
  E01 -->|local変更を確認| G01["G01 F07"]
```

local startとgeneric file browserの作成・削除・path変更・import/exportは接続済みである。個別文書の書出しは現在のeditor本文を使い、ZIP書出しは保存済みworktreeのみを含み、Git履歴・未保存textを含まない。取込は最大256 files、展開後64 MiB、ZIP 68 MiBまでで、既存pathの置換前に確認する。これらはlocal worktree操作で、共有反映にはcommitとpublishが必要。非同期処理中にさらに入力されたtextも保持する。レイアウト変更・mode変更は本文の破棄ではなくjournal flushで扱う（F13/F14）。

## F05 — 読書・preview・組版・印刷

```mermaid
flowchart TD
  E01["E01 editor"] -->|読書 / 入力をflush| E02["E02 reading・preview"]
  E02 -->|編集に戻る / cursor保持| E01
  E01 -->|preview・縦横・集中の切替| E01
  E02 -->|縦横・page移動| E02
  E01 -->|文字と組版| E03["E03 字体・サイズ・行間・字送り・幅・preset"]
  E02 --> E03
  E03 -->|適用 / viewだけ更新| View["元のE01/E02へ"]
  E03 -->|設定保存不可| Notice["現在の表示は維持 / 保存不可を通知"]
  Notice --> View
  E01 -->|印刷| Print["外部ブラウザー印刷dialog"]
  E02 -->|印刷| Print
  Print -->|完了・中止| View
```

入力補助は選択位置へ文字を挿入する編集操作。組版・印刷はGit commit/publishではない。集中解除、keyboard操作、読書pageの往復で文書・選択・IMEを取り違えない。

## F06 — スクラッチ・添付・回復

```mermaid
flowchart TD
  E01["E01 editor"] --> E04["E04 scratch / 本文とは別"]
  E04 -->|メモ入力| Journal["同一Workspaceのjournalへ記録"]
  E04 -->|画像を添付| Picker["外部file / camera picker"]
  Picker -->|中止・権限拒否| E04
  Picker -->|読込成功| Journal
  Picker -->|読込失敗| X04["X04 既存メモ・添付を保持"]
  Journal -->|記録成功| E04
  Journal -->|記録失敗| X04
  X04 -->|再試行| E04
  E04 -->|回復一覧から続ける| X03["X03 現draft保護後に回復"]
  X03 --> E04
  E04 -->|Checkpoint / author・clean worktree確認| Commit["meta/scratchと添付をlocal commit"]
  Commit -->|成功| G02["G02 local履歴 / 未公開"]
  Commit -->|失敗・他の未commit変更あり| E04
  E04 -->|閉じる / pending添付とjournalをflush| E01
```

スクラッチCheckpoint成功は本文の保存やGitHub公開を意味しない。失敗したdraftを消さない。回復候補を開くだけでremoteを上書きしない。

## F07 — 変更確認・local commit・履歴

```mermaid
flowchart TD
  E01["E01 Save draft済み"] --> G01["G01 path・差分・author・message確認"]
  G01 -->|編集bufferがdirty| E01
  G01 -->|author不足| Author["Git author設定 / 本人認証とは別"]
  Author --> G01
  G01 -->|変更なし| Clean["commitしない / clean表示"]
  G01 -->|明示commit / expected HEAD・path検証| Commit["Hostの単一writerでstage・commit"]
  Commit -->|成功| G02["G02 local履歴・OID / GitHub未公開"]
  Commit -->|stale・失敗| X04["X04 変更維持 / 状態再取得"]
  Commit -->|storage_unknown| X02["X02 F16"]
  X04 --> G01
  G02 -->|Refresh・履歴確認| G02
  G02 -->|公開を選ぶ| G03["G03 F08"]
  G02 -->|編集に戻る| E01
  Clean --> E01
```

G01ではlocal HEADとの差分を確認できる。text diffを表示し、binaryはbyte sizeのみを示す。commitを有効にするにはすべての変更pathを確認し、実行時には全変更pathをまとめてstageしてlocal commitする。G02には直近40件の履歴、選択commitのdiff、対象commitで変更されたfileだけをlocal worktreeへ戻す操作が接続されている。restoreは確認とrevision guardを通し、commit/publishしない。path衝突・symlink・実行mode変更を含むcommitはrestoreできない。rebase/mergeや履歴改変は提供しない。Checkpointはlocal commitと同義にし、独立した保存機構を増やさない。

## F08 — Fetch・Pull・Publish・conflict・remote-unknown

```mermaid
flowchart TD
  G03["G03 remote操作選択 / 対象repo・branch表示"] -->|未認証・失効| A01["A01 再認証 / F02"]
  G03 -->|Fetch / 有効なread権限| Fetch["remote objects・refs取得 / worktree不変"]
  G03 -->|Pull / dirty guard通過| Compare{"remoteとlocalを比較"}
  Fetch -->|結果確認| G03
  Compare -->|同一・fast-forward・local-ahead| G03
  Compare -->|分岐・未保存変更と衝突| G04["G04 双方のHEAD・local保持・解決先"]
  G04 -->|履歴を確認| G02["G02 F07"]
  G04 -->|解決後に再比較 / 無断merge禁止| Compare
  G03 -->|Publish / clean・local commit・write権限| Publish["expected remote HEADでnon-force更新"]
  Publish -->|exact commit・remote確認| Published["対象OIDをGitHub公開済み表示"]
  Publish -->|remote前進・競合| G04
  Publish -->|応答喪失・結果不明| G05["G05 remote-unknown"]
  G05 -->|書込再送ではなくremote再読込| Verify{"意図したOIDとremoteを照合"}
  Verify -->|公開確認| Published
  Verify -->|別HEAD・競合| G04
  Verify -->|未反映を確認 / 改めて操作選択| G03
  Verify -->|未確認| G05
  G03 -->|offline・403・制限・timeout| X04["X04 原因表示 / local編集は継続"]
  X04 -->|明示再試行| G03
  Published -->|編集継続| W01["W01 Workspace"]
```

Fetch/Pullの失敗もX04へ戻す。Pushの結果が曖昧ならX04の汎用再試行で書込を再送せずG05へ送る。認証復帰・接続回復だけではPublishしない。現在のadapterが提供しない競合解決アルゴリズムをUIが代行せず、履歴・revision確認と明示的な解決先を提供する。

## F09 — プラグイン導入・更新・実行・停止

```mermaid
flowchart TD
  P01["P01 installed plugins / 状態一覧"] -->|ID・version / installまたはupdate| P02["P02 署名・ABI・依存・容量・権限preview"]
  P02 -->|拒否・中止| P01
  P02 -->|署名不正・互換不可・転送失敗| X04["X04 未実行 / 既存verified版を保持"]
  X04 --> P01
  P02 -->|明示同意・検証済みdownload| Disabled["installed / disabled"]
  Disabled -->|capabilityを選びEnable| Idle["enabled-idle / computeなし"]
  Idle -->|Run / snapshotを固定| P03["P03 実行・結果"]
  P03 -->|提案あり| Q01["Q01 F10"]
  P03 -->|完了| Idle
  P03 -->|stale・trap・timeout・missing asset| X04
  Idle -->|Disable| Disabled
  P03 -->|Stop / cancelしてWorker終了| Disabled
  P01 -->|Rollback / retained verified版| Disabled
  P01 -->|Uninstall確認 / leaseとjobを終了| Removed["未導入 / workspace filesは不変"]
  Removed --> P01
```

導入と有効化は別。update後の追加権限は再同意する。cached verified bytesが不足するoffline実行は利用不可と表示し、編集は止めない。source上のStopボタンの存在を、全実行状態でキャンセル可能な証明にはしない。P03は検証済みHost-rendered contributionのみを表示する。

## F10 — plugin／MCP提案の共通review

```mermaid
flowchart TD
  P03["P03 plugin結果"] --> Q01["Q01 path・内容・期待revision・出所"]
  M02["M02 MCP proposal"] --> Q01
  Q01 -->|Reject / 閉じる| Origin["呼出元へ / file不変"]
  Q01 -->|Approve| Guard{"editor dirty・Workspace世代・read/write revision"}
  Guard -->|dirty| E01["E01 先にlocal保存"]
  Guard -->|stale・scope外・権限不足| X04["X04 未適用 / 再取得・再提案"]
  E01 -->|改めてreview| Q01
  Guard -->|有効| Apply["既存Host mutationでlocal worktreeへ適用"]
  Apply -->|成功| G01["G01 未commit変更 / F07"]
  Apply -->|失敗・不確実| X04
  X04 -->|状態確認 / 自動再適用しない| Q01
```

閉じるだけでRejectと扱わず、未処理提案を保持する。承認はcommit/publishの許可ではない。previewの切り詰め表示だけで全変更を承認させず、完全な対象と差分へ到達できること。切断した外部要求を再接続後に自動replayしない。

## F11 — Active Browser HostへのMCP中継

```mermaid
flowchart TD
  W01["W01 Browser HostがWorkspaceを開く"] -->|自動SSE接続| Active["Gatewayが最新接続HostをActiveに設定"]
  Active --> Client["MCP ClientがCloudflare Access認証"]
  Client -->|tools/list| Fixed["常に8ツールを列挙"]
  Client -->|tools/call + repository_id| Resolve["Active Hostが対象Repositoryとbranchを解決"]
  Resolve -->|既知・利用可能| Run["Git/ファイル/Plugin実行"]
  Resolve -->|未登録・曖昧| Failed["明示エラー / 暗黙fallbackなし"]
  Run -->|Proposal| Q01["Q01 Browser Hostで明示レビュー / F10"]
  Run -->|結果| Client
  Active -->|タブ・通信切断| Lost["Activeなし / tools/list維持・callsはUnavailable"]
  Lost -->|別Hostが新規接続| Active
```

Gatewayはリポジトリを保持せず、同時に複数のBrowser Hostが接続していても最初の接続を初期Activeとし、以後はフォーカスされたBrowser Hostが明示的にActiveを引き継ぐ。Active切断後は古い接続へ暗黙の切替をしない。ユーザーのOwner Key、個別MCP Client Token、クライアント権限・ツール公開選択UIは存在しない。

## F12 — repository_id付きMCP呼出し

```mermaid
flowchart TD
  Client["MCP Client"] -->|Cloudflare Access| Gateway["Gateway"]
  Gateway -->|tools/list| Registry["固定8ツール / 接続不要"]
  Gateway -->|tools/call| Active{"Active Browser Host?"}
  Active -->|なし| Unavailable["503 Unavailable"]
  Active -->|あり| Repository{"repository_idとbranchを解決"}
  Repository -->|解決不可| Failed["repository_unavailable / ambiguous"]
  Repository -->|解決成功| Tool["対象Repositoryの処理"]
  Tool -->|読み取り| Client
  Tool -->|提案| Review["Browser Hostが内容・revisionを承認"]
  Review -->|明示承認| Worktree["ローカルWorktreeへ適用。commit/publishなし"]
```

`repositories_list` は引数なしでローカル既知リポジトリを列挙する。それ以外のツールはimmutable `repository_id` を必須とし、複数branchがある場合は `branch` を要求する。未アクティブRepositoryのPlugin呼出しは明示エラーとする。GitHub OAuthの有無や公開GitHub HEADはローカルWorktreeの黙示的な切替を許可しない。ブラウザーが閉じれば実行できないが、ツール一覧は一定とする。

## F13 — Desktop配置・panelの生存期間

```mermaid
flowchart TD
  W01["W01 Desktop Workspace"] --> S02["S02 layout / presets / panels"]
  S02 -->|Writing・Research・Review / show・hide・tab・split・dock・float| Flush{"editor・scratch journal flush"}
  Flush -->|失敗| Stay["旧配置と入力を保持 / 再試行"]
  Stay --> S02
  Flush -->|成功・要求世代が有効| Layout["新配置 / 同一editor・plugin・Live instance"]
  Layout -->|resize・maximize・restore| Layout
  Layout -->|Save layout| Save{"非secret設定をローカル保存"}
  Save -->|成功| W01
  Save -->|保存不可| Notice["現在の配置は利用可 / 永続化失敗表示"]
  Notice --> W01
  W01 -->|保存済みlayout不正| Default["安全なWriting配置 / 明示保存まで勝手に上書きしない"]
  Default --> S02
```

drag以外のMove panelフォーム、keyboardによるtab/resize、hidden panel再表示を維持する。最後の必要な面を閉じて操作不能にしない。layout保存はGitHub保存ではない。

## F14 — Mobile navigation・sheet・mode切替

```mermaid
flowchart TD
  W01["W01 Mobile Workspace"] --> Nav["作品 / 書く / 確認 / 道具 / 設定"]
  Nav -->|tap・Back・history・view変更| Guard{"journal flush・scope・navigation世代"}
  Guard -->|不可| Stay["旧view・URL・入力を保持 / 再試行"]
  Guard -->|可| View["対応panel / focus・scroll復帰"]
  View -->|書く| E01["E01 editor / keyboardとIMEを保持"]
  E01 -->|構成・保存状態を参照| Sheet["outline / inspector sheet"]
  Sheet -->|閉じる・Back| E01
  E01 -->|読書・page操作| E02["E02 reading / F05"]
  View -->|設定| S01["S01 settings"]
  S01 -->|Desktopへ / flush成功| Desktop["DesktopShell / 同じWorkspace"]
  Desktop -->|Mobileへ / flush成功| W01
  Stay --> Nav
```

sheetのdismissでtriggerへfocusを戻す。keyboard表示・safe area・orientationで主操作を隠さない。幅が変わるだけでeditorを作り直さない。Workspace未選択時はH01へ誘導し、使えない空panelを主操作にしない。モード切替は明示選択を尊重する。

## F15 — 設定・account・接続先変更

```mermaid
flowchart TD
  W01["W01 またはH01"] --> S01["S01 設定入口"]
  S01 -->|ライト・ダーク・紙 / UI mode| Appearance["非secret preference適用 / 保存失敗は通知"]
  Appearance --> S01
  S01 -->|組版| E03["E03 F05"]
  S01 -->|Git author| G01["G01 commit設定 / F07"]
  S01 -->|Gateway変更| A01["A01 origin信頼確認 / F02"]
  A01 -->|既存Liveあり| Stop["旧接続を明示停止・失効してから変更 / F11"]
  Stop -->|新originを確認して設定 / 秘密の再利用なし| S01
  S01 -->|GitHub sign out| Signout["GitHub session終了 / local files・commitsを保持"]
  Signout --> S01
  S01 -->|MCP接続状態の確認| M03["M03 接続先URLとActive状態 / F11"]
  S01 -->|戻る| W01
```

現在、設定contentはDesktopではトップバーから開くmodal、MobileではWorkspace navigation内の専用settings viewに表示され、Desktop切替も含む。外観、Git author、GitHub接続状態、Gateway URLとAccess linkを扱う。shell headerにもthemeとGitHub connect/sign-out操作があるため、全設定をまとめたDesktop settings pageではない。Proprium MCP認証TokenやOwner Keyは発行も保存もしない。GitHub OAuth Tokenは既存どおりブラウザー内で保持し、MCP認証には使わない。Gateway接続先変更時は新Originへの接続を再確立する。

## F16 — 不確実な保存・journal回復・機能別error

```mermaid
flowchart TD
  W01["W01 開く・操作・再訪"] -->|storage_unknown| X02["X02 shell外の整合性検証dialog"]
  X02 -->|検証する| Verify["既存Browser Git verifyStorage"]
  Verify -->|成功だけmarker解除| W01
  Verify -->|失敗| X02
  X02 -->|閉じる| Guarded["書込guard維持 / 再度検証する入口を表示"]
  Guarded -->|Git保存状態を確認| X02
  W01 -->|journal回復候補あり| X03["X03 文書・作者・origin・revision確認"]
  X03 -->|明示的に開く| E01["E01 editorのdraft / remote未変更"]
  X03 -->|scratchを続ける| E04["E04 F06"]
  X03 -->|採用せず戻る| W01
  W01 -->|quota・network・権限・plugin等の失敗| X04["X04 機能と影響範囲を表示"]
  X04 -->|明示再試行 / 読取で状態確認| Origin["失敗した機能の入口へ"]
  X04 -->|利用不可の任意機能を閉じる| W01
```

markerを消すためのresetやデータ削除は禁止。回復不能なevictionでは未公開データを救出済みと称さない。ブロッキングerrorを高さ制限のあるstatus shelf内だけに置かない。X04のretryはmutationの無条件再実行ではない。

## F17 — Gateway設置者・Linux CLI・統合user service・更新

```mermaid
flowchart TD
  O01["O01 main pushで自動公開された最新Gateway releaseを解決"] --> Verify["Linux asset・API digest・SHA256SUMS・manifestを同一releaseで検証"]
  Verify -->|失敗・releaseなし| Retry["既存binary不変 / 原因修正・再試行"]
  Retry --> O01
  Verify -->|成功 / XDG user領域へ配置| O02["O02 origin・OAuth client ID・Tunnel secret fileを設定"]
  O02 --> Service["O03 Gatewayとpinned cloudflaredを一つのsystemd --user serviceで管理"]
  Service -->|設定・Tunnel失敗| O02
  Service -->|local・公開経路・認証を段階検証| Ready["稼働状態 / Hostへ接続先を案内"]
  Ready -->|所有者の明示公開| M01["M01 F11"]
  Service -->|更新／rollback / active MCP時は確認または--maintenance| O04["O04 stage・検証・切替"]
  O04 -->|取得・検証失敗 / 現行binary維持| Service
  O04 -->|新binaryとhealth check成功| Service
  O04 -->|起動・health失敗| Rollback["旧Gateway/cloudflared releaseへ復旧"]
  Rollback --> Service
  Service -->|停止・再起動| Lost["Live session終了 / 再接続・再認可が必要"]
```

Linux amd64/arm64の`proprium` CLIがlatestのGateway releaseを選択し、pinned `cloudflared`とともにuser領域へ配置して、両者を一つのsystemd user serviceで管理する。main push後にrelease workflowが検証済み資材を自動公開する。非対話設定はsecret fileをデータとして読む。Cloudflare TunnelやDNSの作成は行わない。active MCP connectionがあると通常操作は拒否され、対話では確認し、非対話では失敗する。`--maintenance`は明示的にsessionを終了させてservice変更を許可する。再起動後のsession・認可・未確定mutationは復元しない。継続的な自動更新・再起動を無断で有効にしない。詳細は[UIアーキテクチャ](UI-ARCHITECTURE.md)と[Gateway operations](../deployment/GATEWAY.md)を参照する。
