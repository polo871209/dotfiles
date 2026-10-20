// Octicons copy-16 and check-16, https://github.com/primer/octicons
const COPY_ICON =
    '<svg class="mdview-copy-idle" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>' +
    '<svg class="mdview-copy-done" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

function addCopyButtons() {
    for (const pre of document.querySelectorAll(
        "pre:not(:has(> .mdview-copy))",
    )) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mdview-copy";
        button.title = "Copy";
        button.setAttribute("aria-label", "Copy code");
        button.innerHTML = COPY_ICON;
        pre.prepend(button);
    }
}

let pendingButtons = false;
new MutationObserver(() => {
    if (pendingButtons) return;
    pendingButtons = true;
    queueMicrotask(() => {
        pendingButtons = false;
        addCopyButtons();
    });
}).observe(document.documentElement, { childList: true, subtree: true });
addCopyButtons();

document.addEventListener(
    "click",
    (event) => {
        const button = event.target.closest?.(".mdview-copy");
        if (!button || !event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        const pre = button.parentElement;
        const text = (
            pre.querySelector(":scope > code") ?? pre
        ).textContent.replace(/\n$/, "");
        webkit.messageHandlers.copy.postMessage(text);
        button.classList.add("copied");
        clearTimeout(button.copiedTimer);
        button.copiedTimer = setTimeout(
            () => button.classList.remove("copied"),
            1500,
        );
    },
    true,
);
