# Changelog

All notable changes to Gtags Hopper will be documented in this file.

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