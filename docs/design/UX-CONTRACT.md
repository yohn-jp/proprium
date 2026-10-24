# Scriptorium — Design and UX contract

## 1. この文書の位置付け

本書はScriptoriumが作者に保証する体験の正本であり、実装済み機能や本番受入の報告ではない。MUST／禁止は受入条件、SHOULDは例外理由と代替の証拠を要する設計原則とする。画像モックや外部製品の外観は仕様ではない。

最新の明示的なオーナー指示と受入済み製品契約を優先する。本書は情報設計・表示・操作の判断を固定し、[Core](../architecture/CORE.md)、[Internal boundaries](../architecture/INTERNAL-BOUNDARIES.md)、[Modular workspace](../architecture/MODULAR-WORKSPACE.md)、[Modules](../architecture/MODULES.md)の正本・保存・認可の意味を変更しない。[Authoring](../authoring.md)と[Mobile interactions](../architecture/MOBILE-INTERACTION-UX.md)も併読する。

既存のReact、CodeMirror、Radix、Ionic React、可変パネル、Vite、Fastify、Gitの技術選択を維持する。Desktop／Mobileは別のpresentation、authoring coordinatorと保存・復旧は共通の責務とする。新しい状態管理基盤、別エディタ、別保存方式でUX問題を回避しない。

配色、余白、画面割り、ナビゲーション、パネルの初期配置は本書の範囲で改善できる。プリセットを固定モードへ縮退させたり、対応済みの執筆・閲覧機能を見た目のために削除してはならない。

## 2. 製品として実現すること

**作者が、どの作品のどの文章を書いているか、変更がどこまで保護されているかを見失わず、参照・整理・レビューを挟んでも同じ思考へ戻れる。**

Scriptoriumは、巻・章・シーンと日本語原稿を中心とするGit-backed writing workspaceである。Gitクライアントでも、汎用の社内Wiki／プロジェクト管理ダッシュボードでもない。Git、検索、解析は執筆を支えるが、作者の文章より前に立たない。

| 作者の仕事 | 第一に必要な情報 | 周辺に呼び出す道具 |
| --- | --- | --- |
| 続きを書く | 作品・シーン、最新の回復可能な本文、入力可否、保護状態 | 構成、保存状態、必要な書式操作 |
| 読み直す | 読み位置、本文とルビ、選択した組版 | 構成移動、表示調整、編集への復帰 |
| 調べながら書く | 現在の本文と参照箇所の関係 | 検索、用語、関連する文書、任意の解析 |
| 変更を確かめる | 変更対象、差分、適用先、保存範囲 | 提案レビュー、履歴、Checkpoint、GitHubへの保存 |

最初から執筆できる完成した初期配置を提供し、設定やパネル組立てを利用開始の前提にしない。一方で、熟練者の任意配置・分割・複数パネルを制限して「シンプルさ」を作らない。

## 3. 情報設計と状態の語彙

### 作業の軸

作者／リポジトリのscope、作品の構成、現在のシーン、本文、参照対象を区別する。同名シーンでも文脈から識別でき、ライブラリから本文へ、参照から執筆へ戻れる。ファイルpathやGit SHAは調査・差分に必要な時に示し、常時それだけで対象を説明しない。

執筆・調査・レビューは別のデータ正本ではない。Writing／Research／Reviewは同じ作業状態を使う編集可能なレイアウトの出発点であり、文書のコピーや新しい保存セッションを作らない。

### 保存は一つの直線的なステータスではない

| 軸 | 正しい意味 | 表示上の禁止 |
| --- | --- | --- |
| 入力と保護 | 現在の入力、journal書込み中／成功／失敗、復旧照合中 | タイピングしただけでDraft保存済みとする |
| Draft | 同じbrowser・author・originの回復journalに保持された内容 | サーバーや別端末にも保存済みと示す |
| Checkpoint | 承認済み変更がサーバーのlocal Gitに確定した内容 | GitHub保存の完了と示す |
| GitHubへの保存 | 対象revisionのremote反映を確認できた内容 | 要求受付、local commit、応答不明を成功にする |
| Remote観測 | fresh／stale／unknownなど、外部状態を確認できた範囲 | 接続不能を原稿消失や保存失敗と即断する |

これらは同時に存在する。Checkpoint後の新しい編集はそのCheckpointに含まれない。GitHubに保存したrevisionと現在の未反映編集を混同しない。通常表示は短くても、どの範囲がどこに残っているかを展開して確認できること。全状態を巨大なバッジ列に常時並べる必要はない。

## 4. 執筆・参照の契約

### S-01 — 安全に続きを始められる

