# Proprium 機能・画面台帳

**Status: source-grounded inventory and normative navigation vocabulary.** 「画面」はページだけでなく、パネル、ダイアログ、シート、外部認証画面、運用端末の操作面を含む。ソース上の接続を記録するもので、本番表示・実機動作の認定ではない。対象ソースのcommitと検証結果はPRに記録し、この文書には時点報告を置かない。

[全遷移図](USER-FLOWS.md)が利用者の操作契約、[UIアーキテクチャ](UI-ARCHITECTURE.md)が状態・責務の契約である。[Workspace UX](WORKSPACE-UX.md)の編集継続性とDesktop/Mobile分離を維持する。

## 1. 棚卸しの境界

Browser Hostの入口から到達するUIを対象にする。`main.tsx`は`BrowserRouter`内に一つの`HostApp`をmountする。`/desktop`・`/mobile`は初期モードの選択に使われ、画面別の独立したアプリケーションではない。Mobileの`view=library|writing|inspection|tools|settings`も、認証・保存状態を表すものではない。

DesktopはWorkspace未選択時、左の「作品ライブラリ」にrecentsを置き、右の主領域にGateway設定・認証・repository選択のpickerを出す。Workspace選択後は`editor / outline / inspector / history / review`の5パネルを構成する。Mobileは同じ機能を独立したナビゲーションで提示し、`settings`には表示設定カードと`inspector`の対応がある。Desktopに`?view=settings`が残っていても、それだけで独立した設定画面が開いたとは判定しない。

実装上の入口は[Host entry][entry]、機能接続は[HostApp][host]、配置は[DesktopShell][desktop]・[MobileShell][mobile]・[Workspace][layout]を参照する。虫眼鏡風のレールアイコンも実際の遷移先は`inspector`であり、全文検索の実装証拠にはしない。

## 2. 利用者と権限

| 利用者 | 目的 | 必要な権限 |
| --- | --- | --- |
| ローカル利用者 | 作成・再開・編集・local Git・検証済みプラグイン利用 | ブラウザーの利用可能なローカル保存領域。Gateway・GitHubログインは不要 |
| GitHub利用者 | リポジトリ選択・fetch・pull・publish | Device OAuthで得た本人のGitHub権限。Git author名/emailは認証ではない |
| Gateway設置者／Live MCP所有者 | バイナリ運用、Workspace公開、クライアント認可 | OSユーザー領域と必要なCloudflare権限。Live作成はOwner Key |
| MCPクライアント | 接続中Workspaceの許可されたツール呼出し | Workspace・セッション・capabilityに束縛した個別Bearer Token |

共有Gatewayの一般利用者登録・GitHub ID allowlist・組織管理画面は採用済み要件ではない。GitHubログイン成功をGateway所有者認可に読み替えない。

## 3. 機能から実装と導線への対応

「既存」はイベントハンドラーとUI接続を確認できること、「不足」は既存契約に必要だが独立導線や機能接続が揃っていないことを示す。見た目の正常性を意味しない。

