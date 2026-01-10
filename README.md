# Gtags Hopper

**Gtags Hopper** は、GNU GLOBAL (gtags) を使ってソースコードの定義・参照へ素早くジャンプできる VS Code 拡張機能です。  
右側のエディタカラムで開くので、コードの見比べがスムーズにできます。

---

## 主な機能

- 定義ジャンプ (`Jump to Definition`)
- 元の位置に戻る (`Jump Back`)
- 参照ジャンプ (`Jump to References`)
- ファイル内シンボル一覧 (`List Symbols in File`)
- Grep 検索 (`Search by Grep`)
- タグ更新 (`Update Tags`)

---

## インストール方法

### Visual Studio Code Marketplace
（公開後、ここにリンクを追加）

### 手動インストール
1. このリポジトリをクローンまたはダウンロード
2. `vsce package` で `.vsix` ファイルを作成
3. VS Code で「拡張機能」→「…」→「VSIX からインストール」を選択

---

## 使い方

1. プロジェクトのルートで `gtags` を実行してタグを作成
2. キーバインドまたはコマンドパレットから機能を呼び出す

既定のキーバインド例:
| 機能 | キー |
|------|------|
| Jump to Definition | `Ctrl+Alt+]` |
| Jump Back          | `Ctrl+Alt+[` |
| Jump to References | `Ctrl+Alt+;` |
| List Symbols       | `Ctrl+Alt+'` |
| Update Tags        | `Ctrl+Alt+T` |
| Search by Grep     | `Ctrl+Alt+<` |

---

## ライセンス

このプロジェクトのライセンスは MIT です。（LICENSE ファイル参照）
自由に利用・改変・再配布が可能です。

---

## 作者

uta
