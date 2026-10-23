# Plugin platform proposal

This proposal specifies external plugin protocols, packaging and enforced isolation. It does not describe the trusted built-in module runtime or promise those isolation guarantees for its packages. See [Modules](MODULES.md) for the supported runtime contract.

## 1. 製品の定義と品質目標

**Scriptoriumは、プラグインによって自由に構成できる、Gitネイティブなライティングアプリケーション基盤である。**

執筆を第一用途とするが、Coreの保存モデルを小説の「巻・章・シーン」に固定しない。Markdown、図面、参考資料、独自形式は、最終的には同じGit-backed Workspaceに置くファイルとして扱う。文章の意味づけ・編集体験はCoreが提供する既定UIまたは拡張に委ねる。

**固定する品質条件:**

1. **Always usable:** 全Pluginが存在しない／停止していても、Coreの起動、既定Markdownの閲覧・編集、回復記録の確認、認可済みGit保存・同期は成立する。
2. **Fault containment:** Pluginのtrap、例外、無限ループ、メモリ超過、クラッシュ、壊れたRPC、ハング、任意の停止操作が**Scriptorium Coreと他の無関係なPluginの稼働に波及しない**。これを満たさない実行モードは隔離保証を掲げない。
3. **No authority transfer:** PluginはGitの正本、認可、単一Writer、Recovery Journal、Checkpoints、Publishを所有しない。Pluginが起こせる永続変更は原則「検証付き提案」までである。
4. **Pay only when used:** 未インストール・無効・有効だが非アクティブという各状態を区別し、無使用の機能がCPU、実行プロセス、索引更新、ブラウザJS、定期通信を消費しない。
5. **Public, language-neutral contract:** Rust/WASM、TypeScript、別言語でPluginを書けるように、境界はシリアライズ可能なVersioned Protocolで固定する。CoreをRustへ全面移植することは前提にしない。
6. **Independent delivery:** Pluginは独立したGitリポジトリから開発・ビルドでき、ホストの承認済みバージョンとDigestを参照して組み込める。外部コードが作業リポジトリから勝手にインストール・実行されない。

**保証範囲を正確にする:** Plugin専用のOS分離とリソース制御が動作する範囲で、Plugin側の通常のクラッシュ/OOM/CPU暴走がCoreを終了させないことを目標とする。カーネル障害、ホスト全体のリソース枯渇、ブラウザ自体のクラッシュ、未知のSandbox脆弱性まで「絶対に落ちない」と主張しない。境界の成立は実機で故障注入して証明する。

## 2. Trust boundary

Built-in modules are trusted application code. Public contracts, lifecycle supervision and lazy browser imports constrain supported integration, but do not isolate arbitrary JavaScript from the host process, DOM or credentials.

External plugins require versioned namespaced identities, metadata-only registration, capability grants, immutable distribution, OS-enforced server isolation and a separate browser origin. Snapshot identity, operation approval, Git authority and browser recovery remain host-owned.

## 3. 最小の信頼境界と全体構成

~~~mermaid
flowchart TB
    User["Author / Browser"]
    Shell["Workspace Shell + Core Editor fallback"]
    Broker["Plugin Host: Registry / Capability Broker / Supervisor"]
    Core["Core: File / Snapshot / Journal / Mutation / Authorization"]
    Git[("Git objects + confirmed GitHub history")]

    User --> Shell
    Shell --> Broker
    Shell --> Core
    Broker -->|"Validated, scoped requests only"| Core
    Core --> Git

    subgraph PUI["Untrusted Browser Domain"]
        Frame["Sandboxed iframe: Plugin UI JS"]
    end
    subgraph PRUN["Untrusted Server Domain"]
        Worker["OS-isolated process: WASI Component runtime"]
    end
    Shell <-->|"MessageChannel / typed bridge"| Frame
    Broker <-->|"Bounded framed RPC"| Worker

    Meta["Signed immutable Plugin metadata / assets"] --> Broker
    Meta --> Frame
~~~

**Trusted Computing Base (TCB):** CoreStore/Git・Browser Journal・作者の認証UI・プラットフォーム認証・Plugin Registry・RPC Validation/Broker・Supervisor・配布Artifact検証。Pluginの任意コードはTCBの外に置く。

**Two execution domains:**

