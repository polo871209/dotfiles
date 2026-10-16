import GithubSlugger from "mdview://app/vendor/github-slugger.js";

const content = document.getElementById("content");
const base = document.querySelector("base");
const dark = matchMedia("(prefers-color-scheme: dark)");

const highlighted = new Map();
const diagrams = new Map();
const CACHE_LIMIT = 500;

let mermaidReady;
let diagramId = 0;
let last;

function remember(cache, key, value) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, value);
}

function highlight(code) {
    const lang = code.className.match(/language-(\S+)/)?.[1];
    if (!lang || !hljs.getLanguage(lang)) return;
    const key = `${lang}\0${code.textContent}`;
    let html = highlighted.get(key);
    if (html === undefined) {
        html = hljs.highlight(code.textContent, {
            language: lang,
            ignoreIllegals: true,
        }).value;
        remember(highlighted, key, html);
    }
    code.innerHTML = html;
    code.classList.add("hljs");
}

async function importMermaid() {
    await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "mdview://app/vendor/mermaid.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.append(script);
    });
    themeMermaid();
}

function loadMermaid() {
    mermaidReady ??= importMermaid();
    return mermaidReady;
}

function themeMermaid() {
    mermaid.initialize({
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: dark.matches ? "dark" : "default",
    });
}

function diagram(node, result, sourcepos) {
    const div = document.createElement("div");
    div.className = result.svg ? "mermaid" : "mermaid error";
    div.dataset.sourcepos = sourcepos;
    if (result.svg) div.innerHTML = result.svg;
    else div.textContent = result.error;
    node.replaceWith(div);
}

async function drawDiagrams(previous) {
    const missing = [];
    content
        .querySelectorAll("pre > code.language-mermaid")
        .forEach((code, i) => {
            const cached = diagrams.get(code.textContent);
            if (cached)
                diagram(
                    code.parentElement,
                    cached,
                    code.parentElement.dataset.sourcepos,
                );
            else
                missing.push([
                    code.textContent,
                    code.parentElement,
                    previous[i],
                ]);
        });
    if (!missing.length) return;
    for (const [, pre, old] of missing) if (old) pre.replaceWith(old);
    await loadMermaid();
    for (const [source, pre, old] of missing) {
        let result;
        try {
            result = {
                svg: (await mermaid.render(`mermaid-${diagramId++}`, source))
                    .svg,
            };
        } catch (error) {
            result = { error: String(error.message ?? error) };
        }
        remember(diagrams, source, result);
        const slot = old ?? pre;
        if (slot.isConnected) diagram(slot, result, pre.dataset.sourcepos);
    }
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

// cmark-gfm has no alert syntax. This emits GitHub's own markup, which github-markdown.css styles.
function alerts() {
    for (const quote of content.querySelectorAll("blockquote")) {
        const first = quote.firstElementChild;
        const text = first?.tagName === "P" ? first.firstChild : null;
        const match = text?.nodeType === Node.TEXT_NODE && text.data.match(ALERT);
        if (!match) continue;
        const kind = match[1].toLowerCase();
        text.data = text.data.slice(match[0].length);
        if (!first.textContent.trim() && !first.querySelector("img")) first.remove();
        const alert = document.createElement("div");
        alert.className = `markdown-alert markdown-alert-${kind}`;
        alert.dataset.sourcepos = quote.dataset.sourcepos;
        const title = document.createElement("p");
        title.className = "markdown-alert-title";
        title.textContent = kind[0].toUpperCase() + kind.slice(1);
        alert.append(title, ...quote.childNodes);
        quote.replaceWith(alert);
    }
}

// cmark-gfm emits bare checkboxes. GitHub adds these classes after rendering, and its stylesheet keys on them.
function taskLists() {
    for (const box of content.querySelectorAll("li > input[type=checkbox]")) {
        box.classList.add("task-list-item-checkbox");
        box.parentElement.classList.add("task-list-item");
        box.parentElement.parentElement.classList.add("contains-task-list");
    }
}

// cmark-gfm emits no heading ids. github-slugger makes the ids GitHub makes, so `#section` links resolve.
function anchors() {
    const slugger = new GithubSlugger();
    for (const h of content.querySelectorAll("h1, h2, h3, h4, h5, h6")) h.id = slugger.slug(h.textContent);
}

const toc = document.getElementById("toc");
const tocToggle = document.getElementById("toc-toggle");
let tocHeadings = [];
let tocKey = "";

function buildToc() {
    tocHeadings = [...content.querySelectorAll("h1, h2, h3")].filter((h) => h.id);
    document.body.classList.toggle("has-toc", tocHeadings.length > 1);
    const key = tocHeadings.map((h) => `${h.tagName}${h.id}\0${h.textContent}`).join("\n");
    if (key !== tocKey) {
        tocKey = key;
        const top = Math.min(...tocHeadings.map((h) => Number(h.tagName[1])));
        toc.replaceChildren(
            ...tocHeadings.map((h) => {
                const a = document.createElement("a");
                a.href = `#${encodeURIComponent(h.id)}`;
                a.textContent = a.title = h.textContent.trim();
                a.dataset.depth = Number(h.tagName[1]) - top;
                return a;
            }),
        );
    }
    spy();
}

function spy() {
    const limit = 64;
    let lo = 0;
    let hi = tocHeadings.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tocHeadings[mid].getBoundingClientRect().top > limit) hi = mid;
        else lo = mid + 1;
    }
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) lo = tocHeadings.length;
    const active = toc.children[lo - 1];
    for (const a of toc.querySelectorAll(".active")) if (a !== active) a.classList.remove("active");
    if (!active || active.classList.contains("active")) return;
    active.classList.add("active");
    // Scrolls the list by hand, because scrollIntoView can also scroll the page.
    if (active.offsetTop < toc.scrollTop || active.offsetTop + active.offsetHeight > toc.scrollTop + toc.clientHeight)
        toc.scrollTop = active.offsetTop - toc.clientHeight / 2;
}

