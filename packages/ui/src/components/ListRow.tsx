import type { SourceType } from "@grounded/core/contract";
import { typeLabel } from "../util.js";

export function ListRow(props: {
  type: SourceType;
  title: string;
  meta?: string;
  pinned?: boolean;
  status?: string;
  statusColor?: string;
  onClick: () => void;
}) {
  return (
    <div class="row" onClick={props.onClick}>
      <span class={`type-tag ${props.type}`}>{typeLabel(props.type)}</span>
      {props.pinned && <span class="pin-dot">★</span>}
      <span class="row-title">{props.title}</span>
      {props.status && <span class="row-meta" style={{ color: props.statusColor }}>{props.status}</span>}
      {props.meta && <span class="row-meta">{props.meta}</span>}
    </div>
  );
}
