// src/extension.ts
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';  // Node.jsのPromise版fsモジュールを使う

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
 * 最適化された履歴管理クラス
 * shift()を使わずにindexベースで管理してO(1)操作を実現
 */
class OptimizedHistory<T> {
  private items: T[] = [];
  private startIndex = 0;

  push(item: T, maxSize: number) {
    // 最大サイズを超えた場合は開始インデックスを進める（古いアイテムを論理的に削除）
    if (this.items.length >= maxSize) {
      this.startIndex++;
    }
    this.items.push(item);
  }

  pop(): T | undefined {
    // 有効なアイテムがない場合
    if (this.items.length <= this.startIndex) {
      return undefined;
    }
    return this.items.pop();
  }

  get length(): number {
    return Math.max(0, this.items.length - this.startIndex);
  }

  clear() {
    this.items = [];
    this.startIndex = 0;
  }
}

/**
 * 現在のカーソル位置を含む関数のスコープを特定する
 * @param document テキストドキュメント
 * @param position カーソル位置
 * @returns 関数の開始行と終了行 {start, end} または null
 */
function getCurrentFunctionScope(document: vscode.TextDocument, position: vscode.Position): {start: number, end: number} | null {
  const lines = document.getText().split('\n');
  const currentLine = position.line;
  
  let functionStart = -1;
  let functionEnd = -1;
  let braceLevel = 0;
  let inFunction = false;
  
  // 現在行より上を検索して関数開始を見つける
  for (let i = currentLine; i >= 0; i--) {
    const line = lines[i].trim();
    
    // 関数定義っぽい行をチェック（簡易的なパターン）
    const functionPattern = /^[^\/\*]*\b\w+\s*\([^)]*\)\s*\{?/;
    const isFunction = functionPattern.test(line) && 
                      !line.includes('if') && !line.includes('while') && 
                      !line.includes('for') && !line.includes('switch');
    
    if (isFunction) {
      functionStart = i;
      break;
    }
  }
  
  if (functionStart === -1) return null;
  
  // 関数の終了を見つける（ブレース matching）
  braceLevel = 0;
  for (let i = functionStart; i < lines.length; i++) {
    const line = lines[i];
    
    for (const char of line) {
      if (char === '{') braceLevel++;
      if (char === '}') {
        braceLevel--;
        if (braceLevel === 0 && i > functionStart) {
          functionEnd = i;
          break;
        }
      }
    }
    
    if (functionEnd !== -1) break;
  }
  
  if (functionEnd === -1) functionEnd = lines.length - 1;
  
  return { start: functionStart, end: functionEnd };
}

/**
 * 指定範囲内でシンボルを検索し、定義らしい候補をフィルタリングして返す
 * @param symbol 検索対象シンボル
 * @param document ドキュメント
 * @param startLine 検索開始行（省略時は0）
 * @param endLine 検索終了行（省略時は最終行）
 * @returns 候補の配列
 */