let spyFrame;
for (const event of ["scroll", "resize"])
    addEventListener(event, () => {
        cancelAnimationFrame(spyFrame);
        spyFrame = requestAnimationFrame(spy);
    });

function collapseToc(collapsed) {
    document.body.classList.toggle("toc-collapsed", collapsed);
    tocToggle.setAttribute("aria-expanded", String(!collapsed));
    try {
        localStorage.setItem("tocCollapsed", collapsed ? "1" : "");
    } catch {}
}

try {
    collapseToc(localStorage.getItem("tocCollapsed") === "1");
} catch {}
tocToggle.addEventListener("click", () => collapseToc(!document.body.classList.contains("toc-collapsed")));

// Each rendered block with its source lines and page position, in document order.
// cmark-gfm writes data-sourcepos as "startLine:startCol-endLine:endCol".
function sourceLines(el) {
    const [, start, end] = el.dataset.sourcepos.match(/^(\d+):\d+-(\d+):/);
    return [Number(start), Number(end)];
}

function blocks() {
    return [...content.querySelectorAll("[data-sourcepos]")].map((el) => {
        const [start, end] = sourceLines(el);
        const box = el.getBoundingClientRect();
        return { start, end, top: box.top + scrollY, bottom: box.bottom + scrollY };
    });
}

// Source lines and page offsets map linearly inside a block and inside the gap between two blocks.
function lineToY(line) {
    let prev;
    let next;
    for (const block of blocks()) {
        if (block.start > line) {
            next = block;
            break;
        }
        prev = block;
    }
    if (!prev) return 0;
    if (line <= prev.end)
        return prev.top + ((line - prev.start) / (prev.end - prev.start + 1)) * (prev.bottom - prev.top);
    if (!next) return prev.bottom;
    return prev.bottom + ((line - prev.end - 1) / (next.start - prev.end - 1)) * (next.top - prev.bottom);
}

