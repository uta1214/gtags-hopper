"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// src/extension.ts
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
function activate(context) {
    // ジャンプ履歴を保持（戻る機能用）
    const jumpHistory = [];
    /**
     * 定義ジャンプコマンド
     * カーソル下のシンボルの定義位置をgtags(global)で検索し、
     * 候補が1件なら直接ジャンプ、複数なら選択させる
     */
    const jumpToDefinition = vscode.commands.registerCommand('gtags-hopper.jumpToDefinition', () => __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }
        const document = editor.document;
        const position = editor.selection.active;
        // 選択中の単語（シンボル）を取得
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            vscode.window.showErrorMessage('No symbol selected');
            return;
        }
        const symbol = document.getText(wordRange);
        const rootPath = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
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
            // プログレス表示しつつglobalコマンドで定義を検索
            const elapsedMs = yield vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: `Searching for "${symbol}"...`,
                cancellable: false
            }, () => {
                const startTime = Date.now();
                globalResult = cp.execSync(`global -xa ${symbol}`, { cwd: rootPath }).toString();
                const endTime = Date.now();
                return Promise.resolve(endTime - startTime);
            });
            // 結果の行を分割して空行を除外
            const lines = globalResult.trim().split('\n').filter(l => l.trim() !== '');
            if (lines.length === 0) {
                vscode.window.showInformationMessage(`No definition found for: ${symbol}`);
                return;
            }
            // 候補アイテムの作成
            const itemsRaw = lines.map(line => {
                var _a, _b;
                // globalの行形式を正規表現でパース
                const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\S+)/);
                if (!m)
                    return null;
                const [, sym, lineNumStr, file] = m;
                const lineNum = parseInt(lineNumStr, 10) - 1;
                // 行番号だけの無効なファイル名は除外
                if (/^\d+$/.test(file))
                    return null;
                // ファイルの相対パスを計算
                const relPath = path.isAbsolute(file)
                    ? path.relative(rootPath, file)
                    : file;
                // ファイルの該当行テキストを取得（読み込み失敗時はメッセージ）
                let lineContent = '';
                try {
                    const fileContent = fs.readFileSync(path.isAbsolute(file) ? file : path.join(rootPath, file), 'utf8');
                    const fileLines = fileContent.split(/\r?\n/);
                    lineContent = (_b = (_a = fileLines[lineNum]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : '';
                }
                catch (_c) {
                    lineContent = '[Failed to read line]';
                }
                return {
                    label: `${relPath}:${lineNum + 1}`,
                    description: lineContent,
                    file,
                    line: lineNum
                };
            }).filter((v) => v !== null);
            // 候補が1件なら直接ジャンプ
            if (itemsRaw.length === 1) {
                yield openFileAtPosition(itemsRaw[0], rootPath);
                // 複数件なら選択肢＋「すべて開く」オプションを表示
            }
            else {
                const allOpenOption = {
                    label: 'Open All Definitions',
                    description: '',
                    file: '__all__',
                    line: -1
                };
                const itemsWithAll = [...itemsRaw, allOpenOption];
                const picked = yield vscode.window.showQuickPick(itemsWithAll, {
                    placeHolder: `Select definition of ${symbol}`
                });
                if (!picked)
                    return;
                if (picked.file === '__all__') {
                    // ファイルごとに最小の行番号を探して順に開く
                    const fileMap = new Map();
                    for (const item of itemsRaw) {
                        const prevLine = fileMap.get(item.file);
                        if (prevLine === undefined || item.line < prevLine) {
                            fileMap.set(item.file, item.line);
                        }
                    }
                    for (const [file, line] of fileMap.entries()) {
                        yield openFileAtPosition({ file, line }, rootPath);
                    }
                }
                else {
                    yield openFileAtPosition(picked, rootPath);
                }
            }
            vscode.window.showInformationMessage(`Search took ${elapsedMs} ms`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`global error: ${err.message}`);
        }
    }));
    /**
     * 指定ファイルの指定行にジャンプして開く
     * @param item {file, line}
     * @param rootPath workspaceルートパス
     */
    function openFileAtPosition(item, rootPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const filePath = path.isAbsolute(item.file) ? item.file : path.join(rootPath, item.file);
            const doc = yield vscode.workspace.openTextDocument(filePath);
            yield vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.Two,
                preserveFocus: false,
                preview: false
            }).then(editor2 => {
                const pos = new vscode.Position(item.line, 0);
                editor2.selection = new vscode.Selection(pos, pos);
                editor2.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            });
        });
    }
    /**
     * ジャンプ履歴から前の位置に戻るコマンド
     */
    const jumpBack = vscode.commands.registerCommand('gtags-hopper.jumpBack', () => __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (jumpHistory.length === 0) {
            vscode.window.showInformationMessage('No jump history available.');
            return;
        }
        const last = jumpHistory.pop();
        const doc = yield vscode.workspace.openTextDocument(last.uri);
        const editor = yield vscode.window.showTextDocument(doc, {
            viewColumn: (_a = last.viewColumn) !== null && _a !== void 0 ? _a : vscode.ViewColumn.One,
            preview: false
        });
        editor.selection = new vscode.Selection(last.position, last.position);
        // editor.revealRange(new vscode.Range(last.position, last.position), vscode.TextEditorRevealType.InCenter);
    }));
    /**
     * 参照検索コマンド
     * カーソル下のシンボルの参照箇所をglobalで検索し、QuickPickで選択してジャンプ
     */
    const jumpToReferences = vscode.commands.registerCommand('gtags-hopper.jumpToReferences', () => __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
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
        const rootPath = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
        if (!rootPath) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }
        let globalResult = '';
        try {
            globalResult = cp.execSync(`global -rx ${symbol}`, { cwd: rootPath }).toString();
        }
        catch (err) {
            vscode.window.showErrorMessage(`global error: ${err.message}`);
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
            if (parts.length < 4)
                return null;
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
        }).filter((v) => v !== null);
        const picked = yield vscode.window.showQuickPick(items, {
            placeHolder: `Select reference of ${symbol}`
        });
        if (!picked)
            return;
        // 選択したファイル位置にジャンプ
        const filePath = path.isAbsolute(picked.file) ? picked.file : path.join(rootPath, picked.file);
        const doc = yield vscode.workspace.openTextDocument(filePath);
        const editor2 = yield vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Two,
            preserveFocus: false,
            preview: false
        });
        const pos = new vscode.Position(picked.line, 0);
        editor2.selection = new vscode.Selection(pos, pos);
        editor2.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }));
    /**
     * ファイル内タグ一覧コマンド
     * 現在のファイルにあるシンボル一覧をgtagsで取得し、ターミナルに出力
     */
    const listSymbolsInFile = vscode.commands.registerCommand('gtags-hopper.listSymbolsInFile', () => __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }
        const document = editor.document;
        const filePath = document.uri.fsPath;
        const rootPath = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
        if (!rootPath) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }
        try {
            // globalコマンドでファイルのタグ一覧を取得
            const globalResult = cp.execSync(`global -f ${filePath}`, { cwd: rootPath }).toString();
            // 行ごとに分割・整形して表示用文字列作成
            const header = '--list symbol--';
            const lines = globalResult
                .trim()
                .split('\n')
                .filter(l => l.trim() !== '')
                .map(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 4)
                    return null;
                const symbol = parts[0];
                const lineNum = parts[1];
                const file = parts[2];
                const idx = line.indexOf(file) + file.length;
                const code = line.slice(idx).trim();
                return `${file}:${lineNum} ${symbol} ${code}`;
            })
                .filter((v) => v !== null)
                .join('\n');
            // ターミナルの既存インスタンスを取得 or 新規作成
            let terminal = vscode.window.terminals.find(t => t.name === 'Gtags Output');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'Gtags Output', cwd: rootPath });
            }
            terminal.show(true);
            // 端末に出力（printfでヘッダー付き）
            terminal.sendText(`printf "%s\\n%s\\n" "--list symbol--" "${lines.replace(/"/g, '\\"')}"`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`global error: ${err.message}`);
        }
    }));
    /**
     * 正規表現検索コマンド
     * 入力ボックスで正規表現を受け取りglobal grep検索をターミナルで実行
     */
    const searchByGrep = vscode.commands.registerCommand('gtags-hopper.searchByGrep', () => __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const rootPath = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
        if (!rootPath) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }
        // 検索パターンを入力
        const pattern = yield vscode.window.showInputBox({
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
    }));
    /**
     * gtagsデータベース更新コマンド
     * ターミナルで gtags を実行してタグを生成
     */
    const updateTags = vscode.commands.registerCommand('gtags-hopper.updateTags', () => {
        var _a, _b;
        const rootPath = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
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
    context.subscriptions.push(jumpToDefinition, jumpBack, jumpToReferences, listSymbolsInFile, searchByGrep, updateTags, statusBarItem);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map