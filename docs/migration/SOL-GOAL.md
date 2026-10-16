/goal

# Scriptorium — Complete Modular Migration

Coordinator: Sol
Workers: Luna / subagents。人数の人工的な上限は設けない。独立作業は並列化する。
Target: https://github.com/yohn-jp/scriptorium
Read-only source: https://github.com/yohn-jp/arcadia-loom
Execution authority: Scriptorium Epic #7

## Goal

既存Coreの保存・同期を改良し、Arcadia Loomの実装済み執筆機能を本物のアドオンとして移行する。機能、作者の確定データ、UI、API、MCP、実行時分離まで含めて移行を完了し、検証済みの統合成果をmainへcommit・pushする。雛形、Coreだけ、バックエンドだけ、計画やPRだけで終了しない。

## Canonical plan

計画は `docs/7-full-migration-plan` ブランチにある。mainに未反映なら当該成果を取得して読む。

- `docs/architecture/FULL-MIGRATION.md`
- `docs/migration/FULL-MIGRATION-PLAN.md`
- `docs/migration/SOL-GOAL.md`

この実行依頼では上記計画を採用し、P00〜P13の固定キャンペーンを最後まで実行する。既存Issue #1はMVPの履歴であり、今回の完了条件をCore限定に戻さない。

確認済み基準:
- target main: `01403182e9f73dec29d04954e3091c235cd1aac0`
- source main: `edc033c2c9466274a334299dadfa426661d957d9`

開始時に最新状態を取得し、差分があれば今回の契約に関係するものだけ整合する。既存成果を作り直さない。

## Fixed architecture

- git cloneを維持。原稿の編集対象はGitHubのdefault branch。コンテナ別のremote branchは作らない。
- Draft＝ブラウザ、Checkpoint＝ローカルcommit、Saved＝GitHubへのpush確認済み。Checkpoint成功でブラウザの復元記録を消さない。
- remoteを実際にfetchし、正本snapshotと未pushの変更を分離する。未編集の表示は追従し、編集中の内容は保護する。ローカルのahead/behind確認だけで追従済みとしない。
- 同一変更の再試行・コンテナ再作成・応答喪失・push競合を計画の操作IDとrevision契約で処理する。force-pushや本文の自動競合解決は禁止。
- TypeScript/Nodeとpnpm workspaceを維持。UIは既存React/Vite資産を再利用し、APIは既存Fastifyの境界を整理して移植する。NLPを理由にPython/Rustへ全面再実装しない。
- story、diagnostics、nlp、semantic、speaker、assistant、publishing、mcpを独立パッケージ化する。Coreは個別モジュールをimportしない。
- 未搭載・無効・有効待機・実行中を分ける。UI非表示だけでなく依存物、初期化、ジョブ、worker、モデルを分離する。重い計算は同一コンテナ内の子プロセス。モジュール別コンテナ群やnpm公開基盤は作らない。
- core/fullは単一アプリケーションイメージの構成違い。作品データと作者の訂正・設定を保持し、派生索引だけを再生成可能にする。

## Execution

Solが共有契約、root manifest/lockfile、統合とmainへの書込みを一元管理する。サブエージェントは独立作業領域で実装・必要な検証・commitし、成果を返す。

今回もmainへの直接commit・pushを許可する。Issue別PRは不要。計画文書と既存成果を重複なく取り込み、完了までコミットを保留せず、意味のある単位で継続的にpushする。履歴の削除、force-push、他者の変更破棄はしない。

P00でbaselineと実際のproducer契約を確定し、固定DAGに沿って依存が揃った担当を直ちに進める。3件ずつ等の人工的な分割や各Wave末尾での停止・再承認要求は禁止。未計画の機能追加や無限のバックログ探索も行わない。

48のsource API登録と非API機能・保存データの台帳を完成させ、各項目に移行先と証拠を付ける。機能名やファイルの移動だけで移行済みとしない。sourceの壊れた接続部分は担当機能内で修復し、未実装の将来構想は台帳の明示的な除外に従う。

## Constraints and verification

Arcadia Loom/Platformは変更しない。Platform実装・本番デプロイ・イメージ公開・CI/GitHub Actions・組織テンプレート同期/追加/実行・Inariは禁止。私的作品、秘密情報、私的評価コーパス、権利未確認の資産を公開しない。

ローカル型検査・テスト・ビルド・実ブラウザ・実Git・実モデル・実OCIイメージ検証を計画どおり実施する。必要なテストだけを追加し、モックだけで実統合を認定しない。core-onlyとfullの両方、コンテナ破棄後の復元、モジュール無効化後の実リソース解放を証明する。

レビューは実装担当とは別の読み取り専用サブエージェントへ割り当てる。Solは受入条件に基づいて指摘を精査し、担当実装者に修正させ、影響する検証を再実行する。

解消可能な障害は自律的に修復する。外部権限・実行環境が本当に不足する場合は、無関係な作業を止めず成果を保存し、該当検証をBLOCKED/NOT_CHECKEDとして原因と最小の解除条件を示す。未検証を成功としない。

## Stop

成功条件はEpic #7、P00〜P13、機能/データ台帳の受入条件を満たし、独立レビューを解消して、検証済みの全成果がmainにcommit・pushされたこと。

最終報告はmain HEAD、移行済み機能/台帳、保存同期契約、実行した検証、image digest、計測結果、残るブロッカー。CI未導入をブロッカーにせず、実装完了・検証完了・未実施を区別する。