最後の作業対象へ戻る時、現在のauthor／repositoryに結び付く正規の回復記録と本文を照合する。表示を先に出す場合も、照合が終わるまでは「回復済み・編集可能」と偽装しない。別作者のDraftを混ぜない。

現在のシーンが利用できる時、remote HEAD、検索index、モデル、非表示パネルの完了を待たせない。遅れて届いた前のシーンや古いsnapshotが新しい本文を上書きしない。作品が空、シーン未選択、削除済み、権限拒否、取得失敗、回復に判断が必要な状態には別の説明と正規の次の行動を用意する。[R2]

### S-02 — 日本語入力と編集状態が主役であり続ける

CodeMirrorが保持する入力、IME変換、caret、selection、undo、scrollを、状態通知、remote観測、パネル開閉、解析結果、レイアウト変更のために失わない。表示用React stateを最新の入力の代わりの正本にしない。[R7]

変更でeditorをunmountする必要がある場合は、既存のcomposition／journal／navigation guardを通す。変換中や保護できない入力がある場合は安全に遷移を止め、理由をその場で説明する。強制的に変換確定したり、古い読み出し結果へ戻したりしない。guardの拒否を単なるクリック無反応にしない。

入力・選択・copy／paste・undoの通常操作を独自gestureやshortcutで横取りしない。OS／ブラウザの操作と競合するshortcutは避け、表示されたボタンやメニューからも同じ仕事を完遂できる。

### S-03 — 日本語原稿として読み書きできる

長い日本語本文、句読点・括弧、和欧混植、見出し、ルビ、横書き・既存の縦書き閲覧を実データ形式で評価する。本文の読み幅・行間・文字サイズを中心に整え、装飾のために詰め込まない。JLReqを組版上の検討資料として使うが、全文準拠を自動的に名乗らない。[R8]

閲覧表示への切替えや表示調整は原稿の書換えではない。Markdown、frontmatter、未知のmetadata、関連しないファイルを保持する。読み位置と編集位置を対応可能な範囲で復帰させ、対応できない場合は勝手な位置へ戻ったことを隠さない。

### S-04 — 構成と参照へ寄り道しても戻れる

巻・章・シーンの階層で現在位置を示し、選択・移動・作成・並べ替えを権限と既存Core操作に結び付ける。構成操作が本文や別作品へ与える影響を確認できる。dragだけを必須にしない。

検索結果や用語参照は所属する作品／sceneと該当箇所を示し、元の原稿へ戻れる。可能な参照は本文を閉じずに行える。snapshotの古い結果を現在の本文の一致と偽装せず、無効な参照は再確認できる状態へ戻す。検索条件と位置を背景処理の都合で捨てない。

## 5. 保存・復旧・レビューの契約

### S-05 — 今の文章がどこに残っているか分かる

Draft、Checkpoint、GitHub保存、未確認の反映を一つの「Saved」へ統合しない。成功表示は対応するjournal書込み、receipt、remote確認の後だけ出す。journal容量不足や書込み失敗は回復上のリスクとして残し、消えるトーストだけで知らせない。

保存中にも安全に入力できる経路では、処理対象revisionと後続入力を分ける。後続入力まで保存済みと表示しない。処理中の制約が必要なら対象操作と理由を明示し、関係のない閲覧・入力まで止めない。

### S-06 — CheckpointとGitHub保存を意図して実行できる

作者は対象の変更、必要な承認、local確定とremote反映の違いを理解して実行できる。Checkpointを作成しただけで自動publishしない。GitHubへの保存は明示的な操作であり、画面移動やレイアウト保存で発生させない。

通常のCheckpointと回復再実行は既存の同一protocolを使う。二重押下・再読み込み・応答損失に対し、operation ID、generation、author／repository、proposal、receiptの束縛を維持する。表示を速くするためにreceipt保存や承認を省略しない。

### S-07 — 失敗しても文章と復旧判断を失わない

通信断、journal不良、権限失効、競合、push結果不明を別々に扱う。結果不明は既存operation／receiptの照合で確認し、安易に新しい意味の操作として再実行しない。記録は正規の確定条件まで保持する。

409／412などの競合は正規契約に従って表示し、自分の本文、比較対象、次に取れる行動を示す。原稿の自動競合merge、force-push、黙ったDraft破棄は行わない。外部サービスの障害中も読める検証済みlocal内容を残し、freshな認可を要する操作だけを正しく制限する。

再ログインや別shellへの移行が必要な時は、何が同じbrowser／originに残るかを説明する。別端末・別originへの未公開Draft同期や完全offline編集を、存在しない保証として提供しない。

