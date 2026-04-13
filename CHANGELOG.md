# Changelog

All notable changes to Gtags Hopper will be documented in this file.

## [0.0.5] - 2026-04-13

### Added
- **Results Panel**: Search results (definitions, references, symbols, grep) now display in a dedicated bottom panel
  - Preview files by hovering over results without leaving the panel
  - Navigate with ↑↓ keys, confirm with Enter, cancel with Escape
  - Automatically restores focus to the previous terminal or editor after jumping
  - Configurable via `gtags-hopper.resultDisplayMode` (`panel` / `quickPick`, default: `panel`)
  - Preview can be toggled via `gtags-hopper.showPreview` (default: `true`)
- **WSL / Remote workspace support**: File path resolution now correctly handles WSL and remote environments

### Changed
- **Jump to References** now uses the Results Panel instead of QuickPick (consistent with other commands)
- **List Symbols in File** now displays results in the Results Panel instead of terminal output (in `panel` mode)
- **Search by Grep** now displays results in the Results Panel instead of terminal output (in `panel` mode)
- Jump history now uses physical deletion instead of logical deletion, reducing long-term memory usage
- Multi-root workspace support: file URIs are now resolved against the correct workspace folder

### Fixed
- Unreachable code branch in `List Symbols in File` removed
- Inconsistent panel usage in `Search by Grep` unified with other commands

### Security
- Added Content Security Policy (CSP) to both Webview panels (history panel and results panel)
- Fixed unescaped dynamic `RegExp` construction in local definition search (`escapeRegExp` added)
- Removed debug `console.log` and `console.error` statements from production code

---

## [0.0.4] - 2026-03-08

### Added
- **Incremental update support for `Update Tags`**
  - When GTAGS already exists, runs `global -u` (incremental) instead of full regeneration
  - Configurable via `gtags-hopper.incrementalUpdate` (default: `true`)
- **New command: `Gtags Hopper: Rebuild Tags (Full Regeneration)`**
  - Forces full regeneration regardless of the `incrementalUpdate` setting
  - Available from the Command Palette only (`Ctrl+Shift+P`)

---

## [0.0.3] - 2026-02-01

### Security
- Fixed command injection vulnerability in `global`, `gtags`, and shell command execution
  - Replaced `child_process.exec` with `execFile` to avoid shell interpretation
  - Added shell argument escaping for terminal commands

---

## [0.0.2] - 2026-01-27

### Added
- **Jump History Panel** in the sidebar
  - Visual history of all jumps with file name, line number, and symbol
  - Navigate history with ▲/▼ buttons
  - Filter history by file name or symbol name
  - Click any item to jump directly to that location
  - Clear history with the Clear button
- **Theme support** for the history panel
  - Choose from 4 themes: `modern-dark`, `modern-light`, `colorful-dark`, `colorful-light`
  - Configurable via `gtags-hopper.historyPanelTheme`

---

## [0.0.1] - 2026-01-12

### Added
- Initial release
- **Jump to Definition** using GNU GLOBAL (gtags), with fallback to local scope search
- **Jump Back** to return to the previous location
- **Jump to References** to find all references of a symbol
- **List Symbols in File** to display all symbols in the current file
- **Search by Grep** for regex-based search across the codebase
- **Update Tags** to regenerate the gtags database
- Configurable editor column, preview tab, and multiple result behavior