const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HISTORY_KEY = 'aimlab.history.v1';
const HISTORY_LIMIT = 50;
const TRAINING_MARGIN_ROWS = 2;
const TRAINING_MARGIN_COLUMNS = 2;
const PRESETS = {
    easy: { height: 3, width: 5, timeoutMs: 2000, speed: 2 },
    medium: { height: 2, width: 4, timeoutMs: 1200, speed: 4 },
    hard: { height: 1, width: 2, timeoutMs: 800, speed: 6 },
    extreme: { height: 1, width: 1, timeoutMs: 800, speed: 8 }
};

const RANGE_LEVELS = {
    narrow: { label: 'Narrow', percent: 40 },
    medium: { label: 'Medium', percent: 60 },
    wide: { label: 'Wide', percent: 80 },
    full: { label: 'Full', percent: 100 }
};

const DIFFICULTY_LABELS = {
    easy: 'Easy',
    medium: 'Medium',
    hard: 'Hard',
    extreme: 'Extreme',
    custom: 'Custom'
};

const TRACKING_MOTIONS = {
    smooth: { label: 'Smooth' },
    sharp: { label: 'Sharp Turns' }
};

let activeSession = null;
let activeSidebar = null;
let lastTrainableUri = null;

const NON_TRAINABLE_SCHEMES = new Set([
    'output', 'debug', 'search', 'comment', 'terminal', 'vscode-scm', 'vscode-settings'
]);

function isTrainableEditor(editor) {
    if (!editor || !editor.document || !editor.document.uri) {
        return false;
    }
    const scheme = editor.document.uri.scheme;
    return Boolean(scheme) && !NON_TRAINABLE_SCHEMES.has(scheme);
}

function numberInRange(value, fallback, min, max) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function normalizeDifficulty(value) {
    if (value === 'standard') {
        return 'medium';
    }
    if (value === 'veryHard') {
        return 'extreme';
    }
    return value === 'easy' || value === 'medium' || value === 'hard' || value === 'extreme' || value === 'custom'
        ? value
        : 'medium';
}

function normalizeRange(value) {
    return RANGE_LEVELS[value] ? value : 'medium';
}

function normalizeMotion(value) {
    return TRACKING_MOTIONS[value] ? value : 'smooth';
}

function getTrainingConfig() {
    const settings = vscode.workspace.getConfiguration('aimlab');
    const difficulty = normalizeDifficulty(settings.get('difficulty', settings.get('preset', 'medium')));
    const custom = settings.get('custom', {}) || {};
    const rawMode = settings.get('mode', 'count');
    const mode = rawMode === 'tracking' || rawMode === 'timed' ? rawMode : 'count';
    const basePreset = PRESETS.medium;
    const preset = difficulty === 'custom' ? basePreset : PRESETS[difficulty];
    const range = normalizeRange(settings.get('range', 'medium'));
    const value = (key, fallback) => difficulty === 'custom' && custom[key] !== undefined
        ? custom[key]
        : fallback;

    return {
        mode,
        difficulty,
        range,
        rangePercent: RANGE_LEVELS[range].percent,
        motion: normalizeMotion(settings.get('trackingMotion', 'smooth')),
        testCount: numberInRange(settings.get('testCount'), 20, 1, 1000),
        durationMs: numberInRange(settings.get('durationSeconds'), 30, 5, 3600) * 1000,
        height: numberInRange(value('height', preset.height), preset.height, 1, 10),
        width: numberInRange(
            difficulty === 'custom' && (custom.width !== undefined || custom.targetWidth !== undefined)
                ? custom.width ?? custom.targetWidth
                : preset.width,
            preset.width,
            1,
            20
        ),
        timeoutMs: numberInRange(value('timeoutMs', preset.timeoutMs), preset.timeoutMs, 100, 60000),
        speed: numberInRange(value('speed', preset.speed), preset.speed, 1, 10),
        intervalMs: numberInRange(settings.get('intervalMs'), 100, 0, 10000)
    };
}

function configKey(config) {
    return JSON.stringify(config);
}