### S-08 — 変更と提案を理解して採否を決められる

差分は対象作品・シーン・元revision・適用先を明示し、現在の編集と過去の履歴やmodule提案を混同しない。履歴を見るだけで原稿を変更しない。適用には正規のproposal・承認・revision検証を通す。

提案の一部適用、取消し、巻き戻しは既存APIが保証する単位でだけ提供する。表示上だけのUndoを復旧保証として見せない。承認後に原稿へ戻った時、採用した変更と新しい未反映編集の範囲が分かる。

## 6. Workspaceと任意機能の契約

### S-09 — 完成した初期配置と自由な配置を両立する

Writing／Research／Reviewからすぐ使え、各panelを許された範囲で並べ替え・分割・tab化・resize・非表示にできる。固定3カラムや固定モードだけへ縮退させない。キーボード／ボタンによる移動とfocus復帰を用意する。[R9]

配置はauthorとdevice classのbrowser設定で、原稿Gitやdraft journalとは独立する。DesktopとMobileの配置を相互に上書きしない。壊れたlayoutはCoreの利用可能な配置にfallbackし、明示的に置換保存するまで元の設定を消さない。

panelを閉じても原稿は破棄されない。未導入／無効moduleのpanelは説明付きの回復可能なfallbackとし、他panelを止めない。不要なmount・worker・requestは解放し、隠れたpanelが無制限の仕事を継続しない。

### S-10 — Optionalな道具が執筆の前提にならない

検索・用語・NLP・Semantic・Assistantは既存module境界を使う。未導入、無効、利用可能だが未起動、実行中、失敗、結果が古い、を区別する。enableはpackageのinstallではない。Core-onlyでも構成移動、編集、履歴、Checkpoint、GitHub保存を維持する。

通常の語句検索にモデルを暗黙に読み込まない。用語リンクは非破壊的な装飾で、MarkdownやGitを自動変更しない。曖昧な候補を正解と決め付けず、IME・ルビ・selectionを乱さない。moduleの処理や結果はsnapshot／scopeへ拘束する。

外部Assistant等へ原稿を送る操作は、送信先、対象範囲、目的を確認でき、既存の明示同意を満たす。provider未設定・未同意でもlocal執筆を妨げない。UI刷新はuntrusted plugin、marketplace、別のwriter、外部送信の既定有効化を許可しない。

## 7. Desktop／Mobileと操作の連続性

### S-11 — DesktopとMobileは異なる操作面で同じ原稿を扱う

`/desktop/`と`/mobile/`の独立shell、明示選択と記憶を維持する。画面幅、向き、キーボード表示、pinch zoomでshellを勝手に入れ替えない。狭いDesktopでも内容を失わず、広いMobileでも別製品状態を作らない。

Desktopは本文と構成・参照・差分の並行作業を支える。Mobileは本文を中心に、必要な構成／保存情報をIonic sheet等で一時参照して戻れるようにする。通常の参照sheetの開閉で本文editorをunmountしない。別sceneへの移動は既存のguardを通す。

本文の選択・long press・scroll・IMEはCodeMirror／browserに、sheetのdrag・閉じる・focusはIonicに責務を置く。全画面swipe listenerで競合させない。閉じた時にkeyboardを勝手に再表示せず、適切なinvokerにfocusを返す。safe areaとkeyboardで本文caret・主要操作を隠さない。

### S-12 — 保存・通知・背景処理が執筆を揺らさない

保存やエラー表示のためにヘッダーを差し込んで本文を押し下げない。通常の状態は安定した領域または非侵入的な通知で示す。対処が必要な問題はその場から再確認でき、トーストの消滅とともに失われない。[R3][R5]

文字入力中にfocusを奪わず、進捗のたびに読み上げを繰り返さない。通知を閉じることと問題の解消を区別する。modalは承認や競合判断など本当に操作範囲を限定すべき場合にだけ使い、通常の保存待機では使わない。[R6][R10]

### S-13 — 速さは保護を省くことで作らない

入力・現在sceneの表示・navigation・panel操作をremote観測やindex作成と直列化しない。可視作業を優先し、不要な背景処理を停止・遅延できる。復旧照合が必要な時だけは正しく待ち、その理由を示す。

測定は入力反応、scene切替え、journal書込み、Checkpoint、GitHub保存、検索を別々に扱い、[Performance](../performance/README.md)に従う。cold／warm、同じfixture・profile・browser・host条件と試行数を記録する。ネットワーク完了時間を入力反応時間と呼ばない。