- **Browser UI:** 別originのsandboxed iframe内でPluginの画面コードを動かす。親のReact Tree、DOM、Cookie、IndexedDB、同一origin APIにアクセスさせず、Hostが検証した`MessageChannel`のみ提供する。Core既定Editorはホスト側に存在し、Plugin Editorが停止しても使用できる。
- **Server Compute:** WASI Componentを**Coreとは独立したOSプロセス**内のWasmtime等で実行し、IPC越しにHost Capabilityを使う。WASMの線形メモリ分離**だけ**でCPU/OOM/Filesystem/Kernel限界を証明したことにはならない。OS側の制限と計測が必要。

WASM Component Model/WITは異言語間IFとして第一候補、RustはPluginの作成言語の一つ。公開ProtocolのJSON/WIT表現を二つの独立正本にしない（§4）。

**原則として1 Pluginにつき必要時にだけSandboxを起動する。** 無効・アイドルに対して固定のContainer、WASM Runtime、WebSocket、OS Workerを用意しない。GPU/長時間学習/外部推論向けの分離コンピュートはPlugin Hostの追加Transportであり、Core必須要件ではない。

## 4. Public Plugin Protocol v1 — 契約面

### 4.1 パッケージとManifest

公開Pluginの識別子は **`publisher.plugin-name`** のような名前空間付きStable IDとし、内部の9件固定`ModuleId`とは区別する。表示名・Gitリポジトリ名・作業中のプロジェクトパスをコード実行IDに使用しない。

**提案するManifestの論理構造（提案Schema）:**

~~~json
{
  "schema": "scriptorium.plugin/v1",
  "id": "example.diagram",
  "version": "1.0.0",
  "sdk": { "min": "1.0.0", "maxExclusive": "2.0.0" },
  "entrypoints": {
    "ui": "dist/ui/index.html",
    "compute": "dist/worker/plugin.wasm"
  },
  "contributions": [
    { "kind": "editor", "id": "diagram-editor", "extensions": [".excalidraw"] },
    { "kind": "command", "id": "diagram.open" }
  ],
  "permissions": ["workspace.snapshot.read", "workspace.change.propose"],
  "limits": { "class": "interactive" }
}
~~~

ここでの`entrypoints`は**発行済みPlugin Artifact内部の検証済み相対パス**であり、実行時URL/npm specifier、外部network fetch、ホスト絶対パスではない。実際の`schema`、SemVer要件、Permission語彙、Limits値は実装前にMachine-readable schemaで固定する。UI-only/compute-onlyも可。例示Pluginは実際に存在しない。

**採用:** パブリックSDKのIDは開放するが、実行権限はインストール済みArtifactのIdentity、Host Policy、認証PrincipalとCapability Grantの**積集合**で決定する。Manifestの自己申告で権限を得られない。未認可のPluginは`not-installed`または`disabled`となる。

### 4.2 Versioning・型の正本

- 公開の**Protocol/schema version**、各**Capability API version**、Plugin package SemVer、Artifact digestを別々に管理する。
- JSON Schemaなどの**機械検証可能な単一の論理Contract**を正本にして、TypeScript SDK型とランタイムValidator、必要なWIT ABI bindingを生成・整合性検証する。WITはWASM Guest↔Broker Adapterの表現であり、権限の別正本ではない。
- ホストはインストール/起動時に互換性を検証し、サポートしない必須Capabilityは起動拒否。Optional Capabilityは宣言したフォールバックのみ許す。
- Minor/patchの後方互換契約は公開、破壊的変更は新major/並行対応期間を設ける。未知フィールドの扱いとSchema MigrationはABIごとに固定し、危険な黙認/型キャストはしない。
- スナップショット・ChangeOperation等の既存契約は**アプリ内`CONTRACT_VERSION=1`をそのまま公開Plugin ABIとみなさない**。Adapterで変換し、公開範囲だけを安定化させる。

### 4.3 Host Capability API（許可リスト）

