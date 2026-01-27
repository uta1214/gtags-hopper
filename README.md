# Gtags Hopper

**Gtags Hopper** is a VS Code extension that enables quick navigation to code definitions and references using GNU GLOBAL (gtags).  
Files open in the right editor column for easy side-by-side code comparison.

---

## Key Features

### Code Search & Navigation
- **Jump to Definition**
  - Definition search using gtags
  - Falls back to local search (function scope → entire file) if not found
- **Jump Back**: Return to previous location
- **Jump to References**: Find all references
- **List Symbols in File**: Display all symbols in current file
- **Search by Grep**: Search using regular expressions
- **Update Tags**: Regenerate gtags database

### Jump History Panel
- **Visual History Management**: Display jump history in sidebar
- **History Navigation**: Navigate through history using ▲/▼ buttons
- **History Search**: Filter history by file name or symbol name
- **One-Click Jump**: Click history items to jump to any location
- **Theme Customization**: Choose from 4 themes
  - Modern Dark (VSCode style)
  - Modern Light
  - Colorful Dark (gradient style)
  - Colorful Light

---

## Installation

### Visual Studio Code Marketplace
https://github.com/uta1214/gtags-hopper

### Manual Installation
1. Clone or download this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to compile
4. Run `vsce package` to create `.vsix` file
5. In VS Code, select "Extensions" → "..." → "Install from VSIX"

---

## Usage

### Basic Usage
1. Run `gtags` in your project root to create tags
2. Use keybindings or command palette to invoke features

### Keybindings
Default keybindings:
| Feature | Key |
|---------|-----|
| Jump to Definition | `Ctrl+Alt+]` |
| Jump Back          | `Ctrl+Alt+[` |
| Jump to References | `Ctrl+Alt+R` |
| List Symbols       | `Ctrl+Alt+S` |
| Update Tags        | `Ctrl+Alt+T` |
| Search by Grep     | `Ctrl+Alt+G` |

### How to Use History Panel
1. Click Gtags Hopper icon in sidebar
2. "Jump History" panel will appear
3. **▼ Button**: Navigate to older history
4. **▲ Button**: Navigate to newer history
5. **Clear Button**: Clear all history
6. **Search Box**: Filter history by file name or symbol name
7. Click history items to jump directly

---

## Configuration

### Main Settings

#### Display Settings
- `gtags-hopper.viewColumn`: Editor column to open files
  - Choose from `first`, `second`, `third`, `active`, `beside`
  - Default: `second`
- `gtags-hopper.usePreviewTab`: Open files in preview tab
  - Default: `false`

#### Search Behavior
- `gtags-hopper.multipleResultAction`: Action when multiple results found
  - `quickPick`: Show selection dialog
  - `firstMatch`: Jump to first result automatically
  - Default: `quickPick`

#### History Settings
- `gtags-hopper.maxHistory`: Maximum number of jump history entries
  - Default: `50`
- `gtags-hopper.centerCursorAfterJumpBack`: Center cursor when jumping back
  - Default: `false`
- `gtags-hopper.historyPanelTheme`: History panel theme
  - Choose from `modern-dark`, `modern-light`, `colorful-dark`, `colorful-light`
  - Default: `modern-dark`

#### Terminal Settings
- `gtags-hopper.updateTagsTerminalNew`: Create new terminal for Update Tags
- `gtags-hopper.listSymbolsInFileTerminalNew`: Create new terminal for List Symbols
- `gtags-hopper.searchByGrepTerminalNew`: Create new terminal for Search by Grep

#### Gtags Settings
- `gtags-hopper.gtagsCommand`: Path to gtags command (searches PATH if empty)
- `gtags-hopper.gtagsArgs`: Additional arguments for gtags execution
  - Example: `--gtagslabel=ctags --verbose`

#### Other Settings
- `gtags-hopper.showSearchTime`: Display search time
  - Default: `false`

---

## Troubleshooting

### Definition Not Found
1. Verify that `gtags` has been run in project root
2. Check if tag files (`GTAGS`, `GRTAGS`, `GPATH`) exist
3. Update tags using `Gtags Hopper: Update Tags` if needed

---

## License

This project is licensed under the MIT License. (See LICENSE file)
Free to use, modify, and redistribute.

---

## Author

uta

---

## Repository

https://github.com/uta1214/gtags-hopper

---

# 日本語版 (Japanese)

# Gtags Hopper

**Gtags Hopper** は、GNU GLOBAL (gtags) を使ってソースコードの定義・参照へ素早くジャンプできる VS Code 拡張機能です。  
右側のエディタカラムで開くので、コードの見比べがスムーズにできます。

---

## 主な機能

### コード検索・ジャンプ
- **定義ジャンプ** (`Jump to Definition`)
  - gtags による定義検索
  - 見つからない場合は、関数スコープ内 → ファイル全体の順でローカル検索にフォールバック
