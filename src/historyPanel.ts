// src/historyPanel.ts
import * as vscode from 'vscode';
import * as path from 'path';

/**
 * 履歴項目の型定義
 */
export interface HistoryItem {
  from: {
    uri: vscode.Uri;
    position: vscode.Position;
    viewColumn: vscode.ViewColumn | undefined;
  };
  to: {
    uri: vscode.Uri;
    position: vscode.Position;
  };
  timestamp: number;
  symbol?: string;
}

/**
 * 履歴パネル用のインターフェース
 */
export interface HistoryManager {
  getItems(): HistoryItem[];
  onChange(listener: () => void): void;
  clear(): void;
}

/**
 * 履歴パネルプロバイダー
 */
export class HistoryPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gtagsHopperHistory';
  private view?: vscode.WebviewView;
  private currentIndex: number = -1; // 現在の履歴位置

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly historyManager: HistoryManager,
    private readonly onJumpToHistory: (index: number) => Promise<void>
  ) {
    // 履歴変更時にビューを更新
    this.historyManager.onChange(() => {
      this.updateView();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // メッセージハンドラー
    webviewView.webview.onDidReceiveMessage(async data => {
      switch (data.type) {
        case 'jumpToHistory':
          this.currentIndex = data.index;
          await this.onJumpToHistory(data.index);
          this.updateView();
          break;
        case 'navigateHistory':
          const items = this.historyManager.getItems();
          
          // 初回ボタン押下時（currentIndex === -1）は最新履歴から開始
          if (this.currentIndex === -1 && items.length > 0) {
            this.currentIndex = items.length - 1;
            await this.onJumpToHistory(this.currentIndex);
            this.updateView();
            return;
          }
          
          // ▼ボタン: 'down'方向 → 古い履歴へ（indexを減らす）
          // ▲ボタン: 'up'方向 → 新しい履歴へ（indexを増やす）
          if (data.direction === 'down' && this.currentIndex > 0) {
            this.currentIndex--;
          } else if (data.direction === 'up' && this.currentIndex < items.length - 1) {
            this.currentIndex++;
          } else {
            return; // 移動できない
          }
          await this.onJumpToHistory(this.currentIndex);
          this.updateView();
          break;
        case 'clearHistory':
          this.historyManager.clear();
          this.currentIndex = -1;
          break;
      }
    });

    // 設定変更を監視してHTMLを再生成
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gtags-hopper.historyPanelTheme')) {
        if (this.view) {
          this.view.webview.html = this.getHtmlForWebview(this.view.webview);
          this.updateView();
        }
      }
    });

    this.updateView();
  }

  private updateView() {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'updateHistory',
        items: this.getHistoryItems(),
        currentIndex: this.currentIndex
      });
    }
  }

  private getHistoryItems() {
    const items = this.historyManager.getItems();
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    
    return items.map((item, index) => {
      const fromPath = rootPath ? path.relative(rootPath, item.from.uri.fsPath) : item.from.uri.fsPath;
      const toPath = rootPath ? path.relative(rootPath, item.to.uri.fsPath) : item.to.uri.fsPath;
      
      return {
        index,
        fromFile: fromPath,
        fromLine: item.from.position.line + 1,
        toFile: toPath,
        toLine: item.to.position.line + 1,
        symbol: item.symbol || ''
      };
    }).reverse(); // 新しい順に表示
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const theme = vscode.workspace.getConfiguration('gtags-hopper').get<string>('historyPanelTheme', 'modern-dark');
    const cssPath = path.join(this.extensionUri.fsPath, 'resources', 'themes', `${theme}.css`);
    const cssUri = webview.asWebviewUri(vscode.Uri.file(cssPath));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jump History</title>
  <link rel="stylesheet" href="${cssUri}">
  <style>
    body {
      padding: 0;
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h3 {
      margin: 0;
      font-weight: 600;
    }
    .header-controls {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .nav-buttons {
      display: flex;
      gap: 3px;
    }
    .nav-btn, .clear-btn {
      border: none;
      cursor: pointer;
      border-radius: 2px;
    }
    .nav-btn:disabled {
      cursor: default;
      pointer-events: none;
    }
    .search-input {
      width: 100%;
      font-size: 11px;
      font-family: inherit;
      box-sizing: border-box;
      border-radius: 2px;
    }
    .search-input:focus {
      outline: none;
    }
    .history-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .history-item {
      cursor: pointer;
      transition: background-color 0.1s;
    }
    .history-item.current {
      padding-left: 7px;
    }
    .history-item.hidden {
      display: none;
    }
    .item-file {
      font-weight: 500;
      margin-bottom: 2px;
    }
    .item-arrow {
      margin: 0 4px;
    }
    .empty-message {
      padding: 20px 12px;
      text-align: center;
      font-size: 11px;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="header">
    <h3>Jump History</h3>
    <div class="header-controls">
      <div class="nav-buttons">
        <button class="nav-btn" id="upBtn" onclick="navigateHistory('up')">▲</button>
        <button class="nav-btn" id="downBtn" onclick="navigateHistory('down')">▼</button>
      </div>
      <button class="clear-btn" onclick="clearHistory()">Clear</button>
    </div>
  </div>
  <div class="search-container">
    <input 
      type="text" 
      class="search-input" 
      id="searchInput" 
      placeholder="Search files or symbols..."
      oninput="filterHistory()"
    />
  </div>
  <ul class="history-list" id="historyList">
    <li class="empty-message">No history available</li>
  </ul>

  <script>
    const vscode = acquireVsCodeApi();
    let currentIndex = -1;
    let itemsLength = 0;
    let allItems = [];

    function jumpToHistory(index) {
      vscode.postMessage({ type: 'jumpToHistory', index });
    }

    function navigateHistory(direction) {
      vscode.postMessage({ type: 'navigateHistory', direction });
    }

    function clearHistory() {
      vscode.postMessage({ type: 'clearHistory' });
      document.getElementById('searchInput').value = '';
    }

    function filterHistory() {
      const searchTerm = document.getElementById('searchInput').value.toLowerCase();
      const listItems = document.querySelectorAll('.history-item');
      
      listItems.forEach((item, index) => {
        const itemData = allItems[index];
        if (!itemData) return;
        
        const fromFile = itemData.fromFile.toLowerCase();
        const toFile = itemData.toFile.toLowerCase();
        const symbol = (itemData.symbol || '').toLowerCase();
        
        const matches = fromFile.includes(searchTerm) || 
                       toFile.includes(searchTerm) || 
                       symbol.includes(searchTerm);
        
        item.classList.toggle('hidden', !matches);
      });
    }

    function updateNavigationButtons() {
      const upBtn = document.getElementById('upBtn');     // ▲ 新しい履歴へ
      const downBtn = document.getElementById('downBtn'); // ▼ 古い履歴へ
      
      if (upBtn && downBtn) {
        // 初期状態（currentIndex === -1）では▼ボタンのみ有効
        if (currentIndex === -1) {
          upBtn.disabled = true;
          downBtn.disabled = itemsLength === 0;
        } else {
          // ▲ボタン: 新しい履歴へ（currentIndexを増やす）
          upBtn.disabled = currentIndex >= itemsLength - 1;
          // ▼ボタン: 古い履歴へ（currentIndexを減らす）
          downBtn.disabled = currentIndex <= 0;
        }
      }
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'updateHistory') {
        currentIndex = message.currentIndex;
        itemsLength = message.items.length;
        allItems = message.items;
        updateHistoryList(message.items);
        updateNavigationButtons();
        filterHistory(); // 検索フィルターを再適用
      }
    });

    function updateHistoryList(items) {
      const list = document.getElementById('historyList');
      
      if (items.length === 0) {
        list.innerHTML = '<li class="empty-message">No history available</li>';
        return;
      }

      list.innerHTML = items.map((item, reverseIndex) => {
        const actualIndex = items.length - 1 - reverseIndex;
        const isCurrent = actualIndex === currentIndex;
        const symbolText = item.symbol ? \`[\${escapeHtml(item.symbol)}] \` : '';
        
        return \`
          <li class="history-item\${isCurrent ? ' current' : ''}" onclick="jumpToHistory(\${item.index})">
            <div class="item-file">
              <span class="item-from">\${escapeHtml(item.fromFile)}:\${item.fromLine}</span>
              <span class="item-arrow">→</span>
              <span class="item-to">\${escapeHtml(item.toFile)}:\${item.toLine}</span>
            </div>
            <div class="item-details">\${symbolText}</div>
          </li>
        \`;
      }).join('');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}