| 機能ID | 機能とソース上の到達点 | 制約／不足 | 遷移図 |
| --- | --- | --- | --- |
| FT01 | 起動・Desktop/Mobile選択・オフラインshell：[entry]、[host] | cold offlineとキャッシュ済み再訪を区別する | F00, F01, F14 |
| FT02 | 最近のWorkspace・ローカル再開：[host]の`selectRecent` | 初回ローカル作成ボタンはない。E2E用`openWorkspace`を利用者導線と数えない | F01, F03 |
| FT03 | Gateway URL設定・GitHub接続：[host]の`connectGitHub` | picker内にcode・承認link・待機／repository取得状態・キャンセルあり。期限表示・再試行・呼出元復帰の一貫したtask導線は不足 | F02, F15 |
| FT04 | GitHubリポジトリ・branch選択／open：[host] | branchは入力欄。remote repo作成・branch管理UIではない | F03 |
| FT05 | ファイル一覧・新規path・読込・削除：[host] | rename/import/export UIは確認できない。binaryはbyte数表示で編集不可 | F04 |
| FT06 | CodeMirror入力・Save draft・local journal：[editor]、[scene] | journal記録、worktree保存、Git commitは別操作 | F04, F16 |
| FT07 | 読書・縦横・preview・集中・印刷：[scene] | 同一文書の表示モード。Git操作を伴わない | F05 |
| FT08 | 組版・文字サイズ・行間・字送り・幅・字体・日本語入力補助：[scene] | 表示設定は本文変更や公開ではない | F05, F15 |
| FT09 | スクラッチ・画像／camera picker・回復・Checkpoint：[scene]、[editor] | 本文ではなく`meta/scratch/`。Checkpointはlocal commitまで | F06 |
| FT10 | Git author・変更件数・Commit locally：[host]の`inspector` | 現行commitは変更pathをまとめてstage。ファイル単位diff確認は不足 | F07 |
| FT11 | 履歴一覧・Refresh：[host]の`historyPanel` | 一覧は`log(40)`。詳細diff／履歴復元UIが動くとは主張しない | F07 |
| FT12 | Fetch・Pull・Publish：[host]、[sync] | exact SHA確認、local-ahead、conflict、offline、remote-unknownを区別 | F08 |
| FT13 | プラグイン検証・install/update preview・明示download：[plugins] | trusted registryはHost build設定。任意URLや未知publisherの実行入口ではない | F09 |
| FT14 | capability選択・Enable・Run・Stop/Disable・Rollback・Uninstall：[plugins] | 権限とWorkspace revisionに束縛。contribution一覧は任意UI実装済みの証明ではない | F09 |
| FT15 | plugin提案／MCP提案の確認・ローカル適用：[plugins]、[live] | 現行は別々の表示面。共通のHost mutation契約を守り、commit/publishしない | F10 |
| FT16 | Live MCP opt-in・SSE接続・停止・切断：[live] | Owner KeyはGitHub tokenとは別。常時利用・mobile background保証なし | F11 |
| FT17 | client認可・token一回表示・一覧・失効・実行履歴：[live] | Gateway再起動／session切断後に旧tokenを復活させない | F12 |
| FT18 | Writing/Research/Review・tab/split・float/dock・maximize・Save layout：[layout] | 配置を閉じることと実行終了を区別。保存失敗／invalid layoutを表示 | F13 |
| FT19 | Mobile 5 view・戻る・参照sheet・keyboard／focus保持：[mobile] | Desktopの縮小版にしない。履歴遷移もflushと世代検証の対象 | F14 |
| FT20 | ライト／ダーク／紙、UI mode、Git author、接続設定：[theme]、[host] | 設定が複数箇所に分散。統合入口は契約として整理する | F15 |
| FT21 | unsaved離脱・journal回復・`storage_unknown`検証：[host]、[editor]、[recovery] | native dialogはstatus shelfの外。reset/deleteを検証の代替にしない | F04, F16 |
| FT22 | Gateway release取得・設定・Tunnel・user service・更新：[operations]、[release] | Linux CLIがlatest解決とsystemd user serviceを管理する。Windows/macOSのCLI管理は未対応 | F17 |

## 4. 画面IDと配置契約

IDは機能面の識別子であり、新しいHTTP path/APIの定義ではない。「目標」は新しい実装をこのPRで加える意味ではない。Desktopの認証・初回選択は主領域、Mobileでは専用の全幅タスク面に置き、狭いライブラリペインに押し込まない。