function yToLine(y) {
    let prev;
    let next;
    for (const block of blocks()) {
        if (block.top > y) {
            next = block;
            break;
        }
        prev = block;
    }
    if (!prev) return 1;
    if (y < prev.bottom)
        return Math.round(prev.start + ((y - prev.top) / (prev.bottom - prev.top)) * (prev.end - prev.start + 1));
    if (!next) return prev.end;
    return Math.round(prev.end + 1 + ((y - prev.bottom) / (next.top - prev.bottom)) * (next.start - prev.end - 1));
}

const contentTop = () => content.getBoundingClientRect().top + scrollY;

// The scroll event that our own scrollTo causes must not go back to nvim, or the two sides chase each other.
let syncedY;

function syncTo(top) {
    scrollTo(0, lineToY(top) - contentTop());
    syncedY = scrollY;
}

let reportFrame;
addEventListener("scroll", () => {
    if (scrollY === syncedY) return;
    cancelAnimationFrame(reportFrame);
    reportFrame = requestAnimationFrame(() => {
        const top = yToLine(scrollY + contentTop());
        if (last) last[3] = top;
        webkit.messageHandlers.scroll.postMessage({ path: currentPath, top });
    });
});

let currentPath = "";
let pendingAnchor;
let restoring;

history.scrollRestoration = "manual";

let saveTimer;
function saveScroll() {
    clearTimeout(saveTimer);
    if (history.state) history.replaceState({ ...history.state, y: scrollY }, "");
}

// WebKit rate-limits replaceState, so the position is saved only once scrolling settles.
addEventListener("scroll", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveScroll, 300);
});

addEventListener("popstate", ({ state }) => {
    clearTimeout(saveTimer);
    if (!state) return;
    if (state.path === currentPath) return scrollTo(0, state.y);
    restoring = state;
    webkit.messageHandlers.open.postMessage({ path: state.path });
});

function scrollToAnchor(hash) {
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    const target = id && document.getElementById(id);
    target?.scrollIntoView();
    return Boolean(target);
}

const commentBox = document.getElementById("comment");
const commentLines = document.getElementById("comment-lines");
const commentText = document.getElementById("comment-text");
const commentStatus = document.getElementById("comment-status");
const commentListeners = document.getElementById("comment-listeners");
const toast = document.getElementById("toast");
let commentTarget;
let listeners;
let lastSpace = -Infinity;
let toastTimer;

// The source lines of the blocks that hold the selection. A partly selected block counts whole.
function selectedLines() {
    const selection = getSelection();
    if (selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const block = (node) => (node instanceof Element ? node : node.parentElement)?.closest("[data-sourcepos]");
    const first = block(range.startContainer);
    const last = block(range.endContainer);
    if (!first || !last || !content.contains(first) || !content.contains(last)) return;
    const [sline] = sourceLines(first);
    const [lastStart, lastEnd] = sourceLines(last);
    // A triple-click selection ends at offset 0 of the next block, which holds none of the selected text.
    const eline = range.endOffset === 0 && last !== first ? lastStart - 1 : lastEnd;
    return { sline, eline: Math.max(sline, eline), box: range.getBoundingClientRect() };
}

function openComment() {
    const lines = selectedLines();
    if (!lines) return;
    commentTarget = { path: currentPath, sline: lines.sline, eline: lines.eline };
    commentLines.textContent = lines.sline === lines.eline ? `Line ${lines.sline}` : `Lines ${lines.sline}-${lines.eline}`;
    commentStatus.textContent = "";
    const column = content.getBoundingClientRect();
    commentBox.style.top = `${lines.box.bottom + scrollY + 8}px`;
    commentBox.style.left = `${column.left + scrollX}px`;
    commentBox.style.width = `${column.width}px`;
    commentBox.hidden = false;
    commentText.focus();
}

function stopChoosing() {
    listeners = undefined;
    commentListeners.replaceChildren();
    commentStatus.textContent = "";
    commentText.readOnly = false;
}

function closeComment() {
    if (listeners) stopChoosing();
    commentText.blur();
    commentBox.hidden = true;
}

function sendComment(target) {
    const comment = commentText.value.trim();
    if (!comment) return;
    commentText.readOnly = true;
    commentStatus.textContent = "Sending to pi…";
    webkit.messageHandlers.comment.postMessage({ ...commentTarget, comment, target });
}

function pick(listener) {
    listeners = undefined;
    commentListeners.replaceChildren();
    sendComment(listener.sock);
}

function showToast(text) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = setTimeout(() => (toast.hidden = true), 2500);
}

