/**
 * Model Picker — a grand /models switcher for pi.
 *
 * A two-pane model switcher in the spirit of Cursor / Claude Code:
 *  - grouped list by provider with accent-colored section headers
 *  - rich rows: name + provider, context window, cost (in/out per M tokens),
 *    and a per-level colored thinking badge
 *  - LiveBench leaderboard scores (overall + coding) per model, fetched in
 *    the background at session start from livebench.ai, cached on disk, and
 *    refreshable on demand with `r`; sortable, with category bars in the
 *    detail card
 *  - a detail card for the focused model: context bar, cost bars,
 *    thinking selector (every supported level as a badge), and tags
 *  - type to fuzzy-filter with match highlighting, cycle sort, toggle scope
 *  - remembers the last thinking level used with each model (persisted
 *    alongside favorites, so a level change no longer bleeds across models)
 *  - adapts to narrow terminals by dropping to a single pane + footer
 *
 * Install: copy to ~/.pi/agent/extensions/ (global) or .pi/extensions/,
 * then /reload, then use /models.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    getKeybindings,
    matchesKey,
    Key,
    decodeKittyPrintable,
    fuzzyFilter,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

interface PickerEntry {
    model: Model<any>;
    supported: ModelThinkingLevel[];
}

type SortMode = "default" | "cost" | "context" | "score" | "name";

const SORT_LABEL: Record<SortMode, string> = {
    default: "default",
    cost: "price",
    context: "context",
    score: "score",
    name: "name",
};

const SORT_ORDER: SortMode[] = ["default", "cost", "context", "score", "name"];

const LEVEL_ABBREV: Record<ModelThinkingLevel, string> = {
    off: "off",
    minimal: "min",
    low: "low",
    medium: "med",
    high: "high",
    xhigh: "xhigh",
    max: "max",
};

const THINK_COLOR: Record<ModelThinkingLevel, string> = {
    off: "thinkingOff",
    minimal: "thinkingMinimal",
    low: "thinkingLow",
    medium: "thinkingMedium",
    high: "thinkingHigh",
    xhigh: "thinkingXhigh",
    max: "thinkingMax",
};

// Palette used to tint provider group headers.
const PROVIDER_COLORS = [
    "accent",
    "borderAccent",
    "success",
    "warning",
    "syntaxString",
    "syntaxFunction",
    "syntaxNumber",
    "syntaxType",
] as const;

function isSameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
    return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function keyOf(m: Model<any>): string {
    return `${m.provider}\0${m.id}`;
}

function providerColor(provider: string): (typeof PROVIDER_COLORS)[number] {
    let h = 0;
    for (const c of provider) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PROVIDER_COLORS[h % PROVIDER_COLORS.length];
}

function fmtCost(v: number): string {
    if (!v || !Number.isFinite(v) || v <= 0) return "-";
    return `$${v.toFixed(2)}`;
}

/** Whether a model is free (no listed input or output cost). */
function isFree(m: { cost: { input?: number; output?: number } }): boolean {
    return (m.cost.input ?? 0) <= 0 && (m.cost.output ?? 0) <= 0;
}

/** Per-token blended cost assuming a 12:1 input→output ratio. */
function blendedCost(m: { cost: { input: number; output: number } }): number {
    return (12 * m.cost.input + m.cost.output) / 13;
}

/**
 * Provider group cost: the cheapest blended cost among its models.
 * Free-model providers get 0, so they always sort to the top.
 */
function groupCost(entries: Array<{ model: { cost: { input: number; output: number } } }>): number {
    return Math.min(...entries.map((e) => blendedCost(e.model)));
}

// ── favorites + per-model thinking persistence ──────────────────────────────────
// Starred models are stored as `provider\0id` keys in a JSON file next to pi's
// other agent config (models.json, settings.json). The same file also remembers
// the last thinking level each model was picked with, so a level change applied
// to one model in the picker no longer bleeds into every other model on the
// next open. Legacy files (a bare array of favorite keys) are still read and
// upgraded to the object form on the next save.
const FAVORITES_FILE = join(getAgentDir(), "model-picker-favorites.json");
const FAVORITES_GROUP = "\u2605 Favorites";

// LiveBench cache and user-editable mapping overrides. Two files on purpose:
// the cache is rewritten on every refresh, manual mapping fixes must survive it.
const LB_CACHE_FILE = join(getAgentDir(), "model-picker-livebench.json");
const LB_OVERRIDES_FILE = join(getAgentDir(), "model-picker-livebench-overrides.json");

// Every level THINK_COLOR knows about — used to validate entries read from disk.
const VALID_LEVELS: ReadonlySet<string> = new Set<string>(Object.keys(THINK_COLOR));

/** Per-model last-used thinking levels, keyed by `provider\0id`. */
type RememberedThinking = Map<string, ModelThinkingLevel>;

interface PickerPersistedState {
    favorites?: unknown;
    thinking?: unknown;
}

/**
 * Capability rows for the detail card: label + whether the model supports it.
 * `input` carries text/image (video not in pi's schema yet, but we surface it so
 * the row stays honest); `reasoning` is labeled "thinking" for the user.
 */
function capabilities(m: Model<any>): Array<[string, boolean]> {
    const input = m.input ?? [];
    return [
        ["text", input.includes("text")],
        ["vision", input.includes("image")],
        ["video", input.includes("video" as never)],
        ["thinking", !!m.reasoning],
    ];
}

async function loadPickerState(): Promise<{ favorites: Set<string>; thinking: RememberedThinking }> {
    try {
        const raw = await readFile(FAVORITES_FILE, "utf8");
        const parsed: unknown = JSON.parse(raw);
        // Legacy format: a bare array of favorite keys (no thinking memory).
        if (Array.isArray(parsed)) {
            return {
                favorites: new Set(parsed.filter((k): k is string => typeof k === "string")),
                thinking: new Map(),
            };
        }
        if (parsed && typeof parsed === "object") {
            const obj = parsed as PickerPersistedState;
            const favorites = new Set(
                Array.isArray(obj.favorites) ? obj.favorites.filter((k): k is string => typeof k === "string") : [],
            );
            const thinking: RememberedThinking = new Map();
            if (obj.thinking && typeof obj.thinking === "object") {
                for (const [key, level] of Object.entries(obj.thinking as Record<string, unknown>)) {
                    if (typeof level === "string" && VALID_LEVELS.has(level)) {
                        thinking.set(key, level as ModelThinkingLevel);
                    }
                }
            }
            return { favorites, thinking };
        }
    } catch {
        // missing/corrupt file → no favorites, no remembered levels
    }
    return { favorites: new Set(), thinking: new Map() };
}

async function savePickerState(favorites: Set<string>, thinking: RememberedThinking): Promise<void> {
    try {
        await writeFile(
            FAVORITES_FILE,
            JSON.stringify({ favorites: [...favorites], thinking: Object.fromEntries(thinking) }, null, 2),
            "utf8",
        );
    } catch {
        // best-effort; ignore write failures
    }
}

// ── LiveBench data layer (pure: no pi imports) ──────────────────────────────
// Leaderboard data from livebench.ai, fetched in the background at session
// start and cached to disk. The site is a React SPA, but its data files are
// static, date-stamped CSV/JSON at the site root:
//   table_<YYYY_MM_DD>.csv        per-task scores (0-100) for every model
//   categories_<YYYY_MM_DD>.json  task -> category grouping
// The release dates are embedded in the site's JS bundle (main.<hash>.js),
// so discovery means: fetch index.html, extract the bundle name, regex out
// the date array. Scores aggregate exactly like the site computes them:
// category = plain mean of its task scores, overall = mean of the category
// means. The picker itself only ever reads the local cache; network happens
// at session_start (TTL-gated) or on the manual refresh key.

