# Surface Urban Heat Island (SUHI) Germany

An interactive Cesium-based geospatial dashboard that visualises summer daytime Surface Urban Heat Island (SUHI) patterns across three German cities — Essen, Wuppertal, and Soest — for the years 2022 and 2024. The dashboard was developed as part of a Master's thesis in Geo-Information Science and Earth Observation at the Faculty ITC, University of Twente, to support exploratory analysis of urban heat dynamics and their environmental and morphological drivers.

## Features

- Interactive Cesium 3D map with terrain
- City and year switching (Essen, Wuppertal, Soest / 2022, 2024)
- Layer groups:
  - **Heat Stressors:** Land Surface Temperature (LST), Surface Urban Heat Island (SUHI), Hotspots
  - **Environmental Drivers:** NDVI, NDBI, MNDWI, Surface Albedo, Local Climate Zones (LCZ)
  - **Urban Morphometrics:** 3D Buildings
- Cloud-Optimised GeoTIFF (COG) rasters rendered client-side with custom colour ramps
- Gi\* hotspot/coldspot vector layers
- Click-to-read pixel values directly on the map
- Dark/light theme toggle
- English/German language toggle
- Per-layer info modals and a dashboard overview panel

## Data Sources

- **Optical imagery:** Sentinel-2 and Landsat
- **Local Climate Zones (LCZ):** WUDAPT dataset
- **3D buildings:** Cesium Ion
- **Gi\* hotspots and coldspots:** computed from LST using spatial statistics
- **Raster format:** all rasters are distributed as Cloud-Optimised GeoTIFFs (COG) in EPSG:4326

## Running Locally

The dashboard fetches COG rasters at runtime, so it must be served over HTTP — opening `index.html` directly via `file://` will not work.

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd SUHI_Germany
   ```
2. Serve the project root with any local HTTP server (for example, the **Live Server** extension in VS Code) and open `index.html` in your browser.

## Project Structure

```
SUHI_Germany/
├── index.html        # Dashboard markup and entry point
├── style.css         # Styling and theming
├── app.js            # Application logic (map, layers, interactions, i18n)
├── assets/           # Logos and static assets
└── data/
    ├── rasters/      # COG raster layers (LST, SUHI, NDVI, NDBI, MNDWI, Albedo, LCZ)
    └── Vector/       # Gi* hotspot/coldspot vector layers
```

## Cesium Ion Token

The dashboard initialises Cesium with an access token hardcoded near the top of `app.js` (line 1, `Cesium.Ion.defaultAccessToken = "..."`). The bundled token is tied to the author's Cesium Ion account and may be rate-limited, revoked, or expire at any time.

If you fork or deploy this project, replace it with your own token from [ion.cesium.com](https://ion.cesium.com/). Cesium Ion offers a free tier sufficient for terrain, 3D buildings, and base-map streaming.

## Author and Academic Context

**Saurabh Bhagchandani**
M.Sc. Geo-Information Science and Earth Observation
Faculty of Geo-Information Science and Earth Observation (ITC), University of Twente

This dashboard is part of the author's Master's thesis on Surface Urban Heat Island analysis in Germany.

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.