function searchSymbolInRange(
  symbol: string, 
  document: vscode.TextDocument, 
  startLine: number = 0, 
  endLine: number = document.lineCount - 1
): Array<{label: string, description: string, line: number, priority: number}> {
  const lines = document.getText().split('\n');
  const results: Array<{label: string, description: string, line: number, priority: number}> = [];
  
  console.log(`[DEBUG] searchSymbolInRange: symbol="${symbol}", lines ${startLine}-${endLine}`);
  
  for (let i = startLine; i <= Math.min(endLine, lines.length - 1); i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    
    // コメント行をスキップ
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*')) continue;
    
    // シンボルが含まれているかチェック
    if (!new RegExp(`\\b${symbol}\\b`).test(line)) continue;
    
    console.log(`[DEBUG] Found symbol on line ${i + 1}: "${line.trim()}"`);
    
    let priority = 100; // デフォルト優先度（非常に低い）
    
    // 関数パラメータ定義パターン（最優先）
    if (new RegExp(`\\b\\w+\\s+${symbol}\\s*[,)]`).test(line)) {
      priority = 1;
      console.log(`[DEBUG] Line ${i + 1}: Parameter definition (priority 1)`);
    }
    // 変数宣言
    else if (new RegExp(`\\b(int|char|float|double|void|string|auto|const|let|var|bool|size_t)\\s+[^=]*\\b${symbol}\\b`).test(line)) {
      priority = 2;
      console.log(`[DEBUG] Line ${i + 1}: Variable declaration (priority 2)`);
    }
    // for文のループ変数
    else if (new RegExp(`for\\s*\\([^;]*\\b${symbol}\\b`).test(line)) {
      priority = 2;
      console.log(`[DEBUG] Line ${i + 1}: Loop variable (priority 2)`);
    }
    // 代入
    else if (new RegExp(`\\b${symbol}\\s*=`).test(line)) {
      priority = 5;
      console.log(`[DEBUG] Line ${i + 1}: Assignment (priority 5)`);
    }
    // 関数定義
    else if (new RegExp(`\\b${symbol}\\s*\\(`).test(line)) {
      priority = 3;
      console.log(`[DEBUG] Line ${i + 1}: Function definition (priority 3)`);
    }
    // 使用箇所（printf, return など）
    else if (line.includes('printf') || line.includes('scanf') || line.includes('return') || line.includes('cout')) {
      priority = 50;
      console.log(`[DEBUG] Line ${i + 1}: Usage in function call (priority 50)`);
    }
    else {
      console.log(`[DEBUG] Line ${i + 1}: Other usage (priority 100)`);
    }
    
    results.push({
      label: `Line ${i + 1}`,
      description: line.trim(),
      line: i,
      priority: priority
    });
  }
  
  // 優先度順にソート（数値が小さいほど高優先度）
  const sorted = results.sort((a, b) => a.priority - b.priority);
  console.log(`[DEBUG] Sorted results:`, sorted);
  
  // 最高優先度のもののみを返す（同じ優先度が複数ある場合は全て返す）
  if (sorted.length === 0) return sorted;
  
  const bestPriority = sorted[0].priority;
  const bestResults = sorted.filter(r => r.priority === bestPriority);
  
  console.log(`[DEBUG] Best priority: ${bestPriority}, returning ${bestResults.length} results`);
  return bestResults;
}

