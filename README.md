# Netflix & Disney+ Dual Subtitles JKL Capture

NetflixおよびDisney+の再生画面に日本語・英語字幕を同時表示し、`j` / `k` / `l` でシークと再生を操作し、`c` で字幕付きPNGを保存するChrome拡張です。

> [!IMPORTANT]
> 各サービスの公開APIではなく、再生ページが取得する字幕情報を端末内で観測します。NetflixまたはDisney+側の変更によって字幕取得が動かなくなる場合があります。DRM保護により、PNGの映像部分が黒くなる環境もあります。本拡張はDRMを回避しません。

## 対応環境

- Windows版の最新Google Chrome
- `https://www.netflix.com/` または `https://www.disneyplus.com/` の再生ページ
- 利用中のサービスから日本語・英語字幕が提供されている作品

翻訳サービスや外部サーバーは使用しません。字幕本文・視聴履歴も保存しません。

## インストール

1. 配布ZIPを任意のフォルダへ展開します。
2. Chromeで `chrome://extensions` を開きます。
3. 右上の「デベロッパー モード」を有効にします。
4. 「パッケージ化されていない拡張機能を読み込む」を選び、`manifest.json` があるフォルダを指定します。
5. すでにNetflixまたはDisney+を開いていた場合は、タブを再読み込みしてから動画を再生します。

更新時は展開先を新しい内容で置き換え、`chrome://extensions` の本拡張にある更新ボタンを押して再生タブを再読み込みしてください。

## 使い方

- `j`: 10秒戻る
- `k`: 再生・一時停止
- `l`: 10秒進む
- `c`: 一時停止して表示中タブをPNG保存し、直前に再生中なら自動再開
- ツールバーアイコン: ON/OFF、字幕順、サイズ、位置、キー、保存先を変更

画像は既定で `Downloads/Dual Subtitle Captures/` に保存されます。入力欄やプレイヤーの設定ダイアログを操作している間、ショートカットは無効です。

## 状態とトラブルシューティング

ツールバーアイコンを開くと、日本語・英語それぞれの取得状態を確認できます。

- 「検索中」のまま: 再生タブを再読み込みし、字幕メニューを一度開くか別の字幕へ切り替えてください。
- 「利用不可」: 作品、地域、プロフィール設定の組み合わせで対象言語が提供されていません。
- 「エラー」: サービスの内部レスポンス形式が未対応、または字幕リクエストが失敗しています。再読み込み後も続く場合はサービス側の変更が疑われます。
- PNGの映像が黒い: DRMによる環境依存の制限です。字幕オーバーレイは保存されますが、映像込みは保証されません。
- 字幕が三重になる: 拡張をOFF→ONにして復旧しない場合、再生タブを再読み込みしてください。

## 開発・検証

拡張はビルド不要のES Modulesです。開発環境はNode.js 24 LTSを推奨し、Node.js 20以上で以下を実行できます。Windowsへ新規インストールした直後は、PATHを反映するためターミナルを開き直してください。

```powershell
npm test
npm run check
npm run package
```

`npm run package` はマニフェストのバージョンに合わせたZIP（現在は `release/netflix-dual-subtitles-v1.0.0.zip`）と展開済みフォルダを生成します。

実サービスでのリリース確認項目は [MANUAL_TESTS.md](MANUAL_TESTS.md) を、Disney+対応の設計と保守情報は [doc/DISNEY_PLUS_SUPPORT.md](doc/DISNEY_PLUS_SUPPORT.md) を参照してください。

## プライバシーと権限

- `storage`: ローカル設定の保存
- `downloads`: PNGの保存
- `activeTab`: ツールバーから有効化した対応サービスのタブのPNGキャプチャ
- `<all_urls>`（任意）: `c` キーからのPNGキャプチャ。ポップアップで明示的に許可した場合だけ有効
- `https://www.netflix.com/*`: 字幕表示、キー操作、表示中タブのキャプチャ
- Netflix CDN（`nflxvideo.net`、`nflxso.net`、`nflximg.net`）: Netflixが提供する字幕ファイルの取得
- `https://www.disneyplus.com/*`: 字幕表示、キー操作、表示中タブのキャプチャ
- Disney+字幕CDN（`media.dssott.com`）: Disney+が提供するHLS字幕プレイリストとWebVTT断片の取得

Netflix・Disney+とそれぞれの字幕CDN以外への通信、字幕の書き出し、閲覧履歴の取得、クラウド同期は行いません。