| Versioned capability family | 最小操作 | 権限・実装境界 |
| --- | --- | --- |
| `workspace.snapshot.read` | `list(prefix,cursor,limit)`,`stat(path)`,`read(path,revision,range)` | 認可済みRepository+Snapshotに固定、Path/Symlink検証、Bytes/Files上限。Private Git Credentialは渡さない |
| `workspace.change.propose` | `propose(changeSet,readSet,revision,operationId)` | **提案まで**。Authorの明示的な受入・Browser Journal・Checkpoint/PublishはHost-owned。別Plugin権限では代行不可 |
| `workspace.events.subscribe` | `subscribe(types,scope)`,`unsubscribe` | advisoryな更新通知。Snapshot/version付き。欠落後は`snapshot.diff`等で照合できる |
| `workspace.navigation` | `open(path,revision)`,`reveal(panelId)` | 対象Projectの認可・Safe Path、Editor Recovery GateとNavigation GenerationをHostが確認 |
| `workspace.ui.contribute` | Editor/Viewer、Panel、Command、Toolbar、Context Menuの**宣言的登録** | 登録先と表示順・可否はShellが管理。Pluginは任意Host DOMやGlobal CSSを編集できない |
| `workspace.compute` | `invoke(actionId,input,deadline)`,`cancel(jobId)` | Actionの副作用クラス・同時実行・CPU/Memory/Time/Output quotaをHostが検証 |
| `plugin.state` | `readSettings`,`proposeSettingsChange`,`cacheRead/Write` | Git保存するSettingsは承認経路。実行キャッシュはPlugin毎quota・破棄可能・正本ではない |
| `network.egress` | Default **DENY**。許可する場合は明示許可Originと用途別Proxy | Browser direct fetch/Native networkは不可。GitHub/AIトークンはPluginに渡さずProxy側でScope/Consent/Limitを適用 |

**非公開・非委譲:** raw`fs`/Git exec、`MutationCoordinator.approve/checkpoint/publish`、GitHub App鍵、host credential、Kubernetes/Podman/host daemon socket、`/data`/Browser IndexedDBの直接アクセス、任意Server routes、他Repositoryへの無制限Reader、任意Pluginのkill/enable、Host CSP/認証処理。

v1必須集合は`snapshot.read`、`change.propose`、`ui.contribute`、`navigation`、Lifecycleとする。Events/Computeは任意Capabilityとし、対応範囲をManifestで宣言する。

### 4.4 Request/Responseの封筒

~~~text
request  = {protocolVersion, requestId, pluginId, packageDigest, instanceId,
            projectId, repositoryIdentity, authorScope, snapshotId,
            activationEpoch, capability, method, payload, deadline}
response = {protocolVersion, requestId, activationEpoch, snapshotId,
            ok, data | machineError}
event    = {protocolVersion, eventId, projectId, snapshotId,
            type, pathOrScope, revision, activationEpoch}
~~~

- **上記は概念的なフィールド一覧**。最終的なWire Schemaは実装時に単一の正本へ固定する。
- Identity、author scope、snapshot、Capability、Deadlineは**HostがSessionから束縛**し、Pluginが送った値を認可根拠として採用しない。
- IPCはサイズ上限付きLength-framed、入力/出力Validatorを通す。Pluginのstdout/stderrをProtocolとして信頼しない。WASI Guest↔Sandbox Brokerの呼び出しは生成Bindingを使い、Broker↔Hostで検証済みEnvelopeに正規化する。
- Requestの多重化とCancelには相関IDを使い、応答はActivation EpochとSnapshot一致を満たす場合のみ適用。タイムアウトした古い応答、前回起動の応答、別Projectからの応答は拒否。
- Backpressure: 1 PluginのQueue、RPC同時実行、Bytes in flight、Event buffer、UI message率を上限付きにする。上限超過は`plugin_overloaded`で**そのPluginだけ**失敗させる。
- Machine Errorは`code`、`message`、`retryable`、`requestId`の必要最小限。例: `plugin_crashed`、`plugin_timeout`、`plugin_oom`、`plugin_protocol_invalid`、`capability_denied`、`plugin_unavailable`、`snapshot_changed`。Host内部例外/Secretは露出しない。

## 5. Git-backed File / Document拡張

File APIを**Markdown以外にも使える原始能力**にする。ただし既存作品の`plot/volumes`、`manuscript/*.md`、YAML Hierarchy、既定執筆UXの互換性は保持し、機械的に廃止しない。

### 5.1 分離すべき抽象