document.addEventListener("keydown", (event) => {
    if (event.target === commentText || event.key !== " " || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || !selectedLines()) return;
    event.preventDefault();
    if (event.timeStamp - lastSpace < 1000) {
        lastSpace = -Infinity;
        openComment();
    } else lastSpace = event.timeStamp;
});

commentText.addEventListener("keydown", (event) => {
    if (listeners) {
        event.preventDefault();
        if (event.key === "Escape") stopChoosing();
        const matches = listeners.filter((listener) => listener.window === event.key);
        if (matches.length === 1) pick(matches[0]);
        return;
    }
    if (event.key === "Escape") {
        event.preventDefault();
        closeComment();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!commentText.readOnly) sendComment();
    }
});
commentText.addEventListener("focus", () => webkit.messageHandlers.editing.postMessage(true));
commentText.addEventListener("blur", () => webkit.messageHandlers.editing.postMessage(false));

window.mdview = {
    async update(html, baseHref, path, top) {
        last = [html, baseHref, path, top];
        const switched = path !== currentPath;
        let restoredY;
        if (switched) {
            if (restoring?.path === path) restoredY = restoring.y;
            else if (currentPath) {
                saveScroll();
                history.pushState({ path, y: 0 }, "");
            } else history.replaceState({ path, y: 0 }, "");
            restoring = undefined;
        }
        currentPath = path;
        const anchor = switched && pendingAnchor?.path === path ? pendingAnchor.hash : "";
        if (switched) pendingAnchor = undefined;
        base.href = baseHref;
        const previous = [...content.querySelectorAll(".mermaid")];
        content.innerHTML = html;
        content.querySelectorAll('pre > code[class*="language-"]:not(.language-mermaid)').forEach(highlight);
        alerts();
        taskLists();
        anchors();
        buildToc();
        const drawing = drawDiagrams(previous);
        if (switched) scrollTo(0, 0);
        const place = () => {
            if (restoredY !== undefined) scrollTo(0, restoredY);
            else if (!(anchor && scrollToAnchor(anchor))) syncTo(top);
        };
        place();
        await drawing;
        place();
        spy();
    },
    scroll(top) {
        last[3] = top;
        syncTo(top);
    },
    choose(choices) {
        if (commentBox.hidden) return;
        listeners = choices;
        commentStatus.textContent = "Send to which pi? Press its tmux window number, or Esc to go back.";
        commentListeners.replaceChildren(
            ...choices.map((listener) => {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = `${listener.window} ${listener.label}`;
                // Keeps focus in the textarea, so the viewer's key shortcuts stay off.
                button.addEventListener("mousedown", (event) => event.preventDefault());
                button.addEventListener("click", () => pick(listener));
                return button;
            }),
        );
    },
    sent(ok, info) {
        commentText.readOnly = false;
        if (!ok) {
            commentStatus.textContent = `Not sent: ${info}`;
            return;
        }
        commentText.value = "";
        closeComment();
        showToast(`pi: ${info}`);
    },
};

document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    const url = new URL(link.href);
    const file = url.protocol === "mdview:" && url.host === "file" ? decodeURIComponent(url.pathname) : null;
    // <base> points at the file's directory, so a bare `#id` would resolve to that directory, not to this page.
    if (link.getAttribute("href").startsWith("#") || file === currentPath) {
        event.preventDefault();
        saveScroll();
        if (scrollToAnchor(url.hash)) history.pushState({ path: currentPath, y: scrollY }, "");
        return;
    }
    if (file) pendingAnchor = { path: file, hash: url.hash };
});

dark.addEventListener("change", async () => {
    diagrams.clear();
    if (mermaidReady) {
        await mermaidReady;
        themeMermaid();
    }
    if (last) window.mdview.update(...last);
});
