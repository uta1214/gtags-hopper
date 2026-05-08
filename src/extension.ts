// src/extension.ts
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import { HistoryPanelProvider, HistoryItem } from './historyPanel';
import { ResultsPanelProvider, ResultItem } from './resultsPanel';

// 正規表現のコンパイル最適化
const GLOBAL_OUTPUT_REGEX = /^(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/;

/**
 * 設定値キャッシュクラス
 * 同じ設定を何度も読み込むのを防ぐ
 */
class ConfigCache {
  private cache = new Map<string, any>();
  private readonly configSection = 'gtags-hopper';
  
  get<T>(key: string, defaultValue: T): T {
    const cacheKey = `${this.configSection}.${key}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    
    const value = vscode.workspace.getConfiguration(this.configSection).get<T>(key, defaultValue);
    this.cache.set(cacheKey, value);
    return value;
  }
  
  invalidate() {
    this.cache.clear();
  }
}

/**
 * エディタキャッシュクラス
 * 開いているエディタの高速検索用
 */
class EditorCache {
  private pathToEditor = new Map<string, vscode.TextEditor>();
  
  update() {
    this.pathToEditor.clear();
    vscode.window.visibleTextEditors.forEach(editor => {
      this.pathToEditor.set(editor.document.uri.fsPath, editor);
    });
  }
  
  findByPath(filePath: string): vscode.TextEditor | undefined {
    return this.pathToEditor.get(filePath);
  }
}

/**
 * 履歴管理クラス（GUI対応版）
 * push() は maxSize を超えると先頭（最古）を物理削除する
 */
class OptimizedHistory {
  private items: HistoryItem[] = [];
  private changeListeners: (() => void)[] = [];

  push(item: HistoryItem, maxSize: number) {
    if (this.items.length >= maxSize) {
      this.items.splice(0, 1); // 先頭（最古）を物理削除
    }
    this.items.push(item);
    this.notifyChange();
  }

  pop(): HistoryItem | undefined {
    if (this.items.length === 0) return undefined;
    const item = this.items.pop();
    this.notifyChange();
    return item;
  }

  get length(): number {
    return this.items.length;
  }

  clear() {
    this.items = [];
    this.notifyChange();
  }

  // GUI用: 有効な履歴アイテムを取得
  getItems(): HistoryItem[] {
    return this.items.slice();
  }

  // 変更通知リスナーを追加
  onChange(listener: () => void) {
    this.changeListeners.push(listener);
  }

  private notifyChange() {
    this.changeListeners.forEach(listener => listener());
  }
}

/**
 * 現在のカーソル位置を含む関数のスコープを特定する
 * 複数行の関数定義と制御構文の除外に対応
 * @param document テキストドキュメント
 * @param position カーソル位置
 * @returns 関数の開始行と終了行 {start, end} または null
 */
function getCurrentFunctionScope(
  document: vscode.TextDocument,
  position: vscode.Position
): { start: number; end: number } | null {
  const lines = document.getText().split('\n');
  const currentLine = position.line;

  let functionStart = -1;
  let functionEnd = -1;
  let braceLevel = 0;
  let inFunction = false;

  // 複数言語対応の関数定義パターン
  const functionStartPatterns = [
    /^\s*\w[\w\s\*]*\w+\s*\([^)]*\)\s*\{?\s*$/,  // C/C++ 関数
    /^\s*\w[\w\s\*]*\w+\s*\([^)]*\)\s*$/,        // 関数宣言（{は次行）
    /^\s*(public|private|protected|static)?\s*\w[\w\s\*]*\w+\s*\([^)]*\)\s*\{?\s*$/,  // C++/Java
    /^\s*function\s+\w+\s*\([^)]*\)\s*\{?\s*$/,   // JavaScript
    /^\s*def\s+\w+\s*\([^)]*\)\s*:\s*$/,          // Python
  ];

  // 1. 現在位置から上に向かって関数開始を探す
  for (let i = currentLine; i >= 0; i--) {
    const line = lines[i].trim();
    
    // 制御構文を除外
    if (/^(if|while|for|switch|else)\b/.test(line)) {
      continue;
    }

    // 関数定義パターンをチェック
    const isFunction = functionStartPatterns.some(pattern => pattern.test(line));
    
    if (isFunction) {
      functionStart = i;
      break;
    }
  }

  if (functionStart === -1) {
    return null;
  }

  // 2. 関数開始から下に向かって対応する閉じ括弧を探す
  braceLevel = 0;
  for (let i = functionStart; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === '{') {
        braceLevel++;
        inFunction = true;
      }
      if (char === '}') {
        braceLevel--;
      }
    }
    
    // 関数内で括弧が閉じられたら終了
    if (inFunction && braceLevel === 0) {
      functionEnd = i;
      break;
    }
  }

  if (functionEnd === -1) functionEnd = lines.length - 1;

  return { start: functionStart, end: functionEnd };
}

/**
 * Vim の `gd` スタイルのシンプルな定義検索
 * 最初に見つけた「定義らしきもの」を返す
 * @param symbol 検索対象シンボル
 * @param document ドキュメント
 * @param startLine 検索開始行（省略時は0）
 * @param endLine 検索終了行（省略時は最終行）
 * @returns 最初に見つけた定義候補または null
 */
function findFirstDefinition(
  symbol: string, 
  document: vscode.TextDocument, 
  startLine: number = 0, 
  endLine: number = document.lineCount - 1
): {line: number, description: string} | null {
  const lines = document.getText().split('\n');
  
  for (let i = startLine; i <= Math.min(endLine, lines.length - 1); i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    
    // コメント行や文字列リテラル内をスキップ
    if (trimmedLine.startsWith('//') || 
        trimmedLine.startsWith('/*') || 
        trimmedLine.includes(`"${symbol}"`) || 
        trimmedLine.includes(`'${symbol}'`)) {
      continue;
    }
    
    // シンボルが含まれているかチェック
    if (!new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(line)) continue;
    
    // Vim gd スタイル: 最初に見つけた定義らしいパターンを即座に返す
    
    // 1. 変数宣言 (最優先)
    if (new RegExp(`\\b(int|char|float|double|void|string|auto|const|let|var|bool|size_t|struct|class|enum)\\s+[^=]*\\b${escapeRegExp(symbol)}\\b`).test(line)) {
      return {line: i, description: line.trim()};
    }
    
    // 2. 関数パラメータ
    if (new RegExp(`\\b\\w+\\s+${escapeRegExp(symbol)}\\s*[,)]`).test(line)) {
      return {line: i, description: line.trim()};
    }
    
    // 3. ループ変数
    if (new RegExp(`for\\s*\\([^;]*\\b${escapeRegExp(symbol)}\\b`).test(line)) {
      return {line: i, description: line.trim()};
    }
    
    // 4. 関数定義
    if (new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`).test(line) && 
        !line.includes('printf') && !line.includes('scanf') && !line.includes('cout')) {
      return {line: i, description: line.trim()};
    }
    
    // 5. 代入（初回のみ）
    if (new RegExp(`\\b${escapeRegExp(symbol)}\\s*=`).test(line) && !line.includes('==')) {
      return {line: i, description: line.trim()};
    }
  }
  
  return null;
}