~~~text
Core immutable repository snapshot
  ├─ File object: path, objectId/contentDigest, MIME hint, size, revision
  ├─ Document read: UTF-8 / bounded binary stream or blob reference
  ├─ File-scoped read-set and write-intent with CAS
  └─ Git checkpoint / reconcile / publish + recovery receipt

Host writing experience
  ├─ Default Markdown Editor / YAML-to-Scene domain adapter
  └─ Host-controlled editor selection by extension/MIME + installed capabilities

Optional Plugin UI / Compute
  └─ Only host-authorized document read + proposed change
~~~

`SnapshotReader.read`のBase64読取りと`FileChange`のBase64書込みは、汎用ファイルの境界に用いる。`DocumentSource`のUTF-8契約、`ChangeOperation.effect`の効果分類、Browser Draftの保存形式を、各Editor bindingが明示的に満たす必要がある。Base64対応だけを根拠に任意形式のUI保存を保証しない。

- Pluginは`*.excalidraw`などの**形式ハンドラ**（Editor/Viewer）を宣言する。HostはExtension・MIME・ユーザー選択・Capability Permissionでルーティングし、衝突はHost/ユーザーが決める。
- Plugin UIからの編集途中はHostが**回復可能なDraft**として受け取る。Plugin自身のLocalStorageだけに唯一の原稿を置かない。大きな画像/Assetはサイズ限定ストリーム・Content Addressing・Commitとの原子的参照関係を設計する。
- Pluginからの提案は`FileChange`系のCAS/Read-set・Operation IDへ正規化し、Editor UIの承認前Journal/Checkpoint/Publishの境界を保つ。承認が必要な効果の分類は明示的に定義。`EffectClass`を理由なく`migration`で使い回さない。
- エディタの一時Draft・ローカルCheckpoint・リモートGitHub confirmedは異なる状態のまま。図面プラグインでも`publication_unknown`を成功表示しない。
- HostのOperation・Scratch限界値を超える巨大画像については、パイプラインを回避するのではなく**サイズ・Asset分割・Chunking方式を別契約として設計**する。上限を超える操作は明示的に拒否する。
- `Git object`/Snapshot IndexはCoreが所有し、Plugin索引は派生・Quota付き・いつでも破棄可能。Pluginが独自の正本DBを作らない。

## 6. Plugin Sandbox：故障と権限を本当に隔離する

### 6.1 信頼度別の実行ポリシー

| 実行コード | 許容条件 | 壊れた場合 |
| --- | --- | --- |
| Core built-in | Scriptorium TCB。変更はCore検証対象 | 通常のCore障害として扱う |
| Trusted built-in Module | 既存内蔵・レビュー済み。**安全隔離保証なし**を明記 | 同一プロセスの不具合がHostへ影響する可能性を認める |
| 外部Plugin UI | **独立originのsandboxed iframeが必須** | HostがFrameを切り離し、エラーPanel/標準Editor fallbackを表示。別Panelの状態は維持 |
| 外部Plugin compute | **WASI Sandbox + 独立OSプロセス + 実証済みResource/Filesystem/Network制御**が必須 | 対象子プロセスだけterminate/quarantine。他のPluginとCoreは保持 |
| 外部native/Node plugin | v1原則**許可しない**。同等以上の実隔離を別途認証した場合のみ | 「子プロセスだから安全」という免除はしない |

### 6.2 Server側の下限

1. WASM GuestにホストFS・ネットワーク・環境変数・clock・乱数を既定で渡さない。必要なWASI ResourceはCapability Broker経由の限定Portのみ。ホスト呼び出しもTimeout/Quota/Authorizationを検証する。
2. 無限ループ: Wasmtime等の**Fuel/Epoch Interrupt**を設定し、実呼び出しDeadlineの期限切れをSupervisorがHost外から監視してterminateする。
3. OOM: WASM Guest Memory/Table/Stack制限に加え、実際の**OS cgroup v2などのhard memory/CPU/PID/IO制御**を併用する。制限の適用可否・oom_score・Host cgroupの位置関係を観測する。
4. Filesystem/Kernel: sandbox専用のUser/Mount/Network Namespace、専用非root UID、Read-only Plugin Artifact、tmpfs quota、no-new-privileges、seccomp/AppArmor等を環境で許される範囲で検証する。Host workspace/PVC・Git credentialsをmountしない。
5. Kubernetes/Podman環境で**子cgroupの作成権限がない場合は無理に代替しない**。独立した制限付きSandbox Pod/Job等を別実行方式として選ぶか、`plugin_sandbox_unavailable`として起動拒否。強い隔離の欠如を正常稼働として黙認しない。
6. Sandbox runtime自体（Wasmtime、Helper、RPC Broker）はTCBに入り、固定Version・脆弱性更新とfuzz/conformanceを必要とする。WasmtimeをCore Nodeプロセスへ直埋込みして、Pluginのtrapに対する唯一の境界としない。

