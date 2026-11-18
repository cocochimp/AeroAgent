import { el } from "../components.js";

/** Accessible, DOM-only modal with focus restoration and explicit actions. */
export function openModal({ title, body, actions = [], onClose = () => {} } = {}) {
  const previousFocus = document.activeElement;
  let closed = false;
  const dialog = el("section", { class: "aa-modal", role: "dialog", "aria-modal": "true", "aria-label": title || "对话框" },
    el("header", { class: "aa-modal-header" }, el("h2", null, title || "确认"),
      el("button", { type: "button", class: "aa-icon-button", "aria-label": "关闭", onclick: () => close() }, "×")),
    el("div", { class: "aa-modal-body" }, body),
    actions.length ? el("footer", { class: "aa-modal-actions" }, actions.map((action) => el("button", {
      type: "button", class: action.primary ? "aa-button aa-button-primary" : "aa-button",
      disabled: action.disabled,
      onclick: async () => { if (action.onClick) await action.onClick(close); else close(); },
    }, action.label))) : null);
  const backdrop = el("div", { class: "aa-modal-backdrop", onclick: (event) => { if (event.target === backdrop) close(); } }, dialog);
  function onKey(event) { if (event.key === "Escape") close(); }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    previousFocus?.focus?.();
    onClose();
  }
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  dialog.querySelector("button, input, textarea, select")?.focus();
  return { close, dialog };
}

export function confirmDialog({ title, message, confirmLabel = "确认", danger = false } = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    openModal({ title, body: el("p", null, message), onClose: () => resolve(confirmed), actions: [
      { label: "取消" },
      { label: confirmLabel, primary: true, onClick: (close) => { confirmed = true; close(); } },
    ] });
    if (danger) document.querySelector(".aa-modal-actions .aa-button-primary")?.classList.add("aa-danger");
  });
}