const LB_SITE = "https://livebench.ai";
const LB_TTL_MS = 24 * 60 * 60 * 1000;
const LB_TIMEOUT_MS = 10_000;
// Five heat bands for scores. Thresholds fit the live field (spans ~62-83
// with a median near 75): 80+ elite, 76+ strong, 71+ mid, 66+ weak, below
// that poor. The greens and reds are pinned to explicit hex values so the
// ladder stays exactly as tuned; yellow stays a theme token so the middle
// band still follows the active theme.
const LB_HEAT_BANDS: Array<{ min: number; color: string }> = [
    { min: 80, color: "#3BCA6D" }, // dark green, elite
    { min: 76, color: "#00FF7F" }, // light green, strong
    { min: 71, color: "warning" }, // yellow, mid
    { min: 66, color: "#FF4444" }, // red, weak
    { min: 0, color: "#CC3333" }, // dark red, poor
];
// Score bars are normalized so the leftmost segment means 50 rather than 0.
// The live field sits between ~62 and ~83, so a 0-based bar renders nearly
// identical for every model. Visual only, never surfaced as a number.
const LB_BAR_FLOOR = 50;
const LB_BAR_SEGMENTS = 12;
// Below this total width the score column disappears (rows get cramped).
const LB_MIN_WIDTH = 84;
// Terminal height at which the detail card earns the full livebench section
// instead of a one-line summary.
const LB_DETAIL_MIN_ROWS = 34;

/** One tested model row from the leaderboard. */
interface LbRow {
    overall: number;
    cats: Record<string, number>;
}

/** Disk cache shape (model-picker-livebench.json). */
interface LbCache {
    version: 1;
    release: string;
    releaseDates: string[];
    fetchedAt: number;
    tasks: number;
    order: string[];
    models: Record<string, LbRow>;
}

/** User-editable mapping fixes (model-picker-livebench-overrides.json). */
interface LbOverrides {
    byId?: Record<string, string | null>;
    byProvider?: Record<string, Record<string, string | null>>;
}

/** A resolved score for one picker model. */
interface LbMatch {
    tested: string; // the LiveBench row name behind the score
    overall: number;
    cats: Record<string, number>;
    rank: number | null; // 1-based leaderboard position
    effort: string | null; // effort level the benchmark used (xhigh, max, ...)
    thinking: string | null; // thinking mode of the tested config (auto/64k/...)
}

function lbFetch(url: string): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LB_TIMEOUT_MS);
    try {
        return fetch(url, { signal: ac.signal, redirect: "follow" });
    } finally {
        clearTimeout(timer);
    }
}

/** Minimal CSV parser: quoted cells, commas and newlines inside quotes. */
function lbParseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    const endRow = () => {
        row.push(cell);
        cell = "";
        if (row.length > 1 || (row[0] ?? "") !== "") rows.push(row);
        row = [];
    };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                cell += ch;
            }
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === ",") {
            row.push(cell);
            cell = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            endRow();
        } else {
            cell += ch;
        }
    }
    if (cell !== "" || row.length > 0) endRow();
    return rows;
}

function lbMean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate per-task rows the way the site does: a category score is the
 * plain mean of its task scores, and overall is the mean of the category
 * means (every category equally weighted). Verified against the site's own
 * aggregation code in its bundle.
 */
function lbAggregate(
    tableCsv: string,
    categories: Record<string, string[]>,
): { models: Record<string, LbRow>; tasks: number } {
    const rows = lbParseCsv(tableCsv);
    if (rows.length < 2) return { models: {}, tasks: 0 };
    const header = rows[0]!;
    const col = new Map<string, number>();
    for (let i = 1; i < header.length; i++) col.set(header[i]!, i);
    const models: Record<string, LbRow> = {};
    for (const cells of rows.slice(1)) {
        const name = (cells[0] ?? "").trim();
        if (!name) continue;
        const cats: Record<string, number> = {};
        for (const [cat, tasks] of Object.entries(categories)) {
            const vals: number[] = [];
            for (const t of tasks) {
                const idx = col.get(t);
                if (idx === undefined) continue;
                const v = Number.parseFloat(cells[idx] ?? "");
                if (Number.isFinite(v)) vals.push(v);
            }
            const m = lbMean(vals);
            if (m !== null) cats[cat] = m;
        }
        const overall = lbMean(Object.values(cats));
        if (overall !== null) models[name] = { overall, cats };
    }
    const tasks = Object.values(categories).reduce((n, t) => n + t.length, 0);
    return { models, tasks };
}

/** First category matching `pattern` (and not `exclude`), by score. */
function lbCatScore(cats: Record<string, number>, pattern: RegExp, exclude?: RegExp): number | null {
    for (const [k, v] of Object.entries(cats)) {
        if (pattern.test(k) && (!exclude || !exclude.test(k))) return v;
    }
    return null;
}

/** Compact label for the detail card's category summary line. */
function lbShortCat(cat: string): string {
    const c = cat.toLowerCase();
    if (c.includes("agentic")) return "agentic";
    if (c.includes("reason")) return "reason";
    if (c.includes("cod")) return "code";
    if (c.includes("math")) return "math";
    if (c.includes("data")) return "data";
    if (c.includes("lang")) return "lang";
    if (c === "if" || c.includes("instruction")) return "if";
    return c.split(/\s+/)[0]!.slice(0, 7);
}

/**
 * Parse the benchmarked configuration out of a LiveBench row name: the
 * effort word (max/xhigh/high/medium/low/minimal, from "-effort" suffixes or
 * trailing markers like "-max") and the thinking mode when the row used a
 * thinking variant (auto / 64k / 128k / bare). Both null when unspecified.
 */
function lbTestedConfig(name: string): { effort: string | null; thinking: string | null } {
    const s = name.toLowerCase();
    const withSuffix = s.match(/-(xhigh|max|high|medium|low|minimal)-effort\b/);
    const effort = withSuffix ? withSuffix[1]! : (s.match(/-(xhigh|max|high|medium|low|minimal)$/)?.[1] ?? null);
    const thinking = s.match(/-thinking-(auto|\d+k)\b/)?.[1] ?? (/-thinking\b/.test(s) ? "on" : null);
    return { effort, thinking };
}