- **元の位置に戻る** (`Jump Back`)
- **参照ジャンプ** (`Jump to References`)
- **ファイル内シンボル一覧** (`List Symbols in File`)
- **Grep 検索** (`Search by Grep`)
- **タグ更新** (`Update Tags`)

### ジャンプ履歴パネル
- **視覚的な履歴管理**: サイドバーにジャンプ履歴を表示
- **履歴ナビゲーション**: ▲/▼ボタンで履歴を前後に移動
- **履歴検索**: ファイル名やシンボル名で履歴をフィルタリング
- **ワンクリックジャンプ**: 履歴項目をクリックして任意の位置に戻る
- **テーマカスタマイズ**: 4種類のテーマから選択可能
  - Modern Dark (VSCode スタイル)
  - Modern Light
  - Colorful Dark (グラデーションスタイル)
  - Colorful Light

---

## インストール方法

### Visual Studio Code Marketplace
https://github.com/uta1214/gtags-hopper

### 手動インストール
1. このリポジトリをクローンまたはダウンロード
2. `npm install` で依存関係をインストール
3. `npm run compile` でコンパイル
4. `vsce package` で `.vsix` ファイルを作成
5. VS Code で「拡張機能」→「…」→「VSIX からインストール」を選択

---

## 使い方

### 基本的な使い方
1. プロジェクトのルートで `gtags` を実行してタグを作成
2. キーバインドまたはコマンドパレットから機能を呼び出す

### キーバインド
既定のキーバインド:
| 機能 | キー |
|------|------|
| Jump to Definition | `Ctrl+Alt+]` |
| Jump Back          | `Ctrl+Alt+[` |
| Jump to References | `Ctrl+Alt+R` |
| List Symbols       | `Ctrl+Alt+S` |
| Update Tags        | `Ctrl+Alt+T` |
| Search by Grep     | `Ctrl+Alt+G` |

### 履歴パネルの使い方
1. サイドバーの Gtags Hopper アイコンをクリック
2. 「Jump History」パネルが表示されます
3. **▼ボタン**: 古い履歴へ移動
4. **▲ボタン**: 新しい履歴へ移動
5. **Clear ボタン**: 履歴をクリア
6. **検索ボックス**: ファイル名やシンボル名で履歴を絞り込み
7. 履歴項目をクリックして直接ジャンプ

---

## 設定

### 主な設定項目

#### 表示設定
- `gtags-hopper.viewColumn`: ファイルを開くエディタカラム
  - `first`, `second`, `third`, `active`, `beside` から選択
  - デフォルト: `second`
- `gtags-hopper.usePreviewTab`: プレビュータブで開くかどうか
  - デフォルト: `false`

#### 検索動作
- `gtags-hopper.multipleResultAction`: 複数結果がある場合の動作
  - `quickPick`: 選択ダイアログを表示
  - `firstMatch`: 最初の結果に自動ジャンプ
  - デフォルト: `quickPick`

#### 履歴設定
- `gtags-hopper.maxHistory`: ジャンプ履歴の最大保持数
  - デフォルト: `50`
- `gtags-hopper.centerCursorAfterJumpBack`: Jump Back 時にカーソルを中央に表示
  - デフォルト: `false`
- `gtags-hopper.historyPanelTheme`: 履歴パネルのテーマ
  - `modern-dark`, `modern-light`, `colorful-dark`, `colorful-light` から選択
  - デフォルト: `modern-dark`

#### ターミナル設定
- `gtags-hopper.updateTagsTerminalNew`: Update Tags 用の新規ターミナル作成
- `gtags-hopper.listSymbolsInFileTerminalNew`: List Symbols 用の新規ターミナル作成
- `gtags-hopper.searchByGrepTerminalNew`: Search by Grep 用の新規ターミナル作成

#### Gtags 設定
- `gtags-hopper.gtagsCommand`: gtags コマンドのパス（空の場合は PATH から検索）
- `gtags-hopper.gtagsArgs`: gtags 実行時の追加引数
  - 例: `--gtagslabel=ctags --verbose`

#### その他
- `gtags-hopper.showSearchTime`: 検索時間を表示
  - デフォルト: `false`

---

## トラブルシューティング

### 定義が見つからない
1. プロジェクトルートで `gtags` を実行してタグを生成しているか確認
2. タグファイル (`GTAGS`, `GRTAGS`, `GPATH`) が存在するか確認
3. 必要に応じて `Gtags Hopper: Update Tags` でタグを更新

---

## ライセンス

このプロジェクトのライセンスは MIT です。（LICENSE ファイル参照）
自由に利用・改変・再配布が可能です。

---

## 作者

uta

---

## リポジトリ

https://github.com/uta1214/gtags-hopper

---