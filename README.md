# JonasanWorks Products for DriftTrack

DriftTrack 社向けの、製品企画の共有資料です。

## 資料

| 資料 | 内容 |
|---|---|
| [スタートシグナル グレード構成とコスト差](docs/startsignal/start-signal-grades.html) | Pro／Standard／Lite のグレード構成、Wi-Fi オプション、コスト差、価格と利益率の案 |
| [スタートシグナル 2 グレード案（Lite 廃止案）](docs/startsignal/start-signal-2grades.html) | Lite をなくし Pro／Standard の 2 グレードにした場合の比較案 |
| [プラネタリウム](docs/planetarium/index.html) | 地上の好きな地点から、いまの時刻の空を再現する 3D ビューア（スマホの向きで見回せる）。宇宙飛行版 `flight.html` 付き。パスワード保護なし |
| [mountainVR（稜線 AR）](docs/mountainvr/index.html) | 現在地から見える山並みを標高データで再現し、山頂に山名と標高を表示する VR（カメラ映像に重ねる AR モード付き）。パスワード保護なし |

資料はパスワードで保護されています。ページを開いて、共有されたパスワードを入力してください。

公開ページ:

- 3 グレード案: https://kamojona.github.io/JonasanWorksProducts_for_DriftTrack/startsignal/start-signal-grades.html
- 2 グレード案: https://kamojona.github.io/JonasanWorksProducts_for_DriftTrack/startsignal/start-signal-2grades.html
- プラネタリウム: https://kamojona.github.io/JonasanWorksProducts_for_DriftTrack/planetarium/
- mountainVR: https://kamojona.github.io/JonasanWorksProducts_for_DriftTrack/mountainvr/

## 資料の暗号化（管理者向け）

`tools/encrypt-page.ps1` で、元の HTML をパスワード付きのページに変換します。元の HTML はこのリポジトリには置きません。

```
powershell -ExecutionPolicy Bypass -File tools\encrypt-page.ps1 -InFile <元の HTML> -OutFile docs\<製品名>\<ファイル名>.html
```

## フォルダ構成

`docs/` の中は製品ごとにフォルダを分けます。

| フォルダ | 製品 |
|---|---|
| `docs/startsignal/` | スタートシグナル |
| `docs/planetarium/` | プラネタリウム（ソースは KamoJona/stars の `planetarium` ブランチ） |
| `docs/mountainvr/` | mountainVR（稜線 AR） |

## 公開の流れ（管理者向け）

GitHub Pages は `main` ブランチの `/docs` を公開します。push したものがそのまま公開されます。

1. 元の HTML を暗号化して `docs/<製品名>/` に置く。
2. 手元のブラウザで開き、パスワードで表示できることと内容を確認する。
3. 確認できたら `main` に commit して push する。

注意: リポジトリは public です。暗号化前の HTML は置かないでください。