/**
 * globalコマンドをユーザーのログインシェル経由で実行する
 * execFileの直接実行ではVS Codeプロセスの環境変数しか引き継がれず、
 * ユーザーが .bashrc / .zshrc 等で設定した GTAGSROOT / GTAGSDBPATH が
 * 読み込まれないためパネルモードでのみコマンドが失敗する問題を修正。
 * ログインシェル(-l)経由で実行することで環境変数を正しく引き継ぐ。
 * 引数は escapeShellArg でエスケープしてインジェクションを防止。
 */
async function execGlobalAsync(args: string[], cwd: string, globalCmd: string = 'global'): Promise<string> {
  const userShell = process.env.SHELL || '/bin/bash';
  const escapedArgs = args.map(a => escapeShellArg(a)).join(' ');
  const cmd = `${escapeShellArg(globalCmd)} ${escapedArgs}`;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const child = cp.spawn(userShell, ['-l', '-c', cmd], { cwd });

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`command failed: ${cmd}\n${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error('GNU GLOBAL (gtags) is not installed or not in PATH'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * 【セキュリティ修正】シェル引数を安全にエスケープ
 */
function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * 正規表現のメタ文字をエスケープ
 * 動的に RegExp を生成する際に使用
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ジャンプ先の行を一瞬ハイライトする（beacon.nvim風）
 * DecorationTypeはextension全体で1つ使い回す
 */
const jumpHighlightDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  isWholeLine: true,
});

// 現在ハイライト中のエディタを追跡
let highlightedEditor: vscode.TextEditor | undefined;

/** プレビュー中に常時表示するハイライト（消えない） */
function showHighlight(editor: vscode.TextEditor, pos: vscode.Position) {
  highlightedEditor = editor;
  editor.setDecorations(jumpHighlightDecoration, [new vscode.Range(pos, pos)]);
}

/** ハイライトを即座に消す（確定・キャンセル時） */
function clearHighlight() {
  if (highlightedEditor) {
    highlightedEditor.setDecorations(jumpHighlightDecoration, []);
    highlightedEditor = undefined;
  }
}

/** 1件即ジャンプ専用: 500ms だけ光らせて消える */
function flashHighlight(editor: vscode.TextEditor, pos: vscode.Position) {
  editor.setDecorations(jumpHighlightDecoration, [new vscode.Range(pos, pos)]);
  setTimeout(() => {
    editor.setDecorations(jumpHighlightDecoration, []);
  }, 500);
}

/**
 * globalコマンドをストリーミング実行し、行が揃うたびにコールバックを呼ぶ
 * cancel()を呼ぶことでプロセスを中断できる
 */
function execGlobalStreaming(
  args: string[],
  cwd: string,
  globalCmd: string = 'global',
  onLines: (lines: string[]) => void
): { promise: Promise<void>; cancel: () => void } {
  const userShell = process.env.SHELL || '/bin/bash';
  const escapedArgs = args.map(a => escapeShellArg(a)).join(' ');
  const cmd = `${escapeShellArg(globalCmd)} ${escapedArgs}`;

  let cancelled = false;
  let childProcess: cp.ChildProcess | undefined;

  const cancel = () => {
    cancelled = true;
    childProcess?.kill();
  };

  const promise = new Promise<void>((resolve, reject) => {
    let buffer = '';

    const child = cp.spawn(userShell, ['-l', '-c', cmd], { cwd });
    childProcess = child;

    child.stdout.on('data', (data: Buffer) => {
      if (cancelled) { return; }
      buffer += data.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      const lines = parts.filter(l => l.trim() !== '');
      if (lines.length > 0) { onLines(lines); }
    });

    child.on('close', (code: number | null) => {
      if (cancelled) { resolve(); return; } // キャンセル時は正常終了扱い
      if (buffer.trim() !== '') { onLines([buffer.trim()]); }
      if (code !== 0 && code !== null) {
        reject(new Error(`command failed: ${cmd}`));
      } else {
        resolve();
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (cancelled) { resolve(); return; }
      reject(err.code === 'ENOENT'
        ? new Error('GNU GLOBAL (gtags) is not installed or not in PATH')
        : err);
    });
  });

  return { promise, cancel };
}

/**
 * コマンド用ターミナル取得関数
 * 設定に応じた新規作成/既存利用を決定
 * forceNew=trueの場合: 同名ターミナルがあれば再利用、なければ新規作成
 * forceNew=falseの場合: アクティブまたは既存のターミナルを利用
 */
function getTerminalForCommand(
  commandName: 'updateTags' | 'listSymbolsInFile' | 'searchByGrep', 
  rootPath: string,
  config: ConfigCache
): vscode.Terminal {
  // 各コマンド用の個別設定を取得
  let forceNew = false;
  switch (commandName) {
    case 'updateTags':
      forceNew = config.get<boolean>('updateTagsTerminalNew', false);
      break;
    case 'listSymbolsInFile':
      forceNew = config.get<boolean>('listSymbolsInFileTerminalNew', false);
      break;
    case 'searchByGrep':
      forceNew = config.get<boolean>('searchByGrepTerminalNew', false);
      break;
  }

  // forceNew=trueの場合は専用ターミナルを使用（同名があれば再利用）
  if (forceNew) {
    const existing = vscode.window.terminals.find(t => t.name === commandName);
    if (existing) return existing; // 再利用する
    return vscode.window.createTerminal({ name: commandName, cwd: rootPath });
  } else {
    // 既存ターミナルを使う、なければ作る
    let terminal = vscode.window.activeTerminal ?? vscode.window.terminals[0];
    if (!terminal) {
      terminal = vscode.window.createTerminal({ cwd: rootPath, shellPath: 'bash' });
    }
    terminal.show(true);
    return terminal;
  }
}

/**
 * マルチルートワークスペース対応: ファイルパスに対応するワークスペースURIを返す
 * 単一ワークスペースの場合は folders[0] を返す
 * 起動直後など workspaceFolders が未ロードの場合はアクティブエディタのURIから
 * スキーム・authorityを補完してWSL Remote環境でも正しく動作するようにする
 */
function getWorkspaceUriForPath(filePath: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    // workspaceFolders が未ロードの場合（起動直後のWSL Remote等）:
    // アクティブエディタのURIからスキームとauthorityを取得して補完する
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && activeUri.scheme !== 'file') {
      // vscode-remote://wsl+Ubuntu/... のスキーム・authorityを保持したベースURIを返す
      return activeUri.with({ path: '/' });
    }
    return vscode.Uri.file('/');
  }
  if (folders.length === 1) return folders[0].uri;
  const folder = folders.find(f =>
    filePath.startsWith(f.uri.fsPath + path.sep) || filePath === f.uri.fsPath
  );
  return folder?.uri ?? folders[0].uri;
}

/**
 * WSL/Remote環境でも正しく動作するファイルURIを生成する
 * global コマンドが返す Unix 絶対パスをワークスペースURIベースで解決する
 */
function resolveFileUri(filePath: string, rootPath: string, wsUri: vscode.Uri): vscode.Uri {
  // global コマンドは相対パスを返すことがあるので、まず絶対パスに解決する
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath);
  const rel = path.relative(rootPath, absPath);
  // ワークスペース内のファイルはワークスペースURIから構築
  // vscode.Uri.joinPath でベースURIのスキームを保持（WSL Remote対応）
  // vscode.Uri.file() を使うと file:// になり WSL Remote では開けない
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return wsUri.with({ path: wsUri.path.replace(/\/$/, '') + '/' + rel.split(path.sep).join('/') });
  }
  // ワークスペース外の場合は絶対パスでfile URIを生成
  return vscode.Uri.file(absPath);
}

/**
 * プレビューで開いたタブをURIで指定して閉じる
 */
async function closeTabByUri(uri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === uri.toString()) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}

// アクティブ関数の開始
export function activate(context: vscode.ExtensionContext) {
   
  // 最適化されたキャッシュ群を初期化
  const configCache = new ConfigCache();
  const editorCache = new EditorCache();
  const jumpHistory = new OptimizedHistory();

  // 自動タグ更新の二重起動防止フラグ
  let isAutoUpdating = false;

  // ステータスバーアイテム（後で参照するため先に宣言）
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(sync) Update Gtags';
  statusBarItem.tooltip = 'Update gtags database';
  statusBarItem.command = 'gtags-hopper.updateTags';
  statusBarItem.show();

  // ファイル保存時に自動でタグ更新（gutentags風）
  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!configCache.get<boolean>('autoUpdateTagsOnSave', true)) { return; }
    if (isAutoUpdating) { return; } // 二重起動防止

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) { return; }

    // ワークスペース外のファイルはスキップ
    if (!doc.uri.fsPath.startsWith(rootPath)) { return; }

    // GTAGS が存在しない場合はスキップ（初回は手動で作る想定）
    const gtagsExists = await fs.access(path.join(rootPath, 'GTAGS')).then(() => true).catch(() => false);
    if (!gtagsExists) { return; }

    isAutoUpdating = true;
    statusBarItem.text = '$(sync~spin) Updating tags...';

    try {
      await execGlobalAsync(['-u'], rootPath, 'global');
      statusBarItem.text = '$(check) Tags updated';
      setTimeout(() => {
        statusBarItem.text = '$(sync) Update Gtags';
      }, 2000);
    } catch {
      // 保存の邪魔をしないので失敗は無視
      statusBarItem.text = '$(sync) Update Gtags';
    } finally {
      isAutoUpdating = false;
    }
  });

  // エディタキャッシュを更新するイベントリスナー
  const updateEditorCache = () => editorCache.update();
  vscode.window.onDidChangeVisibleTextEditors(updateEditorCache);
  updateEditorCache(); // 初期化時にキャッシュ構築

  // 設定変更時にキャッシュをクリア
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('gtags-hopper')) {
      configCache.invalidate();
    }
  });

  // 履歴から指定インデックスにジャンプする関数
  async function jumpToHistoryIndex(index: number) {
    const items = jumpHistory.getItems();
    if (index < 0 || index >= items.length) {
      vscode.window.showErrorMessage('Invalid history index');
      return;
    }

    const item = items[index];
    if (!item) {
      vscode.window.showErrorMessage('Invalid history index');
      return;
    }

    // ジャンプ先に移動
    const doc = await vscode.workspace.openTextDocument(item.to.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: item.from.viewColumn ?? vscode.ViewColumn.One,
      preview: false,
      preserveFocus: false
    });

    editor.selection = new vscode.Selection(item.to.position, item.to.position);

    const centerBack = configCache.get<boolean>('centerCursorAfterJumpBack', false);
    editor.revealRange(
      new vscode.Range(item.to.position, item.to.position),
      centerBack ? vscode.TextEditorRevealType.InCenter : vscode.TextEditorRevealType.Default
    );
  }

  // 履歴パネルプロバイダーを登録
  const historyProvider = new HistoryPanelProvider(
    context.extensionUri,
    jumpHistory,
    jumpToHistoryIndex
  );
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      HistoryPanelProvider.viewType,
      historyProvider
    )
  );

  // 定義検索結果パネルプロバイダーを登録
  const resultsProvider = new ResultsPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ResultsPanelProvider.viewType,
      resultsProvider
    )
  );

  /**
   * QuickPick表示（showPreview=trueの場合はフォーカス移動でプレビュー表示）
   * キャンセル時はプレビューで開いたタブをURIで指定して閉じる
   */
  async function showQuickPickMaybePreview<T extends { file: string; line: number; label: string; description: string }>(
    items: T[],
    placeholder: string,
    rootPath: string,
    showPreview: boolean
  ): Promise<T | null> {
    if (!showPreview) {
      return await vscode.window.showQuickPick(items, { placeHolder: placeholder }) ?? null;
    }

    let previewUri: vscode.Uri | undefined;
    let previewWasAlreadyOpen = false;

    return new Promise<T | null>(resolve => {
      const qp = vscode.window.createQuickPick<T>();
      qp.items = items;
      qp.placeholder = placeholder;
      let resolved = false;

      const doResolve = (val: T | null) => {
        if (resolved) return;
        resolved = true;
        qp.dispose();
        resolve(val);
      };

      qp.onDidChangeActive(async activeItems => {
        const active = activeItems[0];
        if (!active) return;
        // wsUriはactive.fileから毎回計算する（panel側と同じ方式）
        const wsUri = getWorkspaceUriForPath(active.file);
        const uri = resolveFileUri(active.file, rootPath, wsUri);
        previewUri = uri;
        previewWasAlreadyOpen = vscode.window.tabGroups.all.some(g =>
          g.tabs.some(t => t.input instanceof vscode.TabInputText &&
            t.input.uri.toString() === uri.toString() && !t.isPreview)
        );
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(active.line, 0);
        const ed = await vscode.window.showTextDocument(doc, {
          viewColumn: resolveViewColumn(), preview: true, preserveFocus: true
        });
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        showHighlight(ed, pos);
      });

      qp.onDidAccept(() => {
        clearHighlight();
        doResolve(qp.activeItems[0] ?? null);
      });

      qp.onDidHide(async () => {
        clearHighlight();
        if (previewUri && !previewWasAlreadyOpen) { await closeTabByUri(previewUri); }
        doResolve(null);
      });

      qp.show();
    });
  }

  /**
   * 履歴に追加する共通ヘルパー
   */
  function addToHistory(
    fromUri: vscode.Uri,
    fromPos: vscode.Position,
    fromViewColumn: vscode.ViewColumn | undefined,
    toUri: vscode.Uri,
    toPos: vscode.Position,
    symbol: string,
    maxHistory: number
  ) {
    jumpHistory.push({
      from: { uri: fromUri, position: fromPos, viewColumn: fromViewColumn },
      to: { uri: toUri, position: toPos },
      timestamp: Date.now(),
      symbol
    }, maxHistory);
  }

  /**
   * 結果パネル表示の共通ヘルパー
   * onJump: ジャンプ確定時の処理（ファイルを開く部分のみ。パネルクリア・フォーカス復元は自動で行う）
   * restoreOnCancel: キャンセル時にカーソルを復元するエディタ情報（定義・参照ジャンプ用）
   */
  async function showResultsInPanel(params: {
    symbol: string;
    title: string;
    items: ResultItem[];
    rootPath: string;
    onJump: (item: ResultItem) => Promise<{ uri: vscode.Uri; pos: vscode.Position } | void>;
    restoreOnCancel?: { editor: vscode.TextEditor; position: vscode.Position };
    autoFocus?: boolean;
    cancelRef?: { fn?: () => void }; // ストリーミングキャンセル用
  }) {
    const { symbol, title, items, rootPath, onJump, restoreOnCancel, autoFocus = true, cancelRef } = params;
    let previewEditor: vscode.TextEditor | undefined;
    let previewWasAlreadyOpen = false;
    let previewToken = 0; // キャンセルトークン: jumpが来たらインクリメントして古いpreviewのshowHighlightを無効化
    const prevTerminal = vscode.window.activeTerminal;
    const showPreview = configCache.get<boolean>('showPreview', true);

    if (autoFocus) {
      await vscode.commands.executeCommand('gtagsHopperResults.focus');
    }

    resultsProvider.showResults(
      symbol,
      items,
      async (item: ResultItem) => {
        if (!showPreview) return;
        const myToken = ++previewToken; // このpreview操作のトークン
        const uri = resolveFileUri(item.file, rootPath, getWorkspaceUriForPath(item.file));
        const pos = new vscode.Position(item.line, 0);
        // プレビュー前にすでに開いているタブか確認
        previewWasAlreadyOpen = vscode.window.tabGroups.all.some(g =>
          g.tabs.some(t => t.input instanceof vscode.TabInputText &&
            t.input.uri.toString() === uri.toString() && !t.isPreview)
        );
        const doc = await vscode.workspace.openTextDocument(uri);
        // awaitの間にjump(clearHighlight)が来ていたらハイライトしない
        if (myToken !== previewToken) return;
        previewEditor = await vscode.window.showTextDocument(
          doc,
          { viewColumn: resolveViewColumn(), preview: true, preserveFocus: true }
        );
        if (myToken !== previewToken) return;
        previewEditor.selection = new vscode.Selection(pos, pos);
        previewEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        showHighlight(previewEditor, pos);
      },
      async (item: ResultItem) => {
        previewToken++; // jumpが確定したのでpending previewのshowHighlightを無効化
        clearHighlight();
        await onJump(item);
        resultsProvider.clearResults();
        if (prevTerminal) { prevTerminal.show(true); }
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      },
      async () => {
        cancelRef?.fn?.(); // ストリーミング中断
        previewToken++; // pending previewのshowHighlightを無効化
        clearHighlight();
        // 既存タブとして開かれていたファイルは閉じない
        if (previewEditor && !previewWasAlreadyOpen) {
          await closeTabByUri(previewEditor.document.uri);
        }
        if (restoreOnCancel) {
          await vscode.window.showTextDocument(restoreOnCancel.editor.document, {
            viewColumn: restoreOnCancel.editor.viewColumn, preview: false, preserveFocus: false
          }).then(r => {
            r.selection = new vscode.Selection(restoreOnCancel.position, restoreOnCancel.position);
            r.revealRange(new vscode.Range(restoreOnCancel.position, restoreOnCancel.position), vscode.TextEditorRevealType.InCenter);
          });
        }
        resultsProvider.clearResults();
        if (prevTerminal) { prevTerminal.show(true); }
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      },
      title,
      autoFocus
    );
  }

  /** 設定値から vscode.ViewColumn を解決する共通ヘルパー */
  function resolveViewColumn(): vscode.ViewColumn {
    const setting = configCache.get<string>('viewColumn', 'second');
    switch (setting) {
      case 'active': return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Two;
      case 'beside': return vscode.ViewColumn.Beside;
      case 'first':  return vscode.ViewColumn.One;
      case 'third':  return vscode.ViewColumn.Three;
      case 'second':
      default:       return vscode.ViewColumn.Two;
    }
  }

  /**
   * 指定ファイルの指定行にジャンプして開く
   * @param item {file, line}
   * @param rootPath workspaceルートパス
   * @param isLocalFile 同じファイル内かどうか（trueの場合は設定を無視してColumn.Twoに開く）
   */
  async function openFileAtPosition(
    item: { file: string; line: number }, 
    rootPath: string,
    isLocalFile: boolean = false
  ) {
    const filePath = path.isAbsolute(item.file) ? item.file : path.join(rootPath, item.file);
    
    // エディタキャッシュを使用して高速検索
    const existingEditor = editorCache.findByPath(filePath);

    // 同じファイル内の場合は設定を無視して右のエディターに開く
    const viewColumn = isLocalFile ? vscode.ViewColumn.Two : resolveViewColumn();

    const usePreviewTab = configCache.get<boolean>('usePreviewTab', false);

    const pos = new vscode.Position(item.line, 0);
    const wsUri = getWorkspaceUriForPath(filePath);
    const fileUri = resolveFileUri(filePath, rootPath, wsUri);
    if (existingEditor && !isLocalFile) {
      const editor = await vscode.window.showTextDocument(existingEditor.document, {
        viewColumn: viewColumn,
        preview: usePreviewTab
      });
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn,
      preserveFocus: false,
      preview: usePreviewTab
    });

    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /**
   * 統合された定義ジャンプコマンド
   * 1. gtags検索で複数の候補があればQuickPick表示
   * 2. 1件または設定でfirstMatchならそのままジャンプ
   * 3. gtagsで見つからなければgd風ローカル検索にフォールバック
   */
  const jumpToDefinition = vscode.commands.registerCommand('gtags-hopper.jumpToDefinition', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found');
      return;
    }

    const document = editor.document;
    const position = editor.selection.active;

    // カーソル下の単語（シンボル）を取得
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      vscode.window.showErrorMessage('No symbol selected');
      return;
    }
    const symbol = document.getText(wordRange);

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // キャッシュされた設定値を使用
    const maxHistory = configCache.get<number>('maxHistory', 50);

    let globalResult = '';
    let filteredItems: any[] = [];
    
    try {
      // エディタ上部の青い進捗バーを使用
      const elapsedMs = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Searching "${symbol}"`,
        cancellable: false
      }, async (progress) => {
        const startTime = Date.now();
        
        progress.report({ increment: 0, message: 'Executing global command...' });
        
        try {
          const globalCmd = configCache.get<string>('gtagsCommand', '') || 'global';
          globalResult = await execGlobalAsync(['-xa', symbol], rootPath, globalCmd);
          
          progress.report({ increment: 40, message: 'Parsing global results...' });
          
          // 結果の行を分割し、空行を除外
          const lines = globalResult.trim().split('\n').filter(l => l.trim() !== '');
          
          if (lines.length > 0) {
            // 最適化された正規表現処理
            const itemsRaw = lines.map(line => {
              const m = line.trim().match(GLOBAL_OUTPUT_REGEX);
              if (!m) return null;
              const [, , lineNumStr, file, code] = m;
              const lineNum = parseInt(lineNumStr, 10) - 1;

              if (/^\d+$/.test(file)) return null;

              // 表示用相対パス、内部処理用絶対パス
              const relativePath = path.relative(rootPath, file);

              return {
                label: `${relativePath}:${lineNum + 1}`, 
                description: code.trim(),
                file, // 絶対パスを保持
                line: lineNum
              };
            });

            // null除去
            filteredItems = itemsRaw.filter((v): v is NonNullable<typeof v> => v !== null);
          }
        } catch (globalError) {
          filteredItems = []; // グローバル検索失敗時は空配列
        }

        // gtagsで見つからない場合はローカル検索にフォールバック
        if (filteredItems.length === 0) {
          progress.report({ increment: 50, message: 'Global search failed, searching locally...' });
          
          // 現在の関数スコープを取得
          const functionScope = getCurrentFunctionScope(document, position);
          let localDefinition: { line: number; description: string } | null = null;
          
          if (functionScope) {
            // 関数スコープ内で検索
            localDefinition = findFirstDefinition(symbol, document, functionScope.start, functionScope.end);
          }
          
          // 関数スコープで見つからない場合は、ファイル全体で検索
          if (!localDefinition) {
            localDefinition = findFirstDefinition(symbol, document);
          }
          
          if (localDefinition) {
            // ローカル検索結果も設定に応じたエディタで開く
            progress.report({ increment: 100, message: 'Found local definition' });
            
            const localItem = {
              file: document.uri.fsPath,
              line: localDefinition.line
            };
            const currentFilePath = document.uri.fsPath;
            const isLocalFile = localItem.file === currentFilePath;
            
            // ジャンプ実行
            await openFileAtPosition(localItem, rootPath, isLocalFile);
            
            // ジャンプ後、履歴に追加
            const newEditor = vscode.window.activeTextEditor;
            if (newEditor) {
              addToHistory(document.uri, position, editor.viewColumn, newEditor.document.uri, newEditor.selection.active, symbol, maxHistory);
              flashHighlight(newEditor, newEditor.selection.active);
            }
            
            const searchType = functionScope ? 'Function scope' : 'File-wide';
            const showSearchTime = configCache.get<boolean>('showSearchTime', false);
            if (showSearchTime) {
              const elapsed = Date.now() - startTime;
              vscode.window.showInformationMessage(`${searchType} search found definition in ${elapsed} ms`);
            }
            return Date.now() - startTime;
          }
        }
        
        progress.report({ increment: 100, message: `Found ${filteredItems.length} results` });
        
        return Date.now() - startTime;
      });

      // グローバル検索とローカル検索の両方で見つからなかった場合
      if (filteredItems.length === 0) {
        vscode.window.showInformationMessage(`No definition found for: ${symbol}`);
        return;
      }

      // キャッシュされた設定値を使用
      const multipleAction = configCache.get<string>('multipleResultAction', 'show');

      if (filteredItems.length === 1 || multipleAction === 'firstMatch') {
        // 候補1件 または firstMatch指定なら最初にジャンプ
        const currentFilePath = document.uri.fsPath;
        const isLocalFile = filteredItems[0].file === currentFilePath;
        
        // ジャンプ実行
        await openFileAtPosition(filteredItems[0], rootPath, isLocalFile);
        const newEditor = vscode.window.activeTextEditor;
        if (newEditor) {
          addToHistory(document.uri, position, editor.viewColumn, newEditor.document.uri, newEditor.selection.active, symbol, maxHistory);
          flashHighlight(newEditor, newEditor.selection.active);
        }
      } else {
        const displayMode = configCache.get<string>('resultDisplayMode', 'panel');

        if (displayMode === 'quickPick') {
          const showPreview = configCache.get<boolean>('showPreview', true);
          let picked: typeof filteredItems[0] | null = null;
          picked = await showQuickPickMaybePreview(filteredItems, `Select definition of ${symbol}`, rootPath, showPreview);
          if (!picked) return;
          const isLocalFile = picked.file === document.uri.fsPath;
          await openFileAtPosition(picked, rootPath, isLocalFile);
          const newEditor = vscode.window.activeTextEditor;
          if (newEditor) {
            addToHistory(document.uri, position, editor.viewColumn, newEditor.document.uri, newEditor.selection.active, symbol, maxHistory);
          }
        } else {
          await showResultsInPanel({
            symbol, title: 'Definitions', items: filteredItems, rootPath,
            onJump: async (item) => {
              const isLocalFile = item.file === document.uri.fsPath;
              await openFileAtPosition(item, rootPath, isLocalFile);
              const newEditor = vscode.window.activeTextEditor;
              if (newEditor) {
                addToHistory(document.uri, position, editor.viewColumn, newEditor.document.uri, newEditor.selection.active, symbol, maxHistory);
              }
            },
            restoreOnCancel: { editor, position }
          });
        }
      }

      const showSearchTime = configCache.get<boolean>('showSearchTime', false);
      if (showSearchTime) {
        const searchType = globalResult.trim() ? 'Global' : 'Local';
        vscode.window.showInformationMessage(`${searchType} search took ${elapsedMs} ms`);
      }
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error searching for "${symbol}": ${(error as Error).message}`);
    }
  });

  /**
   * ジャンプ履歴から前の位置に戻るコマンド
   * 元のエディタ位置（保存されたviewColumn）に戻る
   */
  const jumpBack = vscode.commands.registerCommand('gtags-hopper.jumpBack', async () => {
    if (jumpHistory.length === 0) {
      vscode.window.showInformationMessage('No jump history available.');
      return;
    }

    const last = jumpHistory.pop()!;

    // ジャンプ元の位置（保存されたviewColumn）に戻る
    const doc = await vscode.workspace.openTextDocument(last.from.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: last.from.viewColumn ?? vscode.ViewColumn.One,
      preview: false,
      preserveFocus: false
    });

    // カーソル位置を復元
    editor.selection = new vscode.Selection(last.from.position, last.from.position);

    // キャッシュされた設定値を使用
    const centerBack = configCache.get<boolean>('centerCursorAfterJumpBack', false);
    editor.revealRange(
      new vscode.Range(last.from.position, last.from.position),
      centerBack ? vscode.TextEditorRevealType.InCenter : vscode.TextEditorRevealType.Default
    );
    flashHighlight(editor, last.from.position);
  });

  /**
   * 参照検索コマンド
   * カーソル下のシンボルの参照箇所をglobalで非同期検索し、
   * QuickPickで選択してジャンプ
   */
  const jumpToReferences = vscode.commands.registerCommand('gtags-hopper.jumpToReferences', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found');
      return;
    }

    const document = editor.document;
    const position = editor.selection.active;

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      vscode.window.showErrorMessage('No symbol selected');
      return;
    }
    const symbol = document.getText(wordRange);

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // キャッシュされた設定値を使用
    const maxHistory = configCache.get<number>('maxHistory', 50);

    let items: any[] = [];
    try {
      // エディタ上部の青い進捗バーを使用
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Searching references for "${symbol}"`,
        cancellable: false
      }, async (progress) => {
        progress.report({ increment: 0, message: 'Executing global command...' });
        const globalCmd = configCache.get<string>('gtagsCommand', '') || 'global';

        const { promise: refPromise } = execGlobalStreaming(['-rx', symbol], rootPath, globalCmd, (rawLines) => {
          const parsed = rawLines.map(line => {
            const m = line.trim().match(GLOBAL_OUTPUT_REGEX);
            if (!m) return null;
            const [, , lineNumStr, file, code] = m;
            const absFile = path.isAbsolute(file) ? file : path.join(rootPath, file);
            return {
              label: `${path.relative(rootPath, absFile)}:${lineNumStr}`,
              description: code.trim(),
              file: absFile,
              line: parseInt(lineNumStr, 10) - 1
            };
          }).filter((v): v is NonNullable<typeof v> => v !== null);
          items.push(...parsed);
        });
        await refPromise;

        progress.report({ increment: 100, message: `Found ${items.length} references` });
      });

      if (items.length === 0) {
        vscode.window.showInformationMessage(`No references found for: ${symbol}`);
        return;
      }

      // 結果が1件の場合はdisplayModeに関わらず即ジャンプ（jumpToDefinitionと同じ挙動）
      if (items.length === 1) {
        const item = items[0];
        await openFileAtPosition(item, rootPath, false);
        const newEditor = vscode.window.activeTextEditor;
        if (newEditor) {
          addToHistory(document.uri, position, editor.viewColumn, newEditor.document.uri, newEditor.selection.active, symbol, maxHistory);
          flashHighlight(newEditor, newEditor.selection.active);
        }
        return;
      }

      const displayMode = configCache.get<string>('resultDisplayMode', 'panel');

      if (displayMode === 'quickPick') {
        const showPreview = configCache.get<boolean>('showPreview', true);
        let picked: typeof items[0] | null = null;
        picked = await showQuickPickMaybePreview(items, `Select reference of ${symbol}`, rootPath, showPreview);
        if (!picked) return;
        await openFileAtPosition(picked, rootPath, false);
        const newEditor = vscode.window.activeTextEditor;
        if (newEditor) {
          addToHistory(document.uri, position, editor.viewColumn, newEditor.document.uri, newEditor.selection.active, symbol, maxHistory);
        }
      } else {
        await showResultsInPanel({
          symbol, title: 'References', items, rootPath,
          onJump: async (item) => {
            await openFileAtPosition(item, rootPath, false);
            const newEditor = vscode.window.activeTextEditor;
            if (newEditor) {
              addToHistory(document.uri, position, editor.viewColumn, newEditor.document.uri, newEditor.selection.active, symbol, maxHistory);
            }
          },
          restoreOnCancel: { editor, position }
        });
      }
    } catch (err) {
      vscode.window.showErrorMessage(`global error: ${(err as Error).message}`);
      return;
    }
  });

  /**
   * ファイル内シンボル一覧コマンド
   * 現在のファイルにあるシンボル一覧をgtagsで取得し、パネルに表示する（quickPickモード時はターミナルに出力）
   */
  const listSymbolsInFile = vscode.commands.registerCommand('gtags-hopper.listSymbolsInFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found');
      return;
    }

    const document = editor.document;
    const filePath = document.uri.fsPath;

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    try {
      const displayMode = configCache.get<string>('resultDisplayMode', 'panel');
      const globalCmd = configCache.get<string>('gtagsCommand', '') || 'global';
      const cancelRef: { fn?: () => void } = {};

      if (displayMode === 'quickPick') {
        // ターミナルに出力（従来動作）
        let terminal = getTerminalForCommand('listSymbolsInFile', rootPath, configCache);
        terminal.show(true);
        terminal.sendText(`${globalCmd} -fx ${escapeShellArg(filePath)}`);
      } else {
        // パネルモード: ストリーミング表示
        await showResultsInPanel({
          symbol: path.basename(filePath), title: 'Symbols', items: [], rootPath,
          autoFocus: configCache.get<boolean>('symbolsPanelAutoFocus', false),
          cancelRef: cancelRef,
          onJump: async (item) => {
            const fromUri = editor.document.uri;
            const fromPos = editor.selection.active;
            const fromCol = editor.viewColumn;
            await openFileAtPosition(item, rootPath, false);
            const newEditor = vscode.window.activeTextEditor;
            if (newEditor) {
              const maxHistory = configCache.get<number>('maxHistory', 50);
              addToHistory(fromUri, fromPos, fromCol, newEditor.document.uri, newEditor.selection.active, item.label, maxHistory);
            }
          }
        });

        let totalFound = 0;
        const { promise, cancel } = execGlobalStreaming(['-fx', filePath], rootPath, globalCmd, (rawLines) => {
          const items: ResultItem[] = rawLines.map(line => {
            const m = line.trim().match(GLOBAL_OUTPUT_REGEX);
            if (!m) return null;
            const [, sym, lineNumStr, file, code] = m;
            const absFile = path.isAbsolute(file) ? file : path.join(rootPath, file);
            return {
              label: `${sym}:${lineNumStr}`,
              description: code.trim(),
              file: absFile,
              line: parseInt(lineNumStr, 10) - 1
            };
          }).filter((v): v is ResultItem => v !== null);
          if (items.length > 0) {
            totalFound += items.length;
            resultsProvider.appendResults(items);
          }
        });
        cancelRef.fn = cancel;
        await promise;

        if (totalFound === 0) {
          resultsProvider.clearResults();
          vscode.window.showInformationMessage('No symbols found in this file.');
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`global error: ${(err as Error).message}`);
    }
  });

  /**
   * 正規表現検索コマンド
   * 入力ボックスで正規表現を受け取り global grep 検索を実行し、パネルに結果を表示する（quickPickモード時はターミナルに出力）
   */
  const searchByGrep = vscode.commands.registerCommand('gtags-hopper.searchByGrep', async () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // 選択テキスト → なければカーソル下の単語 → なければ空
    const editor = vscode.window.activeTextEditor;
    const selectedText = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : editor
        ? (() => { const r = editor.document.getWordRangeAtPosition(editor.selection.active); return r ? editor.document.getText(r) : undefined; })()
        : undefined;

    // 検索パターンを入力
    const pattern = await vscode.window.showInputBox({
      prompt: 'Please enter the regex pattern to search',
      placeHolder: 'e.g. ^foo.*bar',
      ignoreFocusOut: true,
      value: selectedText
    });
    if (!pattern) {
      return; // Cancel or empty input
    }

    const displayMode = configCache.get<string>('resultDisplayMode', 'panel');
    const globalCmd = configCache.get<string>('gtagsCommand', '') || 'global';

    if (displayMode === 'quickPick') {
      // ターミナルに出力（従来動作）
      let terminal = getTerminalForCommand('searchByGrep', rootPath, configCache);
      terminal.show(true);
      terminal.sendText(`${globalCmd} -gx ${escapeShellArg(pattern)}`);
    } else {
      // パネルにストリーミング表示
      try {
        const cancelRef: { fn?: () => void } = {};
        await showResultsInPanel({
          symbol: pattern, title: 'Grep', items: [], rootPath,
          autoFocus: configCache.get<boolean>('grepPanelAutoFocus', false),
          cancelRef,
          onJump: async (item) => {
            const fromUri = editor?.document.uri;
            const fromPos = editor?.selection.active;
            const fromCol = editor?.viewColumn;
            await openFileAtPosition(item, rootPath, false);
            const newEditor = vscode.window.activeTextEditor;
            if (newEditor && fromUri && fromPos) {
              const maxHistory = configCache.get<number>('maxHistory', 50);
              addToHistory(fromUri, fromPos, fromCol, newEditor.document.uri, newEditor.selection.active, item.label, maxHistory);
            }
          }
        });

        let totalFound = 0;
        const { promise, cancel } = execGlobalStreaming(['-gx', pattern], rootPath, globalCmd, (rawLines) => {
          const items: ResultItem[] = rawLines.map(line => {
            const m = line.trim().match(GLOBAL_OUTPUT_REGEX);
            if (!m) return null;
            const [, , lineNumStr, file, code] = m;
            const absFile = path.isAbsolute(file) ? file : path.join(rootPath, file);
            const relativePath = path.relative(rootPath, absFile);
            return {
              label: `${relativePath}:${lineNumStr}`,
              description: code.trim(),
              file: absFile,
              line: parseInt(lineNumStr, 10) - 1
            };
          }).filter((v): v is ResultItem => v !== null);
          if (items.length > 0) {
            totalFound += items.length;
            resultsProvider.appendResults(items);
          }
        });
        cancelRef.fn = cancel;
        await promise;

        if (totalFound === 0) {
          resultsProvider.clearResults();
          vscode.window.showInformationMessage(`No results found for: ${pattern}`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`global error: ${(err as Error).message}`);
      }
    }
  });

  /**
   * gtagsデータベース更新コマンド
   * ターミナルで gtags を実行してタグを生成
   */
  const updateTags = vscode.commands.registerCommand('gtags-hopper.updateTags', async () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // キャッシュされた設定値を使用
    const gtagsCmd = configCache.get<string>('gtagsCommand', '') || 'gtags';
    const gtagsArgs = configCache.get<string>('gtagsArgs', '');
    const incrementalUpdate = configCache.get<boolean>('incrementalUpdate', true);

    const terminal = getTerminalForCommand('updateTags', rootPath, configCache);
    terminal.show(true);

    // 差分更新が有効かつGTAGSが存在する場合は global -u で差分更新
    let cmd: string;
    if (incrementalUpdate) {
      const gtagsDbPath = path.join(rootPath, 'GTAGS');
      const gtagsExists = await fs.access(gtagsDbPath).then(() => true).catch(() => false);
      cmd = gtagsExists ? 'global -u' : (gtagsArgs ? `${gtagsCmd} ${gtagsArgs}` : gtagsCmd);
    } else {
      cmd = gtagsArgs ? `${gtagsCmd} ${gtagsArgs}` : gtagsCmd;
    }
    terminal.sendText(cmd);
  });

  /**
   * gtagsデータベースフル再生成コマンド
   * incrementalUpdate設定に関わらず常に gtags でフル再生成する
   */
  const rebuildTags = vscode.commands.registerCommand('gtags-hopper.rebuildTags', async () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const gtagsCmd = configCache.get<string>('gtagsCommand', '') || 'gtags';
    const gtagsArgs = configCache.get<string>('gtagsArgs', '');

    const terminal = getTerminalForCommand('updateTags', rootPath, configCache);
    terminal.show(true);

    const cmd = gtagsArgs ? `${gtagsCmd} ${gtagsArgs}` : gtagsCmd;
    terminal.sendText(cmd);
  });
  // コマンドやUIアイテムをcontextに登録
  context.subscriptions.push(
    jumpToDefinition,
    jumpBack,
    jumpToReferences,
    listSymbolsInFile,
    searchByGrep,
    updateTags,
    rebuildTags,
    statusBarItem
  );
}

export function deactivate() {}