実行場所を増やす場合も**各PluginのPod常駐を前提としない**。起動オンデマンドと閉鎖を実測し、単一Hostでハード上限を満たせない時にのみPod化する。管理基盤を新設する口実にしない。

### 6.3 Browser側の下限

- Coreと**別のOrigin（できれば別site）**から検証済みのPlugin UIアセットを配信。Host Session Cookie、IndexedDB、DOM、Service Worker、LocalStorageを共有しない。Artifactに紐づくCache-Control・CSPをHostが強制。
- `iframe sandbox="allow-scripts"`を基準とし、`allow-same-origin`、Top Navigation、Popup、Form等は既定では付けない。**同一origin frameの`allow-scripts allow-same-origin`を併用しない**。必要な例外は別設計/検証。Sandboxでブラウザ機能が使えないPluginはSDKへ委譲させる。
- `postMessage`の初期通信はHostが生成したFrameの`contentWindow`と予期したArtifact/Sessionを束縛し、必要な`MessagePort`だけ渡す。Opaque Origin（`origin="null"`）の場合に`event.origin`だけで正当性を判定しない。受信ごとにChannel/Activation Epoch/Capability/Schemaを検査する。
- Pluginの`fetch`によるHost/API認証迂回を禁止。CSP `connect-src 'none'`等とPermission Policyを既定とし、外部アクセスはBrokerの明示Capabilityで処理。画像・フォント等のアセット配信も同じResource Budget/Origin Policyに従う。
- Plugin描画ループが固着したらHostはPanelを閉じる。ブラウザによってFrameとHostが同一Renderer Processになる場合やブラウザ全体OOMは**完全に防げると主張しない**。ブラウザ実機（Chromium/WebKit/モバイル）でRecoveryを含めて検証する。

## 7. Lifecycle、Quotas、エラー閉じ込め

### 7.1 State machine

~~~mermaid
stateDiagram-v2
    [*] --> NotInstalled
    NotInstalled --> InstalledDisabled: Host admits artifact
    InstalledDisabled --> EnabledIdle: permission + profile enabled
    EnabledIdle --> Activating: permitted demand
    Activating --> Active: sandbox ready
    Activating --> Failed: startup/error/timeout
    Active --> Suspended: no consumers
    Suspended --> Activating: new request
    Active --> Draining: disable/upgrade/lease revoked
    Suspended --> Draining: disable
    Draining --> InstalledDisabled: stopped + disposed
    Active --> Failed: crash/oom/protocol invalid
    Failed --> EnabledIdle: explicit recovery or bounded retry
    Failed --> InstalledDisabled: quarantine
~~~

- Installed/Disabled: Hostは検証済みManifestと依存閉包のみを保持。**Pluginコードはimport/execせず、Worker/iframe/timer/HTTP listenerは0**。
- Enabled/Idle: Capability/Contribution Registryへの**純データ登録**は可、実行プロセス、モデル、索引、重いbrowser Chunkは起動しない。静的Manifest参照にかかる微小なHost CPU/RSSのみ許す。
- Active: Visible editor/panel、明示Jobまたは必要な購読があって初めて起動。Activation ID、Lease、AbortSignal、Deadline、Resource Budgetを付与。
- Suspension: リスナー解除・Queue排出・Cancellation・Worker終了・Page Frame detach。Private未保存データがある場合は**HostがRecovery Journalへの保存を確認してから**Panelを破棄する。
- Failed/Quarantined: 原因、Plugin ID/Digest、Quota、Plugin-owned Jobを記録。**CoreのEditorをunmountしない**。単独PluginのエラーでCore Runtime/API全体へ例外を再throwしない。
- Upgrade: Digest変更前に既存Worker/Frameをdrain、Versioned state migrationを検証し、失敗なら旧版を保持。保存済み原稿、未公開Operation、ユーザー設定を破棄しない。