function execGlobalAsync(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[DEBUG] Executing command: "${command}" in directory: "${cwd}"`);
    
    // まずgtagsファイルの存在確認
    const fs = require('fs');
    const path = require('path');
    const gtagsFiles = ['GTAGS', 'GRTAGS', 'GPATH'];
    
    gtagsFiles.forEach(file => {
      const filePath = path.join(cwd, file);
      const exists = fs.existsSync(filePath);
      console.log(`[DEBUG] ${file} exists: ${exists}`);
      if (exists) {
        const stats = fs.statSync(filePath);
        console.log(`[DEBUG] ${file} size: ${stats.size} bytes, modified: ${stats.mtime}`);
      }
    });

    cp.exec(command, { cwd }, (error, stdout, stderr) => {
      console.log(`[DEBUG] Command stderr: "${stderr}"`);
      console.log(`[DEBUG] Command stdout length: ${stdout.length}`);
      console.log(`[DEBUG] Command stdout: "${stdout}"`);
      
      if (error) {
        console.log(`[DEBUG] Command error: ${error.message}`);
        console.log(`[DEBUG] Error code: ${error.code}`);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * コマンド用ターミナル取得関数
 * 設定に応じて新規作成 or 既存ターミナル利用
 */
function getTerminalForCommand(
  commandName: 'updateTags' | 'listSymbolsInFile' | 'searchByGrep', 
  rootPath: string,
  config: ConfigCache
): vscode.Terminal {
    // 新コード（個別 boolean）
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

  // タグ名と同名のターミナルがある場合には、新規作成せず再利用する
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

// アクティブ関数の開始
export function activate(context: vscode.ExtensionContext) {
   
  // 最適化されたキャッシュ群を初期化
  const configCache = new ConfigCache();
  const editorCache = new EditorCache();
  const jumpHistory = new OptimizedHistory<{ uri: vscode.Uri; position: vscode.Position; viewColumn: vscode.ViewColumn | undefined }>();

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

  /**
   * 指定ファイルの指定行にジャンプして開く
   * @param item {file, line}
   * @param rootPath workspaceルートパス
   */
  async function openFileAtPosition(item: { file: string; line: number }, rootPath: string) {
    const filePath = path.isAbsolute(item.file) ? item.file : path.join(rootPath, item.file);
    
    // エディタキャッシュを使用して高速検索
    const existingEditor = editorCache.findByPath(filePath);

    // キャッシュされた設定値を使用
    const viewColumnSetting = configCache.get<string>('viewColumn', 'second');

    let viewColumn: vscode.ViewColumn | undefined;
    switch (viewColumnSetting) {
      case 'active':
        viewColumn = vscode.window.activeTextEditor?.viewColumn;
        break;
      case 'beside':
        viewColumn = vscode.ViewColumn.Beside;
        break;
      case 'first':
        viewColumn = vscode.ViewColumn.One;
        break;
      case 'second':
        viewColumn = vscode.ViewColumn.Two;
        break;
      case 'third':
        viewColumn = vscode.ViewColumn.Three;
        break;
      default:
        viewColumn = vscode.window.activeTextEditor?.viewColumn;
        break;
    }

    const usePreviewTab = configCache.get<boolean>('usePreviewTab', false);

    const pos = new vscode.Position(item.line, 0);
    if (existingEditor) {
      const editor = await vscode.window.showTextDocument(existingEditor.document, {
        viewColumn: existingEditor.viewColumn ?? viewColumn,
        preview: usePreviewTab
      });
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn,
      preserveFocus: false,
      preview: usePreviewTab
    });

    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /**
   * 定義ジャンプコマンド
   * カーソル下のシンボルの定義位置をgtags(global)で検索し、
   * 候補が1件なら直接ジャンプ、複数なら選択させる
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
    console.log(`[DEBUG] Symbol to search: "${symbol}"`);

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // キャッシュされた設定値を使用
    const maxHistory = configCache.get<number>('maxHistory', 50);

    jumpHistory.push({
      uri: document.uri,
      position,
      viewColumn: editor.viewColumn
    }, maxHistory);

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
        globalResult = await execGlobalAsync(`global -xa ${symbol}`, rootPath);
        console.log(`[DEBUG] Raw global result: "${globalResult}"`);
        
        progress.report({ increment: 40, message: 'Parsing global results...' });
        
        // 結果の行を分割し、空行を除外
        const lines = globalResult.trim().split('\n').filter(l => l.trim() !== '');
        
        if (lines.length > 0) {
          // 最適化された正規表現処理
          const itemsRaw = lines.map(line => {
            const m = line.trim().match(GLOBAL_OUTPUT_REGEX);
            if (!m) return null;
            const [, sym, lineNumStr, file, code] = m;
            const lineNum = parseInt(lineNumStr, 10) - 1;

            if (/^\d+$/.test(file)) return null;

            // 相対パスに変更
            const relativePath = path.relative(rootPath, file);

            return {
              label: `${relativePath}:${lineNum + 1}`, 
              description: code.trim(),
              file,
              line: lineNum
            };
          });

          // null除去
          filteredItems = itemsRaw.filter((v): v is NonNullable<typeof v> => v !== null);
          
          console.log(`[DEBUG] Global search results: ${filteredItems.length} items found`);
          console.log(`[DEBUG] Global results:`, filteredItems);
        }

        // gtagsで見つからない場合はローカル検索にフォールバック
        if (filteredItems.length === 0) {
          progress.report({ increment: 50, message: 'Global search failed, searching locally...' });
          console.log(`[DEBUG] No global results found, falling back to local search`);
          
          // 現在の関数スコープを取得
          const functionScope = getCurrentFunctionScope(document, position);
          let localResults: any[] = [];
          
          if (functionScope) {
            // 関数スコープ内で検索
            console.log(`[DEBUG] Searching in function scope: lines ${functionScope.start}-${functionScope.end}`);
            localResults = searchSymbolInRange(symbol, document, functionScope.start, functionScope.end);
            console.log(`[DEBUG] Function scope results:`, localResults);
          }
          
          // 関数スコープで見つからない場合は、ファイル全体で検索
          if (localResults.length === 0) {
            console.log(`[DEBUG] No results in function scope, searching entire file`);
            localResults = searchSymbolInRange(symbol, document);
            console.log(`[DEBUG] File-wide results:`, localResults);
          }
          
          // ローカル検索結果をfilteredItemsの形式に変換
          filteredItems = localResults.map(result => ({
            label: `${document.fileName}:${result.line + 1} (Local)`,
            description: result.description,
            file: document.uri.fsPath,
            line: result.line
          }));
          
          console.log(`[DEBUG] Local search results: ${filteredItems.length} items found`);
          console.log(`[DEBUG] Local results:`, filteredItems);
        }
        
        progress.report({ increment: 100, message: `Found ${filteredItems.length} results` });
        const endTime = Date.now();
        return endTime - startTime;
      });

      console.log(`[DEBUG] After search - filteredItems.length: ${filteredItems.length}`);

      if (filteredItems.length === 0) {
        vscode.window.showInformationMessage(`No definition found for: ${symbol}`);
        return;
      }

      // キャッシュされた設定値を使用
      const multipleAction = configCache.get<string>('multipleResultAction', 'quickPick');

      if (filteredItems.length === 1 || multipleAction === 'firstMatch') {
        // 候補1件 または firstMatch指定なら最初にジャンプ
        await openFileAtPosition(filteredItems[0], rootPath);
      } else {
        // QuickPickを表示
        const allOpenOption = {
          label: 'Open All Definitions',
          description: '',
          file: '__all__',
          line: -1
        };
        const itemsWithAll = [...filteredItems, allOpenOption];

        const picked = await vscode.window.showQuickPick(itemsWithAll, {
          placeHolder: `Select definition of ${symbol}`
        });
        if (!picked) return;

        if (picked.file === '__all__') {
          // 複数ファイルを順に開く
          const fileMap = new Map<string, number>();
          for (const item of filteredItems) {
            const prevLine = fileMap.get(item.file);
            if (prevLine === undefined || item.line < prevLine) {
              fileMap.set(item.file, item.line);
            }
          }
          for (const [file, line] of fileMap.entries()) {
            await openFileAtPosition({ file, line }, rootPath);
          }
        } else {
          await openFileAtPosition(picked, rootPath);
        }
      }

      const showSearchTime = configCache.get<boolean>('showSearchTime', false);
      if (showSearchTime) {
        const searchType = globalResult.trim() ? 'Global' : 'Local';
        vscode.window.showInformationMessage(`${searchType} search took ${elapsedMs} ms`);
      }
    } catch (err) {
      console.log(`[DEBUG] Global search error: ${(err as Error).message}`);
      
      // gtagsコマンドでエラーが発生した場合もローカル検索にフォールバック
      console.log(`[DEBUG] Global command failed, falling back to local search`);
      
      const functionScope = getCurrentFunctionScope(document, position);
      let localResults: any[] = [];
      
      if (functionScope) {
        localResults = searchSymbolInRange(symbol, document, functionScope.start, functionScope.end);
      }
      
      if (localResults.length === 0) {
        localResults = searchSymbolInRange(symbol, document);
      }
      
      if (localResults.length === 0) {
        vscode.window.showErrorMessage(`No definition found for "${symbol}" (global command failed: ${(err as Error).message})`);
        return;
      }
      
      // ローカル検索結果から直接ジャンプ
      const pos = new vscode.Position(localResults[0].line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      
      vscode.window.showInformationMessage(`Found local definition for "${symbol}" (global search failed)`);
    }
  });

  /**
   * ジャンプ履歴から前の位置に戻るコマンド
   */
  const jumpBack = vscode.commands.registerCommand('gtags-hopper.jumpBack', async () => {
    if (jumpHistory.length === 0) {
      vscode.window.showInformationMessage('No jump history available.');
      return;
    }

    const last = jumpHistory.pop()!;

    // エディタキャッシュを使用して高速検索
    let editor = editorCache.findByPath(last.uri.fsPath);

    if (!editor) {
      // 開かれていなければ新規に開く
      const doc = await vscode.workspace.openTextDocument(last.uri);
      editor = await vscode.window.showTextDocument(doc, {
        viewColumn: last.viewColumn ?? vscode.ViewColumn.One,
        preview: false
      });
    } else {
      // 既存エディタを再利用
      editor = await vscode.window.showTextDocument(editor.document, {
        viewColumn: editor.viewColumn ?? last.viewColumn ?? vscode.ViewColumn.One,
        preview: false
      });
    }

    // カーソル位置を復元
    editor.selection = new vscode.Selection(last.position, last.position);

    // キャッシュされた設定値を使用
    const centerBack = configCache.get<boolean>('centerCursorAfterJumpBack', false);
    editor.revealRange(
      new vscode.Range(last.position, last.position),
      centerBack ? vscode.TextEditorRevealType.InCenter : vscode.TextEditorRevealType.Default
    );
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

    // 参照検索でも履歴に追加（定義ジャンプと共通化）
    jumpHistory.push({
      uri: document.uri,
      position,
      viewColumn: editor.viewColumn
    }, maxHistory);

    let globalResult = '';
    let items: any[] = [];
    try {
      // エディタ上部の青い進捗バーを使用
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Searching references for "${symbol}"`,
        cancellable: false
      }, async (progress) => {
        progress.report({ increment: 0, message: 'Executing global command...' });
        globalResult = await execGlobalAsync(`global -rx ${symbol}`, rootPath);
        
        progress.report({ increment: 70, message: 'Processing results...' });
        
        const lines = globalResult.trim().split('\n').filter(l => l.trim() !== '');
        if (lines.length === 0) {
          progress.report({ increment: 100, message: 'No references found' });
          return;
        }

        // QuickPick用アイテム作成（最適化された正規表現使用）
        items = lines.map(line => {
          const m = line.trim().match(GLOBAL_OUTPUT_REGEX);
          if (!m) return null;
          const [, sym, lineNumStr, file, code] = m;

          return {
            label: `${file}:${lineNumStr}`,
            description: code.trim(),
            file,
            line: parseInt(lineNumStr, 10) - 1
          };
        }).filter((v): v is NonNullable<typeof v> => v !== null);
        
        progress.report({ increment: 100, message: `Found ${items.length} references` });
      });

      if (items.length === 0) {
        vscode.window.showInformationMessage(`No references found for: ${symbol}`);
        return;
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Select reference of ${symbol}`
      });

      if (!picked) return;

      // 選択したファイル位置にジャンプ
      const filePath = path.isAbsolute(picked.file) ? picked.file : path.join(rootPath, picked.file);
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor2 = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: false,
        preview: false
      });
      const pos = new vscode.Position(picked.line, 0);
      editor2.selection = new vscode.Selection(pos, pos);
      editor2.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      vscode.window.showErrorMessage(`global error: ${(err as Error).message}`);
      return;
    }
  });

  /**
   * ファイル内タグ一覧コマンド
   * 現在のファイルにあるシンボル一覧をgtagsで取得し、ターミナルに出力
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
      let terminal = getTerminalForCommand('listSymbolsInFile', rootPath, configCache);

      terminal.show(true);
      terminal.sendText(`global -fx "${filePath}"`);

    } catch (err) {
      vscode.window.showErrorMessage(`global error: ${(err as Error).message}`);
    }
  });

  /**
   * 正規表現検索コマンド
   * 入力ボックスで正規表現を受け取りglobal grep検索をターミナルで実行
   */
  const searchByGrep = vscode.commands.registerCommand('gtags-hopper.searchByGrep', async () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // 現在の選択テキストを取得（空なら undefined）
    const editor = vscode.window.activeTextEditor;
    const selectedText = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
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

    let terminal = getTerminalForCommand('searchByGrep', rootPath, configCache);

    terminal.show(true);

    // global grepコマンド実行（シンプルにシングルクォート囲み）
    terminal.sendText(`global -gx '${pattern}'`);
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

    const terminal = getTerminalForCommand('updateTags', rootPath, configCache);
    terminal.show(true);

    // 設定に応じたコマンドを作成
    const cmd = gtagsArgs ? `${gtagsCmd} ${gtagsArgs}` : gtagsCmd;
    terminal.sendText(cmd);
  });

  // ステータスバーアイテムを作成（gtags更新コマンドを実行できるボタン）
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(sync) Update Gtags';
  statusBarItem.tooltip = 'Update gtags database';
  statusBarItem.command = 'gtags-hopper.updateTags';
  statusBarItem.show();

  // コマンドやUIアイテムをcontextに登録
  context.subscriptions.push(
    jumpToDefinition,
    jumpBack,
    jumpToReferences,
    listSymbolsInFile,
    searchByGrep,
    updateTags,
    statusBarItem
  );
}

export function deactivate() {}