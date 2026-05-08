// src/resultsPanel.ts
import * as vscode from 'vscode';

/**
 * 検索結果アイテムの型定義
 */
export interface ResultItem {
  label: string;
  description: string;
  file: string;
  line: number;
}

/**
 * 定義検索結果パネルプロバイダー
 * 下部パネルエリア（ターミナル等と同じ場所）に結果一覧を表示する
 */
export class ResultsPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gtagsHopperResults';
  private view?: vscode.WebviewView;

  // 結果パネルが解決される前に showResults が呼ばれた場合のキュー
  private pendingShow?: {
    symbol: string;
    items: ResultItem[];
    onPreview: (item: ResultItem) => void;
    onJump: (item: ResultItem) => void;
    onCancel: () => void;
    title?: string;
    autoPreview?: boolean;
  };

  // 現在登録されているコールバック
  private onPreviewCallback?: (item: ResultItem) => void;
  private onJumpCallback?: (item: ResultItem) => void;
  private onCancelCallback?: () => void;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml();

    // WebviewからのメッセージをExtension側で処理
    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'preview':
          this.onPreviewCallback?.(data.item);
          break;
        case 'jump':
          this.onJumpCallback?.(data.item);
          break;
        case 'cancel':
          this.onCancelCallback?.();
          break;
      }
    });

    // キューに積まれた結果があれば表示
    if (this.pendingShow) {
      const { symbol, items, onPreview, onJump, onCancel, title, autoPreview } = this.pendingShow;
      this.pendingShow = undefined;
      this.showResults(symbol, items, onPreview, onJump, onCancel, title, autoPreview);
    }
  }

  /**
   * 検索結果を表示する
   * パネルが未解決の場合はキューに積んで、解決後に表示する
   */
  public showResults(
    symbol: string,
    items: ResultItem[],
    onPreview: (item: ResultItem) => void,
    onJump: (item: ResultItem) => void,
    onCancel: () => void,
    title?: string,
    autoPreview?: boolean
  ) {
    this.onPreviewCallback = onPreview;
    this.onJumpCallback = onJump;
    this.onCancelCallback = onCancel;

    if (!this.view) {
      this.pendingShow = { symbol, items, onPreview, onJump, onCancel, title, autoPreview };
      return;
    }

    this.view.webview.postMessage({ type: 'showResults', symbol, items, title, autoPreview: autoPreview !== false });
  }

  public appendResults(items: ResultItem[]) {
    this.view?.webview.postMessage({ type: 'appendResults', items });
  }

  /**
   * パネルをクリアする
   */
  public clearResults() {
    this.onPreviewCallback = undefined;
    this.onJumpCallback = undefined;
    this.onCancelCallback = undefined;
    this.view?.webview.postMessage({ type: 'clearResults' });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Definition Results</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #1e1e1e;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      background: #252526;
      border-bottom: 1px solid #3e3e42;
      padding: 5px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .header-title {
      font-size: 11px;
      color: #9cdcfe;
      font-weight: 600;
    }
    .header-count {
      font-size: 11px;
      color: #858585;
    }
    .empty-message {
      padding: 20px;
      text-align: center;
      color: #858585;
      font-size: 12px;
      font-style: italic;
    }
    .results-list {
      list-style: none;
      overflow-y: auto;
      flex: 1;
    }
    .results-list:focus {
      outline: none;
    }
    .result-item {
      padding: 2px 8px;
      cursor: pointer;
      border-bottom: 1px solid #2d2d30;
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      outline: none;
      min-width: 0;
    }
    .result-item:hover,
    .result-item.focused {
      background: #2a2d2e;
    }
    .result-item.focused {
      border-left: 2px solid #007acc;
      padding-left: 6px;
    }
    .item-location {
      font-size: 11px;
      color: #9cdcfe;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
      font-family: 'Cascadia Code', 'Consolas', monospace;
      width: var(--label-width, auto);
    }
    .item-sep {
      font-size: 11px;
      color: #555;
      flex-shrink: 0;
    }
    .item-code {
      font-size: 11px;
      color: #858585;
      font-family: 'Cascadia Code', 'Consolas', monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="header-title" id="headerTitle">Definition Results</span>
    <span class="header-count" id="headerCount"></span>
  </div>
  <div class="empty-message" id="emptyMessage">No results</div>
  <ul class="results-list" id="resultsList" tabindex="0" style="display:none;"></ul>

  <script>
    const vscode = acquireVsCodeApi();
    let items = [];
    let focusedIndex = -1;
    let currentAutoPreview = true; // showResultsで設定、appendResultsで参照

    // ラベル列の幅をアイテム全体の最大長（上限30ch）に合わせて更新
    function updateLabelWidth() {
      if (items.length === 0) return;
      const max = Math.min(30, Math.max(...items.map(i => i.label.length)));
      document.getElementById('resultsList').style.setProperty('--label-width', max + 'ch');
    }

    // ラベルが30文字を超える場合は左側を省略（ファイル名末尾を優先表示）
    function truncateLabel(label, maxLen) {
      if (label.length <= maxLen) return label;
      return '\u2026' + label.slice(-(maxLen - 1));
    }

    function render(symbol, newItems, title, autoPreview) {
      items = newItems;
      focusedIndex = -1;

      const titleEl = document.getElementById('headerTitle');
      const count = document.getElementById('headerCount');
      const empty = document.getElementById('emptyMessage');
      const list  = document.getElementById('resultsList');

      titleEl.textContent = (title || 'Results') + (symbol ? ': ' + symbol : '');

      if (items.length === 0) {
        count.textContent = '';
        empty.style.display = 'block';
        list.style.display = 'none';
        list.innerHTML = '';
        return;
      }

      count.textContent = items.length + ' found';
      empty.style.display = 'none';
      list.style.display = 'block';

      list.innerHTML = items.map((item, i) => \`
        <li class="result-item"
            tabindex="0"
            data-index="\${i}"
            onclick="onFocus(\${i})"
            ondblclick="onJump(\${i})">
          <span class="item-location" title="\${escapeHtml(item.label)}">\${escapeHtml(truncateLabel(item.label, 30))}</span>
          <span class="item-sep">│</span>
          <span class="item-code">\${escapeHtml(item.description)}</span>
        </li>
      \`).join('');

      // autoPreview=trueのときだけ最初のアイテムにフォーカスしてプレビュー
      setFocus(0, autoPreview);
      updateLabelWidth();
    }

    function setFocus(index, preview) {
      const listItems = document.querySelectorAll('.result-item');
      listItems.forEach(el => el.classList.remove('focused'));

      if (index < 0 || index >= items.length) return;

      focusedIndex = index;
      const el = listItems[index];
      if (el) {
        el.classList.add('focused');
        el.scrollIntoView({ block: 'nearest' });
      }

      if (preview) {
        vscode.postMessage({ type: 'preview', item: items[index] });
      }
    }

    function onFocus(index) {
      setFocus(index, true);
    }

    function onJump(index) {
      if (index < 0 || index >= items.length) return;
      vscode.postMessage({ type: 'jump', item: items[index] });
    }

    // キーボード操作（上下端で循環）
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        vscode.postMessage({ type: 'cancel' });
        return;
      }
      if (items.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        // 末尾なら先頭へ
        setFocus(focusedIndex >= items.length - 1 ? 0 : focusedIndex + 1, true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        // 先頭なら末尾へ
        setFocus(focusedIndex <= 0 ? items.length - 1 : focusedIndex - 1, true);
      } else if (e.key === 'Enter') {
        onJump(focusedIndex);
      }
    });

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'showResults') {
        currentAutoPreview = msg.autoPreview !== false;
        render(msg.symbol, msg.items, msg.title, currentAutoPreview);
        // autoPreview=trueのときだけリストにキーボードフォーカスを当てる
        if (currentAutoPreview) {
          setTimeout(() => {
            const list = document.getElementById('resultsList');
            if (list) list.focus();
          }, 50);
        }
      } else if (msg.type === 'appendResults') {
        // ストリーミング追記
        items = items.concat(msg.items);
        const count = document.getElementById('headerCount');
        const empty = document.getElementById('emptyMessage');
        const list  = document.getElementById('resultsList');

        if (count) { count.textContent = items.length + ' found'; }
        empty.style.display = 'none';
        list.style.display = 'block';

        const fragment = msg.items.map((item, i) => {
          const idx = items.length - msg.items.length + i;
          return \`<li class="result-item" tabindex="0" data-index="\${idx}"
            onclick="onFocus(\${idx})" ondblclick="onJump(\${idx})">
            <span class="item-location" title="\${escapeHtml(item.label)}">\${escapeHtml(truncateLabel(item.label, 30))}</span>
            <span class="item-sep">│</span>
            <span class="item-code">\${escapeHtml(item.description)}</span>
          </li>\`;
        }).join('');
        list.insertAdjacentHTML('beforeend', fragment);

        // 最初のアイテム受信時にフォーカス（currentAutoPreviewがtrueなら）
        if (items.length === msg.items.length && currentAutoPreview) {
          setFocus(0, true);
          setTimeout(() => { list.focus(); }, 50);
        }
        updateLabelWidth();
      } else if (msg.type === 'clearResults') {
        items = [];
        focusedIndex = -1;
        document.getElementById('headerTitle').textContent = 'Definition Results';
        document.getElementById('headerCount').textContent = '';
        document.getElementById('emptyMessage').style.display = 'block';
        const list = document.getElementById('resultsList');
        list.style.display = 'none';
        list.innerHTML = '';
      }
    });
  </script>
</body>
</html>`;
  }
}