INP p75 200ms以下、CLS p75 0.1以下を外部の品質目安として参照する。フィールド値がなければ未計測であり、単発のブラウザ測定から達成を主張しない。本文・caret・focusの位置安定は別途直接検証する。認可、journal、revision、receiptを省略した高速化は不合格。[R4][R5]

## 8. 視覚デザインとアクセシビリティ

**原稿と現在位置が第一の視覚的重心であり、道具と保存状態は必要な時に確実に見つかる。** これをScriptoriumのデザイン命題とする。

大きなロゴ、全機能toolbar、均等なcard群、常時点滅する保存表示で本文と競合しない。本文の読み幅・行間を軸に、構成、参照、状態の階層を作る。余白は読み順と集中のために使い、原稿を小さな中央枠へ追いやらない。

意味的なtypography・spacing・surface・state・focus tokenを揃え、日本語と英数字で光学的な整列を確認する。brand色とエラー色を分ける。長いscene名や多数の章、原稿なし、moduleなし、競合時でも同じ設計言語を使う。配色・テーマ初期値・装飾は裁量だが、既存の表示設定を意図せず失わせない。

適用可能なWCAG 2.2 A／AAを基準とする。ラベル、文書構造、keyboard、読み順、focus、エラー通知、コントラストを確認し、色やhoverだけに意味を置かない。200%文字拡大と320 CSS px相当のreflowを扱い、本質的な二次元比較／組版の例外は説明する。[R1]

主なtouch操作44×44 CSS px以上は製品の設計目標であり、WCAG AAの24×24と例外とは区別する。modalのfocus管理、drag代替、閉じる手段、reduced motionを持つ。固定toolbarやsheetはfocus中の操作を覆わない。[R6][R11]

視覚品質は実際の日本語原稿を表示し、原寸・縮小・グレースケールで本文の優先順位を評価する。美しさと編集の正しさを別々に判定し、見た目の成功をIMEや保存の証明に使わない。

## 9. 受入シナリオ

以下は継続的なテスト義務であり、実行済みチェックリストではない。最小Coreと該当module入りprofileの両方で、要求される範囲を確認する。

| シナリオ | 条件・操作 | 必須の観測結果 | 契約 |
| --- | --- | --- | --- |
| S-A01 | 未公開Draftを持つsceneへ再訪、回復照合を遅延、remoteを停止 | 正しいscopeで照合、早期の偽writableなし、不要なremote待ちなし | S-01,05,07 |
| S-A02 | 日本語入力・変換・selection・undo中に通知、panel開閉、背景観測 | 本文・caret・selection・undoを保持。unmountを伴う操作は正規guardで拒否／実行 | S-02,12 |
| S-A03 | 横書き／縦書き閲覧、ルビ、括弧、長文、表示切替え | 原稿・metadataを変更せず、読みと編集へ復帰できる | S-03 |
| S-A04 | scene A→Bへ移動後にAの応答到着、別authorへ切替え | Bや別authorの本文・回復記録へ古い応答を適用しない | S-01,02,04 |
| S-A05 | Draft書込み中／失敗、Checkpoint後に追加入力、GitHub保存 | 各revisionの保護範囲が正しい。新入力まで保存済みにならない | S-05,06 |
| S-A06 | Checkpoint／pushの応答損失、二重操作、reload後に照合 | 同じoperation／receiptを照合、重複適用・記録の早期削除・偽successなし | S-06,07 |
| S-A07 | remote更新との競合、認可拒否、認証依存障害 | 原稿を保持し、競合／拒否／unknownを区別。forceや自動prose mergeなし | S-07,08 |
| S-A08 | 履歴参照、古いmodule提案、適用前後の編集 | 閲覧は非変更、承認とrevision検査、変更範囲を理解して戻れる | S-08,10 |
| S-A09 | preset適用、任意配置、keyboard移動、layout保存、壊れたlayout | 自由配置とfocus保持、Git非変更、復旧可能fallback、draftは独立保持 | S-09 |
| S-A10 | 検索無効／index更新中／古い結果／曖昧用語、Core-only起動 | 執筆を妨げず、結果のscopeと鮮度を明示、勝手なモデル起動・source変更なし | S-04,10 |
| S-A11 | 外部provider未設定・未同意・送信scope確認 | local作業可能、同意前の原稿送信なし、提案の直接書込みなし | S-10 |
| S-A12 | Mobileで原稿から構成／保存sheetを開閉、back、scene選択、keyboard | 通常参照でeditor再mountなし、guard・focus復帰・safe area、突然のkeyboardなし | S-02,11,12 |
| S-A13 | Desktopを狭める、Mobileを広げる、shellを明示切替え | 自動shell変更なし、回復と作業対象保持、各layout scopeは独立 | S-09,11 |
| S-A14 | 長い構成名、多数scene、背景処理、遅い保存、空状態、zoom | 原稿優先、操作場所が動かず、入力反応と完了時間を分離して測定 | S-01,12,13 |

