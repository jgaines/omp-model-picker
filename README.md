# OMP Model Picker

A keyboard-driven model switcher for [OMP](https://omp.sh), forked from [Pi Model Picker](https://github.com/KyleLavorato/pi-model-picker). Compare cost, context limits, thinking levels, and LiveBench scores before switching models.

![Pi Model Picker TUI](docs/model-picker-tui.png)

## Install

```bash
omp plugin link /absolute/path/to/omp-model-picker
```

Restart OMP, then type **`/model-picker`** or press **Ctrl+Shift+L**. The built-in `/models` command remains unchanged. This is a live link to the local directory; restart OMP after editing it.

Requires OMP 19.x. The port uses OMP's native model-scope resolver, thinking capabilities, and TUI APIs. Scope follows `--models` when supplied, otherwise the active `enabledModels` setting, including pinned thinking suffixes. The all-models view lists authenticated chat models, not models without credentials.

Favorites, per-model thinking levels, and benchmark caches live in OMP's agent directory, normally `~/.omp/agent/`. Pi's files are not changed. Accepting a model without an explicit level preserves OMP's automatic/default thinking mode.

For development, run `npm install`, `npm run typecheck`, and `npm test`. The regression check uses an isolated temporary agent directory and makes no model or benchmark requests.

## Pick with confidence

- **Compare models at a glance.** See context window, input and output price per million tokens, blended cost, and supported thinking levels. The detail panel adds cost and context bars plus text, vision, video, and reasoning capabilities.
- **Check benchmark results.** View LiveBench overall, agentic, and coding scores, category breakdowns, and leaderboard rank alongside each model. Data is cached locally, refreshed in the background at most once a day, and dated in the picker. Press `r` to refresh it manually.
- **Find and organize your options.** Models are grouped by provider, with favorites pinned to the top. Type to fuzzy-filter, cycle sorting by default order, price, context, score, or name, and switch between scoped models and all authenticated chat models.
- **Pick your favourites.** Press `f` on any model to set it as a favourite so it always appears at the top of the list and is easy to access.
- **Set thinking per model.** Preview and change a model's supported thinking level before switching. The picker remembers the last level used for each model.
- **Keep the overview in view.** A two-pane comparison appears in wide terminals; narrower terminals switch to a compact layout.

## Keyboard controls

| Key | Action |
|---|---|
| Type | Fuzzy-filter models |
| `↑` / `↓` | Move through the list |
| `Enter` | Switch to the selected model |
| `←` / `→` | Change its thinking level |
| `f` | Add or remove a favorite |
| `s` | Cycle sort order |
| `Tab` | Toggle scoped/all models |
| `r` | Refresh LiveBench data |
| `Esc` | Clear the filter or close the picker |

The shortcut requires a terminal that reports shifted control chords distinctly.

## Benchmark scores

Scores come from the [LiveBench v2](https://livebench.ai) leaderboard (the number in brackets is the average of the coding and agentic scores). Each score is colour-coded by band:

| Range | Colour | Meaning |
|---|---|---|
| 80+ | Dark green | Elite |
| 70–79.9 | Light green | Strong |
| 60–69.9 | Yellow | Mid |
| 50–59.9 | Red | Weak |
| Below 50 | Dark red | Poor |
