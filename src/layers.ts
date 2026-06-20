// Node pins for maplibregl.Marker, which takes a DOM element. Each pin is a small name caption
// stacked above a Lucide MapPin SVG (monotone — recoloured/resized per selection); selection state
// and renames are style/text mutations on the same element (markers are not churned — see
// store.renderNodeMarkers). Selected pins lighten their own colour rather than switching to a
// fixed accent, so a folder's colour stays recognisable when one of its nodes is picked.
import { createElement, MapPin } from 'lucide';

// Base pin colour for an unselected, ungrouped node. A folder can override it (NodeGroup.color).
export const DEFAULT_PIN_COLOR = '#dc3545';

// Blend a hex colour toward white. Used to derive the selected look from the node's own colour
// (folder colour or the default red) rather than a fixed accent, so selection stays legible no
// matter what palette the folder picked.
function lighten(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

// Apply the selected/unselected look (and current name) to an existing pin element. Selected pins
// are larger with a glow, both derived from the node's own colour (folder colour, or the default
// red) lightened so the pick stays obvious without overriding the folder's palette. Colour drives
// the SVG stroke via currentColor; the drop-shadow keeps the monotone outline legible over busy
// basemaps.
export function stylePinElement(el: HTMLElement, selected: boolean, name: string, color?: string): void {
  const size = selected ? 38 : 30;
  const baseColor = color || DEFAULT_PIN_COLOR;
  const svg = el.querySelector('svg') as SVGElement | null;
  if (svg) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.style.filter = selected
      ? `drop-shadow(0 0 4px ${lighten(baseColor, 0.6)})`
      : 'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45))';
  }
  const label = el.querySelector('.node-pin-label') as HTMLElement | null;
  if (label) {
    label.textContent = name;
    // Cap the caption at twice the icon width so a long name can't sprawl across the map.
    label.style.maxWidth = `${size * 4}px`;
  }
  // currentColor drives the SVG stroke; the caption overrides this back to white in CSS.
  el.style.color = selected ? lighten(baseColor, 0.4) : baseColor;
}

export function makePinElement(selected: boolean, name: string, color?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'node-pin';
  const label = document.createElement('span');
  label.className = 'node-pin-label';
  el.appendChild(label);
  // MapPin's tip sits at the bottom-centre, so anchor:'bottom' on the Marker lands it on the coord.
  // display:block drops the inline-SVG baseline gap that would otherwise float the tip off the point.
  const svg = createElement(MapPin);
  svg.style.display = 'block';
  el.appendChild(svg);
  stylePinElement(el, selected, name, color);
  return el;
}