function median(values) {
    if (!values.length) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calculateMetrics(session) {
    const times = session.reactionTimes;
    const average = times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : null;
    const trackingElapsedMs = session.trackingElapsedMs || 0;
    const onTargetMs = session.trackingOnTargetMs || 0;
    const trackingAccuracy = trackingElapsedMs > 0 ? onTargetMs / trackingElapsedMs * 100 : 0;
    const isTracking = session.config.mode === 'tracking';
    const fastestMs = isTracking || !times.length ? null : Math.min(...times);
    const slowestMs = isTracking || !times.length ? null : Math.max(...times);
    const totalMs = isTracking || !session.startedAt
        ? null
        : Math.max(0, (session.finishedAt || Date.now()) - session.startedAt);
    return {
        mode: session.config.mode,
        targets: session.spawnedCount,
        hits: session.hits,
        misses: session.misses,
        timeouts: session.timeouts,
        shots: session.shots,
        hitRate: session.config.mode === 'tracking'
            ? trackingAccuracy
            : (session.spawnedCount ? session.hits / session.spawnedCount * 100 : 0),
        accuracy: session.config.mode === 'tracking'
            ? trackingAccuracy
            : (session.shots ? session.hits / session.shots * 100 : 0),
        averageMs: session.config.mode === 'tracking' ? null : average,
        medianMs: isTracking ? null : median(times),
        fastestMs,
        slowestMs,
        totalMs,
        trackingAccuracy,
        onTargetMs,
        trackingElapsedMs
    };
}

function isBetter(record, other) {
    if (!other) {
        return true;
    }
    if (record.config.mode === 'tracking') {
        const accuracy = record.metrics.trackingAccuracy ?? 0;
        const otherAccuracy = other.metrics.trackingAccuracy ?? 0;
        if (accuracy !== otherAccuracy) {
            return accuracy > otherAccuracy;
        }
        return (record.metrics.onTargetMs ?? 0) > (other.metrics.onTargetMs ?? 0);
    }
    if (record.config.mode === 'count') {
        if (record.metrics.hitRate !== other.metrics.hitRate) {
            return record.metrics.hitRate > other.metrics.hitRate;
        }
        return (record.metrics.medianMs ?? Infinity) < (other.metrics.medianMs ?? Infinity);
    }
    if (record.metrics.hits !== other.metrics.hits) {
        return record.metrics.hits > other.metrics.hits;
    }
    return record.metrics.accuracy > other.metrics.accuracy;
}

function formatMs(value) {
    return value === null || value === undefined ? 'N/A' : `${Number(value).toFixed(0)} ms`;
}

function formatSeconds(value) {
    return value === null || value === undefined ? 'N/A' : `${(Number(value) / 1000).toFixed(1)} s`;
}

// Legacy records have no `shots`; fall back to the target count.
function clickShots(metrics) {
    return Number.isFinite(metrics.shots) ? metrics.shots : metrics.targets;
}

function clickScore(metrics) {
    return `${metrics.hits}/${clickShots(metrics)} clicks`;
}

function getTrainingWebviewHtml(nonce, highlightSource, gutterDigits) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        user-select: none;
        -webkit-user-select: none;
    }
    #stage {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        cursor: default;
        touch-action: none;
    }
    #scroller {
        position: absolute;
        inset: 0;
        overflow-y: scroll;
        overflow-x: hidden;
        scrollbar-gutter: stable;
        scrollbar-width: thin;
        scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4)) transparent;
        overscroll-behavior: contain;
        scroll-behavior: auto;
    }
    #scroller::-webkit-scrollbar {
        width: 10px;
    }
    #scroller::-webkit-scrollbar-thumb {
        background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
    }
    #scroller::-webkit-scrollbar-track {
        background: transparent;
    }
    #content {
        position: relative;
        display: flex;
        align-items: flex-start;
        min-height: 100%;
    }
    #gutter {
        flex: 0 0 auto;
        margin: 0;
        padding: 0 6px 0 0;
        box-sizing: border-box;
        text-align: right;
        white-space: pre;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 14px);
        line-height: 1.5;
        font-variant-numeric: tabular-nums;
        color: var(--vscode-editorLineNumber-foreground, #858585);
        opacity: 0.72;
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
    }
    #code {
        flex: 1 1 auto;
        min-width: 0;
        margin: 0;
        padding: 0;
        overflow: hidden;
        white-space: pre;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 14px);
        line-height: 1.5;
        font-variant-ligatures: none;
        letter-spacing: 0;
        tab-size: 4;
        color: var(--vscode-editor-foreground);
        opacity: 0.78;
        filter: saturate(0.72) brightness(1.15);
    }
    .hljs-comment, .hljs-quote {
        color: var(--vscode-symbolIcon-commentForeground, #6a9955);
        font-style: italic;
    }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag {
        color: var(--vscode-symbolIcon-keywordForeground, #569cd6);
    }
    .hljs-string, .hljs-regexp, .hljs-template-tag {
        color: var(--vscode-symbolIcon-stringForeground, #ce9178);
    }
    .hljs-number, .hljs-symbol, .hljs-bullet {
        color: var(--vscode-symbolIcon-numberForeground, #b5cea8);
    }
    .hljs-title.function_, .hljs-function .hljs-title, .hljs-built_in {
        color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
    }
    .hljs-title.class_, .hljs-type, .hljs-class .hljs-title {
        color: var(--vscode-symbolIcon-classForeground, #4ec9b0);
    }
    .hljs-variable, .hljs-template-variable, .hljs-params {
        color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
    }
    .hljs-attr, .hljs-property, .hljs-attribute {
        color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe);
    }
    .hljs-meta, .hljs-selector-class, .hljs-selector-id {
        color: var(--vscode-symbolIcon-keywordForeground, #c586c0);
    }
    .target {
        position: absolute;
        display: none;
        z-index: 2;
        box-sizing: border-box;
        pointer-events: none;
        background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.35));
        border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
        border-radius: 2px;
    }
    .target.hit {
        background: rgba(0, 180, 90, 0.55);
        border-color: rgba(0, 140, 70, 0.9);
    }
    .target.miss {
        background: rgba(230, 70, 70, 0.5);
        border-color: rgba(200, 40, 40, 0.9);
    }
    .target.tracking {
        background: rgba(90, 160, 255, 0.3);
        border-color: rgba(130, 190, 255, 0.9);
    }
    .target.tracking.on-target {
        background: rgba(0, 190, 110, 0.42);
        border-color: rgba(0, 210, 120, 0.95);
    }
    #paused {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 8px;
        background: rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(2px);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family, sans-serif);
        z-index: 3;
    }
    body.paused #paused { display: flex; }
    #paused-title { font-size: 28px; font-weight: 600; }
    #paused-hint { font-size: 14px; opacity: 0.8; }
</style>
</head>
<body>
<div id="stage">
    <div id="scroller">
        <div id="content">
            <pre id="gutter" aria-hidden="true"></pre>
            <pre id="code" aria-hidden="true"></pre>
            <div id="target" class="target"></div>
        </div>
    </div>
    <div id="paused">
        <div id="paused-title">Paused</div>
        <div id="paused-hint">Run Aimlab: Resume to continue</div>
    </div>
</div>
<script nonce="${nonce}">
${highlightSource}
</script>
<script nonce="${nonce}">
(function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    const scroller = document.getElementById('scroller');
    const content = document.getElementById('content');
    const gutter = document.getElementById('gutter');
    const code = document.getElementById('code');
    const target = document.getElementById('target');
    const gutterDigits = ${gutterDigits};
    const marginRows = ${TRAINING_MARGIN_ROWS};
    const marginColumns = ${TRAINING_MARGIN_COLUMNS};
    let cols = 0;
    let rows = 0;
    let cellWidth = 0;
    let cellHeight = 0;
    let gutterWidth = 0;
    let hasLayout = false;
    let initialScrollApplied = false;
    let tracking = null;
    let staticTarget = null;
    let pointer = { x: -1, y: -1, active: false };
    let lastFrame = performance.now();
    let scrollerBox = { left: 0, top: 0 };
    let targetAnchorScrollTop = 0;
    let lastTrackingScrollTop = 0;
    let scrollReportTimer = null;
    let sourceLines = [];
    let lineOffsets = [];
    let textNodes = [];
    let lastGlyphNode = null;
    let lastGlyphStart = 0;
    let contentBox = { left: 0, top: 0 };
    let contentLeft = 0;
    let contentBaseTop = 0;
    const edgeCache = new Map();

    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(100);
    probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre;';
    document.body.appendChild(probe);

    function refreshScrollerBox() {
        const rect = scroller.getBoundingClientRect();
        scrollerBox = { left: rect.left, top: rect.top };
    }

    // Targets live in the scrolling content layer. Use plain left/top so the
    // highlight is painted in the same layer as the glyphs; a GPU composited
    // transform snaps to a different subpixel grid and drifts off the text.
    function setTargetRect(left, top, width, height) {
        target.style.transform = '';
        target.style.left = left + 'px';
        target.style.top = top + 'px';
        target.style.width = width + 'px';
        target.style.height = height + 'px';
        target.style.display = 'block';
    }

    // Report pointer cells in the same viewport grid used when the target
    // was spawned, so a fallback range check stays valid after scrolling.
    function pointerGrid(event) {
        return {
            line: (event.clientY - scrollerBox.top
                + scroller.scrollTop - targetAnchorScrollTop) / cellHeight,
            character: (event.clientX - scrollerBox.left - gutterWidth) / cellWidth
        };
    }

    function targetOffscreen() {
        if (target.style.display === 'none') {
            return 'none';
        }
        const box = target.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        if (box.bottom <= view.top) {
            return 'above';
        }
        if (box.top >= view.bottom) {
            return 'below';
        }
        return 'none';
    }

    function measureLayout() {
        const style = getComputedStyle(code);
        probe.style.fontFamily = style.fontFamily;
        probe.style.fontSize = style.fontSize;
        probe.style.fontWeight = style.fontWeight;
        const width = Math.max(1, probe.getBoundingClientRect().width / 100);
        const height = Math.max(1, parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5);
        const nextGutterWidth = gutterDigits * width + 12;
        return {
            cols: Math.min(1000, Math.max(1, Math.floor((scroller.clientWidth - nextGutterWidth) / width))),
            rows: Math.min(500, Math.max(1, Math.floor(scroller.clientHeight / height))),
            cellWidth: width,
            cellHeight: height,
            gutterWidth: nextGutterWidth
        };
    }

    function publishLayout() {
        refreshScrollerBox();
        const layout = measureLayout();
        const changed = layout.cols !== cols || layout.rows !== rows
            || Math.abs(layout.cellWidth - cellWidth) > 0.01
            || Math.abs(layout.cellHeight - cellHeight) > 0.01
            || Math.abs(layout.gutterWidth - gutterWidth) > 0.01;
        if (!changed) {
            return;
        }
        cols = layout.cols;
        rows = layout.rows;
        cellWidth = layout.cellWidth;
        cellHeight = layout.cellHeight;
        gutterWidth = layout.gutterWidth;
        gutter.style.width = gutterWidth + 'px';
        scroller.style.paddingTop = marginRows * cellHeight + 'px';
        scroller.style.paddingBottom = marginRows * cellHeight + 'px';
        code.style.paddingLeft = marginColumns * cellWidth + 'px';
        code.style.paddingRight = marginColumns * cellWidth + 'px';
        const box = content.getBoundingClientRect();
        contentLeft = box.left;
        contentBaseTop = box.top + scroller.scrollTop;
        edgeCache.clear();
        vscode.postMessage({
            type: hasLayout ? 'resize' : 'ready',
            cols,
            rows
        });
        hasLayout = true;
    }

    // Tabs, italic tokens, font fallback and hinting all break the naive
    // "column * cellWidth" assumption. Snap the highlight to real glyph edges
    // measured through Range, the same way a native text selection is drawn.
    function indexText(lines) {
        sourceLines = lines;
        lineOffsets = [];
        let offset = 0;
        for (const line of lines) {
            lineOffsets.push(offset);
            offset += line.length + 1; // the joining newline
        }
        textNodes = [];
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            textNodes.push(node);
        }
        lastGlyphNode = null;
        edgeCache.clear();
    }

    function rectInNode(node, local) {
        const range = document.createRange();
        range.setStart(node, local);
        range.setEnd(node, Math.min(local + 1, node.textContent.length));
        return range.getBoundingClientRect();
    }

    function glyphRectAt(absOffset) {
        if (lastGlyphNode
            && absOffset >= lastGlyphStart
            && absOffset < lastGlyphStart + lastGlyphNode.textContent.length) {
            return rectInNode(lastGlyphNode, absOffset - lastGlyphStart);
        }
        let start = 0;
        for (const node of textNodes) {
            const length = node.textContent.length;
            if (absOffset >= start && absOffset < start + length) {
                lastGlyphNode = node;
                lastGlyphStart = start;
                return rectInNode(node, absOffset - start);
            }
            start += length;
        }
        return null;
    }

    function rowEdges(fileRow) {
        if (edgeCache.has(fileRow)) {
            return edgeCache.get(fileRow);
        }
        if (fileRow < 0 || fileRow >= sourceLines.length) {
            return null;
        }
        const base = lineOffsets[fileRow];
        const length = sourceLines[fileRow].length;
        if (length > 600) {
            return null; // extreme long line: keep the linear grid fallback
        }
        const fallback = gutterWidth + marginColumns * cellWidth;
        const edges = [];
        for (let column = 0; column <= length; column++) {
            let left = fallback + column * cellWidth;
            if (column < length) {
                const box = glyphRectAt(base + column);
                if (box) {
                    left = box.left - contentBox.left;
                }
            } else if (length) {
                const last = glyphRectAt(base + length - 1);
                if (last) {
                    left = last.right - contentBox.left;
                }
            }
            edges.push(left);
        }
        if (edgeCache.size >= 12) {
            edgeCache.delete(edgeCache.keys().next().value);
        }
        edgeCache.set(fileRow, edges);
        return edges;
    }

    // Both axes come from real text metrics measured against the #content
    // box, which is exactly the containing block of the absolute target.
    // No assumption about padding, line-height or scroll offset remains.
    // The size stays fixed (width * cellWidth by height * cellHeight).
    function alignedOrigin(rawLeft, rawTop) {
        contentBox = content.getBoundingClientRect();
        let left = rawLeft;
        let top = rawTop;
        if (lineOffsets.length >= 2) {
            const first = glyphRectAt(lineOffsets[0]);
            const second = glyphRectAt(lineOffsets[1]);
            if (first && second) {
                const pitch = second.top - first.top;
                if (pitch > 0) {
                    const firstTop = first.top - contentBox.top;
                    const row = Math.max(0, Math.min(
                        sourceLines.length - 1,
                        Math.round((rawTop - firstTop) / pitch)
                    ));
                    const rowGlyph = glyphRectAt(lineOffsets[row]);
                    if (rowGlyph) {
                        top = rowGlyph.top - contentBox.top;
                    }
                    const edges = rowEdges(row);
                    if (edges && edges.length > 1) {
                        let distance = Infinity;
                        for (const edge of edges) {
                            const delta = Math.abs(edge - rawLeft);
                            if (delta < distance) {
                                distance = delta;
                                left = edge;
                            }
                        }
                    }
                }
            }
        }
        return {
            left,
            top,
            screenLeft: contentBox.left + left,
            screenTop: contentBox.top + top
        };
    }

    function placeStaticTarget(line, character, height, width) {
        targetAnchorScrollTop = scroller.scrollTop;
        lastTrackingScrollTop = targetAnchorScrollTop;
        staticTarget = {
            line,
            character,
            height,
            width,
            contentTop: targetAnchorScrollTop + line * cellHeight - marginRows * cellHeight
        };
        applyStaticTarget();
    }

    function applyStaticTarget() {
        if (!staticTarget) {
            return;
        }
        const origin = alignedOrigin(
            gutterWidth + staticTarget.character * cellWidth,
            staticTarget.contentTop
        );
        setTargetRect(
            origin.left,
            origin.top,
            staticTarget.width * cellWidth,
            staticTarget.height * cellHeight
        );
    }

    // VS Code renders tabs as fixed-width blanks. Do the same here so every
    // character occupies one grid cell and the highlight stays aligned.
    function normalizeLine(line) {
        let column = 0;
        let out = '';
        for (const character of line) {
            if (character === '\\r') {
                continue;
            }
            if (character === '\\t') {
                const spaces = 4 - (column % 4);
                out += ' '.repeat(spaces);
                column += spaces;
            } else {
                out += character;
                column += 1;
            }
        }
        return out;
    }

    function renderCode(message) {
        const normalized = message.lines.map(normalizeLine);
        const text = normalized.join('\\n');
        const aliases = {
            javascriptreact: 'javascript',
            typescriptreact: 'typescript',
            shellscript: 'bash',
            vue: 'xml',
            svelte: 'xml'
        };
        const language = aliases[message.language] || message.language;
        if (window.hljs && language && hljs.getLanguage(language)) {
            code.innerHTML = hljs.highlight(text, {
                language,
                ignoreIllegals: true
            }).value;
        } else {
            code.textContent = text;
        }
        indexText(normalized);
    }

    function renderGutter(message) {
        const lines = message.lines.map((line, index) => (
            String(message.startLine + index).padStart(gutterDigits, ' ')
        ));
        gutter.textContent = lines.join('\\n');
    }

    let resizeTimer;
    function scheduleLayout() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(publishLayout, 100);
    }

    window.addEventListener('resize', scheduleLayout);
    if (window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(scheduleLayout);
        resizeObserver.observe(document.documentElement);
        resizeObserver.observe(scroller);
    }
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(publishLayout);
    }

    scroller.addEventListener('scroll', () => {
        const current = scroller.scrollTop;
        // Tracking stays under the pointer while the code scrolls beneath it.
        if (tracking) {
            tracking.contentOrigin += current - lastTrackingScrollTop;
        }
        lastTrackingScrollTop = current;
        if (scrollReportTimer) {
            return;
        }
        scrollReportTimer = setTimeout(() => {
            scrollReportTimer = null;
            refreshScrollerBox();
            vscode.postMessage({
                type: 'viewport',
                offscreen: tracking ? 'none' : targetOffscreen(),
                scrollTop: scroller.scrollTop
            });
        }, 120);
    }, { passive: true });

    function reportTracking(final = false) {
        if (!tracking) {
            return;
        }
        vscode.postMessage({
            type: 'tracking',
            final,
            onTargetMs: Math.round(tracking.onTarget),
            elapsedMs: Math.round(tracking.elapsed)
        });
    }

    function sharpTurnDelay(speedFactor) {
        // Deliberately unhurried: ~1.4-2.6s between corners. Speed should
        // make the target run faster, not turn three times per second.
        return (1.4 + Math.random() * 1.2) / Math.max(1, speedFactor * 0.5);
    }

    function startSharpMotion(state, speedFactor) {
        const rate = 0.18 * speedFactor;
        const angle = Math.random() * Math.PI * 2;
        state.x = 0.2 + Math.random() * 0.6;
        state.y = 0.2 + Math.random() * 0.6;
        state.vx = Math.cos(angle) * rate;
        state.vy = Math.sin(angle) * rate;
        state.turnIn = sharpTurnDelay(speedFactor);
    }

    function turnSharp(state, speedFactor) {
        const rate = Math.hypot(state.vx, state.vy) || 0.18 * speedFactor;
        const angle = Math.atan2(state.vy, state.vx);
        // 60-180 degrees in either direction: a visible corner, not a curve.
        const turn = (Math.PI / 3 + Math.random() * (Math.PI * 2 / 3))
            * (Math.random() < 0.5 ? -1 : 1);
        state.vx = Math.cos(angle + turn) * rate;
        state.vy = Math.sin(angle + turn) * rate;
        state.turnIn = sharpTurnDelay(speedFactor);
    }

    function advanceSharp(state, seconds, speedFactor) {
        state.turnIn -= seconds;
        let x = state.x + state.vx * seconds;
        let y = state.y + state.vy * seconds;
        if (x < 0 || x > 1) {
            state.vx = -state.vx;
            x = Math.min(1, Math.max(0, x));
            state.turnIn = 0;
        }
        if (y < 0 || y > 1) {
            state.vy = -state.vy;
            y = Math.min(1, Math.max(0, y));
            state.turnIn = 0;
        }
        state.x = x;
        state.y = y;
        if (state.turnIn <= 0) {
            turnSharp(state, speedFactor);
        }
        return { xRatio: x, yRatio: y };
    }

    function trackingFrame(now) {
        requestAnimationFrame(trackingFrame);
        if (!tracking) {
            lastFrame = now;
            return;
        }
        const delta = Math.min(100, Math.max(0, now - lastFrame));
        lastFrame = now;
        if (!tracking.running) {
            return;
        }
        tracking.elapsed += delta;
        const seconds = tracking.elapsed / 1000;
        const speedFactor = Math.max(0.25, (tracking.speed || 4) / 4);
        let xRatio;
        let yRatio;
        if (tracking.motion === 'sharp') {
            if (!tracking.sharp) {
                tracking.sharp = { x: 0.5, y: 0.5, vx: 0, vy: 0, turnIn: 0 };
                startSharpMotion(tracking.sharp, speedFactor);
            }
            const point = advanceSharp(tracking.sharp, delta / 1000, speedFactor);
            xRatio = point.xRatio;
            yRatio = point.yRatio;
        } else {
            // A sine stalls at its peaks (derivative -> 0), so the target
            // visibly slows down exactly when it turns. An ellipse keeps a
            // near-constant speed while the slow radius drift keeps the path
            // from being a perfectly predictable circle.
            const angular = 0.34 * speedFactor;
            const angle = seconds * angular + tracking.phaseX;
            const drift = 0.05 * Math.sin(seconds * 0.09 * speedFactor + tracking.phaseY);
            xRatio = 0.5 + (0.41 + drift) * Math.cos(angle);
            yRatio = 0.5 + (0.37 + drift * 0.85) * Math.sin(angle);
        }
        const rawLeft = gutterWidth
            + (tracking.minColumn + (tracking.maxColumn - tracking.minColumn) * xRatio) * cellWidth;
        const rawTop = tracking.contentOrigin
            + (tracking.minRow + (tracking.maxRow - tracking.minRow) * yRatio) * cellHeight;
        // Tracking is a continuous animation. Never snap it to glyph cells —
        // alignedOrigin quantises to whole rows/columns and would make the
        // target jump between frames.
        const left = rawLeft;
        const top = rawTop;
        const width = tracking.width * cellWidth;
        const height = tracking.height * cellHeight;
        if (tracking.lastWidth !== width || tracking.lastHeight !== height) {
            tracking.lastWidth = width;
            tracking.lastHeight = height;
            target.style.width = width + 'px';
            target.style.height = height + 'px';
        }
        target.style.transform = '';
        target.style.left = left + 'px';
        target.style.top = top + 'px';
        target.style.display = 'block';
        // Screen position derived from the measured #content origin. The
        // vertical term tracks scrolling without any per-frame DOM read.
        const screenLeft = contentLeft + left;
        const screenTop = contentBaseTop - scroller.scrollTop + top;
        const onTarget = pointer.active
            && pointer.x >= screenLeft && pointer.x < screenLeft + width
            && pointer.y >= screenTop && pointer.y < screenTop + height;
        target.classList.toggle('on-target', onTarget);
        if (onTarget) {
            tracking.onTarget += delta;
        }
        if (tracking.elapsed - tracking.lastReport >= 150) {
            tracking.lastReport = tracking.elapsed;
            reportTracking();
        }
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'content') {
            if (message.cols !== cols || message.rows !== rows) {
                return;
            }
            renderCode(message);
            renderGutter(message);
            if (!initialScrollApplied) {
                scroller.scrollTop = Math.max(0, (message.scrollLine - 1) * cellHeight);
                initialScrollApplied = true;
            }
            target.style.display = 'none';
        } else if (message.type === 'target') {
            target.className = 'target';
            placeStaticTarget(message.line, message.character, message.height, message.width);
        } else if (message.type === 'flash') {
            const sameTarget = staticTarget
                && staticTarget.line === message.line
                && staticTarget.character === message.character
                && staticTarget.height === message.height
                && staticTarget.width === message.width;
            if (!sameTarget) {
                placeStaticTarget(message.line, message.character, message.height, message.width);
            }
            target.className = 'target ' + (message.hit ? 'hit' : 'miss');
            target.style.display = 'block';
        } else if (message.type === 'clearTarget') {
            target.style.display = 'none';
        } else if (message.type === 'trackingStart') {
            staticTarget = null;
            tracking = {
                minColumn: message.minColumn,
                maxColumn: message.maxColumn,
                minRow: message.minRow,
                maxRow: message.maxRow,
                width: message.width,
                height: message.height,
                speed: message.speed || 4,
                motion: message.motion === 'sharp' ? 'sharp' : 'smooth',
                sharp: null,
                contentOrigin: scroller.scrollTop - marginRows * cellHeight,
                phaseX: Math.random() * Math.PI * 2,
                phaseY: Math.random() * Math.PI * 2,
                elapsed: 0,
                onTarget: 0,
                lastReport: 0,
                lastWidth: 0,
                lastHeight: 0,
                running: true
            };
            lastTrackingScrollTop = scroller.scrollTop;
            lastFrame = performance.now();
            target.className = 'target tracking';
        } else if (message.type === 'trackingBounds') {
            if (tracking) {
                tracking.minColumn = message.minColumn;
                tracking.maxColumn = message.maxColumn;
                tracking.minRow = message.minRow;
                tracking.maxRow = message.maxRow;
                tracking.width = message.width;
                tracking.height = message.height;
                tracking.speed = message.speed || tracking.speed;
                if (message.motion !== undefined) {
                    const nextMotion = message.motion === 'sharp' ? 'sharp' : 'smooth';
                    if (nextMotion !== tracking.motion) {
                        tracking.motion = nextMotion;
                        tracking.sharp = null;
                    }
                }
                tracking.contentOrigin = scroller.scrollTop - marginRows * cellHeight;
                lastTrackingScrollTop = scroller.scrollTop;
            }
        } else if (message.type === 'trackingStop') {
            if (tracking) {
                tracking.running = false;
                reportTracking(true);
                tracking = null;
            } else {
                vscode.postMessage({
                    type: 'tracking',
                    final: true,
                    onTargetMs: 0,
                    elapsedMs: 0
                });
            }
            target.style.display = 'none';
        } else if (message.type === 'state') {
            const paused = message.value === 'paused';
            document.body.classList.toggle('paused', paused);
            if (tracking) {
                tracking.running = !paused && message.value !== 'finished';
                lastFrame = performance.now();
            }
        }
    });

    document.addEventListener('pointermove', event => {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.active = true;
    });
    document.addEventListener('pointerleave', () => {
        pointer.active = false;
    });
    window.addEventListener('blur', () => {
        pointer.active = false;
    });
    document.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !cols || !rows) {
            return;
        }
        const localX = event.clientX - scrollerBox.left - gutterWidth;
        if (localX < 0 || event.clientX - scrollerBox.left >= scroller.clientWidth) {
            return;
        }
        event.preventDefault();
        const targetRect = target.getBoundingClientRect();
        const insideTarget = target.style.display !== 'none'
            && event.clientX >= targetRect.left && event.clientX < targetRect.right
            && event.clientY >= targetRect.top && event.clientY < targetRect.bottom;
        const cell = pointerGrid(event);
        vscode.postMessage({
            type: 'click',
            insideTarget,
            line: Math.max(0, Math.min(rows - 1, Math.floor(cell.line))),
            character: Math.max(0, Math.min(cols - 1, Math.floor(cell.character)))
        });
    });
    document.addEventListener('contextmenu', event => event.preventDefault());
    document.addEventListener('selectstart', event => event.preventDefault());
    document.addEventListener('dblclick', event => event.preventDefault());
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            vscode.postMessage({ type: 'stop' });
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
        }
    });

    requestAnimationFrame(trackingFrame);
    publishLayout();
})();
</script>
</body>
</html>`;
}

class AimlabTrainingView {
    constructor(extensionUri, title, lineNumberDigits) {
        this.extensionUri = extensionUri;
        this.title = title || 'Aimlab Training';
        this.lineNumberDigits = Math.max(2, Number(lineNumberDigits) || 2);
        this.panel = null;
        this.cols = 0;
        this.rows = 0;
        this.visible = false;
        this.active = false;
        this.onLayout = null;
        this.onClick = null;
        this.onStop = null;
        this.onDispose = null;
        this.onVisibilityChange = null;
        this.onTracking = null;
        this.onViewport = null;
        this.trackingStopped = false;
        this.trackingStopResolver = null;
        this.readyPromise = null;
        this.resolveReady = null;
        this.rejectReady = null;
    }

    async open() {
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.panel = vscode.window.createWebviewPanel(
            'aimlab.training',
            this.title,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableFindWidget: false
            }
        );
        this.visible = this.panel.visible;
        this.active = this.panel.active;
        this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
        this.panel.onDidChangeViewState(event => {
            this.visible = event.webviewPanel.visible;
            this.active = event.webviewPanel.active;
            if (this.onVisibilityChange) {
                this.onVisibilityChange(this.visible, this.active);
            }
        });
        this.panel.onDidDispose(() => {
            this.panel = null;
            if (this.rejectReady) {
                this.rejectReady(new Error('The training view was closed.'));
                this.rejectReady = null;
            }
            if (this.onDispose) {
                this.onDispose();
            }
        });
        const nonce = crypto.randomBytes(16).toString('base64');
        const extensionPath = this.extensionUri && this.extensionUri.fsPath
            ? this.extensionUri.fsPath
            : __dirname;
        let highlightSource = '';
        try {
            highlightSource = fs.readFileSync(path.join(extensionPath, 'media', 'highlight.min.js'), 'utf8');
        } catch (error) {
            highlightSource = '';
        }
        this.panel.webview.html = getTrainingWebviewHtml(
            nonce,
            highlightSource,
            this.lineNumberDigits
        );
        await new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('The training view did not become ready.')),
                10000
            );
            this.readyPromise.then(
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                error => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
        this.resolveReady = null;
        this.rejectReady = null;
    }

    handleMessage(message) {
        if (!message || typeof message.type !== 'string') {
            return;
        }
        if (message.type === 'ready' || message.type === 'resize') {
            const cols = Math.floor(Number(message.cols));
            const rows = Math.floor(Number(message.rows));
            if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
                return;
            }
            this.cols = Math.min(1000, cols);
            this.rows = Math.min(500, rows);
            if (this.resolveReady && message.type === 'ready') {
                this.resolveReady();
            }
            if (this.onLayout) {
                this.onLayout(this.cols, this.rows);
            }
            return;
        }
        if (message.type === 'click' && this.onClick) {
            const line = Math.floor(Number(message.line));
            const character = Math.floor(Number(message.character));
            if (Number.isFinite(line) && Number.isFinite(character)) {
                this.onClick({
                    line,
                    character,
                    insideTarget: typeof message.insideTarget === 'boolean'
                        ? message.insideTarget
                        : undefined
                });
            }
            return;
        }
        if (message.type === 'tracking') {
            const onTargetMs = Math.max(0, Number(message.onTargetMs));
            const elapsedMs = Math.max(0, Number(message.elapsedMs));
            if (this.onTracking && Number.isFinite(onTargetMs) && Number.isFinite(elapsedMs)) {
                this.onTracking({
                    onTargetMs: Math.min(onTargetMs, elapsedMs),
                    elapsedMs
                });
            }
            if (message.final && this.trackingStopResolver) {
                const resolve = this.trackingStopResolver;
                this.trackingStopResolver = null;
                resolve();
            }
            return;
        }
        if (message.type === 'viewport' && this.onViewport) {
            this.onViewport({
                offscreen: message.offscreen === 'above' || message.offscreen === 'below'
                    ? message.offscreen
                    : 'none',
                scrollTop: Number(message.scrollTop) || 0
            });
            return;
        }
        if (message.type === 'stop' && this.onStop) {
            this.onStop();
        }
    }

    setContent(lines, language, lineInfo = {}) {
        if (this.panel) {
            this.panel.webview.postMessage({
                type: 'content',
                lines,
                cols: this.cols,
                rows: this.rows,
                language,
                startLine: lineInfo.startLine || 1,
                sourceLineCount: lineInfo.sourceLineCount || 0,
                scrollLine: lineInfo.scrollLine || 1
            });
        }
    }

    showTarget(range) {
        if (this.panel) {
            this.panel.webview.postMessage({
                type: 'target',
                line: range.start.line,
                character: range.start.character,
                height: range.end.line - range.start.line + 1,
                width: range.end.character - range.start.character
            });
        }
    }

    flashTarget(range, hit) {
        if (this.panel) {
            this.panel.webview.postMessage({
                type: 'flash',
                hit,
                line: range.start.line,
                character: range.start.character,
                height: range.end.line - range.start.line + 1,
                width: range.end.character - range.start.character
            });
        }
    }

    startTracking(bounds) {
        if (this.panel) {
            this.trackingStopped = false;
            this.panel.webview.postMessage({ type: 'trackingStart', ...bounds });
        }
    }

    updateTrackingBounds(bounds) {
        if (this.panel) {
            this.panel.webview.postMessage({ type: 'trackingBounds', ...bounds });
        }
    }

    stopTracking() {
        if (!this.panel || this.trackingStopped) {
            return Promise.resolve();
        }
        this.trackingStopped = true;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.trackingStopResolver = null;
                resolve();
            }, 250);
            this.trackingStopResolver = () => {
                clearTimeout(timer);
                resolve();
            };
            this.panel.webview.postMessage({ type: 'trackingStop' });
        });
    }

    clearTarget() {
        if (this.panel) {
            this.panel.webview.postMessage({ type: 'clearTarget' });
        }
    }

    setState(value) {
        if (this.panel) {
            this.panel.webview.postMessage({ type: 'state', value });
        }
    }

    isActive() {
        return Boolean(this.panel && this.panel.visible && this.panel.active);
    }

    dispose() {
        if (this.panel) {
            const panel = this.panel;
            this.panel = null;
            panel.dispose();
        }
    }
}

class AimlabSession {
    constructor(context, config, options = {}) {
        this.context = context;
        this.config = config;
        this.source = 'editor';
        this.sourceEditor = options.editor || null;
        this.state = 'created';
        this.view = null;
        this.trainingTitle = 'Aimlab Training';
        this.sourceStartLine = 1;
        this.scrollStartLine = 1;
        this.lineNumberDigits = 2;
        this.trackingOnTargetMs = 0;
        this.trackingElapsedMs = 0;
        this.viewWatchTimer = null;
        this.sourceLines = [];
        this.cols = 0;
        this.rows = 0;
        this.targetRange = null;
        this.pendingWait = null;
        this.pauseWait = null;
        this.terminalReason = 'stopped';
        this.reactionTimes = [];
        this.spawnedCount = 0;
        this.hits = 0;
        this.misses = 0;
        this.timeouts = 0;
        this.shots = 0;
        this.deadline = null;
        this.remainingSessionMs = config.durationMs;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    }

    sourceText() {
        if (!isTrainableEditor(this.sourceEditor)) {
            throw new Error('The selected editor is not a regular file.');
        }
        const sourceDocument = this.sourceEditor.document;
        const sourceRange = this.sourceEditor.visibleRanges[0];
        if (!sourceRange) {
            throw new Error('The selected editor has no visible content.');
        }
        const firstLine = sourceRange.start.line;
        this.sourceStartLine = 1;
        this.scrollStartLine = firstLine + 1;
        const fileName = sourceDocument.fileName
            || (sourceDocument.uri && (sourceDocument.uri.fsPath || sourceDocument.uri.toString()))
            || 'Untitled';
        this.trainingTitle = path.basename(fileName) || 'Untitled';
        const text = sourceDocument.getText();
        if (!text.trim()) {
            throw new Error('The selected file contains no code.');
        }
        return text;
    }

    refreshLayout(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        if (this.view) {
            this.view.setContent(this.sourceLines, this.languageId, {
                startLine: 1,
                sourceLineCount: this.sourceLines.length,
                scrollLine: this.scrollStartLine
            });
        }
    }

    async run() {
        activeSession = this;
        try {
            this.languageId = (this.sourceEditor && this.sourceEditor.document.languageId)
                || 'plaintext';
            this.sourceLines = this.sourceText()
                .replace(/\r\n?/g, '\n')
                .split('\n')
                .map(line => line.replace(/\t/g, '    '));
            this.lineNumberDigits = Math.max(
                2,
                String(this.sourceLines.length).length
            );

            this.view = new AimlabTrainingView(
                this.context.extensionUri,
                this.trainingTitle,
                this.lineNumberDigits
            );
            this.view.onLayout = (cols, rows) => {
                this.refreshLayout(cols, rows);
                if (this.state === 'running') {
                    if (!this.view.isActive()) {
                        this.requestStop('abandoned');
                    } else {
                        this.pause('Training view resized. Resume when ready.');
                    }
                }
            };
            this.view.onClick = position => this.handleClick(
                position.line,
                position.character,
                position.insideTarget
            );
            this.view.onTracking = metrics => {
                this.trackingOnTargetMs = metrics.onTargetMs;
                this.trackingElapsedMs = metrics.elapsedMs;
                this.updateStatusBar();
            };
            this.view.onViewport = info => this.handleViewport(info);
            this.view.onStop = () => this.requestStop('stopped');
            this.view.onDispose = () => {
                if (this.state !== 'finished') {
                    this.requestStop('closed');
                }
            };
            this.view.onVisibilityChange = (visible, active) => {
                if ((!visible || !active) && this.state !== 'finished' && this.state !== 'stopped') {
                    this.requestStop('abandoned');
                }
            };
            await this.view.open();
            this.refreshLayout(this.view.cols, this.view.rows);
            this.viewWatchTimer = setInterval(() => {
                if (this.state !== 'finished'
                    && this.state !== 'stopped'
                    && !this.view.isActive()) {
                    this.requestStop('abandoned');
                }
            }, 250);

            this.updateStatusBar();
            this.statusBarItem.show();
            this.state = 'countdown';
            await this.runCountdown();

            if (this.state !== 'stopped') {
                this.state = 'running';
                this.view.setState('running');
                this.startedAt = Date.now();
                this.deadline = this.config.mode === 'count'
                    ? null
                    : this.startedAt + this.config.durationMs;
                if (!this.view.isActive()) {
                    this.requestStop('abandoned');
                } else if (this.config.mode === 'tracking') {
                    this.view.startTracking(this.trackingBounds());
                    await this.trackingLoop();
                } else {
                    await this.trainingLoop();
                }
            }
            await this.finish(this.state === 'stopped' ? this.terminalReason : 'completed');
        } catch (error) {
            await this.finish('error');
            vscode.window.showErrorMessage(`Aimlab failed: ${error.message}`);
        }
    }

    async runCountdown() {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Aimlab starting',
            cancellable: false
        }, async progress => {
            for (let seconds = 3; seconds > 0 && this.state !== 'stopped'; seconds--) {
                progress.report({ message: String(seconds) });
                this.statusBarItem.text = `Aimlab starts in ${seconds}s`;
                const outcome = await this.wait(1000);
                if (outcome === 'stopped' || this.state === 'stopped') {
                    break;
                }
            }
        });
    }

    async trainingLoop() {
        while (this.state === 'running' || this.state === 'paused') {
            if (this.state === 'paused') {
                await this.waitForResume();
                continue;
            }
            if (this.config.mode === 'count' && this.spawnedCount >= this.config.testCount) {
                break;
            }
            if (this.deadline !== null && Date.now() >= this.deadline) {
                if (this.targetRange && !this.targetSettled) {
                    this.timeouts++;
                    this.clearTarget();
                }
                break;
            }

            this.spawnTarget();
            const outcome = await this.waitForTarget();
            if (outcome === 'stopped' || this.state === 'stopped') {
                break;
            }
            if (outcome === 'paused' || this.state === 'paused') {
                continue;
            }
            this.updateStatusBar();

            if (this.deadline !== null && Date.now() >= this.deadline) {
                break;
            }
            if (this.config.mode === 'count' && this.spawnedCount >= this.config.testCount) {
                break;
            }
            if (this.config.mode === 'timed') {
                const outcomeOfInterval = await this.wait(this.config.intervalMs);
                if (!outcomeOfInterval && this.state === 'stopped') {
                    break;
                }
            }
        }
    }

    trackingBounds() {
        const { height, width } = this.config;
        const firstLine = TRAINING_MARGIN_ROWS;
        const lastLine = this.rows - 1 - TRAINING_MARGIN_ROWS;
        const lastStartLine = lastLine - height + 1;
        const activeWidth = this.cols - TRAINING_MARGIN_COLUMNS * 2;
        if (lastStartLine < firstLine) {
            throw new Error('The training view is too short for the configured target height.');
        }
        if (width > activeWidth) {
            throw new Error('The training view is too narrow for the configured target width.');
        }

        const rowCount = lastStartLine - firstLine + 1;
        const rangeRowCount = Math.max(1, Math.round(rowCount * this.config.rangePercent / 100));
        const minRow = firstLine + Math.floor((rowCount - rangeRowCount) / 2);
        const maxRow = minRow + rangeRowCount - 1;

        const rangeWidth = Math.max(width, Math.round(activeWidth * this.config.rangePercent / 100));
        const minColumn = TRAINING_MARGIN_COLUMNS + Math.floor((activeWidth - rangeWidth) / 2);
        const maxColumn = minColumn + rangeWidth - width;
        return {
            minColumn,
            maxColumn,
            minRow,
            maxRow,
            width,
            height,
            speed: this.config.speed,
            motion: this.config.motion
        };
    }

    async trackingLoop() {
        this.spawnedCount = 1;
        while (this.state === 'running' || this.state === 'paused') {
            if (this.state === 'paused') {
                await this.waitForResume();
                continue;
            }
            const remaining = (this.deadline || Date.now()) - Date.now();
            if (remaining <= 0) {
                break;
            }
            const outcome = await this.wait(Math.min(250, remaining));
            if (outcome === 'stopped' || this.state === 'stopped') {
                break;
            }
        }
        await this.view.stopTracking();
    }

    spawnTarget() {
        const { height, width } = this.config;
        const firstLine = TRAINING_MARGIN_ROWS;
        const lastLine = this.rows - 1 - TRAINING_MARGIN_ROWS;
        const lastStartLine = lastLine - height + 1;
        if (lastStartLine < firstLine) {
            throw new Error('The training view is too short for the configured target height.');
        }
        const activeWidth = this.cols - TRAINING_MARGIN_COLUMNS * 2;
        if (width > activeWidth) {
            throw new Error('The training view is too narrow for the configured target width.');
        }

        const rowCount = lastStartLine - firstLine + 1;
        const rangeRowCount = Math.max(1, Math.round(rowCount * this.config.rangePercent / 100));
        const rangeFirstLine = firstLine + Math.floor((rowCount - rangeRowCount) / 2);
        const rangeLastLine = rangeFirstLine + rangeRowCount - 1;

        const rangeWidth = Math.max(width, Math.round(activeWidth * this.config.rangePercent / 100));
        const rangeLeft = TRAINING_MARGIN_COLUMNS + Math.floor((activeWidth - rangeWidth) / 2);
        const rangeRight = Math.min(
            this.cols - TRAINING_MARGIN_COLUMNS,
            rangeLeft + rangeWidth
        );

        const candidates = [];
        for (let lineNumber = rangeFirstLine; lineNumber <= rangeLastLine; lineNumber++) {
            for (let character = rangeLeft; character <= rangeRight - width; character++) {
                candidates.push({ line: lineNumber, character });
            }
        }

        if (!candidates.length) {
            throw new Error('Unable to place a target. Resize the training view or choose a different Range.');
        }

        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        const selected = new vscode.Range(pick.line, pick.character, pick.line + height - 1, pick.character + width);

        this.targetRange = selected;
        this.targetSettled = false;
        this.targetStartedAt = Date.now();
        this.spawnedCount++;
        this.view.showTarget(selected);
        this.updateStatusBar();
    }

    waitForTarget() {
        return new Promise(resolve => {
            if (this.config.mode !== 'timed') {
                this.pendingWait = { resolve, timer: null, kind: 'target' };
                return;
            }
            const sessionRemaining = this.deadline === null ? Infinity : this.deadline - Date.now();
            const timeout = Math.max(0, Math.min(this.config.timeoutMs, sessionRemaining));
            const timer = setTimeout(() => {
                if (this.state !== 'running' || this.targetSettled) {
                    return;
                }
                this.targetSettled = true;
                this.timeouts++;
                this.clearTarget();
                this.pendingWait = null;
                resolve('timeout');
            }, timeout);
            this.pendingWait = { resolve, timer, kind: 'target' };
        });
    }

    wait(milliseconds) {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pendingWait = null;
                resolve(true);
            }, milliseconds);
            this.pendingWait = { resolve, timer, kind: 'interval' };
        });
    }

    waitForResume() {
        if (this.pauseWait) {
            return this.pauseWait;
        }
        this.statusBarItem.text = 'Aimlab paused - run Aimlab: Resume';
        this.pauseWait = new Promise(resolve => {
            this.resolvePause = resolve;
        });
        return this.pauseWait;
    }

    handleViewport(info) {
        if (this.state !== 'running'
            || this.config.mode === 'tracking'
            || !info
            || info.offscreen === 'none'
            || !this.targetRange
            || this.targetSettled) {
            return;
        }
        // A target fully scrolled out of view cannot be clicked. Re-anchor it
        // in the current viewport without counting a hit, a miss, or a timeout.
        this.spawnedCount = Math.max(0, this.spawnedCount - 1);
        this.clearTarget();
        this.resolvePending('rescroll');
    }

    handleClick(line, character, insideTarget) {
        if (this.state !== 'running' || !this.targetRange || this.targetSettled) {
            return;
        }

        const range = this.targetRange;
        const afterStart = line > range.start.line
            || (line === range.start.line && character >= range.start.character);
        const beforeEnd = line < range.end.line
            || (line === range.end.line && character < range.end.character);
        const isHit = typeof insideTarget === 'boolean'
            ? insideTarget
            : (afterStart && beforeEnd);
        this.shots++;

        if (!isHit) {
            this.misses++;
            this.view.flashTarget(range, false);
            this.updateStatusBar();
            return;
        }

        this.targetSettled = true;
        this.hits++;
        this.reactionTimes.push(Date.now() - this.targetStartedAt);
        this.view.clearTarget();
        this.view.flashTarget(range, true);
        this.targetRange = null;
        if (this.pendingWait) {
            if (this.pendingWait.timer) {
                clearTimeout(this.pendingWait.timer);
            }
            const resolve = this.pendingWait.resolve;
            this.pendingWait = null;
            resolve('hit');
        }
        this.updateStatusBar();
    }

    pause(message) {
        if (this.state !== 'running') {
            return;
        }
        this.state = 'paused';
        if (this.deadline !== null) {
            this.remainingSessionMs = Math.max(0, this.deadline - Date.now());
        }
        if (this.config.mode !== 'tracking' && this.targetRange && !this.targetSettled) {
            this.spawnedCount = Math.max(0, this.spawnedCount - 1);
            this.clearTarget();
        }
        this.view.setState('paused');
        this.resolvePending('paused');
        this.statusBarItem.text = 'Aimlab paused - run Aimlab: Resume';
        if (message) {
            this.statusBarItem.tooltip = message;
        }
    }

    resume() {
        if (this.state !== 'paused') {
            return;
        }
        if (this.deadline !== null) {
            this.deadline = Date.now() + this.remainingSessionMs;
        }
        this.state = 'running';
        this.pauseWait = null;
        this.view.setState('running');
        if (this.config.mode === 'tracking') {
            this.view.updateTrackingBounds(this.trackingBounds());
        }
        if (this.resolvePause) {
            this.resolvePause();
            this.resolvePause = null;
        }
        this.updateStatusBar();
    }

    requestStop(reason = 'stopped') {
        if (this.state === 'stopped' || this.state === 'finished') {
            return;
        }
        this.terminalReason = reason;
        this.state = 'stopped';
        this.resolvePending('stopped');
        if (this.resolvePause) {
            this.resolvePause();
            this.resolvePause = null;
        }
    }

    resolvePending(outcome) {
        if (!this.pendingWait) {
            return;
        }
        if (this.pendingWait.timer) {
            clearTimeout(this.pendingWait.timer);
        }
        const resolve = this.pendingWait.resolve;
        this.pendingWait = null;
        resolve(outcome);
    }

    clearTarget() {
        if (this.view) {
            this.view.clearTarget();
        }
        this.targetRange = null;
    }

    updateStatusBar() {
        if (this.state === 'paused') {
            return;
        }
        const remaining = Math.max(0, Math.ceil(((this.deadline || Date.now()) - Date.now()) / 1000));
        if (this.config.mode === 'tracking') {
            const trackingAccuracy = this.trackingElapsedMs > 0
                ? this.trackingOnTargetMs / this.trackingElapsedMs * 100
                : 0;
            this.statusBarItem.text = `Aimlab Tracking ${remaining}s | ${trackingAccuracy.toFixed(1)}%`;
            this.statusBarItem.tooltip = 'Keep the pointer inside the moving target. Commands: Pause, Resume, Stop, Restart.';
            return;
        }
        const progress = this.config.mode === 'count'
            ? `${this.spawnedCount}/${this.config.testCount}`
            : `${remaining}s`;
        const latest = this.reactionTimes.length ? ` Last: ${this.reactionTimes[this.reactionTimes.length - 1]}ms` : '';
        this.statusBarItem.text = `Aimlab ${progress} Hit:${this.hits} Miss:${this.misses} Timeout:${this.timeouts}${latest}`;
        this.statusBarItem.tooltip = 'Webview training view. Commands: Pause, Resume, Stop, Restart.';
    }

    getStorage() {
        return getHistoryStorage(this.context);
    }

    async saveRecord(outcome) {
        const record = {
            createdAt: new Date().toISOString(),
            outcome,
            source: this.source,
            config: this.config,
            metrics: calculateMetrics(this)
        };
        const storage = this.getStorage();
        const history = storage.get(HISTORY_KEY, []);
        const comparable = history.filter(item => item.source === this.source
            && configKey(item.config) === configKey(this.config));
        const previous = comparable[0] || null;
        const completed = comparable.filter(item => item.outcome === 'completed');
        const bestBefore = completed.reduce((best, item) => isBetter(item, best) ? item : best, null);
        await storage.update(HISTORY_KEY, [record, ...history].slice(0, HISTORY_LIMIT));
        if (activeSidebar) {
            activeSidebar.refresh();
        }
        return { record, previous, bestBefore };
    }

    async finish(outcome) {
        if (this.state === 'finished') {
            return;
        }
        this.finishedAt = Date.now();
        this.state = 'finished';
        if (this.viewWatchTimer) {
            clearInterval(this.viewWatchTimer);
            this.viewWatchTimer = null;
        }
        this.resolvePending('stopped');
        if (this.resolvePause) {
            this.resolvePause();
        }
        this.clearTarget();
        if (this.view) {
            if (this.config.mode === 'tracking') {
                await this.view.stopTracking();
            }
            this.view.setState('finished');
            this.view.dispose();
        }
        this.statusBarItem.dispose();
        if (activeSession === this) {
            activeSession = null;
        }

        if (outcome !== 'completed') {
            await this.saveRecord(outcome);
            return;
        }

        const { record, bestBefore } = await this.saveRecord(outcome);
        const isBest = isBetter(record, bestBefore);
        let summary;
        const metrics = record.metrics;
        const difficulty = difficultyLabel(this.config.difficulty);
        if (this.config.mode === 'tracking') {
            summary = `Aimlab complete | Tracking ${metrics.trackingAccuracy.toFixed(1)}% | On target ${(metrics.onTargetMs / 1000).toFixed(1)}s / ${(metrics.trackingElapsedMs / 1000).toFixed(1)}s | ${difficulty}`;
        } else if (this.config.mode === 'timed') {
            summary = `Aimlab complete | ${metrics.hits}/${metrics.targets} hits | ${metrics.hitRate.toFixed(1)}% hit rate | Average ${formatMs(metrics.averageMs)} | Fastest ${formatMs(metrics.fastestMs)} | Slowest ${formatMs(metrics.slowestMs)} | ${difficulty}`;
        } else {
            summary = `Aimlab complete | ${clickScore(metrics)} | Total ${formatSeconds(metrics.totalMs)} | Average ${formatMs(metrics.averageMs)} | Fastest ${formatMs(metrics.fastestMs)} | Slowest ${formatMs(metrics.slowestMs)} | ${difficulty}`;
        }
        void vscode.window.showInformationMessage(`${summary}${isBest ? ' | New best' : ''}`);
    }
}

function findTrainableEditor(preferred) {
    const candidates = [
        preferred,
        vscode.window.activeTextEditor,
        ...(vscode.window.visibleTextEditors || [])
    ];
    const seen = new Set();
    for (const editor of candidates) {
        if (!editor || !editor.document || seen.has(editor.document.uri.toString())) {
            continue;
        }
        seen.add(editor.document.uri.toString());
        if (isTrainableEditor(editor)) {
            return editor;
        }
    }
    return null;
}

function rememberTrainableEditor(editor) {
    if (isTrainableEditor(editor)) {
        lastTrainableUri = editor.document.uri;
    }
}

async function findFallbackTrainableEditor() {
    const uris = [];
    if (lastTrainableUri) {
        uris.push(lastTrainableUri);
    }
    const tabGroups = vscode.window.tabGroups;
    if (tabGroups && Array.isArray(tabGroups.all)) {
        for (const group of tabGroups.all) {
            for (const tab of group.tabs || []) {
                const uri = tab.input && tab.input.uri;
                if (uri) {
                    uris.push(uri);
                }
            }
        }
    }

    const seen = new Set();
    for (const uri of uris) {
        const key = uri.toString();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        let document = (vscode.workspace.textDocuments || [])
            .find(item => item.uri.toString() === key);
        if (!document) {
            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch (error) {
                continue;
            }
        }
        if (!isTrainableEditor({ document })) {
            continue;
        }
        try {
            const editor = await vscode.window.showTextDocument(document, { preview: false });
            if (isTrainableEditor(editor)) {
                return editor;
            }
        } catch (error) {
            continue;
        }
    }
    return null;
}

async function startSession(context) {
    if (activeSession && activeSession.state !== 'finished') {
        const choice = await vscode.window.showWarningMessage(
            'An Aimlab session is already running. Stop it and restart?',
            { modal: true },
            'Stop and Restart'
        );
        if (choice !== 'Stop and Restart') {
            return;
        }
        const previousSession = activeSession;
        previousSession.requestStop('restarted');
        await previousSession.runPromise;
    }

    let editor = findTrainableEditor();
    if (!editor) {
        editor = await findFallbackTrainableEditor();
    }
    if (!editor) {
        vscode.window.showErrorMessage('No regular file is open. Open a file before starting Aimlab.');
        return;
    }
    rememberTrainableEditor(editor);
    const session = new AimlabSession(context, getTrainingConfig(), { editor });
    session.runPromise = session.run();
    await session.runPromise;
}

function getConfigurationTarget() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

let settingsSchemaWarningActive = false;

async function offerWindowReload(message) {
    if (settingsSchemaWarningActive) {
        return;
    }
    settingsSchemaWarningActive = true;
    try {
        const choice = await vscode.window.showWarningMessage(message, 'Reload Window');
        if (choice === 'Reload Window') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } finally {
        settingsSchemaWarningActive = false;
    }
}

async function updateAimlabSetting(settings, key, value, target) {
    try {
        await settings.update(key, value, target);
        return true;
    } catch (error) {
        await offerWindowReload(
            'This VS Code window has not loaded the updated Aimlab settings schema. Reload the window to enable the new settings.'
        );
        return false;
    }
}

function checkSettingsSchema() {
    const settings = vscode.workspace.getConfiguration('aimlab');
    if (typeof settings.inspect === 'function' && !settings.inspect('difficulty')) {
        void offerWindowReload(
            'This VS Code window is using an older Aimlab settings schema. Reload the window to enable the new settings.'
        );
    }
}

async function promptForNumber(label, current, min, max) {
    const raw = await vscode.window.showInputBox({
        prompt: `${label} (${min}-${max})`,
        value: String(current),
        validateInput: value => {
            const number = Number(value);
            return Number.isInteger(number) && number >= min && number <= max
                ? null
                : `Enter an integer from ${min} to ${max}.`;
        }
    });
    return raw === undefined ? null : Number(raw);
}

function customConfigFromEffective(effective) {
    return {
        height: effective.height,
        width: effective.width,
        timeoutMs: effective.timeoutMs,
        speed: effective.speed
    };
}

async function saveCustomDifficultyField(settings, target, effective, key, value) {
    const custom = customConfigFromEffective(effective);
    custom[key] = value;
    await updateAimlabSetting(settings, 'custom', custom, target);
    if (effective.difficulty !== 'custom') {
        await updateAimlabSetting(settings, 'difficulty', 'custom', target);
    }
}

async function editAimlabSetting(key) {
    const settings = vscode.workspace.getConfiguration('aimlab');
    const effective = getTrainingConfig();
    const target = getConfigurationTarget();

    if (key === 'mode') {
        const choice = await vscode.window.showQuickPick([
            { label: 'Count', description: 'Finish after a fixed number of targets', value: 'count' },
            { label: 'Timed', description: 'Finish after a fixed duration', value: 'timed' },
            { label: 'Tracking', description: 'Follow a moving target and score time on target', value: 'tracking' }
        ], { placeHolder: 'Select mode' });
        if (choice) {
            await updateAimlabSetting(settings, 'mode', choice.value, target);
        }
        return;
    }

    if (key === 'difficulty') {
        const choice = await vscode.window.showQuickPick([
            { label: 'Easy', value: 'easy' },
            { label: 'Medium', value: 'medium' },
            { label: 'Hard', value: 'hard' },
            { label: 'Extreme', value: 'extreme' },
            { label: 'Custom', value: 'custom' }
        ], { placeHolder: 'Select difficulty' });
        if (!choice) {
            return;
        }
        if (choice.value === 'custom') {
            await updateAimlabSetting(settings, 'custom', customConfigFromEffective(effective), target);
        }
        await updateAimlabSetting(settings, 'difficulty', choice.value, target);
        return;
    }

    if (key === 'range') {
        const choice = await vscode.window.showQuickPick(
            Object.entries(RANGE_LEVELS).map(([value, level]) => ({
                label: level.label,
                description: `${level.percent}% of the visible area around the center`,
                value
            })),
            { placeHolder: 'Select target range' }
        );
        if (choice) {
            await updateAimlabSetting(settings, 'range', choice.value, target);
        }
        return;
    }

    if (key === 'trackingMotion') {
        const choice = await vscode.window.showQuickPick([
            { label: 'Smooth', description: 'Continuous sine-wave motion', value: 'smooth' },
            { label: 'Sharp Turns', description: 'Straight lines with sudden sharp direction changes', value: 'sharp' }
        ], { placeHolder: 'Select tracking motion' });
        if (choice) {
            await updateAimlabSetting(settings, 'trackingMotion', choice.value, target);
        }
        return;
    }

    if (key === 'testCount') {
        const value = await promptForNumber('Count', effective.testCount, 1, 1000);
        if (value !== null) {
            await updateAimlabSetting(settings, 'testCount', value, target);
        }
        return;
    }

    if (key === 'durationSeconds') {
        const value = await promptForNumber('Duration in seconds', effective.durationMs / 1000, 5, 3600);
        if (value !== null) {
            await updateAimlabSetting(settings, 'durationSeconds', value, target);
        }
        return;
    }

    if (key === 'intervalMs') {
        const value = await promptForNumber('Interval in milliseconds', effective.intervalMs, 0, 10000);
        if (value !== null) {
            await updateAimlabSetting(settings, 'intervalMs', value, target);
        }
        return;
    }

    const difficultyFields = {
        height: { label: 'Height in lines', min: 1, max: 10 },
        width: { label: 'Width in characters', min: 1, max: 20 },
        timeoutMs: { label: 'Timeout in milliseconds', min: 100, max: 60000 },
        speed: { label: 'Tracking speed (1-10)', min: 1, max: 10 }
    };
    if (difficultyFields[key]) {
        const field = difficultyFields[key];
        const value = await promptForNumber(field.label, effective[key], field.min, field.max);
        if (value !== null) {
            await saveCustomDifficultyField(settings, target, effective, key, value);
        }
        return;
    }

    if (key === 'resetDefaults') {
        const choice = await vscode.window.showWarningMessage(
            'Reset all Aimlab settings to their defaults?',
            { modal: true },
            'Reset Defaults'
        );
        if (choice === 'Reset Defaults') {
            for (const settingKey of ['mode', 'difficulty', 'range', 'trackingMotion', 'testCount', 'durationSeconds', 'intervalMs', 'custom']) {
                await updateAimlabSetting(settings, settingKey, undefined, target);
            }
        }
    }
}

function getHistoryStorage(context) {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? context.workspaceState : context.globalState;
}

function getStoredHistory(context) {
    return getHistoryStorage(context).get(HISTORY_KEY, []) || [];
}

function difficultyLabel(value) {
    return DIFFICULTY_LABELS[normalizeDifficulty(value)];
}

class AimlabSidebarProvider {
    constructor(context) {
        this.context = context;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
    }

    getTreeItem(element) {
        return element;
    }

    refresh() {
        this.emitter.fire();
    }

    dispose() {
        this.emitter.dispose();
    }

    getChildren(element) {
        if (element && element.id === 'aimlab.difficulty') {
            return this.createDifficultyItems();
        }
        if (element && element.id === 'aimlab.history') {
            return this.createHistoryItems();
        }
        if (element) {
            return [];
        }

        const start = new vscode.TreeItem('Start', vscode.TreeItemCollapsibleState.None);
        start.id = 'aimlab.start';
        start.tooltip = 'Open the current file in the Aimlab training view. The source file is never modified.';
        start.command = { command: 'aimlab.start', title: 'Start' };

        const config = getTrainingConfig();
        const modeLabel = config.mode === 'tracking'
            ? 'Tracking'
            : (config.mode === 'timed' ? 'Timed' : 'Count');
        const mode = this.createActionItem('Mode', modeLabel, 'mode');
        const difficulty = new vscode.TreeItem('Difficulty', vscode.TreeItemCollapsibleState.Expanded);
        difficulty.id = 'aimlab.difficulty';
        difficulty.description = difficultyLabel(config.difficulty);
        difficulty.tooltip = 'Click to select Easy, Medium, Hard, Extreme, or Custom.';
        difficulty.command = { command: 'aimlab.editSetting', title: 'Select Difficulty', arguments: ['difficulty'] };
        const range = this.createActionItem(
            'Range',
            `${RANGE_LEVELS[config.range].label} (${config.rangePercent}%)`,
            'range'
        );

        const items = [start, mode, difficulty, range];
        if (config.mode === 'timed') {
            items.push(this.createActionItem('Interval', `${config.intervalMs} ms`, 'intervalMs'));
            items.push(this.createActionItem('Duration', `${config.durationMs / 1000} s`, 'durationSeconds'));
        } else if (config.mode === 'tracking') {
            items.push(this.createActionItem('Duration', `${config.durationMs / 1000} s`, 'durationSeconds'));
            items.push(this.createActionItem(
                'Motion',
                TRACKING_MOTIONS[config.motion].label,
                'trackingMotion'
            ));
        } else {
            items.push(this.createActionItem('Count', `${config.testCount}`, 'testCount'));
        }

        const reset = new vscode.TreeItem('Reset Default Settings', vscode.TreeItemCollapsibleState.None);
        reset.id = 'aimlab.setting.resetDefaults';
        reset.command = { command: 'aimlab.editSetting', title: 'Reset Default Settings', arguments: ['resetDefaults'] };
        items.push(reset);

        const history = getStoredHistory(this.context);
        const historyRoot = new vscode.TreeItem('History', vscode.TreeItemCollapsibleState.Collapsed);
        historyRoot.id = 'aimlab.history';
        historyRoot.description = `${history.length} run${history.length === 1 ? '' : 's'}`;
        items.push(historyRoot);
        return items;
    }

    createActionItem(label, description, key) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `aimlab.setting.${key}`;
        item.description = description;
        item.tooltip = `Click to change ${label}.`;
        item.command = { command: 'aimlab.editSetting', title: `Edit ${label}`, arguments: [key] };
        return item;
    }

    createDifficultyItems() {
        const config = getTrainingConfig();
        const items = [
            this.createActionItem('Height', `${config.height} line${config.height === 1 ? '' : 's'}`, 'height'),
            this.createActionItem('Width', `${config.width} character${config.width === 1 ? '' : 's'}`, 'width')
        ];
        if (config.mode === 'timed') {
            items.push(this.createActionItem('Timeout', `${config.timeoutMs} ms`, 'timeoutMs'));
        }
        if (config.mode === 'tracking') {
            items.push(this.createActionItem('Speed', `${config.speed} / 10`, 'speed'));
        }
        return items;
    }

    createHistoryItems() {
        const history = getStoredHistory(this.context);
        if (!history.length) {
            const empty = new vscode.TreeItem('No training history yet.', vscode.TreeItemCollapsibleState.None);
            empty.id = 'aimlab.history.empty';
            return [empty];
        }

        const items = history.slice(0, 10).map((record, index) => {
            const config = record.config || {};
            const mode = config.mode === 'tracking'
                ? 'Tracking'
                : (config.mode === 'timed' ? 'Timed' : 'Count');
            const item = new vscode.TreeItem(
                `${difficultyLabel(config.difficulty || config.preset)} - ${mode}`,
                vscode.TreeItemCollapsibleState.None
            );
            item.id = `aimlab.history.${index}.${record.createdAt}`;
            const date = new Date(record.createdAt);
            const dateLabel = Number.isNaN(date.getTime())
                ? 'Unknown time'
                : date.toLocaleString('en-US', { hour12: false });
            if (config.mode === 'tracking') {
                const accuracy = record.metrics.trackingAccuracy ?? 0;
                const onTarget = (record.metrics.onTargetMs ?? 0) / 1000;
                const elapsed = (record.metrics.trackingElapsedMs ?? 0) / 1000;
                item.description = `${dateLabel} - ${accuracy.toFixed(1)}% tracked`;
                item.tooltip = [
                    `Status: ${record.outcome}`,
                    `Source: ${record.source === 'editor' ? 'Current editor' : 'Sample code'}`,
                    `Tracking accuracy: ${accuracy.toFixed(1)}%`,
                    `On target: ${onTarget.toFixed(1)} s`,
                    `Tracked time: ${elapsed.toFixed(1)} s`
                ].join('\n');
            } else {
                const metrics = record.metrics;
                const lines = [
                    `Status: ${record.outcome}`,
                    `Source: ${record.source === 'editor' ? 'Current editor' : 'Sample code'}`
                ];
                if (config.mode === 'timed') {
                    item.description = `${dateLabel} - ${metrics.hits}/${metrics.targets} hits`;
                    lines.push(
                        `Hits: ${metrics.hits}/${metrics.targets}`,
                        `Hit rate: ${metrics.hitRate.toFixed(1)}%`,
                        `Click accuracy: ${metrics.accuracy.toFixed(1)}%`
                    );
                } else {
                    item.description = `${dateLabel} - ${clickScore(metrics)}`;
                    lines.push(
                        `Click hits: ${metrics.hits}/${clickShots(metrics)}`,
                        `Total time: ${formatSeconds(metrics.totalMs)}`
                    );
                }
                lines.push(
                    `Average reaction: ${formatMs(metrics.averageMs)}`,
                    `Fastest reaction: ${formatMs(metrics.fastestMs)}`,
                    `Slowest reaction: ${formatMs(metrics.slowestMs)}`
                );
                item.tooltip = lines.join('\n');
            }
            return item;
        });

        const clear = new vscode.TreeItem('Clear History', vscode.TreeItemCollapsibleState.None);
        clear.id = 'aimlab.history.clear';
        clear.command = { command: 'aimlab.clearHistory', title: 'Clear History' };
        items.push(clear);
        return items;
    }
}

function activate(context) {
    activeSidebar = new AimlabSidebarProvider(context);
    context.subscriptions.push(activeSidebar);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('aimlab.sidebar', activeSidebar));
    rememberTrainableEditor(vscode.window.activeTextEditor);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        rememberTrainableEditor(editor);
        if (editor && activeSession && !activeSession.view?.isActive()) {
            activeSession.requestStop('abandoned');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('aimlab.start', () => startSession(context)));
    context.subscriptions.push(vscode.commands.registerCommand('aimlab.editSetting', key => editAimlabSetting(key)));
    context.subscriptions.push(vscode.commands.registerCommand('aimlab.openSettings', () => {
        return vscode.commands.executeCommand('workbench.action.openSettings', 'aimlab');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('aimlab.stop', () => {
        if (activeSession) {
            activeSession.requestStop('stopped');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('aimlab.restart', () => startSession(context)));
    context.subscriptions.push(vscode.commands.registerCommand('aimlab.pause', () => {
        if (activeSession) {
            activeSession.pause();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('aimlab.resume', () => {
        if (activeSession) {
            activeSession.resume();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('aimlab.clearHistory', async () => {
        const choice = await vscode.window.showWarningMessage('Clear all Aimlab training history?', { modal: true }, 'Clear History');
        if (choice === 'Clear History') {
            await Promise.all([
                context.workspaceState.update(HISTORY_KEY, undefined),
                context.globalState.update(HISTORY_KEY, undefined)
            ]);
            if (activeSidebar) {
                activeSidebar.refresh();
            }
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('aimlab')) {
            return;
        }
        if (activeSidebar) {
            activeSidebar.refresh();
        }
        if (activeSession && activeSession.state === 'running') {
            activeSession.pause('Settings changed. Resume to continue with the original settings.');
        }
    }));

    checkSettingsSchema();
}

function deactivate() {
    if (activeSession) {
        activeSession.requestStop('closed');
    }
    activeSidebar = null;
}

module.exports = { activate, deactivate, calculateMetrics, isBetter, getTrainingConfig };