| 画面ID | 面・主な操作 | 現行との関係／所有者 | 主な戻り先 |
| --- | --- | --- | --- |
| H00 | shell起動・利用可能性表示 | 既存entry。Host | H01／X04 |
| H01 | Home／Workspace一覧・切替 | picker/recentsは既存。初回local開始・統一入口は目標。Host | W01 |
| H02 | ローカルWorkspace作成 | 既存local-first契約の未整備導線。remote認証不要 | H01／W01 |
| A01 | Gateway選択・信頼確認・GitHub接続開始 | 接続先設定detailsは既存。信頼確認と呼出元復帰は目標。Host | 呼出元H01/S01/G03 |
| A02 | device code・承認待機・期限・中止・再試行 | code・待機／一覧取得・中止は既存。期限／再試行の整理は目標。Host | A01／H03 |
| A03 | GitHub本人認証・承認／拒否 | 外部GitHub画面。Hostがパスワードを受け取らない | A02 |
| H03 | repository／branch／permission選択 | 既存picker。Host | H01／W01 |
| W01 | 開いているWorkspaceの構成 | 既存shell＋5 panels。Host | H01（離脱guard） |
| W02 | file一覧・新規path・選択 | 既存outline/library。Host | E01／E05 |
| E01 | text編集・Save draft・保護状態 | 既存RestoredEditor/CodeMirror | W02／G01 |
| E02 | 読書・preview・縦横・集中 | 既存editorの表示状態 | E01 |
| E03 | 文字と組版・入力補助 | 既存editor controls | 呼出元E01/E02 |
| E04 | スクラッチ・画像添付・回復一覧 | 既存editor details | E01／G02 |
| E05 | binary情報 | 既存byte数表示。text編集・無断変換不可 | W02 |
| G01 | local変更確認・author・commit | inspectorは既存。diff確認を満たす目標面 | E01／G02 |
| G02 | local履歴・commit結果 | historyは既存。未接続のrestore操作は出さない | W01／G03 |
| G03 | Fetch／Pull／Publish・進捗・結果 | sidebar操作を整理する面 | W01／G04／G05 |
| G04 | conflict確認・双方のrevision・安全な解決先 | 現行はメッセージ中心。専用review面は不足 | G02／G03／W01 |
| G05 | remote-unknown・remote再照合 | 現行statusを操作可能にする目標 | G03／G04 |
| P01 | installed plugin・状態・有効化／停止／削除 | 既存PluginPanel | W01 |
| P02 | signed install/update preview・容量・依存・権限 | 既存preview。転送前同意 | P01 |
| P03 | plugin要求・実行・結果・stale/failure | 既存PluginPanel | P01／Q01 |
| Q01 | proposal内容・revision・approve/reject | 既存plugin/MCP表示に共通の論理契約。Host | 呼出元P03/M02／G01 |
| M01 | Live MCP公開先・tool選択・Owner Key | 既存LiveMcpPanel、offが初期値 | W01／M02 |
| M02 | 接続中Workspace・実行中／履歴・停止／切断 | 既存LiveMcpPanel | M01／Q01 |
| M03 | client認可・token一回表示・一覧・失効 | 既存LiveMcpPanel。tokenは設定URLに含めない | M02 |
| S01 | 外観・account・Gateway・Git authorへの設定入口 | 既存分散設定をまとめる目標。Mobile設定面は既存 | 呼出元 |
| S02 | panel/preset/配置・Save layout・復旧 | 既存Workspace controls | W01 |
| X01 | unsaved離脱確認 | 現行confirm。保存／破棄／留まるを区別する目標 | 呼出元／選択先 |
| X02 | local Git整合性検証dialog | 既存StorageRecoveryDialog | 元Workspace／H01 |
| X03 | journal下書き／scratch回復 | 既存RestoredEditor/SceneEditor | E01／E04 |
| X04 | 機能別error・再試行・中止 | 共通の表示契約。独立した万能error画面ではない | 失敗した機能の入口 |
| O01 | latest取得・checksum・配置 | 運用端末。手動取得は既存、統合導線は目標 | O02 |
| O02 | env／OAuth App／公開URL／Tunnel設定 | 運用端末とCloudflare外部管理。OS rootとは別権限 | O03 |
| O03 | foreground／systemd --user・診断・停止 | 運用端末。既存運用手順 | O02／O04 |
| O04 | 更新・稼働確認・旧版復帰 | 運用端末。latest更新契約は目標 | O03 |

外部のブラウザー印刷dialogとOSの画像／camera pickerはF05/F06の外部ノードで扱う。これらをProprium固有画面と数えない。権限拒否・キャンセルは元の文書へ戻る。

## 5. 追加済みと誤認してはいけないもの

ローカル新規作成の利用者入口、変更diff、認証の期限・再試行・復帰先を統一するtask導線、統合設定、conflict解決面、latest installerは、この台帳が存在するだけでは実装済みにならない。`SceneEditor`内に汎用conflict/restore用propsがあっても、`RestoredEditor`が`conflict=null`・解決不可・external historyとして接続する部分を、利用可能な製品機能に数えない。

`modules/*`の検索、用語、グラフ、モデル、管理機能や旧Node/Hosted/OCI画面は、[Compatibility](COMPATIBILITY.md)に従いBrowser Hostの画面集合に含めない。Atlas、常時稼働MCP、共同編集backend、一般ユーザー管理、管理者Web consoleを本設計で追加しない。任意pluginの将来画面を架空の固定画面として列挙せず、P01/P03/Q01のHost-owned contribution境界で扱う。

[entry]: ../../app/src/browser/proprium/host/main.tsx
[host]: ../../app/src/browser/proprium/host/HostApp.tsx
[desktop]: ../../app/src/shells/desktop/DesktopShell.tsx
[mobile]: ../../app/src/shells/mobile/MobileShell.tsx
[layout]: ../../app/src/workspace/Workspace.tsx
[editor]: ../../app/src/browser/proprium/host/RestoredEditor.tsx
[scene]: ../../app/src/editor/SceneEditor.tsx
[plugins]: ../../app/src/browser/proprium/host/PluginPanel.tsx
[live]: ../../app/src/browser/proprium/host/LiveMcpPanel.tsx
[sync]: ../../app/src/browser/proprium/git/github-sync.ts
[theme]: ../../app/src/components/ThemeControl.tsx
[recovery]: ../../app/src/browser/proprium/host/StorageRecoveryDialog.tsx
[operations]: ../deployment/GATEWAY.md
[release]: ../../.github/workflows/release-proprium-gateway.yml
