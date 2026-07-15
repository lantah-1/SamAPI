function samApiIconSvg(accent: string, accentRaised: string, accentForeground: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="SamAPI">
  <defs>
    <linearGradient id="bg" x1="32" y1="6" x2="32" y2="58" gradientUnits="userSpaceOnUse">
      <stop stop-color="${accentRaised}"/>
      <stop offset="1" stop-color="${accent}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bg)"/>
  <path d="M32 10.5 48 17v13.5c0 10.2-6.9 19.7-16 23-9.1-3.3-16-12.8-16-23V17l16-6.5Z" fill="none" stroke="${accentForeground}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="m24.5 32.5 5.2 5.2 10.8-11.4" fill="none" stroke="${accentForeground}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

export function updateSiteChromeFromTheme() {
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--accent").trim() || "#0f766e";
  const accentRaised = styles.getPropertyValue("--accent-raised").trim() || accent;
  const accentForeground = styles.getPropertyValue("--accent-foreground").trim() || "#ffffff";
  const faviconHref = `data:image/svg+xml,${encodeURIComponent(samApiIconSvg(accent, accentRaised, accentForeground))}`;
  const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]') || document.createElement("link");
  iconLink.rel = "icon";
  iconLink.type = "image/svg+xml";
  iconLink.href = faviconHref;
  if (!iconLink.parentNode) document.head.appendChild(iconLink);

  const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]') || document.createElement("meta");
  themeColorMeta.name = "theme-color";
  themeColorMeta.content = accent;
  if (!themeColorMeta.parentNode) document.head.appendChild(themeColorMeta);
}
