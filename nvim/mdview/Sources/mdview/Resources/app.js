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

function reveal(line) {
    let target;
    for (const el of content.querySelectorAll("[data-sourcepos]")) {
        if (parseInt(el.dataset.sourcepos, 10) > line) break;
        target = el;
    }
    if (!target) return;
    const box = target.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight)
        target.scrollIntoView({ block: "center" });
}

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

window.mdview = {
    async update(html, baseHref, path, line) {
        last = [html, baseHref, path, line];
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
            else if (!(anchor && scrollToAnchor(anchor))) reveal(line);
        };
        place();
        await drawing;
        place();
        spy();
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
