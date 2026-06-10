// Node pins for maplibregl.Marker, which takes a DOM element rather than a Leaflet-style icon.
// A plain <div> holding the 📍 emoji reproduces the old divIcon; selection state is a style
// mutation on the same element (markers are not churned — see store.renderNodeMarkers).

// Apply the selected/unselected look to an existing pin element. Selected pins are larger with a
// blue glow; unselected pins are the bare red pushpin.
export function stylePinElement(el: HTMLElement, selected: boolean): void {
  el.style.fontSize = selected ? '38px' : '30px';
  el.style.filter = selected ? 'drop-shadow(0 0 4px #00aaff)' : '';
  el.style.color = selected ? '' : 'red';
}

export function makePinElement(selected: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'node-pin';
  el.textContent = '📍';
  // anchor:'bottom' on the Marker puts the pin tip on the coordinate.
  stylePinElement(el, selected);
  return el;
}
