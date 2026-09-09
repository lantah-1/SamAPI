import { mobilePrimarySections, navGroups } from "../app/constants";
import type { Section } from "../app/types";
import { NavButton } from "./NavButton";

export function MainNavigation(props: { section: Section; onNavigate: (section: Section) => void }) {
  return (
    <nav className="app-nav-groups" aria-label="主导航">
      {navGroups.map((group) => (
        <div className="app-nav-group" key={group.label}>
          <div className="app-nav-group-label">{group.label}</div>
          {group.items.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={props.section === item.id}
              onClick={props.onNavigate}
              className={mobilePrimarySections.includes(item.id) ? "mobile-primary-nav" : ""}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
