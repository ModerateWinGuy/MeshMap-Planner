// Node pins for maplibregl.Marker, which takes a DOM element. Each pin is a small name caption
// stacked above a Lucide MapPin SVG (monotone — recoloured/resized per selection); selection state
// and renames are style/text mutations on the same element (markers are not churned — see
// store.renderNodeMarkers).
import { createElement, MapPin } from 'lucide';

// Base pin colour for an unselected, ungrouped node. A folder can override it (NodeGroup.color).
export const DEFAULT_PIN_COLOR = '#dc3545';
// Selection always wins over the folder colour so the picked node stays obvious on any palette.
export const SELECTED_PIN_COLOR = '#fd7e14';

// Apply the selected/unselected look (and current name) to an existing pin element. Selected pins
// are larger and orange with a glow; unselected ones are smaller and take the folder colour (or the
// default red). Colour drives the SVG stroke via currentColor; the drop-shadow keeps the monotone
// outline legible over busy basemaps.
export function stylePinElement(el: HTMLElement, selected: boolean, name: string, color?: string): void {
  const size = selected ? 38 : 30;
  const svg = el.querySelector('svg') as SVGElement | null;
  if (svg) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.style.filter = selected
      ? 'drop-shadow(0 0 4px #ff922b)'
      : 'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45))';
  }
  const label = el.querySelector('.node-pin-label') as HTMLElement | null;
  if (label) {
    label.textContent = name;
    // Cap the caption at twice the icon width so a long name can't sprawl across the map.
    label.style.maxWidth = `${size * 4}px`;
  }
  // currentColor drives the SVG stroke; the caption overrides this back to white in CSS. Selected =
  // bright orange (matches the brand accent); otherwise the folder colour, falling back to red.
  el.style.color = selected ? SELECTED_PIN_COLOR : color || DEFAULT_PIN_COLOR;
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