### 7.2 Resource budgets（設計契約）

各Pluginの**Host実行予算**はHost Policyが定義し、Manifest申告のBudget Classは許可拡張ではなく**上限内の要求**とする。必要メトリクス:

| 指標 | プロトコル上の意味 |
| --- | --- |
| DisabledのOSプロセス/Browser Chunk | **0**（Manifest解析以外実行しない） |
| Enabled-Idle CPU/Job/Network | **0の定期実行**。購読が明示的に存在する時だけ認可済み処理 |
| ActiveのCPU/RSS/Memory/Table/PID/IO/Network | Guest上限、OS/cgroup上限、Host全体の上限を**階層的に強制** |
| RPC bytes/in-flight/concurrency | 上限を超えたら該当Pluginへ`plugin_overloaded` |
| Deadline/Cancel/Drain | 無応答でもHost Supervisorが外側から終了できる |
| Crash restart/Backoff | Crash loopがCore CPU/Log/Diskを無限に消費しない |
| Plugin cache/quota | キャッシュはPluginごとの名前空間/Quota。削除でAuthorデータを消さない |

MiB、ms、同時起動数の上限は対象Hostの実測と故障注入で検証する。内蔵Workerの上限値を外部Pluginの隔離保証へ流用しない。

### 7.3 エラー伝播とユーザー表示

| 事象 | Hostの対応 | Core・作業データ |
| --- | --- | --- |
| 不正Manifest/署名/互換性 | Admit拒否、既存版維持 | Core通常起動 |
| Load失敗/Trap/Process crash | 対象Plugin `failed`、実行Handle破棄、PanelはError Boundaryへ | Core Editor・他Panel継続 |
| 無限ループ/Timeout | Deadline経過で独立Worker/Frameをterminate、必要ならQuarantine | Draft保存済み/未保存状態はHostが保持 |
| OOM/IO過負荷 | OS予算で当該Sandbox終了、BudgetViolation記録 | Host cgroupが道連れにならないことを受入試験で検証 |
| 非準拠RPC/権限外操作 | Fail closed、Audit、依存程度でQuarantine | Git/権限変更なし |
| Host再起動/Delivery喪失 | Pluginの実行履歴は再構築、未確認Proposal/Operationを正本と照合 | Journal・Receipt保持。未知Publishは`publication_unknown` |
| Pluginの要求したChangeの競合 | Coreが`snapshot_changed`やConflictを返し再提案を要求 | 原稿は自動上書きしない |

**自動再試行の対象は冪等なRead/Computeに限定**。提案済みMutationは同一Operation IDとDigestで照合し、Checkpoint/PublishをPluginが自律的に繰り返さない。

### 7.4 Praetorium Runtime / Quiesceとの連動

Pluginが止まることと、**Scriptorium Writerを安全に停止できることは別**。Hosted Runtimeの`/api/platform/v1/status`、`quiesce`、`resume`契約（[platform-runtime](../../packages/api/src/platform-runtime.ts)）に従い、Plugin Hostも活動・保存状態に参加する。

