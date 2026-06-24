# MeshMap Planner

**▶ Live site: https://moderatewinguy.github.io/MeshMap-Planner/**

Runs entirely in your browser — nothing to install, no account, no server.

## About

MeshMap Planner is an online utility for predicting the range of mesh radios. It is agnostic between **Meshcore** and **Meshtastic** and works with any LoRa-based mesh network. It creates radio coverage maps using the ITM/Longley-Rice model — the classic propagation core from SPLAT! by John A. Magliacane, KD2BD (https://www.qsl.net/kd2bd/splat.html), compiled to WebAssembly and run **entirely in your browser**. The maps are used for planning repeater deployments and for estimating the coverage provided by an existing mesh network. The default parameters are derived from experimental data and practical experience with Meshtastic devices, and serve as sensible starting points for Meshcore and amateur radio projects too. Model parameters are adjustable, so this tool can also be used for amateur radio projects using different frequencies and higher transmit powers.

MeshMap Planner is a **static, browser-only single-page app** — there is no backend or server-side computation. The coverage map, link matrix, point-to-point profiles, relay siting, and viewshed all run client-side in a Web Worker.

A hosted instance is published from `main` to GitHub Pages at **https://moderatewinguy.github.io/MeshMap-Planner/**. To run or modify your own copy, see [Building](#building) below.

The terrain elevation tiles are streamed directly from Mapterhorn (https://mapterhorn.com/), a global terrain dataset built on the Copernicus GLO-30 DEM with higher-resolution national LiDAR baked in over many regions, including New Zealand.

## Usage

### Coverage

The minimal steps for creating a mesh coverage prediction are:

1. Open the [hosted site](https://moderatewinguy.github.io/MeshMap-Planner/) in a web browser (or run your own copy — see [Building](#building)).
2. Go to the settings tab and select your radio preset for your region
3. Add a node by right clicking on the map > Add node here, or by pressing A on the keyboard.
4. Drag the node to exactly where you want it if you need to adjust the position
5. Configure your node's settings in the node settings panel (In the nodes tab)
6. Go to the coverage tab and click "Run Simulation" or press the keyboard shortcut "C"
   
### Link Profile

To generate a link profile:

1. Add two nodes to the map
2. Select one, shift + click the other and then click "Calculate link & Show Profile"
3. You can go to the Links tab to fine tune your settings, or bulk calculate links on the map.
4. Click 3D and Links on the left hand side of the map will allow you to visualize all of the calculated links in 3D.

### Relay Finder
The relay finder calculates the coverage for two nodes and then shows where they overlap, for when you want to find a way to link two nodes.

Simply select one node, shift click another, and then you'll get a heatmap like the coverage map that shows the overlap. It'll also present some points that show some possible node locations with good margins that you can use to create nodes from.

Multiple radio sites can be added to the simulation by repeating these steps. For a detailed explanation of the other adjustable parameters, see [parameters.md](parameters.md).

## Model and Assumptions

This tool runs a physics simulation that depends on several assumptions. The most important ones are:

1. The terrain model is accurate to its source resolution, capped at the app's own terrain zoom ceiling. Mapterhorn bakes in higher-resolution national LiDAR/DEM datasets for many countries (e.g. ~4 m for New Zealand's LINZ data) over a ~30 m Copernicus GLO-30 baseline everywhere else — see Mapterhorn's [source attribution list](https://mapterhorn.com/attribution) for the full per-country breakdown.
2. There are no obstructions besides terrain that attenuate radio signals — trees, buildings, and transient effects like precipitation are not modeled directly (they can be approximated with the clutter-height parameter).
3. Antennas are isotropic in the horizontal plane (we do not account for directional antennas).
4. Reflections from the upper atmosphere (skywave propagation) are negligible. This is less accurate when the signal frequency is low (less than approximately 50 MHz).

A detailed description of the model parameters and their recommended values is in [parameters.md](parameters.md).

## Building

There is no backend: the RF model is compiled to WebAssembly and runs in the browser, and terrain streams directly from Mapterhorn. Building produces a static bundle you can host anywhere.

Requirements:

- Node 20.19+ / 22.12+ and [pnpm](https://pnpm.io/)

```bash
git clone https://github.com/ModerateWinGuy/MeshMap-Planner && cd MeshMap-Planner
pnpm install
```

### Development

```bash
pnpm dev        # Vite dev server with hot reload on http://localhost:5173
```

### Production build

```bash
pnpm build      # type-checks and bundles to dist/
```

Deploy the contents of `dist/` to any static host or CDN (GitHub Pages, Netlify, Vercel, S3 + CloudFront, nginx, …). No server, database, or container is required.

### Rebuilding the WASM model (optional)

The compiled RF core (`src/sim/itm/itm.js`) is committed, so a normal build never needs a C/C++ toolchain. To regenerate it from source (`wasm/itm/itwom3.0.cpp`, SPLAT's ITM), the only requirement is Docker:

```bash
sh wasm/itm/build.sh
```

See [wasm/itm/README.md](wasm/itm/README.md) for details and the validation procedure.

## Credits

MeshMap Planner is a fork of the [Meshtastic Site Planner](https://github.com/meshtastic/meshtastic-site-planner) project — thanks to its authors for the original work, which made this tool possible.

The propagation model is the ITM/Longley-Rice core from [SPLAT!](https://www.qsl.net/kd2bd/splat.html) by John A. Magliacane, KD2BD, compiled to WebAssembly. This project is distributed under the GNU General Public License v3, carried over from the upstream project (see [LICENSE](LICENSE)).
