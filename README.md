# OrcaSlicer Web · CubbySlicer

iPadやPCのブラウザでモデルを開き、**OrcaSlicerの実際のスライスエンジンをWebAssemblyで端末内実行**する非公式Webアプリです。[CubbySlicer](https://github.com/JoshTheDerf/cubbyslicer)をベースにGitHub Pages向けに構成しました。デスクトップ版の公式Web版ではありません。

**公開URL: https://psych0h3ad.github.io/orcaslicer-web/**

STL・OBJ・STEP・3MFの読込、プリンター／フィラメント／プロセス設定、モデル配置・加工、スライス、ツールパスプレビュー、G-code保存、3MFプロジェクトの保存に対応します。OrcaSlicer 2.5.0 / bridge ABI 1のシングルスレッドビルドをWeb Workerで実行します。スライス用サーバーやAPIキーは不要です。

## iPadで使う

1. 最新のiPadOSのSafariで公開URLを開きます。初回はプリンタープロファイルを設定します。
2. **モデルを開く · Import** から「ファイル」にあるSTLなどを選択します。
3. 左上のサイドバーボタンから、実際に使うプリンター・ノズル・材料・印刷設定を選びます。
4. **Slice plate** を押し、Previewで印刷経路を確認します。
5. **Export G-code** で保存します。3MFはFileメニューから保存できます。

1本指で視点を回転、2本指でズーム・移動。共有メニューの「ホーム画面に追加」も利用できます。iPadOS実機での検証はまだ行っていません。まず小さいモデルで確認してください。詳しくはアプリ内の「使い方・iPadガイド」を参照してください。

## この配布版の範囲

- モデルとG-codeはブラウザ内で処理します。モデルを外部スライスサーバーへ送信しません。
- エンジン・プロファイル・CAD・校正用モデル・テクスチャは同じPagesサイトから配信します。初回表示にはネット接続が必要です。オフライン動作は保証しません。
- GitHub Pagesの通常ヘッダーで動かすため、SharedArrayBuffer・COOP/COEP・Service Workerを必要としないST版を使用します。大きなモデルは端末のメモリ制限を受けます。
- CubbyCADクラウド、AI/MCP接続、Pythonプラグイン、preFlightエンジンはこの配布版では使用できません。Python処理付きプロジェクトは説明を表示してスライスを停止します。
- プリンターへの直接送信は機種やCORS・HTTPSの条件に依存します。G-codeを保存して渡す方法が基本です。デスクトップ版の全機能との完全互換を保証するものではありません。

## ローカルで起動

Node.js 24 と Git が必要です。PowerShellでも同じコマンドを使用できます。

```sh
npm ci
npm run assets
npm run dev
```

表示されたlocalhost URLを開きます。公開サイトと同じくクロスオリジン分離ヘッダーを付けません。別端末からの閲覧用にPCのポートを自動公開する設定にはしていません。

```sh
npm test
npm run test:engine
npm run build
npm run preview
```

`test:engine`はモックを使わず、実際のプリセット・STL読込・パッキング・Orca WASMで20mm立方体をスライスします。G-code／レポートは `e2e-out/engine-smoke/` に保存し、不正なメッシュ参照が構造化エラーで拒否されることも検証します。

## GitHub Pages

リポジトリの **Settings → Pages → Build and deployment → Source: GitHub Actions** を選択します。`main`へのpush、またはActionsの手動実行で [pages.yml](.github/workflows/pages.yml) が公開します。

ワークフローは依存関係インストール、固定資産の検証付き取得、テスト、実エンジンスライス、型検査、ビルド、Pagesデプロイの順に実行します。`actions/configure-pages`の実URLからbase pathを取得するため、リポジトリ名変更・ユーザーサイト・カスタムドメインにも追従します。

サブパスのローカルビルド例（PowerShell）:

```powershell
$env:BASE_PATH = '/orcaslicer-web/'
npm run build
npm run preview
```

## 資産の固定とソース

`scripts/pages-assets.lock.json`に取得URL・サイズ・SHA-256とソース情報を記録しています。検証済みの720資産は、このリポジトリの[固定スナップショット](https://github.com/Psych0h3ad/orcaslicer-web/releases/tag/assets-2026-11-16)にも保存しました。`npm run assets`は一致するローカルファイルを再利用し、不足があれば約40MBのスナップショットZIPを取得します。ZIP全体と各ファイルのSHA-256を検証してから展開するため、上流CDNの地域別画像変換に左右されません。

`npm run assets:verify`はネット接続なしで完全性を検証します。意図的に上流から更新するときだけ `node scripts/stage-pages-assets.mjs --update-lock` を実行し、ソース・エンジンABI・差分を確認して再テストしてください。この操作は古いsnapshot指定を外します。更新後は新しい固定スナップショットを公開し、そのURL・サイズ・SHA-256をlockの `snapshot` に記録してください。元の上流URLは可変です。公開済みスナップショットを置き換えず、新しいタグを使用します。

バイナリ配布元はビルドcommitを公表していません。lockにあるソースSHAは取得時に観測した参照情報です。該当バイナリがそのSHAから作られたという保証ではありません。配布バイナリ自体の同一性はSHA-256で検証します。C++からの再ビルドは [orcaslicer-wasm](https://github.com/JoshTheDerf/orcaslicer-wasm) を参照してください。

ビルド時にこのフロントエンドの `source.zip` とライセンスを生成し、アプリのヘルプからダウンロードできます。依存パッケージはlockfileから取得し、エンジンの別ソースはprovenanceに記載しています。

## クレジット

- [CubbySlicer](https://github.com/JoshTheDerf/cubbyslicer) — Web UIとブラウザ統合。ベースcommit: `bdf0007bda4d5bc0fe56b34df1e8fb7fdcf234b5`。[元のREADME](docs/UPSTREAM-README.md)
- [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) — スライスエンジン・プロファイル・校正用モデル。
- [orcaslicer-wasm](https://github.com/JoshTheDerf/orcaslicer-wasm) — OrcaSlicerのWebAssembly移植。
- [cubby-shared](https://github.com/JoshTheDerf/cubby-shared) — 共有モデリング・UI部品。依存commitはpackage-lock.jsonに固定。

[AGPL-3.0-or-later](LICENSE)。各依存物・モデル・プロファイルの権利表示も引き続き適用されます。
