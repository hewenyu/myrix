import { useEffect, useRef, type ReactNode } from "react";

/** Modal focus stays in the dialog and returns to the invoking control on close. */
export function Modal({ children, labelledBy, alert = false, onClose }: { children: ReactNode; labelledBy: string; alert?: boolean; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = panel.current;
    if (!element) return;
    const focusable = () => [...element.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']")];
    (element.querySelector<HTMLElement>("[data-initial-focus]") ?? focusable()[0] ?? element).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); element.focus(); return; }
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === element)) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && !element.contains(event.target)) (focusable()[0] ?? element).focus(); };
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", focus);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("focusin", focus); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop"><section ref={panel} className="create-book-dialog" role={alert ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>{children}</section></div>;
}