/** Local YYYY-MM-DD stamp for a timestamp. */
function lbFormatDate(ms: number): string {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Freshness stamp for the header badge: the day we last pulled the data, so a
 * stale cache is visible at a glance. Falls back to the release date if the
 * cache was written before the fetch timestamp existed.
 */
function lbStamp(cache: LbCache): string {
    return Number.isFinite(cache.fetchedAt) && cache.fetchedAt > 0 ? lbFormatDate(cache.fetchedAt) : cache.release;
}

function lbHeat(v: number): string {
    for (const band of LB_HEAT_BANDS) {
        if (v >= band.min) return band.color;
    }
    return LB_HEAT_BANDS[LB_HEAT_BANDS.length - 1]!.color;
}

/**
 * Foreground helper for heat colours: a "#rrggbb" value emits a truecolor
 * escape directly, anything else resolves as a theme colour token. This lets
 * the score ladder pin exact hex shades without editing the user's theme, and
 * still lets tokens like "warning" track the active theme.
 */
function lbFg(theme: any, color: string, text: string): string {
    if (!color.startsWith("#")) return theme.fg(color, text);
    const n = Number.parseInt(color.slice(1), 16);
    return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m${text}\x1b[39m`;
}

// Tokens that never distinguish a model across the two catalogs: thinking
// effort suffixes, provider labels, and context-window markers. Date-ish
// tokens drop out separately.
const LB_STRIP_TOKENS = new Set([
    "thinking", "effort", "high", "medium", "low", "xhigh", "max", "auto",
    "64k", "128k", "latest", "preview", "anthropic", "openai", "google",
    "azure", "bedrock", "vertex", "openrouter",
]);

/** Pure-digit tokens that are actually dates (20251101, 0731, 0813...). */
function lbIsDateToken(t: string): boolean {
    if (/^\d{8}$/.test(t)) return t.startsWith("20");
    if (/^\d{4}$/.test(t)) {
        const m = Number(t.slice(0, 2));
        return m >= 1 && m <= 12;
    }
    return false;
}

/**
 * Normalize a model id or LiveBench name into comparable tokens: lowercase,
 * dots dropped (4.8 -> 48 so versions stay atomic), single-digit version
 * dashes fused (claude-opus-4-8 -> ...48...), dates and strip-tokens removed.
 */
function lbTokens(raw: string): string[] {
    let s = raw.toLowerCase().replaceAll("_", "-").replaceAll(".", "");
    s = s.replace(/(?<!\d)(\d)-(\d)(?!\d)/g, "$1$2");
    const out: string[] = [];
    for (const t of s.split(/[^a-z0-9]+/)) {
        if (!t || LB_STRIP_TOKENS.has(t) || lbIsDateToken(t)) continue;
        out.push(t);
    }
    return out;
}

/** Sorted unique token signature, for set-equality matching. */
function lbTokenKey(raw: string): string {
    return [...new Set(lbTokens(raw))].sort().join("+");
}

/** Model-size token (27b, 35b, 70b, a3b): must never be fuzzy-matched away. */
function lbIsSizeToken(t: string): boolean {
    return /^\d+[a-z]$/.test(t) || /^[a-z]\d+[a-z]$/.test(t);
}

/** One LiveBench row prepared for matching. */
interface LbCandidate {
    name: string;
    row: LbRow;
    tokens: string[];
}

/**
 * Match a picker model to a LiveBench row. Pass 1: token-set equality
 * (covers exact and normalized ids, e.g. claude-4.8-opus-anthropic vs
 * claude-opus-4-8-...-effort). Pass 2: unique subset, the LiveBench name
 * being strictly less specific (a quant fork of a catalog model), rejecting
 * when the extra picker-side tokens carry model sizes (35b is not 27b).
 * Ties prefer the higher-scoring row; rows sharing a token signature have
 * already been collapsed to their best row by the caller.
 */
function lbMatchModel(
    provider: string,
    id: string,
    candidates: LbCandidate[],
    overrides: LbOverrides | null,
): { tested: string; row: LbRow } | null {
    const pick = (v: string | null | undefined): { tested: string; row: LbRow } | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null) return null; // explicit hide
        // Direct row name first; if that row was collapsed into a better
        // sibling with the same token signature, resolve through the signature.
        const hit =
            candidates.find((c) => c.name === v) ??
            candidates.find((c) => [...new Set(c.tokens)].sort().join("+") === lbTokenKey(v));
        return hit ? { tested: hit.name, row: hit.row } : null;
    };
    const pv = pick(overrides?.byProvider?.[provider]?.[id]);
    if (pv !== undefined) return pv;
    const gv = pick(overrides?.byId?.[id]);
    if (gv !== undefined) return gv;

    const piTokens = [...new Set(lbTokens(id))];
    if (piTokens.length === 0) return null;
    const piKey = [...piTokens].sort().join("+");

    // Pass 1: token-set equality.
    let best: LbCandidate | null = null;
    for (const c of candidates) {
        const cKey = [...new Set(c.tokens)].sort().join("+");
        if (cKey === piKey && (!best || c.row.overall > best.row.overall)) best = c;
    }
    if (best) return { tested: best.name, row: best.row };

    // Pass 2: subset, LiveBench name strictly less specific than the picker id.
    const piSet = new Set(piTokens);
    let subset: LbCandidate | null = null;
    let subsetSize = Infinity;
    for (const c of candidates) {
        const cSet = new Set(c.tokens);
        if (cSet.size === 0 || cSet.size >= piSet.size) continue;
        let covered = true;
        for (const t of cSet) {
            if (!piSet.has(t)) {
                covered = false;
                break;
            }
        }
        if (!covered) continue;
        // Extra picker-side tokens must not hide a different model size.
        const extra = piTokens.filter((t) => !cSet.has(t));
        if (extra.some(lbIsSizeToken)) continue;
        if (cSet.size < subsetSize) {
            subset = c;
            subsetSize = cSet.size;
        } else if (cSet.size === subsetSize && subset && c.row.overall > subset.row.overall) {
            subset = c;
        }
    }
    return subset ? { tested: subset.name, row: subset.row } : null;
}

/** Pull the release-date array out of the site's JS bundle. */
function lbExtractReleaseDates(bundle: string): string[] {
    let best: string[] = [];
    const arrayRe = /\[((?:\s*"\d{4}-\d{2}-\d{2}"\s*,?)+)\s*\]/g;
    for (const m of bundle.matchAll(arrayRe)) {
        const dates = [...m[1]!.matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((d) => d[1]!);
        if (dates.length >= 2 && dates.length > best.length) best = dates;
    }
    return best;
}

/** Discover the release list: index.html -> main.<hash>.js -> date array. */
async function lbDiscoverReleases(fallback: string[]): Promise<string[]> {
    try {
        const res = await lbFetch(`${LB_SITE}/`);
        if (!res.ok) return fallback;
        const html = await res.text();
        const m = html.match(/static\/js\/(main\.[0-9a-f]+\.js)/);
        if (!m) return fallback;
        const bres = await lbFetch(`${LB_SITE}/static/js/${m[1]!}`);
        if (!bres.ok) return fallback;
        const dates = lbExtractReleaseDates(await bres.text());
        return dates.length > 0 ? dates : fallback;
    } catch {
        return fallback;
    }
}

interface LbRefreshResult {
    ok: boolean;
    skipped?: boolean;
    release?: string;
    models?: number;
    tasks?: number;
    error?: string;
}

async function lbLoadCache(cacheFile: string): Promise<LbCache | null> {
    try {
        const raw = await readFile(cacheFile, "utf8");
        const parsed = JSON.parse(raw) as LbCache;
        if (parsed && parsed.version === 1 && parsed.models && parsed.order && parsed.release) {
            return parsed;
        }
    } catch {
        // missing/corrupt cache -> no scores
    }
    return null;
}

async function lbLoadOverrides(overridesFile: string): Promise<LbOverrides> {
    try {
        const raw = await readFile(overridesFile, "utf8");
        const parsed = JSON.parse(raw) as LbOverrides;
        if (parsed && typeof parsed === "object") return parsed;
    } catch {
        // missing file -> no overrides, which is the normal case
    }
    return {};
}

async function lbSaveCache(cacheFile: string, cache: LbCache): Promise<void> {
    const tmp = `${cacheFile}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await rename(tmp, cacheFile);
}

// Single-flight guard so session_start and manual refreshes never stack.
let lbInflight: Promise<LbRefreshResult> | null = null;

function lbRefresh(opts: { cacheFile: string; force?: boolean }): Promise<LbRefreshResult> {
    if (lbInflight) return lbInflight;
    lbInflight = lbRefreshInner(opts).finally(() => {
        lbInflight = null;
    });
    return lbInflight;
}

async function lbRefreshInner({ cacheFile, force }: { cacheFile: string; force?: boolean }): Promise<LbRefreshResult> {
    const existing = await lbLoadCache(cacheFile);
    if (!force && existing && Date.now() - existing.fetchedAt < LB_TTL_MS) {
        return { ok: true, skipped: true, release: existing.release, models: existing.order.length, tasks: existing.tasks };
    }

    // Newest release that actually serves a table; walk back a little in case
    // the bundle lists a release whose data files are not up yet.
    const dates = await lbDiscoverReleases(existing?.releaseDates ?? []);
    if (dates.length === 0) return { ok: false, error: "no releases discovered" };
    let table: string | null = null;
    let release = "";
    for (let i = dates.length - 1, tried = 0; i >= 0 && tried < 3; i--, tried++) {
        const d = dates[i]!;
        try {
            const res = await lbFetch(`${LB_SITE}/table_${d.replaceAll("-", "_")}.csv`);
            if (res.ok) {
                table = await res.text();
                release = d;
                break;
            }
        } catch {
            // network hiccup on this date, try the next older one
        }
    }
    if (table === null) return { ok: false, error: "no leaderboard table fetched" };

    let categories: Record<string, string[]> | null = null;
    try {
        const res = await lbFetch(`${LB_SITE}/categories_${release.replaceAll("-", "_")}.json`);
        if (res.ok) {
            const json = (await res.json()) as unknown;
            if (json && typeof json === "object") {
                const entries = Object.entries(json as Record<string, unknown>).filter(
                    ([k, v]) => typeof k === "string" && Array.isArray(v) && v.every((t) => typeof t === "string"),
                );
                if (entries.length > 0) categories = Object.fromEntries(entries) as Record<string, string[]>;
            }
        }
    } catch {
        categories = null;
    }
    if (!categories) return { ok: false, error: "no categories fetched" };

    const { models, tasks } = lbAggregate(table, categories);
    if (Object.keys(models).length === 0) return { ok: false, error: "no models parsed" };
    const order = Object.keys(models).sort((a, b) => models[b]!.overall - models[a]!.overall);
    const cache: LbCache = {
        version: 1,
        release,
        releaseDates: dates,
        fetchedAt: Date.now(),
        tasks,
        order,
        models,
    };
    try {
        await lbSaveCache(cacheFile, cache);
    } catch {
        // read-only disk? scores still work in memory this session
    }
    return { ok: true, release, models: order.length, tasks };
}
// ── end LiveBench data layer ────────────────────────────────────────────────

/**
 * Heat color for a cost bar: ratio of the value to its baseline.
 * Green (cheap) → yellow (mid) → red (expensive).
 */
function heatColor(ratio: number): string {
    if (ratio < 0.3) return "success";
    if (ratio < 0.65) return "warning";
    return "error";
}

function fmtCtx(n: number): string {
    if (n >= 1_000_000) {
        const m = n / 1_000_000;
        return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return `${n}`;
}

function padRight(s: string, w: number): string {
    return visibleWidth(s) >= w ? s : s + " ".repeat(w - visibleWidth(s));
}

function padLeft(s: string, w: number): string {
    return visibleWidth(s) >= w ? s : " ".repeat(w - visibleWidth(s)) + s;
}

/**
 * Friendly display name. Some catalogs append redundant pricing hints like
 * `[B:$1.63/M|I:$1.40/M|O:$4.40/M]`; costs are already shown in the columns,
 * so strip those bracket blocks.
 */
function displayName(m: Model<any>): string {
    const raw = (m.name || m.id).trim();
    return raw
        .replace(/\s*\[[^\]]*\/M[^\]]*\]\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

/** Highlight the first case-insensitive occurrence of `query` in `text`. */
function highlightMatch(text: string, query: string, theme: any): string {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return text;
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + query.length);
    const after = text.slice(idx + query.length);
    const hi = theme.bg("searchMatchBg", theme.fg("searchMatchText", match));
    return `${before}${hi}${after}`;
}

export default function modelPicker(pi: ExtensionAPI) {
    // Shared entry point for the picker UI. Both the /models command and the
    // ctrl+shift+l shortcut call this so they behave identically.
    async function openModelPicker(ctx: ExtensionContext) {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/models requires TUI mode", "error");
                return;
            }

            const current = ctx.model;
            const currentThinking = ctx.thinkingLevel ?? "off";
            // Key of the live model, so per-model memory can defer to the real
            // session level for the model that is currently selected.
            const currentKey = current ? keyOf(current) : "";

            // Pinned thinking levels from scoped-model patterns (e.g. "model:high").
            const pinned = new Map<string, ModelThinkingLevel>();
            for (const s of ctx.scopedModels) {
                if (s.thinkingLevel) pinned.set(keyOf(s.model), s.thinkingLevel);
            }

            const scopedEntries: PickerEntry[] = ctx.scopedModels.map((s) => ({
                model: s.model,
                supported: getSupportedThinkingLevels(s.model),
            }));
            const allEntries: PickerEntry[] = ctx.modelRegistry
                .getAvailable()
                .map((m) => ({ model: m, supported: getSupportedThinkingLevels(m) }));
            const canScope = scopedEntries.length > 0;
            let useScoped = canScope;

            // Provider display names (fall back to raw id).
            const providerNames = new Map<string, string>();
            for (const e of [...scopedEntries, ...allEntries]) {
                const p = e.model.provider;
                if (!providerNames.has(p)) {
                    const dn = ctx.modelRegistry.getProviderDisplayName(p);
                    providerNames.set(p, dn || p);
                }
            }

            // Favorites (a pinned set of model keys, provider\0id) plus the
            // last-used thinking level per model, persisted together across
            // sessions. The ★ Favorites group always renders first in the list;
            // a remembered level wins over the global fallback for that model.
            const { favorites, thinking: remembered } = await loadPickerState();

            // LiveBench scores: local cache only on the open path (network
            // happens at session_start or via the manual refresh key). The
            // state is rebuildable in place so `r` can hot-swap fresh data
            // into an open picker.
            let lbCache = await lbLoadCache(LB_CACHE_FILE);
            const lbOverrides = await lbLoadOverrides(LB_OVERRIDES_FILE);
            const lbScores = new Map<string, LbMatch>();
            let lbRefreshing = false;

            function rebuildLbScores(): void {
                lbScores.clear();
                if (!lbCache) return;
                const rank = new Map<string, number>();
                lbCache.order.forEach((name, i) => rank.set(name, i + 1));
                // Collapse rows sharing a token signature (a dated thinking
                // variant and its bare sibling) to their best-scoring row.
                const byKey = new Map<string, LbCandidate>();
                for (const [name, row] of Object.entries(lbCache.models)) {
                    const sig = lbTokenKey(name);
                    if (!sig) continue;
                    const cur = byKey.get(sig);
                    if (!cur || row.overall > cur.row.overall) {
                        byKey.set(sig, { name, row, tokens: lbTokens(name) });
                    }
                }
                const candidates = [...byKey.values()];
                const seen = new Set<string>();
                for (const e of [...scopedEntries, ...allEntries]) {
                    const mk = keyOf(e.model);
                    if (seen.has(mk)) continue;
                    seen.add(mk);
                    const hit = lbMatchModel(e.model.provider, e.model.id, candidates, lbOverrides);
                    if (hit) {
                        const cfg = lbTestedConfig(hit.tested);
                        lbScores.set(mk, {
                            tested: hit.tested,
                            overall: hit.row.overall,
                            cats: hit.row.cats,
                            rank: rank.get(hit.tested) ?? null,
                            effort: cfg.effort,
                            thinking: cfg.thinking,
                        });
                    }
                }
            }

            function lbCodingScore(m: LbMatch): number | null {
                return lbCatScore(m.cats, /^coding/i, /agentic/i);
            }

            /** Plain text of the score cell, for column-width math. */
            function lbCellText(e: PickerEntry): string {
                const m = lbScores.get(keyOf(e.model));
                if (!m) return "–";
                const cd = lbCodingScore(m);
                return `${m.overall.toFixed(1)}(${cd === null ? "–" : cd.toFixed(1)})`;
            }

            rebuildLbScores();

            // Per-metric baselines for the detail-pane bars. Computed over the
            // current scope (scoped or all), NOT the whole registry, so the
            // priciest / biggest model the user can actually pick sets the
            // bar scale (e.g. Opus's input/output max out the cost bars).
            function barStats(list: PickerEntry[]) {
                const models = list.map((e) => e.model);
                return {
                    maxIn: Math.max(1, ...models.map((m) => m.cost.input || 0)),
                    maxOut: Math.max(1, ...models.map((m) => m.cost.output || 0)),
                    maxBlend: Math.max(0.01, ...models.map((m) => blendedCost(m))),
                    maxRead: Math.max(1, ...models.map((m) => m.cost.cacheRead || 0)),
                    maxWrite: Math.max(1, ...models.map((m) => m.cost.cacheWrite || 0)),
                    maxCtx: Math.max(1, ...models.map((m) => m.contextWindow || 0)),
                };
            }

            const state = {
                filter: "",
                selected: 0,
                scopeIdx: 0,
                sort: "default" as SortMode,
            };
            // Index into the DISPLAY list (left pane, cost-grouped order), which is
            // what navigation and the detail pane both follow.
            state.selected = Math.max(0, displayEntryList().findIndex((e) => isSameModel(e.model, current)));
            const pendingThinking = new Map<string, ModelThinkingLevel>();

            function costOf(e: PickerEntry): number {
                return blendedCost(e.model);
            }

            function sortEntries(list: PickerEntry[]): PickerEntry[] {
                const arr = [...list];
                arr.sort((a, b) => {
                    if (state.sort === "score") {
                        // Best first; models without a score sink to the bottom
                        // and ties keep the default ordering below.
                        const av = lbScores.get(keyOf(a.model))?.overall ?? -1;
                        const bv = lbScores.get(keyOf(b.model))?.overall ?? -1;
                        if (av !== bv) return bv - av;
                    }
                    if (state.sort === "cost") return costOf(a) - costOf(b);
                    if (state.sort === "context") return b.model.contextWindow - a.model.contextWindow;
                    if (state.sort === "name") {
                        return (a.model.name || a.model.id).localeCompare(b.model.name || b.model.id);
                    }
                    const aCur = isSameModel(a.model, current) ? 0 : 1;
                    const bCur = isSameModel(b.model, current) ? 0 : 1;
                    if (aCur !== bCur) return aCur - bCur;
                    const ap = a.model.provider.localeCompare(b.model.provider);
                    if (ap !== 0) return ap;
                    return a.model.id.localeCompare(b.model.id);
                });
                return arr;
            }

            function currentList(): PickerEntry[] {
                return sortEntries(useScoped ? scopedEntries : allEntries);
            }

            function applyFilter(): PickerEntry[] {
                const list = currentList();
                if (!state.filter) return list;
                return fuzzyFilter(list, state.filter, (e) => {
                    const m = e.model;
                    // Tested LiveBench name included so typing a vendor-specific
                    // variant (e.g. "xhigh") finds the models scored under it.
                    const tested = lbScores.get(keyOf(m))?.tested ?? "";
                    return `${m.name} ${m.id} ${m.provider} ${tested}`;
                });
            }

            // Provider group ordering: cheapest (by lowest blended cost) first;
            // free-model providers (cost 0) always lead.
            function groupOrder(providers: string[], groups: Map<string, PickerEntry[]>): string[] {
                return [...providers].sort((a, b) => {
                    const d = groupCost(groups.get(a)!) - groupCost(groups.get(b)!);
                    return d !== 0 ? d : a.localeCompare(b);
                });
            }

            // The DISPLAY order of the left pane. The ★ Favorites group always pins
            // to the top (cost-sorted), then the remaining models are grouped by
            // provider, itself ordered by cost (free providers first). Navigation
            // and the ▸ marker follow exactly this order.
            function displayEntryList(): PickerEntry[] {
                const rows = applyFilter();
                const fav = rows.filter((e) => favorites.has(keyOf(e.model)));
                const rest = rows.filter((e) => !favorites.has(keyOf(e.model)));
                fav.sort((a, b) => blendedCost(a.model) - blendedCost(b.model) || a.model.id.localeCompare(b.model.id));
                const groups = new Map<string, PickerEntry[]>();
                for (const e of rest) {
                    const arr = groups.get(e.model.provider) ?? [];
                    arr.push(e);
                    groups.set(e.model.provider, arr);
                }
                const ordered: PickerEntry[] = [...fav];
                for (const p of groupOrder([...groups.keys()], groups)) {
                    for (const e of groups.get(p)!) ordered.push(e);
                }
                return ordered;
            }

            const picked = await ctx.ui.custom<{ model: Model<any>; thinking?: ModelThinkingLevel } | null>(
                (tui, theme, _kb, done) => {
                    const kb = getKeybindings();
                    const TWO_PANE_MIN = 100;
                    const DETAIL_W = 46;
                    // Fill the picker to the full terminal height instead of capping
                    // at a fixed 14 rows. 8 = header + filter box + top/bottom borders
                    // + footer hint (fixed chrome above/below the scrolled list). Falls
                    // back to 14 when there's no real tty (headless / non-interactive).
                    const ttyRows = Number((process as any).stdout?.rows ?? (process as any).stderr?.rows ?? 0);
                    const MAX_VIS = ttyRows > 0 ? Math.max(6, ttyRows - 8) : 14;

                    function effectiveThinking(key: string, e: PickerEntry): ModelThinkingLevel {
                        const pend = pendingThinking.get(key);
                        if (pend) return pend;
                        // The live session level is the truth for the currently
                        // selected model (it may have been changed via /thinking
                        // since the picker last ran).
                        if (key === currentKey && e.supported.includes(currentThinking)) return currentThinking;
                        // Last level used with this model (persisted).
                        const rem = remembered.get(key);
                        if (rem && e.supported.includes(rem)) return rem;
                        // Pinned level from scoped-model patterns (e.g. "model:high").
                        const pin = pinned.get(key);
                        if (pin && e.supported.includes(pin)) return pin;
                        if (e.supported.includes(currentThinking)) return currentThinking;
                        if (e.supported.includes("off")) return "off";
                        return e.supported[e.supported.length - 1] ?? "off";
                    }

            // ── render ────────────────────────────────────────────────
            function render(width: number): string[] {
                const rows = applyFilter();
                        const B = (s: string) => theme.fg("border", s);
                        const innerW = Math.max(24, width - 4);
                        if (width < 28) {
                            // Too narrow to frame; one short line keeps the TUI
                            // from crashing on an over-wide rendered row.
                            return [theme.fg("warning", "model picker needs a wider terminal")];
                        }
                        const lbAny = lbScores.size > 0;
                        const showScores = lbAny && width >= LB_MIN_WIDTH;
                        // With the score column in place a 100-col terminal can
                        // no longer fit two panes without crushing the name
                        // column, so the threshold moves up accordingly.
                        const twoPane = width >= (showScores ? TWO_PANE_MIN + 16 : TWO_PANE_MIN);
                        const listW = twoPane ? innerW - DETAIL_W - 3 : innerW;

                        const chrome: string[] = [];

                        // Header
                        const scopePts: Array<[string, boolean]> = canScope
                            ? [
                                  ["scoped", state.scopeIdx === 0],
                                  ["all", state.scopeIdx === 1],
                              ]
                            : [["all", true]];
                        const scopeStr = scopePts
                            .map(([name, on]) => (on ? theme.fg("accent", name) : theme.fg("muted", name)))
                            .join(theme.fg("muted", " | "));
                        const total = currentList().length;
                        const countStr = rows.length === total ? `${total} models` : `${rows.length}/${total} models`;
                        // LiveBench badge: the release date when data is loaded,
                        // a spinner while the manual refresh is in flight.
                        const lbBadge = lbRefreshing
                            ? `${theme.fg("accent", "Benchmarks")} ${theme.fg("muted", "⟳")}`
                            : lbCache
                              ? `${theme.fg("accent", "Benchmarks")} ${theme.fg("muted", lbStamp(lbCache))}`
                              : "";
                        chrome.push(
                            truncateToWidth(
                                `${theme.fg("accent", theme.bold("✦ Model Picker"))}` +
                                    `  ${theme.fg("muted", "·")}  ${scopeStr}` +
                                    `  ${theme.fg("muted", "·")}  ${theme.fg("muted", "sort:")} ${theme.fg("accent", SORT_LABEL[state.sort])}` +
                                    `  ${theme.fg("muted", "·")}  ${theme.fg("muted", countStr)}` +
                                    (lbBadge ? `  ${theme.fg("muted", "·")}  ${lbBadge}` : ""),
                                innerW,
                                "",
                            ),
                        );

                        // Filter box
                        const filterBox = state.filter
                            ? theme.fg("accent", state.filter)
                            : theme.fg("dim", "type to filter…");
                        chrome.push(truncateToWidth(`${theme.fg("muted", "  ⌕")} ${filterBox}${theme.fg("dim", "_")}`, innerW, ""));

                        chrome.push(B(" " + "─".repeat(Math.max(0, innerW - 2))));

                        if (rows.length === 0) {
                            chrome.push(theme.fg("warning", "  no models match your filter"));
                            chrome.push("");
                            chrome.push(theme.fg("dim", "  ↑↓ move · esc cancel"));
                            return frame(chrome, width, innerW, theme, B);
                        }

                        // ── List pane content ──────────────────────────────────
                        const listLines: string[] = [];
                        // displayEntryList() is the single source of truth for what
                        // the pane shows (★ Favorites first, then cost-grouped
                        // providers). Derive the grouped rows from it so headers and
                        // navigation always line up.
                        const displayRows = displayEntryList();
                        const countByGroup = new Map<string, number>();
                        for (const e of displayRows) {
                            const g = favorites.has(keyOf(e.model)) ? FAVORITES_GROUP : e.model.provider;
                            countByGroup.set(g, (countByGroup.get(g) ?? 0) + 1);
                        }
                        const dispItems: Array<{ kind: "header"; provider: string; count: number } | { kind: "entry"; e: PickerEntry; flat: number }> = [];
                        let flat = 0;
                        let lastGroup: string | null = null;
                        for (const e of displayRows) {
                            const g = favorites.has(keyOf(e.model)) ? FAVORITES_GROUP : e.model.provider;
                            if (g !== lastGroup) {
                                dispItems.push({ kind: "header", provider: g, count: countByGroup.get(g) ?? 0 });
                                lastGroup = g;
                            }
                            dispItems.push({ kind: "entry", e, flat: flat++ });
                        }
                        const totalRows = dispItems.length;

                        // Column widths from visible entries. This flattening of
                        // dispItems is exactly the display order (cost-grouped), so
                        // state.selected indexes it for navigation and the detail pane.
                        const shownEntries: PickerEntry[] = [];
                        for (const d of dispItems) if (d.kind === "entry") shownEntries.push(d.e);

                        const selModel = shownEntries[state.selected]?.model;
                        // Locate the ▸ by model identity: dispItems entries mirror
                        // the display order, and state.selected indexes it, so find
                        // the entry whose model matches the selection.
                        const selRow = selModel
                            ? dispItems.findIndex((d) => d.kind === "entry" && isSameModel(d.e.model, selModel))
                            : -1;
                        const start = Math.max(0, Math.min(selRow < 0 ? 0 : selRow - Math.floor(MAX_VIS / 2), Math.max(0, totalRows - MAX_VIS)));
                        const end = Math.min(start + MAX_VIS, totalRows);

                        const ctxW = Math.max(6, ...shownEntries.map((e) => visibleWidth(fmtCtx(e.model.contextWindow))));
                        const costW = Math.max(
                            5,
                            ...shownEntries.map((e) =>
                                Math.max(visibleWidth(fmtCost(e.model.cost.input)), visibleWidth(fmtCost(e.model.cost.output))),
                            ),
                        );
                        // Blended per-token cost column (12:1). Free models get "Free".
                        const blendW = Math.max(
                            5,
                            ...shownEntries.map((e) => visibleWidth(isFree(e.model) ? "Free" : `~${fmtCost(blendedCost(e.model))}`)),
                        );
                        const thinkW = Math.max(6, ...shownEntries.map((e) => visibleWidth(LEVEL_ABBREV[effectiveThinking(keyOf(e.model), e)])));
                        const scoreW = showScores
                            ? Math.max(4, ...shownEntries.map((e) => visibleWidth(lbCellText(e))))
                            : 0;
                        const nameW = Math.max(10, Math.min(30, listW - ctxW - 2 * costW - blendW - (showScores ? scoreW + 2 : 0) - thinkW - 12));

                        for (let d = start; d < end; d++) {
                            const item = dispItems[d];
                            if (item.kind === "header") {
                                const isFav = item.provider === FAVORITES_GROUP;
                                const col = isFav ? "warning" : providerColor(item.provider);
                                const label = isFav
                                    ? "\u2605 Favorites"
                                    : providerNames.get(item.provider) || item.provider;
                                const head = `${theme.fg("dim", "──")} ${theme.fg(col, theme.bold(label))} ${theme.fg("dim", `· ${item.count}`)}`;
                                listLines.push(padRight(truncateToWidth(" " + head, listW, ""), listW));
                                continue;
                            }
                            const isSelected = d === selRow;
                            listLines.push(
                                renderRow(item.e, isSelected, isSameModel(item.e.model, current), nameW, ctxW, costW, blendW, scoreW, thinkW, theme),
                            );
                        }

                        // Scroll indicator (right-aligned inside list pane)
                        if (start > 0 || end < totalRows) {
                            const pct = theme.fg("muted", `${state.selected + 1}/${shownEntries.length}`);
                            listLines.push(padRight(" ".repeat(Math.max(0, listW - visibleWidth(pct))) + pct, listW));
                        }

                        // Detail-pane content: bars scale to the current scope.
                        const detailLines: string[] =
                            twoPane && shownEntries[state.selected] ? renderDetail(shownEntries[state.selected], theme, barStats(currentList())) : [];

                        // Compose the two panes side by side (or single pane).
                        const maxBody = Math.max(listLines.length, detailLines.length);
                        const body: string[] = [];
                        for (let i = 0; i < maxBody; i++) {
                            // Clamp each pane's line to its own width before
                            // composing; a long row must never push the combined
                            // line past the terminal width.
                            const left = truncateToWidth(padRight(listLines[i] ?? "", listW), listW, "");
                            if (twoPane) {
                                const right = padRight(detailLines[i] ?? "", DETAIL_W);
                                body.push(left + B(" │ ") + right);
                            } else {
                                body.push(left);
                            }
                        }

                        // Single-pane: rich detail footer for the focused model.
                        if (!twoPane && shownEntries[state.selected]) {
                            body.push("");
                            body.push(renderSingleFooter(shownEntries[state.selected], theme, innerW));
                        }

                        // ── Footer hints ───────────────────────────────────────
                        body.push(B(" " + "─".repeat(Math.max(0, innerW - 2))));
                        const footer =
                            "↑↓ move · type filter · f favorite · ←→ thinking · s sort · r refresh" +
                            (canScope ? " · tab scope" : "") +
                            " · ⏎ select · esc cancel";
                        body.push(theme.fg("dim", truncateToWidth("  " + footer, innerW, "")));

                        return frame([...chrome, ...body], width, innerW, theme, B);
                    }

                    // ── row ───────────────────────────────────────────────────
                    function renderRow(
                        e: PickerEntry,
                        isSelected: boolean,
                        isCurrent: boolean,
                        nameW: number,
                        ctxW: number,
                        costW: number,
                        blendW: number,
                        scoreW: number,
                        thinkW: number,
                        theme: any,
                    ): string {
                        const m = e.model;
                        const key = keyOf(m);
                        const thinkLevel = effectiveThinking(key, e);
                        const hasPending = pendingThinking.has(key);
                        const isFav = favorites.has(key);

                        const indicator = isSelected ? theme.fg("accent", "▸") : " ";
                        const marker = isCurrent ? theme.fg("accent", "● ") : (isFav ? theme.fg("warning", "★ ") : "  ");

                        // Name column only – provider lives in the group header.
                        // Model capabilities (vision/video/reasoning) are shown in
                        // the detail card, not as icons next to the name.
                        const rawName = displayName(m);
                        const nameTxt = truncateToWidth(rawName, Math.max(1, nameW), "…");
                        const namePart = isSelected
                            ? theme.fg("accent", theme.bold(highlightMatch(nameTxt, state.filter, theme)))
                            : theme.fg("text", highlightMatch(nameTxt, state.filter, theme));
                        const nameCol = padRight(namePart, nameW);

                        const thinkStyle = hasPending
                            ? theme.fg(THINK_COLOR[thinkLevel], theme.bold(LEVEL_ABBREV[thinkLevel]))
                            : theme.fg(THINK_COLOR[thinkLevel], LEVEL_ABBREV[thinkLevel]);

                        // Cost cells: in/out pair, then blended (12:1). Free models
                        // collapse to a single "Free".
                        const free = isFree(m);
                        let costCell: string;
                        let blendCell: string;
                        if (free) {
                            costCell = padLeft(theme.fg("success", "Free"), 2 * costW + 1);
                            blendCell = padRight("", blendW);
                        } else {
                            costCell =
                                padLeft(theme.fg("muted", fmtCost(m.cost.input)), costW) +
                                "/" +
                                padLeft(theme.fg("muted", fmtCost(m.cost.output)), costW);
                            blendCell = padLeft(theme.fg("dim", `~${fmtCost(blendedCost(m))}`), blendW);
                        }

                        // Score cell: overall(coding). Both numbers carry the
                        // 5-band heat signal; overall is bold and first so it
                        // keeps primacy. Unmatched models get a dim dash so the
                        // column stays aligned.
                        let scoreCell = "";
                        if (scoreW > 0) {
                            const sc = lbScores.get(key);
                            if (!sc) {
                                scoreCell = padLeft(theme.fg("dim", "–"), scoreW);
                            } else {
                                const cd = lbCodingScore(sc);
                                scoreCell = padLeft(
                                    lbFg(theme, lbHeat(sc.overall), theme.bold(sc.overall.toFixed(1))) +
                                        lbFg(theme, cd === null ? "dim" : lbHeat(cd), cd === null ? "–" : `(${cd.toFixed(1)})`),
                                    scoreW,
                                );
                            }
                        }

                        // Budget is exact: 1 lead + 1 indicator + 2 marker + name + 1 +
                        // ctx + 1 + in + "/" + out + 1 + blend + 2 + [score + 1 +] think.
                        const row =
                            ` ${indicator}${marker}` +
                            nameCol +
                            " " +
                            padLeft(theme.fg("muted", fmtCtx(m.contextWindow)), ctxW) +
                            " " +
                            costCell +
                            " " +
                            blendCell +
                            (scoreW > 0 ? "  " + scoreCell : "") +
                            " " +
                            padLeft(thinkStyle, thinkW);
                        // Selection glow: tint the whole focused row.
                        return isSelected ? theme.bg("selectedBg", row) : row;
                    }

                    // ── detail card (two-pane) ────────────────────────────────
                    // ── detail pane ──────────────────────────────────────────
                    function renderDetail(
                        e: PickerEntry,
                        theme: any,
                        stats: ReturnType<typeof barStats>,
                    ): string[] {
                        const m = e.model;
                        const key = keyOf(m);
                        const out: string[] = [];
                        const W = DETAIL_W - 2;

                        out.push(theme.fg("accent", theme.bold(truncateToWidth(displayName(m), W, ""))));
                        out.push(theme.fg("muted", truncateToWidth(`${m.id} · ${providerNames.get(m.provider) || m.provider}`, W, "")));
                        out.push("");

                        // Context bar
                        out.push(theme.fg("dim", "  context"));
                        // Any nonzero context gets at least 1 filled segment so small
                        // windows stay visible against a big scope max (e.g. 1M ctx).
                        const ctxVal = m.contextWindow || 0;
                        const ctxFilled = ctxVal > 0 ? Math.max(1, Math.min(12, Math.round((ctxVal / stats.maxCtx) * 12))) : 0;
                        out.push(
                            `   ${theme.fg("accent", "█".repeat(ctxFilled))}${theme.fg("dim", "░".repeat(12 - ctxFilled))}` +
                                `  ${padRight(theme.fg("text", fmtCtx(m.contextWindow)), 6)}`,
                        );
                        out.push("");

                        // Cost bars
                        out.push(theme.fg("dim", "  cost / 1M tokens · blended 12:1"));
                        const costRows: Array<[string, number, number]> = [
                            ["input", m.cost.input, stats.maxIn],
                            ["output", m.cost.output, stats.maxOut],
                            ["blended", blendedCost(m), stats.maxBlend],
                            ["cache read", m.cost.cacheRead, stats.maxRead],
                            ["cache write", m.cost.cacheWrite, stats.maxWrite],
                        ];
                        const detailFree = isFree(m);
                        for (const [label, val, base] of costRows) {
                            const ratio = val / Math.max(0.01, base);
                            // Any nonzero cost gets at least 1 filled segment, so cheap
                            // models (tiny fractions of the scope max) always show a bar.
                            const filled = val > 0 ? Math.max(1, Math.min(10, Math.round(ratio * 10))) : 0;
                            const bar = val > 0
                                ? `${theme.fg(heatColor(ratio), "█".repeat(filled))}${theme.fg("dim", "░".repeat(10 - filled))}`
                                : theme.fg(detailFree ? "success" : "dim", "░".repeat(10));
                            const valueStr = detailFree ? theme.fg("success", "Free") : theme.fg("muted", fmtCost(val));
                            out.push(
                                `   ${padRight(theme.fg("muted", label), 12)} ${padLeft(valueStr, 9)}  ${bar}`,
                            );
                        }
                        out.push("");

                        // LiveBench section: full breakdown when the terminal is
                        // tall enough, a one-line summary otherwise. The cost
                        // block above already ends with a blank line, so this
                        // section starts flush against it.
                        const sc = lbScores.get(key);
                        if (sc && lbCache) {
                            const roomy = ttyRows === 0 || ttyRows >= LB_DETAIL_MIN_ROWS;
                            if (roomy) {
                                const head = `livebench · ${lbStamp(lbCache)}`;
                                const rankStr = sc.rank !== null ? `#${sc.rank} / ${lbCache.order.length}` : "";
                                out.push(
                                    `   ${theme.fg("dim", head)}` +
                                        (rankStr
                                            ? padLeft(theme.fg("accent", rankStr), Math.max(0, W - 3 - visibleWidth(head)))
                                            : ""),
                                );
                                const keyBars: Array<[string, number | null]> = [
                                    ["overall", sc.overall],
                                    ["coding", lbCodingScore(sc)],
                                    ["reasoning", lbCatScore(sc.cats, /reason/i)],
                                ];
                                for (const [label, v] of keyBars) {
                                    if (v === null) continue;
                                    const filled = Math.max(
                                        1,
                                        Math.min(LB_BAR_SEGMENTS, Math.round(((v - LB_BAR_FLOOR) / (100 - LB_BAR_FLOOR)) * LB_BAR_SEGMENTS)),
                                    );
                                    out.push(
                                        `   ${padRight(theme.fg("muted", label), 12)} ${padLeft(lbFg(theme, lbHeat(v), v.toFixed(1)), 6)}  ` +
                                            `${lbFg(theme, lbHeat(v), "█".repeat(filled))}${theme.fg("dim", "░".repeat(LB_BAR_SEGMENTS - filled))}`,
                                    );
                                }
                                const rest = Object.entries(sc.cats)
                                    .filter(([cat]) => !/^coding/i.test(cat) && !/reason/i.test(cat))
                                    .map(([cat, v]) => `${lbShortCat(cat)} ${Math.round(v)}`);
                                if (rest.length > 0) {
                                    out.push(`   ${theme.fg("dim", truncateToWidth(rest.join(" · "), Math.max(8, W - 3), ""))}`);
                                }
                                // Tested level, phrased in the picker's own
                                // thinking vocabulary and nothing else on the
                                // line. Skipped entirely when the benchmark row
                                // does not specify an effort level.
                                if (sc.effort) {
                                    out.push(`   ${theme.fg("accent", truncateToWidth(`thinking: ${sc.effort}`, Math.max(8, W - 3), ""))}`);
                                }
                                out.push("");
                            } else {
                                const cd = lbCodingScore(sc);
                                const bits = [
                                    `Benchmarks ${sc.overall.toFixed(1)}(${cd === null ? "–" : cd.toFixed(1)})`,
                                    sc.rank === null ? null : `#${sc.rank}/${lbCache.order.length}`,
                                ].filter((s) => s !== null);
                                out.push(`   ${theme.fg("dim", truncateToWidth(bits.join(" · "), Math.max(8, W - 3), ""))}`);
                                out.push("");
                            }
                        }

                        // Thinking selector
                        out.push(theme.fg("dim", "  thinking"));
                        const thinkLevel = effectiveThinking(key, e);
                        const badges = e.supported.map((lvl) => {
                            const txt = LEVEL_ABBREV[lvl];
                            return lvl === thinkLevel
                                ? theme.fg(THINK_COLOR[lvl], theme.bold(`▸${txt}`))
                                : theme.fg(THINK_COLOR[lvl], ` ${txt}`);
                        });
                        out.push(`   ${badges.join(" ")}`);
                        out.push("");

                        // Capabilities (bottom, flat): text ✓ · vision ✓ · video — · thinking ✓
                        out.push(theme.fg("dim", "  capabilities"));
                        const caps = capabilities(m);
                        out.push(
                            "   " +
                                caps
                                    .map(([label, on]) =>
                                        on ? theme.fg("success", `${label} ✓`) : theme.fg("muted", `${label} —`),
                                    )
                                    .join(theme.fg("dim", " · ")),
                        );

                        return out.map((l) => truncateToWidth(l, W, ""));
                    }

                    // ── single-pane detail footer ─────────────────────────────
                    function renderSingleFooter(e: PickerEntry, theme: any, w: number): string {
                        const m = e.model;
                        const key = keyOf(m);
                        const thinkLevel = effectiveThinking(key, e);
                        const thinkList = e.supported.map((l) => LEVEL_ABBREV[l] ?? l).join(" · ");
                        const costs = isFree(m)
                            ? theme.fg("success", "Free")
                            : `${theme.fg("muted", ` · ${fmtCtx(m.contextWindow)} ctx · in ${fmtCost(m.cost.input)}/M · out ${fmtCost(m.cost.output)}/M`)}` +
                                  `${theme.fg("dim", ` · blend ${fmtCost(blendedCost(m))}/M`)}`;
                        const sc = lbScores.get(key);
                        let lbStr = "";
                        if (sc) {
                            const cd = lbCodingScore(sc);
                            const cdStr = cd === null ? "–" : cd.toFixed(1);
                            const rankStr = sc.rank === null ? "" : ` · #${sc.rank}/${lbCache?.order.length ?? 0}`;
                            lbStr = theme.fg("dim", ` · Benchmarks ${sc.overall.toFixed(1)}(${cdStr})${rankStr}`);
                        }
                        return truncateToWidth(
                            `${theme.fg("accent", theme.bold(displayName(m)))}` +
                                `${theme.fg("muted", ` ${m.id}`)}` +
                                costs +
                                lbStr +
                                `${theme.fg("dim", "  think:")} ${theme.fg(THINK_COLOR[thinkLevel], thinkList)}`,
                            w,
                            "…",
                        );
                    }

                    // ── frame ─────────────────────────────────────────────────
                    function frame(content: string[], width: number, innerW: number, theme: any, B: (s: string) => string): string[] {
                        const border = B("─".repeat(Math.max(0, width - 2)));
                        const framed: string[] = [B("╭") + border + B("╮")];
                        for (const line of content) {
                            // Final safety net: the TUI aborts on any rendered
                            // line wider than the terminal, so clamp here too.
                            const fitLine = truncateToWidth(line, innerW, "");
                            const lineW = visibleWidth(fitLine);
                            const pad = Math.max(0, innerW - lineW);
                            framed.push(B("│ ") + fitLine + " ".repeat(pad) + B(" │"));
                        }
                        framed.push(B("╰") + border + B("╯"));
                        return framed;
                    }

                    // ── input handling ────────────────────────────────────────
                    return {
                        render,
                        invalidate: () => {},
                        handleInput(data: string): boolean {
                            const kb = getKeybindings();
                            // Navigation follows the DISPLAY order (left pane,
                            // cost-grouped), not the raw sorted rows.
                            const entries = displayEntryList();

                            // Tab: toggle scoped <-> all
                            if (canScope && (matchesKey(data, Key.tab) || kb.matches(data, "tui.input.tab"))) {
                                state.scopeIdx = state.scopeIdx === 0 ? 1 : 0;
                                useScoped = state.scopeIdx === 0;
                                state.selected = Math.max(0, displayEntryList().findIndex((e) => isSameModel(e.model, current)));
                                tui.requestRender();
                                return true;
                            }

                            // s: cycle sort. Letter shortcuts only fire with an
                            // empty filter — while typing, letters go to the box.
                            if (!state.filter && matchesKey(data, "s")) {
                                state.sort = SORT_ORDER[(SORT_ORDER.indexOf(state.sort) + 1) % SORT_ORDER.length];
                                state.selected = Math.min(state.selected, Math.max(0, displayEntryList().length - 1));
                                tui.requestRender();
                                return true;
                            }

                            // Navigation
                            if (kb.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
                                if (entries.length > 0) state.selected = (state.selected - 1 + entries.length) % entries.length;
                                tui.requestRender();
                                return true;
                            }
                            if (kb.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
                                if (entries.length > 0) state.selected = (state.selected + 1) % entries.length;
                                tui.requestRender();
                                return true;
                            }
                            if (matchesKey(data, Key.pageUp)) {
                                state.selected = Math.max(0, state.selected - 10);
                                tui.requestRender();
                                return true;
                            }
                            if (matchesKey(data, Key.pageDown)) {
                                state.selected = Math.min(entries.length - 1, state.selected + 10);
                                tui.requestRender();
                                return true;
                            }
                            if (matchesKey(data, Key.home)) {
                                if (entries.length) state.selected = 0;
                                tui.requestRender();
                                return true;
                            }
                            if (matchesKey(data, Key.end)) {
                                if (entries.length) state.selected = entries.length - 1;
                                tui.requestRender();
                                return true;
                            }

                            // Thinking cycling on the focused model
                            if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
                                const focused = entries[state.selected];
                                if (focused && focused.supported.length > 1) {
                                    const key = keyOf(focused.model);
                                    const cur = effectiveThinking(key, focused);
                                    let idx = focused.supported.indexOf(cur);
                                    if (idx < 0) idx = focused.supported.length - 1;
                                    const dir = matchesKey(data, Key.left) ? -1 : 1;
                                    const next = focused.supported[(idx + dir + focused.supported.length) % focused.supported.length];
                                    pendingThinking.set(key, next);
                                    tui.requestRender();
                                }
                                return true;
                            }

                            // Toggle favorite on the focused model (persisted).
                            // Gated on an empty filter, same as the sort key.
                            if (!state.filter && matchesKey(data, "f")) {
                                const focused = entries[state.selected];
                                if (focused) {
                                    const fk = keyOf(focused.model);
                                    if (favorites.has(fk)) {
                                        favorites.delete(fk);
                                    } else {
                                        favorites.add(fk);
                                    }
                                    void savePickerState(favorites, remembered);
                                    tui.requestRender();
                                }
                                return true;
                            }

                            // Manual LiveBench refresh. Runs in the background;
                            // the header badge shows ⟳ while it is in flight.
                            // Gated on an empty filter like f/s.
                            if (!state.filter && matchesKey(data, "r")) {
                                lbRefreshing = true;
                                tui.requestRender();
                                void lbRefresh({ cacheFile: LB_CACHE_FILE, force: true }).then(async (result) => {
                                    lbRefreshing = false;
                                    if (result.ok && !result.skipped) {
                                        lbCache = await lbLoadCache(LB_CACHE_FILE);
                                        rebuildLbScores();
                                        state.selected = Math.min(state.selected, Math.max(0, displayEntryList().length - 1));
                                        ctx.ui.notify(`Benchmarks: release ${result.release} · ${result.models} models · ${result.tasks} tasks`, "info");
                                    } else if (!result.ok) {
                                        ctx.ui.notify(`Benchmarks refresh failed: ${result.error ?? "unknown error"}`, "error");
                                    }
                                    tui.requestRender();
                                });
                                return true;
                            }

                            // Confirm
                            if (kb.matches(data, "tui.select.confirm")) {
                                const focused = entries[state.selected];
                                if (focused) {
                                    const key = keyOf(focused.model);
                                    done({
                                        model: focused.model,
                                        thinking: pendingThinking.get(key) ?? effectiveThinking(key, focused),
                                    });
                                }
                                return true;
                            }

                            // Cancel: Esc with a live filter clears it first
                            // (keeps your place); a second Esc dismisses.
                            if (kb.matches(data, "tui.select.cancel")) {
                                if (state.filter) {
                                    state.filter = "";
                                    state.selected = Math.max(0, displayEntryList().findIndex((e) => isSameModel(e.model, current)));
                                    tui.requestRender();
                                    return true;
                                }
                                done(null);
                                return true;
                            }

                            // Clear filter
                            if (matchesKey(data, "ctrl+u")) {
                                state.filter = "";
                                state.selected = Math.max(0, displayEntryList().findIndex((e) => isSameModel(e.model, current)));
                                tui.requestRender();
                                return true;
                            }

                            // Backspace
                            if (matchesKey(data, Key.backspace)) {
                                state.filter = state.filter.slice(0, -1);
                                state.selected = Math.max(0, Math.min(state.selected, Math.max(0, displayEntryList().length - 1)));
                                tui.requestRender();
                                return true;
                            }

                            // Printable char → filter
                            const ch = data.length === 1 ? data : decodeKittyPrintable(data);
                            if (ch && ch.length === 1 && /[\u0020-\u007e]/.test(ch)) {
                                state.filter += ch;
                                state.selected = 0;
                                tui.requestRender();
                                return true;
                            }

                            return false;
                        },
                    };
                },
            );

            if (picked) {
                const ok = await pi.setModel(picked.model);
                if (!ok) {
                    ctx.ui.notify(`No API key available for ${picked.model.id}`, "error");
                    return;
                }
                // Applied even for "off" so the stored per-model level and the
                // live session level can't drift apart. setThinkingLevel clamps
                // to the model's supported levels.
                if (picked.thinking) {
                    pi.setThinkingLevel(picked.thinking);
                    // Remember this model's last-used thinking level (persisted
                    // in the favorites file, per model — not globally).
                    const pk = keyOf(picked.model);
                    if (remembered.get(pk) !== picked.thinking) {
                        remembered.set(pk, picked.thinking);
                        void savePickerState(favorites, remembered);
                    }
                }
                ctx.ui.notify(`Model: ${picked.model.name || picked.model.id} (${picked.model.provider})`, "info");
            }
    }

    pi.registerCommand("models", {
        description: "Model switcher: grouped, sortable, with cost/context/thinking detail",
        handler: async (_args, ctx) => {
            await openModelPicker(ctx);
        },
    });

    // Open the picker from a key chord. Uses ctrl+shift+l, which no built-in
    // binding claims. It relies on the terminal reporting shifted control
    // chords distinctly (kitty keyboard protocol); iTerm2 supports this.
    pi.registerShortcut(Key.ctrlShift("l"), {
        description: "Open model picker (/models)",
        handler: (ctx) => openModelPicker(ctx),
    });

    // Warm the LiveBench cache in the background at session start (TTL-gated,
    // silent on failure: the picker reads whatever cache is on disk). The
    // picker itself never touches the network except for the manual refresh
    // key, and this handler never blocks startup.
    pi.on("session_start", () => {
        void lbRefresh({ cacheFile: LB_CACHE_FILE }).catch(() => {});
    });
}