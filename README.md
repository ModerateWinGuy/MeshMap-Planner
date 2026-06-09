# MeshMap Planner

## About

MeshMap Planner is an online utility for predicting the range of mesh radios. It is agnostic between **Meshcore** and **Meshtastic** and works with any LoRa-based mesh network. It creates radio coverage maps using the ITM/Longley-Rice model and SPLAT! software by John A. Magliacane, KD2BD (https://www.qsl.net/kd2bd/splat.html). The maps are used for planning repeater deployments and for estimating the coverage provided by an existing mesh network. The default parameters are derived from experimental data and practical experience with Meshtastic devices, and serve as sensible starting points for Meshcore and amateur radio projects too. Model parameters are adjustable, so this tool can also be used for amateur radio projects using different frequencies and higher transmit powers.

There is currently no hosted instance — see [Building](#building) below to run your own copy.

The terrain elevation tiles are streamed from AWS Open Data (https://registry.opendata.aws/terrain-tiles/), which are based on the NASA SRTM (Shuttle Radar Topography) dataset (https://www.earthdata.nasa.gov/data/instruments/srtm).


## Usage

The minimal steps for creating a mesh coverage prediction are:

1. Run a copy of the tool (see [Building](#building)) and open it in a web browser. 
2. In `Site Parameters > Site / Transmitter`, enter a name for the site, the geographic coordinates, and the antenna height above ground. Input the transmit power, frequency, and antenna gain for your device — for Meshtastic devices you can refer to the regional parameters (https://meshtastic.org/docs/configuration/region-by-country/). 
3. In `Site Parameters > Receiver`, enter the receiver sensitivity (`-130 dBm` for the default `LongFast` channel), the receiver height, and the receiver antenna gain.
4. In `Site Parameters > Receiver`, enter the maximum range for the simulation in kilometers. Selecting long ranges (> 50 kilometers) will result in longer computation times.
5. Press "Run Simulation." The coverage map will be displayed when the calculation completes. 

Multiple radio sites can be added to the simulation by repeating these steps. For a detailed explanation of the other adjustable parameters, refer to:

## Model and Assumptions

This tool runs a physics simulation that depends on several assumptions. The most important ones are:

1. The SRTM terrain model is accurate to 90 meters.
2. There are no obstructions besides terrain that attenuate radio signals. These include trees, artificial structures such as buildings, or transient effects like precipitation.
3. Antennas are isotropic in the horizontal plane (we do not account for directional antennas). 
4. Reflections from the upper atmosphere (skywave propagation) are negligible. This is less accurate when the signal frequency is low (less than approximately 50 MHz). 

A detailed description of the model parameters and their recommended values is available:

## Building

Requirements:

- Docker and Docker Compose
- Git
- pnpm

```bash
git clone --recurse-submodules https://github.com/ModerateWinGuy/MeshMap-Planner && cd MeshMap-Planner

pnpm i && pnpm run build

docker-compose up --build
```

For running a development server, use `pnpm run dev`.

## Credits

MeshMap Planner is a fork of the [Meshtastic Site Planner](https://github.com/meshtastic/meshtastic-site-planner) project — thanks to its authors for the original work, which made this tool possible.

Coverage predictions are powered by [SPLAT!](https://www.qsl.net/kd2bd/splat.html) by John A. Magliacane, KD2BD. This project is distributed under the GNU General Public License v3, carried over from the upstream project (see [LICENSE](LICENSE)).
