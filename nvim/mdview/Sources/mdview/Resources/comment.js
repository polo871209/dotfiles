
const commentBox = document.createElement("form");
commentBox.id = "mdview-comment";
commentBox.hidden = true;
const linesLabel = document.createElement("div");
linesLabel.id = "mdview-comment-lines";
const commentText = document.createElement("textarea");
commentText.id = "mdview-comment-text";
commentText.rows = 3;
commentText.placeholder =
    "Comment for pi. Enter sends, Shift-Enter adds a line, Esc closes.";
const commentStatus = document.createElement("div");
commentStatus.id = "mdview-comment-status";
commentStatus.setAttribute("role", "status");
const listenerList = document.createElement("div");
listenerList.id = "mdview-comment-listeners";
commentBox.append(linesLabel, commentText, commentStatus, listenerList);
const toast = document.createElement("div");
toast.id = "mdview-toast";
toast.setAttribute("role", "status");
toast.hidden = true;
document.documentElement.append(commentBox, toast);

let commentTarget;
let listeners;
let lastSpace = -Infinity;
let toastTimer;

function currentPath() {
    return location.host === "file"
        ? decodeURIComponent(location.pathname)
        : document.documentElement.dataset.mdviewPath;
}

function isInline(el) {
    return getComputedStyle(el).display.startsWith("inline");
}

function sourceBlock(node) {
    let el = node instanceof Element ? node : node.parentElement;
    el = el?.closest("[data-sourcepos], [data-mdview-line]");
    while (
        el?.dataset.mdviewLine &&
        isInline(el) &&
        el.parentElement?.closest("[data-mdview-line]")
    )
        el = el.parentElement.closest("[data-mdview-line]");
    if (!el || commentBox.contains(el)) return;
    if (el.dataset.sourcepos) {
        const [, start, end] = el.dataset.sourcepos.match(/^(\d+):\d+-(\d+):/);
        return { el, start: Number(start), end: Number(end) };
    }
    const start = Number(el.dataset.mdviewLine);
    let end = start;
    let after;
    for (const other of document.querySelectorAll("[data-mdview-line]")) {
        if (
            !(
                el.compareDocumentPosition(other) &
                Node.DOCUMENT_POSITION_FOLLOWING
            )
        )
            continue;
        if (el.contains(other))
            end = Math.max(end, Number(other.dataset.mdviewLine));
        else {
            after = Number(other.dataset.mdviewLine);
            break;
        }
    }
    if (after !== undefined) end = Math.max(end, after - 1);
    return { el, start, end };
}

function selectedLines() {
    const selection = getSelection();
    if (selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const first = sourceBlock(range.startContainer);
    const last = sourceBlock(range.endContainer);
    if (!first || !last) return;
    // A triple-click selection ends at offset 0 of the next block, which holds none of the selected text.
    const eline =
        range.endOffset === 0 && last.el !== first.el
            ? last.start - 1
            : last.end;
    return {
        sline: first.start,
        eline: Math.max(first.start, eline),
        first: first.el,
        rect: range.getBoundingClientRect(),
    };
}

function column(first) {
    const content = document.querySelector("[data-mdview-column]");
    if (content) return content.getBoundingClientRect();
    for (let el = first; el; el = el.parentElement) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 360 || el === document.body) return rect;
    }
}

function openComment() {
    const lines = selectedLines();
    if (!lines) return;
    commentTarget = {
        path: currentPath(),
        sline: lines.sline,
        eline: lines.eline,
    };
    linesLabel.textContent =
        lines.sline === lines.eline
            ? `Line ${lines.sline}`
            : `Lines ${lines.sline}-${lines.eline}`;
    commentStatus.textContent = "";
    const rect = column(lines.first);
    const width = Math.min(Math.max(rect.width, 360), innerWidth - 32);
    const left = Math.min(Math.max(rect.left, 16), innerWidth - 16 - width);
    commentBox.style.setProperty(
        "top",
        `${lines.rect.bottom + scrollY + 8}px`,
        "important",
    );
    commentBox.style.setProperty("left", `${left + scrollX}px`, "important");
    commentBox.style.setProperty("width", `${width}px`, "important");
    commentBox.hidden = false;
    commentText.focus();
}

function stopChoosing() {
    listeners = undefined;
    listenerList.replaceChildren();
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
    webkit.messageHandlers.comment.postMessage({
        ...commentTarget,
        comment,
        target,
    });
}

function pick(listener) {
    listeners = undefined;
    listenerList.replaceChildren();
    sendComment(listener.sock);
}

function showToast(text) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = setTimeout(() => (toast.hidden = true), 2500);
}

addEventListener(
    "keydown",
    (event) => {
        if (
            !event.isTrusted ||
            event.target === commentText ||
            event.key !== " " ||
            event.repeat
        )
            return;
        if (event.metaKey || event.ctrlKey || event.altKey || !selectedLines())
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.timeStamp - lastSpace < 1000) {
            lastSpace = -Infinity;
            openComment();
        } else lastSpace = event.timeStamp;
    },
    true,
);

commentText.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (!event.isTrusted) return;
    if (listeners) {
        event.preventDefault();
        if (event.key === "Escape") stopChoosing();
        const matches = listeners.filter(
            (listener) => listener.window === event.key,
        );
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
commentText.addEventListener("focus", () =>
    webkit.messageHandlers.editing.postMessage(true),
);
commentText.addEventListener("blur", () =>
    webkit.messageHandlers.editing.postMessage(false),
);

window.mdviewComment = {
    choose(choices) {
        if (commentBox.hidden) return;
        listeners = choices;
        commentStatus.textContent =
            "Send to which pi? Press its Rex tab number, or Esc to go back.";
        listenerList.replaceChildren(
            ...choices.map((listener) => {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = `${listener.window} ${listener.label}`;
                button.addEventListener("mousedown", (event) =>
                    event.preventDefault(),
                );
                button.addEventListener(
                    "click",
                    (event) => event.isTrusted && pick(listener),
                );
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
