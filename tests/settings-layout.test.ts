import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss, { type Container } from "postcss";

const stylesheet = postcss.parse(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));

function declarations(selector: string, scope: Container = stylesheet) {
  const values: Record<string, string> = {};
  for (const node of scope.nodes || []) {
    if (node.type !== "rule" || !node.selectors.includes(selector)) continue;
    node.walkDecls((declaration) => { values[declaration.prop] = declaration.value; });
  }
  return values;
}

function media(query: string) {
  const scopes = stylesheet.nodes.filter((node) => node.type === "atrule" && node.name === "media" && node.params === query);
  assert.ok(scopes.length, `missing explicit breakpoint ${query}`);
  return postcss.root({ nodes: scopes.flatMap((scope) => scope.type === "atrule" ? (scope.nodes || []).map((node) => node.clone()) : []) });
}

test("settings mobile layouts keep controls readable, forms single-column and sheet actions visible", () => {
  // These contracts complement real-browser layout checks and guard against later global overrides.
  const mobile = media("(max-width: 760px)");
  for (const selector of [".settings-entry-list", ".settings-detail-dialog .model-rule-target", ".settings-detail-dialog .model-rule-condition", ".settings-detail-dialog .theme-grid"]) {
    assert.equal(declarations(selector, mobile)["grid-template-columns"], "minmax(0, 1fr)", selector);
  }
  assert.equal(declarations(".settings-detail-dialog", mobile)["--settings-control-size"], "1rem", "16px controls avoid mobile focus zoom");
  assert.equal(declarations(".settings-detail-dialog", media("(hover: none) and (pointer: coarse)"))["--settings-control-size"], "1rem", "touch tablets need the same focus-zoom protection");
  assert.equal(declarations(".settings-detail-dialog .action")["min-height"], "44px");
  assert.equal(declarations(".settings-detail-dialog .model-rule-actions .action")["min-height"], "44px");
  assert.equal(declarations(".settings-detail-dialog .model-rule-conditions > .action")["min-height"], "44px");
  assert.equal(declarations(".settings-detail-dialog .field")["min-height"], "44px");
  assert.equal(declarations(".settings-dialog-body")["min-height"], "0");
  assert.equal(declarations(".settings-dialog-body")["overflow-y"], "auto");
  assert.equal(declarations(".settings-dialog-footer").flex, "0 0 auto");
  assert.match(declarations(".settings-detail-dialog", mobile)["max-height"], /--settings-viewport-height.*safe-area-inset-top/);
  assert.match(declarations(".settings-dialog-footer", mobile).padding, /safe-area-inset-bottom/);
  assert.equal(declarations(".settings-dialog-actions", mobile).width, "100%");
  assert.equal(declarations(".settings-detail-dialog[data-compact-viewport] .settings-dialog-parent").display, "none", "compact layout follows the visible viewport, including keyboard insets");
  assert.equal(declarations(".settings-detail-dialog .settings-retry-delay-fields", media("(max-width: 480px)"))["grid-template-columns"], "minmax(0, 1fr)");
});

type Color = [number, number, number, number];
function color(value: string): Color {
  if (value.startsWith("#")) return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).concat(1) as Color;
  const components = value.match(/[\d.]+/g)!.map(Number);
  return [components[0], components[1], components[2], components[3] ?? 1];
}
function over(foreground: Color, background: Color): Color {
  return [0, 1, 2].map((channel) => foreground[channel] * foreground[3] + background[channel] * (1 - foreground[3])).concat(1) as Color;
}
function luminance(rgb: Color) {
  return rgb.slice(0, 3).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a: Color, b: Color) {
  const light = luminance(a); const dark = luminance(b);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

test("settings theme tokens provide AA text, primary-action and field-boundary contrast in all five themes", () => {
  assert.equal(declarations(".settings-detail-dialog .action-primary").background, "var(--accent)");
  assert.equal(declarations(".settings-detail-dialog")["--settings-control-border"], "color-mix(in srgb, var(--muted) 85%, var(--surface-solid))");
  for (const theme of ["fresh", "salt", "citrus", "rose", "midnight"]) {
    const tokens = declarations(`:root[data-theme="${theme}"]`);
    const solid = color(tokens["--surface-solid"]);
    const field = over(color(tokens["--field-bg"]), solid);
    const soft = over(color(tokens["--surface-soft"]), solid);
    const border = over([...color(tokens["--muted"]).slice(0, 3), 0.85] as Color, solid);
    for (const [label, foreground, background, minimum] of [
      ["body", color(tokens["--ink"]), solid, 4.5],
      ["helper", color(tokens["--muted-strong"]), soft, 4.5],
      ["input", color(tokens["--ink"]), field, 4.5],
      ["placeholder", color(tokens["--muted-strong"]), field, 4.5],
      ["primary action", color(tokens["--accent-foreground"]), color(tokens["--accent"]), 4.5],
      ["input boundary", border, field, 3]
    ] as const) assert.ok(contrast(foreground, background) >= minimum, `${theme} ${label} contrast is ${contrast(foreground, background).toFixed(2)}`);
  }
});
