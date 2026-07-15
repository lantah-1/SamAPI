import type { Section } from "../app/types";
import type { allNavItems } from "../app/constants";

export function NavButton(props: { item: (typeof allNavItems)[number]; active: boolean; onClick: (section: Section) => void; className?: string }) {
  const Icon = props.item.icon;
  return (
    <button
      onClick={() => props.onClick(props.item.id)}
      title={props.item.label}
      className={`nav-button ${props.active ? "nav-button-active" : ""} ${props.className || ""}`}
    >
      <Icon className="h-5 w-5" />
      <span className="app-nav-label">{props.item.label}</span>
    </button>
  );
}