Desktopは1440／1920、Mobileは320／375／390／430 CSS pxを基本とし、狭いDesktop、拡大、長文とkeyboard条件を加える。幅とは独立にshellを指定する。

検証は **視覚・情報階層／操作・accessibility／入力・保存・認可** の別gateで報告する。fixtureで失敗状態を再現することと、正規Core／journal／Gitを通した保存の成功は別の証拠。テストは生成した作品・隔離browserで行い、作者の実原稿や本番remoteへ書き込まない。

Playwright CLIで画面を開き、操作前・受付・遅延・結果・復帰を観察し、回帰条件は既存Playwright Testへ残す。画像の存在だけで合格にしない。DOM／操作／networkの確認、画像の目視、keyboard・支援技術による評価を組み合わせる。[R12][R13]

Synthetic composition eventやWebKit emulationは、物理iPhone、OSの日本語IME、native keyboard、long pressを検証したことにはならない。実機未確認はNOT_CHECKEDとし、そのために独立した検証や実装を停止しない。原稿保護が未確認なら全体を完了と主張しない。

結果にはrevision、profile、browser／viewport、fixture、操作、期待／実際、PASS／FAIL／BLOCKED／NOT_CHECKED、artifactを記録する。原稿本文や認証済みstorageを公開せず、実行結果はPR・machine artifactに置く。[Verification](../verification/README.md)の正規gateを省略しない。

## 10. 実装の責務と非目標

SharedApplicationは作業状態と許可されたcommandを調整し、Desktop／Mobileはその表示・操作を担う。Checkpoint protocol、browser journal、CoreStore、HTTP admission、module hostは既存の唯一の責務を維持する。UIのための第二のsave state machineやwriterを作らない。

本書は新規NLP機能、任意外部plugin sandbox、別のGit運用、cloud同期、共同編集、完全offline保証、CI省略、公開・本番デプロイを追加しない。既存能力の不足は最小の正規境界の差分として示し、モックの成功値や架空の操作で埋めない。

## 11. 調査根拠と採用範囲

外部資料から採るのは操作原理と検証方法であり、画面やCSS、framework移行ではない。APIの具体的な利用はリポジトリに固定されたversionに照合する。

| ID | 一次資料 | この製品への適用と限界 |
| --- | --- | --- |
| R1 | [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) | 適用可能なA／AAの評価基準。スクリーンショットだけで適合宣言しない |
| R2 | [IBM Carbon: Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/) | 空作品・未選択・取得失敗を区別し、その場の次の行動を示す |
| R3 | [IBM Carbon: Notifications](https://carbondesignsystem.com/patterns/notification-pattern/) | 通常の保存と重大な回復問題で介入度を変える。通知製品の新設ではない |
| R4 | [web.dev: INP](https://web.dev/articles/inp) | 入力反応とremote完了を分離。単発ラボ値をfield p75と混同しない |
| R5 | [web.dev: CLS](https://web.dev/articles/cls) | 非同期通知による不意の位置移動を抑える。caret保持は別に検証 |
| R6 | [WAI APG: Modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | sheet／dialogのfocusと復帰。常時modal化の要求ではない |
| R7 | [React: Preserving and resetting state](https://react.dev/learn/preserving-and-resetting-state) | render tree・type・key変更によるstate寿命を考慮。原稿正本をReactへ移さない |
| R8 | [W3C: Japanese Text Layout](https://www.w3.org/TR/jlreq/) | 日本語・ルビ・縦組の評価資料。Working Group Noteであり全文準拠認定ではない |
| R9 | [VS Code: Custom layout](https://code.visualstudio.com/docs/configure/custom-layout) | 使える初期配置とユーザーの自由配置を両立。IDEのchromeや機能群はコピーしない |
| R10 | [WAI: Status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) | focusを奪わず重要な保護状態を伝える。連続読み上げは避ける |
| R11 | [WAI: Target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | AA最小条件と大きいtouch目標を区別 |
| R12 | [Playwright: Emulation](https://playwright.dev/docs/emulation) | browser条件の再現と物理端末の証明を区別 |
| R13 | [Playwright: Accessibility testing](https://playwright.dev/docs/accessibility-testing) | 自動検査の限界を明示し、実操作・支援技術確認を併用 |