- **Activity/Status:** Plugin Workerの実行中Job、未DrainのRPC、Plugin UIからHostへ受領した未保存Draft、未確定Proposal/Operationを、Host側の観測に反映する。失敗や接続断は`unknown`として扱い、単に「Pluginプロセスがない = safe」と判定しない。
- **Quiesce:** Hostは新規Plugin編集/書込提案を停止し、進行中UI変更を確定済みBrowser Journalへflushする。Browserが不在でFlushを確認できない場合や、Pluginがクラッシュ中の場合は、元のScriptorium/Writer不在証明・Checkpoint契約に沿って停止可否を決める。
- **Shutdown:** Deadline以内に停止しないPluginは当該Sandboxだけterminateする。ただし未保存編集の消失、未確定Publish、旧Writerが生存していないかを別条件として確認し、単なるProcess killで`quiesced`を確定しない。
- **Resume/Replacement:** PluginのActivation EpochとRuntime Epochを更新し、旧Sandboxから遅延到着したResponse/Event/Proposalを無効化する。新Runtime/新Pluginが旧Writerと同時に同じRepositoryへ書き込まない。
- **プラットフォームの正本:** [Praetorium](https://github.com/yohn-jp/praetorium)のD1・Operation FenceとGitHub履歴をPlugin独自のローカル状態で置き換えない。Pod Ready/Worker停止をGitHubへの出版成功証明として扱わない。

## 8. 外部リポジトリ、配布、Praetorium連携

### 8.1 ソースとArtifactual Identity

~~~text
independent Git repository
  -> reproducible plugin build + SDK conformance
  -> immutable package artifact (manifest, WASM, UI assets, schemas)
  -> Digest + provenance + signature + optional SBOM
  -> operator-approved install/catalog
  -> Praetorium / Scriptorium producer composition
  -> exact plugin digest pinned in runtime image/manifest
  -> metadata-only discovery; lazy sandbox execution
~~~

- Core/SDK/Plugin Hostは`yohn-jp/scriptorium`に置く。Pluginは独立リポジトリから開発でき、機能内の任意依存関係はCore本体へ展開しない。
- 配布形式の第一候補は**OCI Artifact**（Digest pinning、Producer/Registryと再利用しやすい）。npm配布やWIT SDK bindingも選択できるが、Registry名でなく**承認された内容Digest**を最終識別子とする。
- Plugin Artifactの`manifest`、WASM、Browser UI、Resourceアセット、API SchemaはBuild時に同一Digestへ束縛。Manifest内容とEntry Pathは署名済みBundle内だけ参照する。
- **インストール/許可はHost管理**。Git作業リポジトリのYAMLやMarkdownから任意のPlugin URL/Packageを実行することはない。Work repositoryは「承認済みPlugin IDと設定」だけ指定できる。
- Hosted Compositionは既存のPraetoriumによるCatalog、Immutable Digest、Admissionと接続する。新たな認可DBや第二のPlugin Marketplace Authorityを設けない。Private/Internal Pluginも同じVersion/Digest/Scope契約を使う。
- Runtimeの`npm install`や任意コードダウンロード、`latest`タグ追従は禁止。アップグレードはHost Policyで承認したImage/Compositionの再配布とModule Recovery検証を必要とする。
- SDKテストハーネスは外部リポジトリ単独で実行可能。**Coreのprivate importsを使うPluginはSDK準拠と認めない。**

### 8.2 外部Plugin開発者が触れる表面

Pluginが依存してよいのは、Versioned Manifest Schema、生成されたSDK/WIT binding、Capability schemas、UI Bridge、公開conformance fixtureのみ。**`packages/core/src/index.ts`、`packages/api/src/server.ts`、ホストのプライベートEnv、ブラウザの`SharedApplication`状態へ直接依存させない。**

既存の内部`@scriptorium/contracts`全部を無条件にpublic npm SDKへ再輸出しない。単一のTransport非依存な公開Contract subsetを明示し、内部契約とはAdapterを通す。非互換な内部RefactorでもPluginが壊れないよう、公開ABI側にcompatibility gatesを置く。

## 9. 最小垂直スライス：図面エディタを例に契約を検証

このセクションは**Excalidraw Pluginの実装指示ではなく**、汎用APIが実際に使えるかを検査する受入用の例。

1. 外部リポジトリの`example.diagram`を承認済みDigestでBuild Compositionへ登録。Manifestのみ読み込み、Core起動とMarkdown編集の初期コストは変化しない。
2. ユーザーが`docs/map.excalidraw`を開く。HostがPath/Revisionと選択されたSnapshotを確認し、対応Editorをオンデマンドのisolated Frameとして表示。
3. Pluginは`workspace.snapshot.read`でJSONを受け取り編集。Canvas表示をServerへ強制しない。Raw Git Credential/Host DOMは受け取らない。
4. ユーザーが保存操作を行う。Host UIはまず回復可能な差分/完全DraftをJournalに確定し、その後`workspace.change.propose`で適切なOperationを発行。PluginにAuthor Approval権限を渡さない。
5. 既存のChange Approval→Checkpoint→Publish→GitHub confirmedが成功すればGitに`.excalidraw`ファイルとして存在。競合や`publication_unknown`の時はHostが状態を明示し、原稿と図面を保持。
6. PluginのFrame/Workerを強制終了しても別のMarkdown Editor、未公開Draft、Core API、他Pluginは継続。Frameを再起動すればHost Journalから確実なDraftを復元。

**このユースケースを満たせなければ**、公開APIが実際のファイル編集に不足している。具体的な差分を公開Protocolへ追加し、Plugin専用のCore回避APIを作らない。

## 10. 不変条件とConformance / Fault-injection

### 10.1 契約の試験（必須Acceptance）

- **Core-only**: Pluginが0件/100件インストールされていても、disabled/no-plugin時のProcess=0・Browser Plugin Runtimeロード=0。Core Editor/Recovery/Publishへの既定経路は存在。性能差は測定して予算内。
- **Manifest**: 不正ID、パストラバーサル、署名不一致、未知の必須Capability、依存Cycle、Duplicate Provider、ABI不一致、悪意のあるAsset URL、過大入力をfail closed。
- **Isolation**: WASM trap/無限loop/メモリ膨張、OS子プロセスOOM、stdout/stderr洪水、孤児プロセス、IPC洪水、Network/FS脱出要求でCore/他Pluginが落ちない。必要なOS sandboxがなければPlugin起動を拒否する。
- **Browser**: 親DOM/Cookie/IndexedDBへのアクセス、Same-origin Host fetch、Cross-frame spoofing、Popup/Navigation、Promise Hang、Frame crash、Script大負荷を対象。Host Markdown編集とDraftは継続。
- **Persistence**: Pluginの提案→Author Approval→Journal→Checkpoint→Publish、ネット断・Response loss・再起動・同時編集・CAS conflictで旧Writer/古いSnapshotは上書き不可、Digest/Operation IDで再照合。
- **Lifecycle**: Disable/Unload/Upgradeと途中のin-flight RPC、古いActivation Epochの結果がHostへ再適用されない。Capability Leaseは解除され、Resource Usageは起動前まで戻る。
- **Distribution**: 外部Repository Artifactが公開SDKだけでBuild/Verifyでき、Producerへ指定Digestで取り込まれ、Core-only Imageに依存追加しない。改竄Packageは実行前に拒否。
- **Authorization**: Repository/Author scope、Operation、承認状態をHostが毎回照合。Plugin IDの自己申告だけでwrite/linkedReader/networkを得ない。

### 10.2 測定項目と合格の論理

`process RSS/peak`、`cgroup memory.peak/OOM events`、`event loop lag`、`Browser long tasks/INP`、`initial JS+requests`、`sandbox spawn time`、`RPC p95/p99`、`idle CPU`、`plugin crash containment`、`draft recovery success`を測定する。性能予算は対象構成の再現可能な測定で検証し、架空のベースラインを記録しない。

**単一のCrash実験PASS ≠ 隔離認証。** Kubernetes上のcgroup、BrowserのFrame/process分離、PluginのNetwork/FS Access Denial、異常終了後の復旧/Writer安全性まで実測して初めて対象構成に限定したFault-containment claimを出す。

## 11. Deployment-specific design constraints

Host adapters must specify and verify process/cgroup authority, filesystem and network denial, the UI asset origin and CSP, large-file operation limits, registry admission and publisher identity. A deployment may claim only the guarantees exercised by its conformance and fault-injection checks. Numeric resource budgets require measurements on that host configuration.

## 参考ソース

- [Internal Contract](../../packages/contracts/src/index.ts)、[Module Runtime](../../packages/module-runtime/src/module-runtime.ts)、[Worker Supervisor](../../packages/module-runtime/src/worker-supervisor.ts)、[Profile Build](../../scripts/profile-build.mjs)、[Browser Contributions](../../app/src/contributions/ContributionHost.tsx)
- [Modular Workspace](MODULAR-WORKSPACE.md)、[Core](CORE.md)、[Modules](MODULES.md)
- [Wasmtime Security](https://docs.wasmtime.dev/security.html)、[Wasmtime Introduction](https://docs.wasmtime.dev/introduction.html)、[WIT Component Model](https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md)
- [MDN iframe Sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)、[MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)

**設計の到達点:** ScriptoriumのCoreは小さく、Gitと回復を堅牢に保ち、Pluginは公開された能力を通して自由にアプリケーションを構成できる。ただし自由な拡張は、HostのAuthor認可、データ正本、OS/Browserの隔離境界を超えない。
