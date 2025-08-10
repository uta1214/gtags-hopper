// src/extension.ts
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';  // Node.jsのPromise版fsモジュールを使う

/**
 * execの非同期ラッパー関数
 * コマンドを非同期実行し、結果をPromiseで返す
 */
function execGlobalAsync(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function activate(context: vscode.ExtensionContext) {
  // ジャンプ履歴を保持（戻る機能用）
  const jumpHistory: { uri: vscode.Uri; position: vscode.Position; viewColumn: vscode.ViewColumn | undefined }[] = [];

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

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // 現在の編集位置を履歴に保存（戻る用）
    jumpHistory.push({
      uri: document.uri,
      position,
      viewColumn: editor.viewColumn
    });

    let globalResult = '';
    try {
      // プログレス表示しつつglobalコマンドで定義を非同期検索
      const elapsedMs = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Searching for "${symbol}"...`,
        cancellable: false
      }, async () => {
        const startTime = Date.now();
        globalResult = await execGlobalAsync(`global -xa ${symbol}`, rootPath);
        const endTime = Date.now();
        return endTime - startTime;
      });

      // 結果の行を分割し、空行を除外
      const lines = globalResult.trim().split('\n').filter(l => l.trim() !== '');
      if (lines.length === 0) {
        vscode.window.showInformationMessage(`No definition found for: ${symbol}`);
        return;
      }

      // ファイル読み込みも非同期でまとめて実行し、候補アイテムを作成
      const itemsRaw = await Promise.all(lines.map(async (line) => {
        // globalの行形式を正規表現でパース
        const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\S+)/);
        if (!m) return null;
        const [, sym, lineNumStr, file] = m;
        const lineNum = parseInt(lineNumStr, 10) - 1;

        // 行番号だけの無効なファイル名は除外
        if (/^\d+$/.test(file)) return null;

        // ファイルの相対パスを計算
        const relPath = path.isAbsolute(file) ? path.relative(rootPath, file) : file;

        // 該当行テキストを非同期で取得（失敗時はメッセージ）
        let lineContent = '';
        try {
          const filePath = path.isAbsolute(file) ? file : path.join(rootPath, file);
          const fileContent = await fs.readFile(filePath, 'utf8');
          const fileLines = fileContent.split(/\r?\n/);
          lineContent = fileLines[lineNum]?.trim() ?? '';
        } catch {
          lineContent = '[Failed to read line]';
        }

        return {
          label: `${relPath}:${lineNum + 1}`,
          description: lineContent,
          file,
          line: lineNum
        };
      }));

      // null除去
      const filteredItems = itemsRaw.filter((v): v is NonNullable<typeof v> => v !== null);

      if (filteredItems.length === 1) {
        // 候補が1件なら直接ジャンプ
        await openFileAtPosition(filteredItems[0], rootPath);
      } else {
        // 複数候補なら選択肢＋「すべて開く」オプションを表示
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
          // ファイルごとに最小の行番号を探して順に開く
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

      vscode.window.showInformationMessage(`Search took ${elapsedMs} ms`);
    } catch (err) {
      vscode.window.showErrorMessage(`global error: ${(err as Error).message}`);
    }
  });

  /**
   * 指定ファイルの指定行にジャンプして開く
   * @param item {file, line}
   * @param rootPath workspaceルートパス
   */
  async function openFileAtPosition(item: { file: string; line: number }, rootPath: string) {
    const filePath = path.isAbsolute(item.file) ? item.file : path.join(rootPath, item.file);
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: false,
      preview: false
    });
    const pos = new vscode.Position(item.line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /**
   * ジャンプ履歴から前の位置に戻るコマンド
   */
  const jumpBack = vscode.commands.registerCommand('gtags-hopper.jumpBack', async () => {
    if (jumpHistory.length === 0) {
      vscode.window.showInformationMessage('No jump history available.');
      return;
    }

    const last = jumpHistory.pop()!;
    const doc = await vscode.workspace.openTextDocument(last.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: last.viewColumn ?? vscode.ViewColumn.One,
      preview: false
    });
    editor.selection = new vscode.Selection(last.position, last.position);
    // ジャンプ先を画面中央に表示したい場合は下記コメントを解除してください
    // editor.revealRange(new vscode.Range(last.position, last.position), vscode.TextEditorRevealType.InCenter);
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

    let globalResult = '';
    try {
      // execSyncから非同期execに置き換え済み
      globalResult = await execGlobalAsync(`global -rx ${symbol}`, rootPath);
    } catch (err) {
      vscode.window.showErrorMessage(`global error: ${(err as Error).message}`);
      return;
    }

    const lines = globalResult.trim().split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) {
      vscode.window.showInformationMessage(`No references found for: ${symbol}`);
      return;
    }

    // QuickPick用アイテム作成
    const items = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return null;

      // 行のファイル名以降のコード部分を取得
      const sym = parts[0];
      const lineNum = parts[1];
      const file = parts[2];
      const idx = line.indexOf(file) + file.length;
      const code = line.slice(idx).trim();

      return {
        label: `${file}:${lineNum} ${code}`,
        description: '',
        file,
        line: parseInt(lineNum, 10) - 1
      };
    }).filter((v): v is NonNullable<typeof v> => v !== null);

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
      // globalコマンドでファイルのタグ一覧を非同期取得
      const globalResult = await execGlobalAsync(`global -f ${filePath}`, rootPath);

      // 行ごとに分割・整形して表示用文字列作成
      const lines = globalResult
        .trim()
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 4) return null;
          const symbol = parts[0];
          const lineNum = parts[1];
          const file = parts[2];
          const idx = line.indexOf(file) + file.length;
          const code = line.slice(idx).trim();
          return `${file}:${lineNum} ${symbol} ${code}`;
        })
        .filter((v): v is string => v !== null)
        .join('\n');

      // ターミナルの既存インスタンスを取得 or 新規作成
      let terminal = vscode.window.terminals.find(t => t.name === 'Gtags Output');
      if (!terminal) {
        terminal = vscode.window.createTerminal({ name: 'Gtags Output', cwd: rootPath });
      }
      terminal.show(true);

      // 端末に出力（printfでヘッダー付き）
      terminal.sendText(`printf "%s\\n%s\\n" "--list symbol--" "${lines.replace(/"/g, '\\"')}"`);

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

    // 検索パターンを入力
    const pattern = await vscode.window.showInputBox({
      prompt: 'Please enter the regex pattern to search',
      placeHolder: 'e.g. ^foo.*bar$',
      ignoreFocusOut: true,
    });
    if (!pattern) {
      return; // Cancel or empty input
    }

    // ターミナル取得 or 作成
    let terminal = vscode.window.terminals.find(t => t.name === 'Gtags Grep Search');
    if (!terminal) {
      terminal = vscode.window.createTerminal({ name: 'Gtags Grep Search', cwd: rootPath });
    }
    terminal.show(true);

    // global grepコマンド実行（シンプルにシングルクォート囲み）
    terminal.sendText(`echo --search pattern: '${pattern}'`);
    terminal.sendText(`global -gx '${pattern}'`);
  });

  /**
   * gtagsデータベース更新コマンド
   * ターミナルで gtags を実行してタグを生成
   */
  const updateTags = vscode.commands.registerCommand('gtags-hopper.updateTags', () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    let terminal = vscode.window.terminals.find(t => t.name === 'Gtags Generate');
    if (!terminal) {
      terminal = vscode.window.createTerminal({ name: 'Gtags Generate', cwd: rootPath });
    }
    terminal.show(true);
    terminal.sendText('gtags');
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
