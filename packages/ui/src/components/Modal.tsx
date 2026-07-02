import type { ComponentChildren } from "preact";
import { IconClose } from "../icons.js";

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  return (
    <div class="modal-scrim" onClick={props.onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: "1.1rem" }}>
          <h3 class="h-serif" style={{ margin: 0, fontSize: "1.35rem", flex: 1 }}>
            {props.title}
          </h3>
          <button class="btn btn-ghost btn-sm" style={{ minHeight: 0, padding: "0.35rem" }} onClick={props.onClose}>
            <IconClose />
          </button>
        </div>
        {props.children}
        {props.footer && (
          <div style={{ display: "flex", gap: "0.6rem", marginTop: "1.3rem", justifyContent: "flex-end" }}>
            {props.footer}
          </div>
        )}
      </div>
    </div>
  );
}
