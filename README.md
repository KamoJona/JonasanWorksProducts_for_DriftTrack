# JonasanWorks Products for DriftTrack

DriftTrack 社向けの、製品企画の共有資料です。

## 資料

| 資料 | 内容 |
|---|---|
| [スタートシグナル グレード構成とコスト差](docs/startsignal/start-signal-grades.html) | Pro／Standard／Lite のグレード構成、Wi-Fi オプション、コスト差、価格と利益率の案 |

資料はパスワードで保護されています。ページを開いて、共有されたパスワードを入力してください。

公開ページ: https://kamojona.github.io/JonasanWorksProducts_for_DriftTrack/startsignal/start-signal-grades.html

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

## 公開の流れ（管理者向け）

GitHub Pages は `main` ブランチの `/docs` を公開します。push したものがそのまま公開されます。

1. 元の HTML を暗号化して `docs/<製品名>/` に置く。
2. 手元のブラウザで開き、パスワードで表示できることと内容を確認する。
3. 確認できたら `main` に commit して push する。

注意: リポジトリは public です。暗号化前の HTML は置かないでください。