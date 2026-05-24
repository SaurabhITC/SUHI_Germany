
    Cesium.Ion.defaultAccessToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI2ODkyMTBkYy00ZWZhLTRiZTQtYWRkZi0wZmQxOWUyNmUyZTgiLCJpZCI6MzY2OTcxLCJpYXQiOjE3NzE1Mzc0MDh9.S7mUGUzu62Amq544e5YNF1s8lnYIwXSe3NzFBZe3zBU";

    const appFrameEl = document.getElementById("appFrame");
    const selectedInfo = document.getElementById("selectedInfo");
    const mapAreaEl = document.getElementById("mapArea");
    const valueOverlayEl = document.getElementById("lstValueOverlay");
    const valueNumberEl = document.getElementById("lstValueNumber");
    const valueUnitEl = document.getElementById("lstValueUnit");

    const TOPDOWN = { heading: 0.0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0.0 };

    const CITY_VIEWS = {
      ALL:       { lon: 7.50, lat: 51.43, height: 120000 },
      Essen:     { lon: 7.01, lat: 51.45, height: 45000  },
      Wuppertal: { lon: 7.17, lat: 51.26, height: 52000  },
      Soest:     { lon: 8.11, lat: 51.57, height: 65000  }
    };

    const ASSETS = [
      { id: 4469165, name: "Essen",     color: Cesium.Color.RED },
      { id: 4469163, name: "Wuppertal", color: Cesium.Color.RED },
      { id: 4469166, name: "Soest",     color: Cesium.Color.RED }
    ];

    const BUILDING_ASSET_IDS = {
      Wuppertal: 4470590,
      Essen: 4471126,
      Soest: 4471123
    };

    const HOTSPOT_BASE_PATH = "data/Vector/Hotspots";
    const HOTSPOT_FILE_SUFFIX = "70m_gistar_urbanOnly_hotcold_dissolved_4326.geojson";
    const HOTSPOT_DEFAULT_OPACITY = 0.7;
    const HOTSPOT_STYLES = {
      hotspot: {
        fill: "#ff5252",
        fillAlpha: 0.60,
        outline: "#b71c1c",
        outlineAlpha: 0.96,
        line: "#c62828",
        lineAlpha: 0.96
      },
      coldspot: {
        fill: "#3aa0ff",
        fillAlpha: 0.54,
        outline: "#0d47a1",
        outlineAlpha: 0.96,
        line: "#1565c0",
        lineAlpha: 0.96
      }
    };

    let selectedCity = "ALL";
    let selectedYear = "2024";
    let viewer = null;
    const loadedByName = new Map();

    const buildingTilesets = new Map();
    let buildingsEnabled = false;

    const DEFAULT_BUILDING_OPACITY = 1.00;
    let buildingOpacityRuntimeValue = DEFAULT_BUILDING_OPACITY;

    function clampBuildingOpacity(value){
      const num = Number(value);
      if (!Number.isFinite(num)) return DEFAULT_BUILDING_OPACITY;
      return Math.max(0, Math.min(1, num));
    }

    function getBuildingOpacity(){
      return clampBuildingOpacity(buildingOpacityRuntimeValue);
    }

    function setBuildingOpacity(value){
      buildingOpacityRuntimeValue = clampBuildingOpacity(value);
      return buildingOpacityRuntimeValue;
    }

    function buildBuildingCustomShader(opacity){
      const shaderConfig = {
        lightingModel: Cesium.LightingModel.UNLIT,
        uniforms: {
          u_opacity: {
            type: Cesium.UniformType.FLOAT,
            value: opacity
          }
        },
        fragmentShaderText: `
          void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
          {
            vec3 normalEC = normalize(fsInput.attributes.normalEC);

            float roofMask = smoothstep(0.58, 0.88, abs(normalEC.z));
            vec3 wallColor = vec3(0.58, 0.61, 0.64);
            vec3 roofColor = vec3(0.72, 0.74, 0.76);
            vec3 edgeColor = vec3(0.10, 0.11, 0.12);

            vec3 baseColor = mix(wallColor, roofColor, roofMask);

            float edgeFromNormals = length(fwidth(normalEC));
            float edgeFromRoofBreak = fwidth(roofMask);
            float edgeMask = smoothstep(0.10, 0.24, edgeFromNormals + edgeFromRoofBreak * 1.25);

            material.diffuse = mix(baseColor, edgeColor, edgeMask * 0.92);
            material.alpha = u_opacity;
          }
        `
      };

      if (Cesium.CustomShaderTranslucencyMode) {
        shaderConfig.translucencyMode = Cesium.CustomShaderTranslucencyMode.TRANSLUCENT;
      }

      return new Cesium.CustomShader(shaderConfig);
    }

    function applyBuildingAppearanceToTileset(ts){
      if (!ts) return;
      const opacity = getBuildingOpacity();

      if (ts.customShader && typeof ts.customShader.destroy === "function") {
        ts.customShader = ts.customShader.destroy();
      }
      ts.customShader = undefined;
      ts.style = undefined;

      try {
        ts.customShader = buildBuildingCustomShader(opacity);
      } catch (err) {
        console.warn("[3D Buildings] Edge shader failed, falling back to plain building color.", err);
        ts.customShader = undefined;
        ts.style = new Cesium.Cesium3DTileStyle({
          color: `color('#b8b8b8', ${opacity.toFixed(3)})`
        });
      }
    }

    function applyBuildingAppearance(){
      for (const [, ts] of buildingTilesets) {
        applyBuildingAppearanceToTileset(ts);
      }
      if (viewer && viewer.scene) viewer.scene.requestRender();
    }

    const hotspotRuntime = {
      requestedToken: 0,
      layersByUrl: new Map(),
      activeUrls: []
    };
    let hotspotOpacityRuntimeValue = HOTSPOT_DEFAULT_OPACITY;

    const RASTER_KEYS = ["lst", "suhi", "ndvi", "ndbi", "ndwi", "albedo", "lcz"];
    const AVAILABLE_RASTER_KEYS = ["lst", "suhi", "ndvi", "ndbi", "ndwi", "albedo", "lcz"];
    const rasterPriority = [];

    const rasterStates = {
      lst:   { imageryLayer: null, imageryLayers: [], currentUrl: null, currentUrls: [], currentCache: null, currentCaches: [], requestedToken: 0 },
      suhi:  { imageryLayer: null, imageryLayers: [], currentUrl: null, currentUrls: [], currentCache: null, currentCaches: [], requestedToken: 0 },
      ndvi:  { imageryLayer: null, imageryLayers: [], currentUrl: null, currentUrls: [], currentCache: null, currentCaches: [], requestedToken: 0 },
      ndbi:  { imageryLayer: null, imageryLayers: [], currentUrl: null, currentUrls: [], currentCache: null, currentCaches: [], requestedToken: 0 },
      ndwi:  { imageryLayer: null, imageryLayers: [], currentUrl: null, currentUrls: [], currentCache: null, currentCaches: [], requestedToken: 0 },
      albedo:{ imageryLayer: null, imageryLayers: [], currentUrl: null, currentUrls: [], currentCache: null, currentCaches: [], requestedToken: 0 },
      lcz:   { imageryLayer: null, imageryLayers: [], currentUrl: null, currentUrls: [], currentCache: null, currentCaches: [], requestedToken: 0 }
    };
    const rasterAssetCache = new Map();
    let rasterClickHandler = null;
    let valueOverlayCartesian = null;
    const CLICK_MARKER_STYLES = ["crosshair"];
    let currentClickMarkerStyle = "crosshair";
    let valueMarkerEntity = null;

    const LCZ_CLASSES = {
      1:  { code: "1",  alias: "LCZ 1",  label: "Compact high-rise",    color: [140,   0,   0] },
      2:  { code: "2",  alias: "LCZ 2",  label: "Compact mid-rise",     color: [209,   0,   0] },
      3:  { code: "3",  alias: "LCZ 3",  label: "Compact low-rise",     color: [255,   0,   0] },
      4:  { code: "4",  alias: "LCZ 4",  label: "Open high-rise",       color: [191,  77,   0] },
      5:  { code: "5",  alias: "LCZ 5",  label: "Open mid-rise",        color: [255, 102,   0] },
      6:  { code: "6",  alias: "LCZ 6",  label: "Open low-rise",        color: [255, 153,  85] },
      7:  { code: "7",  alias: "LCZ 7",  label: "Lightweight low-rise", color: [250, 238,   5] },
      8:  { code: "8",  alias: "LCZ 8",  label: "Large low-rise",       color: [188, 188, 188] },
      9:  { code: "9",  alias: "LCZ 9",  label: "Sparsely built",       color: [255, 204, 170] },
      10: { code: "10", alias: "LCZ 10", label: "Heavy industry",       color: [ 85,  85,  85] },
      11: { code: "11", alias: "LCZ A",  label: "Dense trees",          color: [  0, 106,   0] },
      12: { code: "12", alias: "LCZ B",  label: "Scattered trees",      color: [  0, 170,   0] },
      13: { code: "13", alias: "LCZ C",  label: "Bush / scrub",         color: [100, 133,  37] },
      14: { code: "14", alias: "LCZ D",  label: "Low plants",           color: [185, 219, 121] },
      15: { code: "15", alias: "LCZ E",  label: "Bare rock or paved",   color: [  0,   0,   0] },
      16: { code: "16", alias: "LCZ F",  label: "Bare soil or sand",    color: [251, 247, 174] },
      17: { code: "17", alias: "LCZ G",  label: "Water",                color: [106, 106, 255] }
    };
    const LCZ_LEGEND_ORDER = Object.keys(LCZ_CLASSES).map(Number).sort((a, b) => a - b);

    const RASTER_SPECS = {
      lst: {
        key: "lst",
        title: "LST",
        unit: "°C",
        alpha: 1.0,
        getDisplayRange(year){
          return String(year) === "2024"
            ? { min: 15, max: 37 }
            : { min: 15, max: 40 };
        },
        getLegendTicks(year){
          return String(year) === "2024"
            ? ["15", "20", "25", "30", "35", "37"]
            : ["15", "20", "25", "30", "35", "40+"];
        },
        getLegendColorScaleMax(year){
          return String(year) === "2024" ? 37 : 40;
        },
        legendNote: "Surface temperatures use year-specific ranges so the full LST palette spans 15–40+ °C in 2022 and 15–37 °C in 2024.",
        candidates(city, year){
          return [`data/rasters/LST/${year}_LST_${city}_c_4326_cog.tif`];
        }
      },
      suhi: {
        key: "suhi",
        title: "SUHI",
        unit: "°C",
        alpha: 1.0,
        displayRange: { min: -10, max: 13 },
        legendTicks: ["-10", "-5", "0", "5", "10", "13"],
        legendNote: "Negative values indicate cooler urban surfaces than the reference; positive values indicate hotter surfaces.",
        candidates(city, year){
          return [`data/rasters/SUHI/${year}_SUHI_${city}_4326_cog.tif`];
        }
      },
      ndvi: {
        key: "ndvi",
        title: "NDVI",
        unit: "",
        alpha: 1.0,
        displayRange: { min: -1, max: 1 },
        legendTicks: ["-1", "-0.5", "0", "0.5", "1"],
        legendNote: "Lower values represent sparse/non-vegetated surfaces; higher values represent denser greenness.",
        candidates(city, year){
          return [
            `data/rasters/NDVI/NDVI_${city}_${year}_10m_4326_cog.tif`,
            `data/rasters/NDVI/NDVI_${city}_${year}_20m_4326_cog.tif`,
            `data/rasters/NDVI/${year}_NDVI_${city}_10m_4326_cog.tif`,
            `data/rasters/NDVI/${year}_NDVI_${city}_20m_4326_cog.tif`
          ];
        }
      },
      ndbi: {
        key: "ndbi",
        title: "NDBI",
        unit: "",
        alpha: 1.0,
        displayRange: { min: -1, max: 1 },
        legendTicks: ["-1", "-0.5", "0", "0.5", "1"],
        legendNote: "Lower values usually correspond more to vegetation or water; higher values indicate stronger built-up signatures.",
        candidates(city, year){
          const yOrder = Array.from(new Set([year, "2024", "2022"]));
          const out = [];
          for (const yy of yOrder) {
            out.push(`data/rasters/NDBI/NDBI_${city}_${yy}_20m_4326_cog.tif`);
            out.push(`data/rasters/NDBI/NDBI_${city}_${yy}_10m_4326_cog.tif`);
            out.push(`data/rasters/NDBI/${yy}_NDBI_${city}_20m_4326_cog.tif`);
            out.push(`data/rasters/NDBI/${yy}_NDBI_${city}_10m_4326_cog.tif`);
          }
          return out;
        }
      },
      ndwi: {
        key: "ndwi",
        title: "MNDWI",
        unit: "",
        alpha: 1.0,
        displayRange: { min: -1, max: 1 },
        legendTicks: ["-1", "-0.5", "0", "0.5", "1"],
        legendNote: "Lower values represent drier or built surfaces; higher values show stronger water signatures.",
        candidates(city, year){
          const yOrder = Array.from(new Set([year, "2024", "2022"]));
          const out = [];
          for (const yy of yOrder) {
            out.push(`data/rasters/MNDWI/MNDWI_${city}_${yy}_20m_4326_cog.tif`);
            out.push(`data/rasters/MNDWI/MNDWI_${city}_${yy}_10m_4326_cog.tif`);
            out.push(`data/rasters/MNDWI/${yy}_MNDWI_${city}_20m_4326_cog.tif`);
            out.push(`data/rasters/MNDWI/${yy}_MNDWI_${city}_10m_4326_cog.tif`);
          }
          out.push(`data/rasters/MNDWI/MNDWI_${city}_20m_4326_cog.tif`);
          out.push(`data/rasters/MNDWI/MNDWI_${city}_10m_4326_cog.tif`);
          return out;
        }
      },
      albedo: {
        key: "albedo",
        title: "Albedo",
        unit: "",
        alpha: 1.0,
        displayRange: { min: 0.05, max: 0.30 },
        legendTicks: ["0.05", "0.10", "0.15", "0.20", "0.25", "0.30"],
        legendNote: "Display stretch fixed to 0.05–0.30 for readability across all city-year maps; click values remain raw albedo values.",
        candidates(city, year){
          return [
            `data/rasters/Albedo/Albedo_${city}_${year}_4326_cog.tif`,
            `data/rasters/Albedo/ALBEDO_${city}_${year}_4326_cog.tif`
          ];
        }
      },
      lcz: {
        key: "lcz",
        title: "LCZ",
        alpha: 1.0,
        allowAllCities: true,
        renderMode: "categorical",
        nodataValue: 0,
        classMap: LCZ_CLASSES,
        candidates(){
          return ["data/rasters/LCZ/LCZ_COG.tif"];
        },
        formatValue(value){
          const cls = LCZ_CLASSES[Math.round(value)];
          if (!cls) return { primary: `Class ${Math.round(value)}`, secondary: "LCZ" };
          const secondary = Number(cls.code) >= 11 ? `${cls.label} (${cls.alias})` : cls.label;
          return { primary: `Class ${cls.code}`, secondary };
        }
      }
    };

    // LST ramp variant: inferno-style high contrast thermal
    const RASTER_COLOR_STOPS = {
      lst: [
        [0.00, [0, 0, 4]],
        [0.15, [31, 12, 72]],
        [0.35, [85, 15, 109]],
        [0.55, [136, 34, 106]],
        [0.72, [186, 54, 85]],
        [0.86, [227, 89, 51]],
        [0.94, [249, 140, 10]],
        [1.00, [252, 255, 164]],

      ],
      suhi: [
        [0.00, [49, 54, 149]],
        [0.18, [69, 117, 180]],
        [0.34, [171, 217, 233]],
        [0.4348, [235, 247, 250]],
        [0.50, [255, 245, 235]],
        [0.64, [254, 224, 144]],
        [0.80, [244, 109, 67]],
        [1.00, [215, 48, 39]]
      ],
      ndvi: [
        [0.00, [120, 72, 32]],
        [0.28, [191, 140, 74]],
        [0.50, [246, 232, 153]],
        [0.72, [167, 209, 120]],
        [1.00, [26, 120, 52]]
      ],
      ndbi: [
        [0.00, [15, 63, 112]],
        [0.16, [49, 105, 166]],
        [0.34, [156, 202, 236]],
        [0.47, [233, 242, 248]],
        [0.50, [247, 245, 239]],
        [0.55, [248, 223, 183]],
        [0.68, [238, 165, 83]],
        [0.82, [201, 108, 34]],
        [1.00, [116, 58, 18]]
      ],
      ndwi: [
        [0.00, [143, 84, 44]],
        [0.30, [222, 192, 141]],
        [0.50, [245, 245, 245]],
        [0.72, [144, 224, 239]],
        [1.00, [32, 84, 173]]
      ],
      albedo: [
        [0.00, [8, 48, 107]],
        [0.25, [33, 102, 172]],
        [0.50, [78, 161, 214]],
        [0.75, [170, 210, 230]],
        [1.00, [242, 248, 255]]
      ]
    };

    function markRasterPriority(key){
      const idx = rasterPriority.indexOf(key);
      if (idx >= 0) rasterPriority.splice(idx, 1);
      rasterPriority.push(key);
    }

    function getTopVisibleRasterKey(){
      for (let i = rasterPriority.length - 1; i >= 0; i--) {
        const key = rasterPriority[i];
        const rs = rasterStates[key];
        if (AVAILABLE_RASTER_KEYS.includes(key) && getLayerEnabled(key) && hasVisibleRasterState(rs) && getRasterCaches(rs).length) {
          return key;
        }
      }
      for (const key of RASTER_KEYS) {
        const rs = rasterStates[key];
        if (AVAILABLE_RASTER_KEYS.includes(key) && getLayerEnabled(key) && hasVisibleRasterState(rs) && getRasterCaches(rs).length) {
          return key;
        }
      }
      return null;
    }

    async function urlExists(url){
      try {
        let res = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (res.ok) return true;
      } catch {}
      try {
        const res = await fetch(url, { method: "GET", cache: "no-store" });
        if (res.ok) return true;
      } catch {}
      return false;
    }

    async function resolveRasterUrl(layerKey, city, year){
      const spec = RASTER_SPECS[layerKey];
      if (!spec) return null;
      const candidates = spec.candidates(city, year);
      for (const url of candidates) {
        if (await urlExists(url)) return url;
      }
      return null;
    }

    function getLayerEnabled(key){
      const el = document.querySelector(`.layerSwitch[data-layer="${key}"]`);
      return !!el?.checked;
    }

    function getRasterLayers(state){
      if (!state) return [];
      if (Array.isArray(state.imageryLayers) && state.imageryLayers.length) {
        return state.imageryLayers.filter(Boolean);
      }
      return state.imageryLayer ? [state.imageryLayer] : [];
    }

    function getRasterCaches(state){
      if (!state) return [];
      if (Array.isArray(state.currentCaches) && state.currentCaches.length) {
        return state.currentCaches.filter(Boolean);
      }
      return state.currentCache ? [state.currentCache] : [];
    }

    function clearRasterStateRefs(state){
      if (!state) return;
      state.imageryLayer = null;
      state.imageryLayers = [];
      state.currentUrl = null;
      state.currentUrls = [];
      state.currentCache = null;
      state.currentCaches = [];
    }

    function setRasterSingleState(state, layer, url, cache){
      clearRasterStateRefs(state);
      state.imageryLayer = layer || null;
      state.imageryLayers = layer ? [layer] : [];
      state.currentUrl = url || null;
      state.currentUrls = url ? [url] : [];
      state.currentCache = cache || null;
      state.currentCaches = cache ? [cache] : [];
    }

    function setRasterMultiState(state, layers, urls, caches){
      clearRasterStateRefs(state);
      state.imageryLayers = Array.isArray(layers) ? layers.filter(Boolean) : [];
      state.imageryLayer = state.imageryLayers[0] || null;
      state.currentUrls = Array.isArray(urls) ? urls.slice() : [];
      state.currentUrl = state.currentUrls[0] || null;
      state.currentCaches = Array.isArray(caches) ? caches.filter(Boolean) : [];
      state.currentCache = state.currentCaches[0] || null;
    }

    function hideRasterStateLayers(state){
      for (const layer of getRasterLayers(state)) {
        layer.show = false;
      }
    }

    function removeRasterStateLayers(state){
      if (!state || !viewer) {
        clearRasterStateRefs(state);
        return;
      }
      for (const layer of getRasterLayers(state)) {
        viewer.imageryLayers.remove(layer, false);
      }
      clearRasterStateRefs(state);
    }

    function hasVisibleRasterState(state){
      return getRasterLayers(state).some(layer => !!layer?.show);
    }

    function sameStringArrays(a, b){
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    function computeFiniteMinMax(values, nodataValue){
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v) || (Number.isFinite(nodataValue) && v === nodataValue)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
      if (min === max) return { min, max: min + 1 };
      return { min, max };
    }

    function lerp(a, b, t){ return a + (b - a) * t; }

    function interpolateColorStops(stops, t){
      const x = Math.max(0, Math.min(1, t));
      for (let i = 0; i < stops.length - 1; i++) {
        const [t0, c0] = stops[i];
        const [t1, c1] = stops[i + 1];
        if (x >= t0 && x <= t1) {
          const u = (x - t0) / (t1 - t0 || 1);
          return [
            Math.round(lerp(c0[0], c1[0], u)),
            Math.round(lerp(c0[1], c1[1], u)),
            Math.round(lerp(c0[2], c1[2], u))
          ];
        }
      }
      return stops[stops.length - 1][1];
    }

    function getRasterDisplayRange(spec, fallback, year = selectedYear){
      if (typeof spec?.getDisplayRange === "function") {
        const range = spec.getDisplayRange(year);
        if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
          return { min: range.min, max: range.max };
        }
      }
      if (spec?.displayRange && Number.isFinite(spec.displayRange.min) && Number.isFinite(spec.displayRange.max)) {
        return { min: spec.displayRange.min, max: spec.displayRange.max };
      }
      return fallback;
    }

    function getRasterLegendTicks(spec, year = selectedYear){
      if (typeof spec?.getLegendTicks === "function") {
        const ticks = spec.getLegendTicks(year);
        if (Array.isArray(ticks) && ticks.length) return ticks;
      }
      if (Array.isArray(spec?.legendTicks) && spec.legendTicks.length) return spec.legendTicks;
      const range = getRasterDisplayRange(spec, { min: 0, max: 1 }, year);
      return [String(range.min), String(range.max)];
    }

    function getRasterColor(key, value, min, max){
      const span = (max - min) || 1;
      const tt = Math.max(0, Math.min(1, (value - min) / span));
      const stops = RASTER_COLOR_STOPS[key] || RASTER_COLOR_STOPS.lst;
      return interpolateColorStops(stops, tt);
    }

    function truncateColorStops(stops, maxT){
      const clampedMax = Math.max(0, Math.min(1, maxT));
      if (clampedMax <= 0) return [[0, stops[0][1]], [1, stops[0][1]]];
      if (clampedMax >= 1) return stops;
      const out = [];
      for (let i = 0; i < stops.length; i++) {
        const [t, color] = stops[i];
        if (t < clampedMax) out.push([t, color]);
        if (t === clampedMax) {
          out.push([t, color]);
          break;
        }
        if (t > clampedMax) {
          out.push([clampedMax, interpolateColorStops(stops, clampedMax)]);
          break;
        }
      }
      if (!out.length) out.push([0, interpolateColorStops(stops, clampedMax)]);
      const lastT = out[out.length - 1][0] || clampedMax;
      return out.map(([t, color]) => [t / lastT, color]);
    }

    function getLegendGradientStops(key, year = selectedYear){
      const spec = RASTER_SPECS[key];
      const baseStops = RASTER_COLOR_STOPS[key] || RASTER_COLOR_STOPS.lst;
      if (typeof spec?.getLegendColorScaleMax === "function") {
        const legendMax = spec.getLegendColorScaleMax(year);
        const displayRange = getRasterDisplayRange(spec, { min: 0, max: 1 }, year);
        const span = (displayRange.max - displayRange.min) || 1;
        if (Number.isFinite(legendMax) && legendMax < displayRange.max) {
          const frac = (legendMax - displayRange.min) / span;
          return truncateColorStops(baseStops, frac);
        }
      }
      return baseStops;
    }

    function buildLegendGradientCss(key, year = selectedYear){
      const stops = getLegendGradientStops(key, year);
      const parts = stops.map(([t, color]) => `${rgbToCss(color)} ${Math.round(t * 1000) / 10}%`);
      return `linear-gradient(90deg, ${parts.join(', ')})`;
    }

    function buildCanvasFromFloatRaster(values, width, height, min, max, nodataValue, layerKey){
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: false });
      const img = ctx.createImageData(width, height);
      const rgba = img.data;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const j = i * 4;
        const isNoData = !Number.isFinite(v) || (Number.isFinite(nodataValue) && v === nodataValue);
        if (isNoData) {
          rgba[j + 0] = 0;
          rgba[j + 1] = 0;
          rgba[j + 2] = 0;
          rgba[j + 3] = 0;
          continue;
        }
        const [r, g, b] = getRasterColor(layerKey, v, min, max);
        rgba[j + 0] = r;
        rgba[j + 1] = g;
        rgba[j + 2] = b;
        rgba[j + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    }

    function buildCanvasFromCategoricalRaster(values, width, height, nodataValue, classMap){
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: false });
      const img = ctx.createImageData(width, height);
      const rgba = img.data;

      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const j = i * 4;
        const classValue = Math.round(v);
        const cls = classMap[classValue];
        const isNoData = !Number.isFinite(v) || (Number.isFinite(nodataValue) && v === nodataValue) || !cls;
        if (isNoData) {
          rgba[j + 0] = 0;
          rgba[j + 1] = 0;
          rgba[j + 2] = 0;
          rgba[j + 3] = 0;
          continue;
        }
        const [r, g, b] = cls.color;
        rgba[j + 0] = r;
        rgba[j + 1] = g;
        rgba[j + 2] = b;
        rgba[j + 3] = 255;
      }

      ctx.putImageData(img, 0, 0);
      return canvas;
    }


    function normalizeClickMarkerStyle(style){
      return "crosshair";
    }

    function makeSvgDataUri(svg){
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    function buildClickMarkerSvg(style){
      const markerStyle = normalizeClickMarkerStyle(style);

      if (markerStyle === "pin") {
        return `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <path d="M32 4C21.23 4 12.5 12.73 12.5 23.5 12.5 38.3 32 60 32 60s19.5-21.7 19.5-36.5C51.5 12.73 42.77 4 32 4Z"
                  fill="#FFD54F" stroke="#1F2937" stroke-width="4" stroke-linejoin="round"/>
            <circle cx="32" cy="23.5" r="6.5" fill="#1F2937"/>
          </svg>
        `.trim();
      }

      if (markerStyle === "crosshair") {
        return `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="16" fill="#FFD54F" fill-opacity="0.28" stroke="#1F2937" stroke-width="4"/>
            <path d="M32 8V20M32 44V56M8 32H20M44 32H56" stroke="#1F2937" stroke-width="4" stroke-linecap="round"/>
            <circle cx="32" cy="32" r="5" fill="#1F2937"/>
          </svg>
        `.trim();
      }

      return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="18" fill="#FFD54F" fill-opacity="0.88" stroke="#1F2937" stroke-width="4"/>
          <circle cx="32" cy="32" r="5" fill="#1F2937"/>
        </svg>
      `.trim();
    }

    function getClickMarkerBillboardOptions(style){
      const markerStyle = normalizeClickMarkerStyle(style);
      const isPin = markerStyle === "pin";
      return {
        image: makeSvgDataUri(buildClickMarkerSvg(markerStyle)),
        width: isPin ? 28 : 26,
        height: isPin ? 38 : 26,
        verticalOrigin: isPin ? Cesium.VerticalOrigin.BOTTOM : Cesium.VerticalOrigin.CENTER,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      };
    }

    function ensureValueMarkerEntity(){
      if (!viewer) return null;
      if (!valueMarkerEntity) {
        valueMarkerEntity = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(0, 0),
          show: false,
          billboard: new Cesium.BillboardGraphics(getClickMarkerBillboardOptions(currentClickMarkerStyle))
        });
      }
      return valueMarkerEntity;
    }

    function applyClickMarkerStyle(){
      const entity = ensureValueMarkerEntity();
      if (!entity?.billboard) return;
      const opts = getClickMarkerBillboardOptions(currentClickMarkerStyle);
      entity.billboard.image = opts.image;
      entity.billboard.width = opts.width;
      entity.billboard.height = opts.height;
      entity.billboard.verticalOrigin = opts.verticalOrigin;
      entity.billboard.heightReference = opts.heightReference;
      entity.billboard.disableDepthTestDistance = opts.disableDepthTestDistance;
    }

    function showValueMarker(lon, lat){
      const entity = ensureValueMarkerEntity();
      if (!entity) return;
      entity.position = Cesium.Cartesian3.fromDegrees(lon, lat);
      applyClickMarkerStyle();
      entity.show = true;
    }

    function hideValueMarker(){
      if (valueMarkerEntity) valueMarkerEntity.show = false;
    }

    function updateClickMarkerButtons(){
      return;
    }

    function setClickMarkerStyle(style, persist = true){
      currentClickMarkerStyle = "crosshair";
      applyClickMarkerStyle();
    }

    function createClickMarkerControls(){
      setClickMarkerStyle("crosshair", false);
    }

    function removeValueLabel(){
      valueOverlayCartesian = null;
      valueOverlayEl.classList.remove("show");
      valueOverlayEl.style.left = "-9999px";
      valueOverlayEl.style.top = "-9999px";
      hideValueMarker();
    }

    function isNoData(v, nodataValue){
      return !Number.isFinite(v) || (Number.isFinite(nodataValue) && v === nodataValue);
    }

    function lonLatToRasterPixel(cache, lon, lat){
      if (!cache) return null;
      const { bbox, width, height } = cache;
      const [minX, minY, maxX, maxY] = bbox;
      if (lon < minX || lon > maxX || lat < minY || lat > maxY) return null;

      let x = Math.floor(((lon - minX) / (maxX - minX)) * width);
      let y = Math.floor(((maxY - lat) / (maxY - minY)) * height);

      x = Math.max(0, Math.min(width - 1, x));
      y = Math.max(0, Math.min(height - 1, y));
      return { x, y, index: y * width + x };
    }

    function updateValueOverlayScreenPosition(){
      if (!viewer || !valueOverlayCartesian) return;
      const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, valueOverlayCartesian);
      if (!Cesium.defined(windowPos) || !Number.isFinite(windowPos.x) || !Number.isFinite(windowPos.y)) {
        valueOverlayEl.classList.remove("show");
        return;
      }
      const rect = mapAreaEl.getBoundingClientRect();
      const x = windowPos.x;
      const y = windowPos.y;
      const padding = 4;
      if (x < -padding || y < -padding || x > rect.width + padding || y > rect.height + padding) {
        valueOverlayEl.classList.remove("show");
        return;
      }
      valueOverlayEl.style.left = `${x}px`;
      valueOverlayEl.style.top = `${y}px`;
      valueOverlayEl.classList.add("show");
    }

    function showValueLabel(lon, lat, primaryText, secondaryText = ""){
      valueNumberEl.textContent = primaryText;
      valueUnitEl.textContent = secondaryText || "";
      valueUnitEl.style.display = secondaryText ? "" : "none";
      valueOverlayCartesian = Cesium.Cartesian3.fromDegrees(lon, lat);
      showValueMarker(lon, lat);
      updateValueOverlayScreenPosition();
    }

    function formatRasterValue(spec, value){
      if (typeof spec?.formatValue === "function") return spec.formatValue(value);
      const decimals = Number.isInteger(spec?.valueDecimals) ? spec.valueDecimals : 2;
      return {
        primary: Number.isFinite(value) ? value.toFixed(decimals) : "No data",
        secondary: spec?.unit || ""
      };
    }

    async function loadRasterAsset(url, spec, layerKey){
      if (rasterAssetCache.has(url)) return rasterAssetCache.get(url);

      const tiff = await GeoTIFF.fromUrl(url);
      const image = await tiff.getImage();
      const width = image.getWidth();
      const height = image.getHeight();
      const bbox = image.getBoundingBox();
      const nodataRaw = image.getGDALNoData();
      const nodataParsed = nodataRaw == null ? null : Number(nodataRaw);
      const nodataValue = Number.isFinite(spec?.nodataValue) ? spec.nodataValue : nodataParsed;
      const rasters = await image.readRasters({ interleave: true });
      const values = (rasters instanceof Float32Array || rasters instanceof Float64Array) ? rasters : Float32Array.from(rasters);
      const mm = computeFiniteMinMax(values, nodataValue);
      const displayRange = getRasterDisplayRange(spec, mm, selectedYear);
      const canvas = spec?.renderMode === "categorical"
        ? buildCanvasFromCategoricalRaster(values, width, height, nodataValue, spec.classMap || {})
        : buildCanvasFromFloatRaster(values, width, height, displayRange.min, displayRange.max, nodataValue, layerKey);
      const dataUrl = canvas.toDataURL("image/png");
      const rectangle = Cesium.Rectangle.fromDegrees(bbox[0], bbox[1], bbox[2], bbox[3]);
      const asset = {
        width, height, bbox, nodataValue, values,
        min: mm.min, max: mm.max,
        displayMin: displayRange.min, displayMax: displayRange.max,
        dataUrl, rectangle
      };
      rasterAssetCache.set(url, asset);
      console.log(`[Raster] ${spec?.title || "Raster"} loaded`, { url, width, height, bbox, min: mm.min, max: mm.max, nodata: nodataRaw });
      return asset;
    }

    async function ensureRasterLayerForSelection(key){
      const spec = RASTER_SPECS[key];
      const state = rasterStates[key];
      if (!spec || !state || !viewer) return;

      const allowsAllCities = !!spec.allowAllCities;
      if (!getLayerEnabled(key)) {
        hideRasterStateLayers(state);
        if (getTopVisibleRasterKey() !== key) removeValueLabel();
        return;
      }

      if (selectedCity === "ALL" && !allowsAllCities) {
        const token = ++state.requestedToken;
        const cityUrls = [];

        for (const assetMeta of ASSETS) {
          const url = await resolveRasterUrl(key, assetMeta.name, selectedYear);
          if (url) cityUrls.push(url);
        }

        if (token !== state.requestedToken) return;

        if (!cityUrls.length) {
          console.warn(`[Raster] No source found for ${key} ALL ${selectedYear}`);
          hideRasterStateLayers(state);
          if (getTopVisibleRasterKey() !== key) removeValueLabel();
          return;
        }

        const existingLayers = getRasterLayers(state);
        const existingCaches = getRasterCaches(state);
        if (sameStringArrays(state.currentUrls || [], cityUrls) && existingLayers.length === cityUrls.length && existingCaches.length === cityUrls.length) {
          for (const layer of existingLayers) {
            layer.show = true;
            layer.alpha = getRasterOpacity(key);
            viewer.imageryLayers.raiseToTop(layer);
          }
          markRasterPriority(key);
          return;
        }

        const loaded = [];
        for (const url of cityUrls) {
          const asset = await loadRasterAsset(url, spec, key);
          if (token !== state.requestedToken) return;
          loaded.push({ url, asset });
        }

        removeRasterStateLayers(state);

        const layers = [];
        for (const item of loaded) {
          const provider = new Cesium.SingleTileImageryProvider({
            url: item.asset.dataUrl,
            rectangle: item.asset.rectangle
          });
          const layer = viewer.imageryLayers.addImageryProvider(provider);
          layer.alpha = getRasterOpacity(key);
          layer.show = true;
          layers.push(layer);
          viewer.imageryLayers.raiseToTop(layer);
        }

        setRasterMultiState(state, layers, loaded.map(item => item.url), loaded.map(item => item.asset));
        if (layers[0]) registerLayer(key, layers[0]);
        markRasterPriority(key);
        return;
      }

      const token = ++state.requestedToken;
      const url = await resolveRasterUrl(key, selectedCity, selectedYear);

      if (token !== state.requestedToken) return;

      if (!url) {
        console.warn(`[Raster] No source found for ${key} ${selectedCity} ${selectedYear}`);
        hideRasterStateLayers(state);
        if (getTopVisibleRasterKey() !== key) removeValueLabel();
        return;
      }

      const existingLayers = getRasterLayers(state);
      const existingCaches = getRasterCaches(state);
      if (state.currentUrl === url && existingLayers.length === 1 && existingCaches.length === 1) {
        for (const layer of existingLayers) {
          layer.show = true;
          layer.alpha = getRasterOpacity(key);
          viewer.imageryLayers.raiseToTop(layer);
        }
        markRasterPriority(key);
        return;
      }

      const asset = await loadRasterAsset(url, spec, key);
      if (token !== state.requestedToken) return;

      removeRasterStateLayers(state);

      const provider = new Cesium.SingleTileImageryProvider({
        url: asset.dataUrl,
        rectangle: asset.rectangle
      });

      const layer = viewer.imageryLayers.addImageryProvider(provider);
      layer.alpha = getRasterOpacity(key);
      layer.show = true;

      setRasterSingleState(state, layer, url, asset);

      registerLayer(key, layer);
      viewer.imageryLayers.raiseToTop(layer);
      markRasterPriority(key);
    }

    async function refreshRasterLayers(){
      const jobs = [];
      for (const key of AVAILABLE_RASTER_KEYS) {
        jobs.push(ensureRasterLayerForSelection(key));
      }

      try {
        await Promise.all(jobs);
      } catch (err) {
        console.error("Raster refresh failed:", err);
      }

      if (!getTopVisibleRasterKey()) removeValueLabel();
      renderLegend();
    }


    function getHotspotParentEnabled(){
      return getLayerEnabled("hotspots");
    }

    function getHotspotChildEnabled(type){
      return getLayerEnabled(type === "coldspot" ? "hotspots_cold" : "hotspots_hot");
    }

    function getDesiredHotspotCities(){
      if (selectedCity === "ALL") return ASSETS.map((asset) => asset.name);
      return [selectedCity];
    }

    function buildHotspotUrl(city, year){
      return `${HOTSPOT_BASE_PATH}/${year}_${city}_${HOTSPOT_FILE_SUFFIX}`;
    }

    async function resolveHotspotRequests(){
      const requests = [];
      for (const city of getDesiredHotspotCities()) {
        const url = buildHotspotUrl(city, selectedYear);
        if (await urlExists(url)) requests.push({ city, year: selectedYear, url });
      }
      return requests;
    }

    function normalizeSpotValue(value){
      return String(value ?? "").trim().toLowerCase().replace(/[_\s-]+/g, "");
    }

    function classifyHotspotFeature(propsLike){
      const props = propsLike || {};
      const keys = ["spot", "type", "spot_type", "spottype", "category", "class", "hs_cs", "hscs", "label", "cluster_type", "cluster"];
      for (const key of keys) {
        if (!(key in props)) continue;
        const norm = normalizeSpotValue(props[key]);
        if (!norm) continue;
        if (norm.includes("cold")) return "coldspot";
        if (norm.includes("hot")) return "hotspot";
      }

      const numericKeys = ["gi_bin", "gibin", "bin", "zscore", "z_score", "value"];
      for (const key of numericKeys) {
        if (!(key in props)) continue;
        const num = Number(props[key]);
        if (!Number.isFinite(num)) continue;
        if (num < 0) return "coldspot";
        if (num > 0) return "hotspot";
      }

      return null;
    }

    function flattenRingDegrees(ring){
      if (!Array.isArray(ring)) return [];
      const out = [];
      for (const coord of ring) {
        if (!Array.isArray(coord) || coord.length < 2) continue;
        const lon = Number(coord[0]);
        const lat = Number(coord[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        out.push(lon, lat);
      }
      return out.length >= 6 ? out : [];
    }

    function buildHoleHierarchy(rings){
      const holes = [];
      for (const ring of rings || []) {
        const flat = flattenRingDegrees(ring);
        if (!flat.length) continue;
        holes.push(new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)));
      }
      return holes;
    }

    function buildPolygonHierarchyFromRings(rings){
      if (!Array.isArray(rings) || !rings.length) return null;
      const outerFlat = flattenRingDegrees(rings[0]);
      if (!outerFlat.length) return null;
      return new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(outerFlat),
        buildHoleHierarchy(rings.slice(1))
      );
    }

    function restyleHotspotEntity(entity){
      const spotType = entity.__spotType || "hotspot";
      const style = getHotspotStyle(spotType);

      if (entity.polygon) {
        entity.polygon.material = style.fill;
        entity.polygon.outline = true;
        entity.polygon.outlineColor = style.outline;
        entity.polygon.outlineWidth = 2;
        entity.polygon.classificationType = Cesium.ClassificationType.BOTH;
        entity.polygon.zIndex = spotType === "hotspot" ? 24 : 23;
      }

      if (entity.polyline) {
        entity.polyline.material = style.line;
        entity.polyline.width = 2.5;
        entity.polyline.clampToGround = true;
      }
    }

    function hotspotDescriptionHtml(label, city, year){
      return `
        <div style="font-family:system-ui,Segoe UI,Roboto,Arial;font-size:13px;line-height:1.45;">
          <div><strong>Type:</strong> ${label}</div>
          <div><strong>City:</strong> ${city}</div>
          <div><strong>Year:</strong> ${year}</div>
        </div>`;
    }

    function createHotspotEntity(hierarchy, spotType, city, year, props, partIndex){
      const label = spotType === "coldspot" ? "Coldspot" : "Hotspot";

      const entity = viewer.entities.add({
        name: `${city} ${year} ${label}`,
        show: false,
        description: hotspotDescriptionHtml(label, city, year),
        properties: {
          ...props,
          spot: props?.spot ?? spotType,
          __spotType: spotType,
          __cityName: city,
          __yearValue: year,
          __partIndex: partIndex
        },
        polygon: {
          hierarchy,
          outline: true
        }
      });

      entity.__spotType = spotType;
      entity.__cityName = city;
      entity.__yearValue = year;
      entity.__partIndex = partIndex;
      restyleHotspotEntity(entity);

      return entity;
    }

    function buildHotspotEntitiesFromFeature(feature, request){
      const geometry = feature?.geometry;
      const props = feature?.properties || {};
      const spotType = classifyHotspotFeature(props) || "hotspot";
      if (!geometry) return [];

      let polygons = [];
      if (geometry.type === "Polygon") {
        polygons = [geometry.coordinates];
      } else if (geometry.type === "MultiPolygon") {
        polygons = geometry.coordinates;
      } else {
        return [];
      }

      const entities = [];
      let partIndex = 0;

      for (const rings of polygons) {
        const hierarchy = buildPolygonHierarchyFromRings(rings);
        if (!hierarchy) continue;
        entities.push(createHotspotEntity(hierarchy, spotType, request.city, request.year, props, partIndex));
        partIndex += 1;
      }

      return entities;
    }

    async function ensureHotspotLayer(request){
      const cached = hotspotRuntime.layersByUrl.get(request.url);
      if (cached) return cached;

      const response = await fetch(request.url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Hotspot GeoJSON not found: ${request.url}`);
      }

      const geojson = await response.json();
      const entities = [];
      for (const feature of geojson?.features || []) {
        entities.push(...buildHotspotEntitiesFromFeature(feature, request));
      }

      const record = {
        ...request,
        entities
      };

      hotspotRuntime.layersByUrl.set(request.url, record);
      return record;
    }

    function applyHotspotVisibility(){
      const parentOn = getHotspotParentEnabled();
      const activeUrlSet = new Set(hotspotRuntime.activeUrls || []);
      const hotOn = getHotspotChildEnabled("hotspot");
      const coldOn = getHotspotChildEnabled("coldspot");

      for (const [url, record] of hotspotRuntime.layersByUrl) {
        const layerVisible = parentOn && activeUrlSet.has(url);

        for (const entity of record.entities || []) {
          const type = entity.__spotType || "hotspot";
          entity.show = layerVisible && ((type === "hotspot" && hotOn) || (type === "coldspot" && coldOn));
        }
      }

      renderLegend();
    }

    async function refreshHotspotLayers(){
      if (!viewer) return;

      const parentOn = getHotspotParentEnabled();
      if (!parentOn) {
        hotspotRuntime.activeUrls = [];
        applyHotspotVisibility();
        return;
      }

      const token = ++hotspotRuntime.requestedToken;
      const requests = await resolveHotspotRequests();
      if (token !== hotspotRuntime.requestedToken) return;

      hotspotRuntime.activeUrls = requests.map((item) => item.url);

      try {
        for (const request of requests) {
          await ensureHotspotLayer(request);
          if (token !== hotspotRuntime.requestedToken) return;
        }
      } catch (err) {
        console.error("Hotspot layer load failed:", err);
      }

      applyHotspotVisibility();
    }

    function ringContainsLonLat(ring, lon, lat){
      if (!Array.isArray(ring) || ring.length < 3) return false;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersects = ((yi > lat) !== (yj > lat)) &&
          (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
        if (intersects) inside = !inside;
      }
      return inside;
    }

    function polygonEntityContainsLonLat(entity, lon, lat){
      const hierarchy = entity?.polygon?.hierarchy?.getValue?.(Cesium.JulianDate.now());
      if (!hierarchy?.positions?.length) return false;

      const outerRing = hierarchy.positions.map((pos) => {
        const carto = Cesium.Cartographic.fromCartesian(pos);
        return [Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)];
      });

      if (!ringContainsLonLat(outerRing, lon, lat)) return false;

      const holes = hierarchy.holes || [];
      for (const hole of holes) {
        const holePositions = hole?.positions || hole?.getValue?.(Cesium.JulianDate.now())?.positions || [];
        if (!holePositions.length) continue;
        const holeRing = holePositions.map((pos) => {
          const carto = Cesium.Cartographic.fromCartesian(pos);
          return [Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)];
        });
        if (ringContainsLonLat(holeRing, lon, lat)) return false;
      }

      return true;
    }

    function detectCityAtLonLat(lon, lat){
      for (const [cityName, ds] of loadedByName) {
        for (const entity of ds.entities.values) {
          if (polygonEntityContainsLonLat(entity, lon, lat)) return cityName;
        }
      }
      return null;
    }

    function syncPillSelection(containerId, dataKey, value){
      const el = document.getElementById(containerId);
      if (!el) return;
      el.querySelectorAll('button').forEach((btn) => {
        const isActive = btn.dataset[dataKey] === value;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    function setupRasterClickValueHandler(){
      if (rasterClickHandler || !viewer) return;

      rasterClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      rasterClickHandler.setInputAction(async (movement) => {
        const ray = viewer.camera.getPickRay(movement.position);
        if (!ray) {
          removeValueLabel();
          return;
        }

        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) {
          removeValueLabel();
          return;
        }

        const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
        const lon = Cesium.Math.toDegrees(cartographic.longitude);
        const lat = Cesium.Math.toDegrees(cartographic.latitude);

        if (selectedCity === "ALL") {
          const clickedCity = detectCityAtLonLat(lon, lat);
          if (clickedCity && clickedCity !== selectedCity) {
            selectedCity = clickedCity;
            syncPillSelection("cityPills", "city", clickedCity);
            removeValueLabel();
            await handleSelectionChange({ flyToCity: true });
            return;
          }
        }

        const topKey = getTopVisibleRasterKey();
        if (!topKey) {
          removeValueLabel();
          return;
        }

        const state = rasterStates[topKey];
        const spec = RASTER_SPECS[topKey];
        const caches = getRasterCaches(state);
        if (!caches.length) {
          removeValueLabel();
          return;
        }

        let px = null;
        let value = null;
        for (const cache of caches) {
          const candidatePx = lonLatToRasterPixel(cache, lon, lat);
          if (!candidatePx) continue;
          const candidateValue = cache.values[candidatePx.index];
          if (isNoData(candidateValue, cache.nodataValue)) continue;
          px = candidatePx;
          value = candidateValue;
          break;
        }
        if (!px || !Number.isFinite(value)) {
          removeValueLabel();
          return;
        }

        const formatted = formatRasterValue(spec, value);
        showValueLabel(lon, lat, formatted.primary, formatted.secondary);
        console.log(`[Raster click] ${topKey}:`, value, "pixel:", px.x, px.y);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function flyToCityTopDownFallback(key){
      const v = CITY_VIEWS[key] || CITY_VIEWS.ALL;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height),
        orientation: TOPDOWN,
        duration: 1.0
      });
    }

    function collectBoundaryPoints(ds){
      const pts = [];
      const now = Cesium.JulianDate.now();
      for (const e of ds.entities.values) {
        if (e.polyline?.positions) {
          const arr = e.polyline.positions.getValue(now);
          if (arr && arr.length) pts.push(...arr);
          continue;
        }
        if (e.polygon?.hierarchy) {
          const h = e.polygon.hierarchy.getValue(now);
          const arr = h?.positions || h?.getValue?.(now)?.positions;
          if (arr && arr.length) pts.push(...arr);
        }
      }
      return pts;
    }

    function flyToBoundaryTopDown(city){
      if (!viewer) return;

      const HOME_ZOOM = {
        ALL:       { mult: 2.6, min: 140000 },
        Wuppertal: { mult: 2.4, min: 42000 },
        Essen:     { mult: 2.2, min: 42000 },
        Soest:     { mult: 2.3, min: 34000 }
      };

      const cfg = HOME_ZOOM[city] || HOME_ZOOM.ALL;

      if (city === "ALL") {
        const allPts = [];
        for (const [, ds] of loadedByName) allPts.push(...collectBoundaryPoints(ds));
        if (!allPts.length) return flyToCityTopDownFallback("ALL");

        const bs0 = Cesium.BoundingSphere.fromPoints(allPts);
        const rect = Cesium.Rectangle.fromCartesianArray(allPts);
        const c = Cesium.Rectangle.center(rect);
        const spanLat = rect.north - rect.south;
        const PAN_SOUTH_FRAC = 0.12;
        const baseH = Cesium.Cartographic.fromCartesian(bs0.center).height;
        let newLat = c.latitude - spanLat * PAN_SOUTH_FRAC;
        newLat = Cesium.Math.clamp(newLat, -Cesium.Math.PI_OVER_TWO + 1e-6, Cesium.Math.PI_OVER_TWO - 1e-6);
        const shiftedCenter = Cesium.Cartesian3.fromRadians(c.longitude, newLat, baseH);
        const bs = new Cesium.BoundingSphere(shiftedCenter, bs0.radius);
        const range = Math.max(bs.radius * cfg.mult, cfg.min);

        return viewer.camera.flyToBoundingSphere(bs, {
          duration: 1.0,
          offset: new Cesium.HeadingPitchRange(0.0, -Cesium.Math.PI_OVER_TWO, range)
        });
      }

      const ds = loadedByName.get(city);
      if (!ds) return flyToCityTopDownFallback(city);

      const pts = collectBoundaryPoints(ds);
      if (!pts.length) return viewer.flyTo(ds, { duration: 1.0 });

      const bs = Cesium.BoundingSphere.fromPoints(pts);
      const range = Math.max(bs.radius * cfg.mult, cfg.min);

      viewer.camera.flyToBoundingSphere(bs, {
        duration: 1.0,
        offset: new Cesium.HeadingPitchRange(0.0, -Cesium.Math.PI_OVER_TWO, range)
      });
    }

    function applyBoundaryVisibility(){
      if (loadedByName.size === 0) return;
      if (selectedCity === "ALL") {
        for (const [, ds] of loadedByName) ds.show = true;
        return;
      }
      for (const [name, ds] of loadedByName) ds.show = (name === selectedCity);
    }

    async function ensureBuildingTileset(city){
      const assetId = BUILDING_ASSET_IDS[city];
      if (!assetId) return null;
      if (buildingTilesets.has(city)) return buildingTilesets.get(city);

      console.log(`[3D Buildings] Loading tileset for ${city} (asset ${assetId})...`);
      const ts = await Cesium.Cesium3DTileset.fromIonAssetId(assetId);
      ts.show = false;
      ts.shadows = Cesium.ShadowMode.ENABLED;
      applyBuildingAppearanceToTileset(ts);

      viewer.scene.primitives.add(ts);
      buildingTilesets.set(city, ts);

      console.log(`[3D Buildings] Loaded ${city}.`);
      return ts;
    }

    async function ensureAllBuildingTilesets(){
      const cities = Object.keys(BUILDING_ASSET_IDS).filter(c => BUILDING_ASSET_IDS[c]);
      for (const c of cities) await ensureBuildingTileset(c);
    }

    async function updateBuildingsVisibility(){
      if (!viewer) return;
      for (const [, ts] of buildingTilesets) ts.show = false;
      if (!buildingsEnabled) return;

      if (selectedCity === "ALL") {
        await ensureAllBuildingTilesets();
        for (const [, ts] of buildingTilesets) ts.show = true;
      } else {
        await ensureBuildingTileset(selectedCity);
        const ts = buildingTilesets.get(selectedCity);
        if (ts) ts.show = true;
      }
    }

    async function handleSelectionChange(options = {}){
      const { flyToCity = false } = options;

      updateSelectedLabel();
      applyBoundaryVisibility();

      if (flyToCity) {
        flyToBoundaryTopDown(selectedCity);
      }

      await refreshRasterLayers();
      await refreshHotspotLayers();
      void updateBuildingsVisibility().catch(err => console.error("[3D Buildings] update failed:", err));
      console.log("Selection:", selectedCity, selectedYear);
    }

    async function addBoundaryFromIon(assetId, color, name) {
      const resource = await Cesium.IonResource.fromAssetId(assetId);
      const ds = await Cesium.GeoJsonDataSource.load(resource, { clampToGround: true });
      ds.name = name;
      viewer.dataSources.add(ds);

      const now = Cesium.JulianDate.now();

      for (const e of ds.entities.values) {
        e.cityName = name;

        if (e.polygon) {
          e.polygon.material = Cesium.Color.TRANSPARENT;
          e.polygon.outline = false;

          const h = e.polygon.hierarchy?.getValue(now);
          if (h?.positions?.length) {
            const closed = h.positions.concat([h.positions[0]]);
            e.polyline = new Cesium.PolylineGraphics({
              positions: closed,
              width: 4,
              material: color,
              clampToGround: true
            });
          }
        }

        if (e.polyline) {
          e.polyline.material = color;
          e.polyline.width = 4;
          e.polyline.clampToGround = true;
        }
      }

      return ds;
    }

    function setupPills(containerId, dataKey, onChange){
      const el = document.getElementById(containerId);
      el.addEventListener("click", (e) => {
        const btn = e.target.closest(`button[data-${dataKey}]`);
        if (!btn) return;

        el.querySelectorAll("button").forEach(b => {
          const isActive = (b === btn);
          b.classList.toggle("active", isActive);
          b.setAttribute("aria-pressed", isActive ? "true" : "false");
        });

        onChange(btn.dataset[dataKey]);
      });
    }

    const LAYER_REGISTRY = {
      lst: null,
      suhi: null,
      hotspots: null,
      hotspots_hot: null,
      hotspots_cold: null,
      ndvi: null,
      ndbi: null,
      ndwi: null,
      albedo: null,
      lcz: null,
      buildings3d: null
    };

    function setVisible(obj, on){
      if (!obj) return;
      if (typeof obj.show === "boolean") { obj.show = on; return; }
      if ("show" in obj) obj.show = on;
    }

    function getLayerState(){
      try { return JSON.parse(localStorage.getItem("layerState") || "{}"); }
      catch { return {}; }
    }
    function setLayerState(state){
      localStorage.setItem("layerState", JSON.stringify(state));
    }

    const DEFAULT_RASTER_OPACITY = 0.7;
    let rasterOpacityRuntimeState = Object.create(null);

    function getRasterOpacityState(){
      return rasterOpacityRuntimeState;
    }

    function setRasterOpacityState(state){
      rasterOpacityRuntimeState = { ...state };
    }

    function clampRasterOpacity(value){
      const num = Number(value);
      if (!Number.isFinite(num)) return DEFAULT_RASTER_OPACITY;
      return Math.max(0, Math.min(1, num));
    }

    function getRasterOpacity(key){
      const state = getRasterOpacityState();
      return clampRasterOpacity(state[key] ?? DEFAULT_RASTER_OPACITY);
    }

    function setRasterOpacity(key, value){
      const opacity = clampRasterOpacity(value);
      const state = getRasterOpacityState();
      state[key] = opacity;
      setRasterOpacityState(state);
      return opacity;
    }

    function clampHotspotOpacity(value){
      const num = Number(value);
      if (!Number.isFinite(num)) return HOTSPOT_DEFAULT_OPACITY;
      return Math.max(0, Math.min(1, num));
    }

    function getHotspotOpacity(){
      return clampHotspotOpacity(hotspotOpacityRuntimeValue);
    }

    function setHotspotOpacity(value){
      hotspotOpacityRuntimeValue = clampHotspotOpacity(value);
      return hotspotOpacityRuntimeValue;
    }

    function hotspotColorWithOpacity(css, alpha){
      return Cesium.Color.fromCssColorString(css).withAlpha(Math.max(0, Math.min(1, alpha)));
    }

    function getHotspotStyle(spotType){
      const base = HOTSPOT_STYLES[spotType] || HOTSPOT_STYLES.hotspot;
      const opacity = getHotspotOpacity();
      return {
        fill: hotspotColorWithOpacity(base.fill, base.fillAlpha * opacity),
        outline: hotspotColorWithOpacity(base.outline, Math.min(1, Math.max(base.outlineAlpha * opacity, 0.55))),
        line: hotspotColorWithOpacity(base.line, Math.min(1, Math.max(base.lineAlpha * opacity, 0.60)))
      };
    }

    function updateHotspotOpacityControlVisibility(isOn){
      const control = document.querySelector('.opacityControl[data-opacity-control="hotspots"]');
      if (control) control.classList.toggle('open', !!isOn);
    }

    function applyRasterOpacity(key, value){
      const opacity = clampRasterOpacity(value);
      const rs = rasterStates[key];
      for (const layer of getRasterLayers(rs)) {
        layer.alpha = opacity;
      }
      const control = document.querySelector(`.opacityControl[data-opacity-control="${key}"]`);
      if (control) {
        const range = control.querySelector('.opacityRange');
        const valueEl = control.querySelector('.opacityValue');
        if (range && Number(range.value) !== Math.round(opacity * 100)) {
          range.value = String(Math.round(opacity * 100));
        }
        if (valueEl) valueEl.textContent = `${Math.round(opacity * 100)}%`;
      }
    }

    function updateOpacityControlVisibility(key, isOn){
      const control = document.querySelector(`.opacityControl[data-opacity-control="${key}"]`);
      if (control) control.classList.toggle('open', !!isOn);
    }

    function createOpacityControls(){
      for (const key of RASTER_KEYS) {
        const row = document.querySelector(`.layerRow[data-toggle-row="${key}"]`);
        if (!row || row.nextElementSibling?.matches?.(`.opacityControl[data-opacity-control="${key}"]`)) continue;

        const control = document.createElement('div');
        control.className = 'opacityControl';
        control.dataset.opacityControl = key;
        control.innerHTML = `
          <span class="opacityLabel">Opacity</span>
          <input class="opacityRange" type="range" min="0" max="100" step="1" value="70" aria-label="${key} opacity" />
          <span class="opacityValue">70%</span>`;

        control.addEventListener('click', (e) => e.stopPropagation());
        const range = control.querySelector('.opacityRange');
        range.addEventListener('input', (e) => {
          const opacity = setRasterOpacity(key, Number(e.target.value) / 100);
          applyRasterOpacity(key, opacity);
        });

        row.insertAdjacentElement('afterend', control);
        applyRasterOpacity(key, getRasterOpacity(key));
        updateOpacityControlVisibility(key, getLayerEnabled(key));
      }
    }

    function applyHotspotOpacity(value){
      const opacity = setHotspotOpacity(value);
      for (const record of hotspotRuntime.layersByUrl.values()) {
        for (const entity of record.entities || []) {
          restyleHotspotEntity(entity);
        }
      }
      const control = document.querySelector('.opacityControl[data-opacity-control="hotspots"]');
      if (control) {
        const range = control.querySelector('.opacityRange');
        const valueEl = control.querySelector('.opacityValue');
        const pct = Math.round(opacity * 100);
        if (range && Number(range.value) !== pct) range.value = String(pct);
        if (valueEl) valueEl.textContent = `${pct}%`;
      }
      renderLegend();
      return opacity;
    }

    function createHotspotOpacityControl(){
      const row = document.querySelector('.layerRow[data-toggle-row="hotspots"]');
      if (!row || document.querySelector('.opacityControl[data-opacity-control="hotspots"]')) return;

      const control = document.createElement('div');
      control.className = 'opacityControl';
      control.dataset.opacityControl = 'hotspots';
      control.innerHTML = `
        <span class="opacityLabel">Opacity</span>
        <input class="opacityRange" type="range" min="0" max="100" step="1" value="70" aria-label="Hotspots opacity" />
        <span class="opacityValue">70%</span>`;

      control.addEventListener('click', (e) => e.stopPropagation());
      const range = control.querySelector('.opacityRange');
      range.addEventListener('input', (e) => {
        applyHotspotOpacity(Number(e.target.value) / 100);
      });

      const group = document.querySelector('.subLayerGroup[data-parent-layer="hotspots"]');
      if (group) {
        group.insertAdjacentElement('afterend', control);
      } else {
        row.insertAdjacentElement('afterend', control);
      }

      applyHotspotOpacity(getHotspotOpacity());
      updateHotspotOpacityControlVisibility(getLayerEnabled('hotspots'));
    }

    function updateBuildingOpacityControlVisibility(isOn){
      const control = document.querySelector('.opacityControl[data-opacity-control="buildings3d"]');
      if (control) control.classList.toggle('open', !!isOn);
    }

    function applyBuildingOpacity(value){
      const opacity = setBuildingOpacity(value);
      const control = document.querySelector('.opacityControl[data-opacity-control="buildings3d"]');
      if (control) {
        const range = control.querySelector('.opacityRange');
        const valueEl = control.querySelector('.opacityValue');
        const pct = Math.round(opacity * 100);
        if (range && Number(range.value) !== pct) range.value = String(pct);
        if (valueEl) valueEl.textContent = `${pct}%`;
      }
      applyBuildingAppearance();
      return opacity;
    }

    function createBuildingOpacityControl(){
      const row = document.querySelector('.layerRow[data-toggle-row="buildings3d"]');
      if (!row || document.querySelector('.opacityControl[data-opacity-control="buildings3d"]')) return;

      const control = document.createElement('div');
      control.className = 'opacityControl';
      control.dataset.opacityControl = 'buildings3d';
      control.innerHTML = `
        <span class="opacityLabel">Opacity</span>
        <input class="opacityRange" type="range" min="0" max="100" step="1" value="100" aria-label="3D Buildings opacity" />
        <span class="opacityValue">100%</span>`;

      control.addEventListener('click', (e) => e.stopPropagation());
      const range = control.querySelector('.opacityRange');
      range.addEventListener('input', (e) => {
        applyBuildingOpacity(Number(e.target.value) / 100);
      });

      row.insertAdjacentElement('afterend', control);
      applyBuildingOpacity(getBuildingOpacity());
      updateBuildingOpacityControlVisibility(getLayerEnabled('buildings3d'));
    }

    function registerLayer(key, cesiumObj){
      LAYER_REGISTRY[key] = cesiumObj;
      const state = getLayerState();
      setVisible(cesiumObj, !!state[key]);
    }

    function updateHotspotSubLayerGroup(){
      const group = document.querySelector('.subLayerGroup[data-parent-layer="hotspots"]');
      if (!group) return;
      group.classList.toggle('open', getHotspotParentEnabled());
    }

    const LAYER_INFO = {
      overview: {
  title: "Dashboard overview",
  subtitle: "Explore Surface Urban Heat Island (SUHI) patterns and drivers",
  what: `This dashboard is designed to support the exploration of daytime summer surface heat patterns and their possible environmental and urban-form controls across the German cities of Essen, Wuppertal, and Soest for the years 2022 and 2024. It brings together multiple spatial layers in a single interactive environment so that users can examine where surfaces are hotter or cooler, compare patterns between cities and years, and understand how these patterns relate to vegetation, built-up surfaces, water-related influence, surface reflectivity, land-cover classes, hotspot clustering, and 3D urban structure.

The two main thermal layers in the dashboard are Land Surface Temperature (LST) and Surface Urban Heat Island intensity (SUHI). These are complemented by contextual layers that help explain spatial variation in heat conditions, including Greenness (NDVI), Built-up (NDBI), Water Proximity (MNDWI-based information), Surface Albedo, Local Climate Zones (LCZ), Hotspots & Coldspots, and 3D Buildings. Together, these layers allow the user not only to identify areas of stronger or weaker heat, but also to interpret why such patterns may occur.

The dashboard is therefore intended as an interactive exploratory and comparative tool. It is not limited to showing temperature alone. Instead, it allows users to move between cities and years, switch layers on and off, view different base maps, inspect local values, and compare multiple types of spatial information in the same map environment. In this way, it helps users understand both the distribution of surface heat and the urban and environmental context in which that heat occurs.

The interface is structured so that the most important controls are always visible. At the top, the user can choose the city and year, switch between dark and light theme, reopen this overview, and change the interface language between English and German. The main map occupies the center of the dashboard and is used for visualization and interaction. The Controls Panel on the left contains the available thematic layers, grouped into Heat Stressors, Environmental Drivers, and Urban Morphometrics. Each layer also has an info button, which opens a detailed explanation of what the layer represents, how it should be interpreted, and what its main limitations are.

At the bottom-right of the map, the dashboard also includes an AI Assistant panel. This can be opened to ask quick conceptual questions while exploring the dashboard. It is intended as a support feature for understanding terms and concepts rather than as a replacement for the map itself.

Overall, the dashboard should be understood as a platform for interpreting spatial heat patterns in relation to urban structure and environmental conditions, rather than as a single-temperature viewer.`,
  units: `Different layers in the dashboard use different units and data types.

LST is shown in degrees Celsius (°C).
SUHI is shown as a degrees Celsius (°C) difference relative to a rural reference.
NDVI, NDBI, MNDWI, and Albedo are unitless indices or values.
LCZ is a categorical classification layer.
Hotspots & Coldspots are categorical outputs from statistical clustering analysis.
3D Buildings provide geometric urban-form context, and where height is available it is generally expressed in metres.

Because the dashboard combines different kinds of data, users should always read each layer according to its own definition rather than assume that all layers represent the same kind of measurement.`,
  interpret: [
    "At the top of the dashboard, use the City selector to switch between All, Wuppertal, Essen, and Soest.",
    "Use the Year selector to switch between 2022 and 2024.",
    "When All cities is selected, the dashboard shows the combined study extent. When a single city is selected, the map view focuses on that city.",
    "The Selected card in the left panel always shows the currently active city and year combination.",
    "The Dark / Light theme button changes the interface appearance.",
    "The Overview button reopens this general dashboard explanation at any time.",
    "The EN / DE language selector switches the interface language between English and German.",
    "The main map is interactive. You can pan, zoom, and inspect the mapped patterns directly.",
    "Standard Cesium controls are available in the map area, including the Home button, which returns the map to the default top-down view for the current city selection, the search/geocoder control if you want to search locations, the scene mode or map view controls available through Cesium, the base map selector which allows switching between available background map styles, the navigation help control, and the fullscreen control.",
    "The dashboard uses terrain-enabled Cesium visualization, so the map is not only a flat image viewer but a navigable geospatial scene.",
    "The Controls Panel on the left contains the thematic layers.",
    "Layers are grouped into Heat Stressors, Environmental Drivers, and Urban Morphometrics.",
    "Heat Stressors include LST, SUHI, and Hotspots.",
    "Environmental Drivers include Greenness, Built-up, Water Proximity, Surface Albedo, and LCZ.",
    "Urban Morphometrics currently includes 3D Buildings.",
    "Each layer has a toggle switch. Turning the switch on displays that layer on the map. Turning it off hides it.",
    "Next to each layer name is a small info icon. Clicking this opens a popup with the detailed explanation for that layer.",
    "For most raster layers, an opacity control appears when the layer is turned on. This allows the user to adjust transparency and compare the layer more clearly against the base map or against other active layers.",
    "The 3D Buildings layer also includes an opacity setting so the user can adjust how strongly the building geometry appears in the scene.",
    "The Hotspots layer has a special structure.",
    "First, the main Hotspots switch must be turned on.",
    "Once it is active, two nested sublayers become available: Hotspots and Coldspots.",
    "These can be switched separately so that the user can view only hotspots, only coldspots, or both together.",
    "This makes it easier to inspect statistically clustered hot and cool areas independently.",
    "The legend appears automatically in the map area when a relevant layer is active.",
    "The legend updates depending on the currently displayed thematic content.",
    "For continuous raster layers such as LST, SUHI, NDVI, NDBI, MNDWI, and Albedo, the legend shows a color ramp and value range.",
    "For LCZ, the legend shows the class colors and class names.",
    "For Hotspots, the legend shows hotspot and coldspot color categories.",
    "This means the legend is dynamic and only appears when it is relevant.",
    "When a raster layer is active, clicking on the map allows the dashboard to display the value at that location.",
    "A small marker is placed at the clicked location and a value label appears above it.",
    "This is useful for checking the local value of LST, SUHI, NDVI, NDBI, MNDWI, Albedo, or LCZ class at a specific position.",
    "In All cities mode, if you click inside one of the city extents while using an active raster layer, the dashboard can use that interaction to move into the corresponding city context more specifically.",
    "The 3D Buildings layer provides additional urban-form context.",
    "It does not represent heat directly, but it helps the user visually interpret how building shape, spacing, and structure may relate to the mapped heat patterns.",
    "It is especially useful when compared together with LST, SUHI, LCZ, and the other environmental layers.",
    "The AI Assistant button in the lower-right corner opens a side panel.",
    "This assistant can be used to ask quick explanatory questions while using the dashboard.",
    "It is intended for help with concepts, terminology, and general understanding during exploration.",
    "It should be understood as a support tool within the interface rather than as a core analytical layer.",
    "A Development Notice is shown at the top of the dashboard.",
    "This indicates that the dashboard is still a prototype.",
    "Users should therefore expect that some elements may still be refined and that functionality, content, or design may change over time.",
    "Start by selecting a city and year.",
    "Turn on LST to see the direct surface temperature pattern.",
    "Turn on SUHI to see where urban surfaces are warmer or cooler relative to the rural reference.",
    "Then compare these heat layers with the contextual layers.",
    "Greenness helps indicate vegetation presence.",
    "Built-up helps indicate sealed and impervious surfaces.",
    "Water Proximity helps indicate water-related influence.",
    "Albedo helps indicate surface reflectivity.",
    "LCZ provides standardized urban and land-cover class context.",
    "Hotspots & Coldspots highlight statistically clustered heat concentration.",
    "3D Buildings provide visual urban-form context.",
    "The dashboard is most useful when interpreted through layer comparison, not by reading one layer in isolation.",
    "For example, areas with high LST and high NDBI may indicate strongly built-up and sealed surfaces.",
    "Areas with high NDVI and lower LST may reflect vegetation-related cooling.",
    "Hotspot clusters can be compared with LCZ and 3D buildings to understand whether heat concentration aligns with denser urban structure.",
    "The interface is therefore intended to support comparative spatial reasoning, where heat patterns are interpreted alongside the environmental and urban layers that may help explain them."
  ],
  limitations: [
    "The dashboard focuses mainly on surface-based thermal conditions, especially LST and SUHI. These are not the same as near-surface air temperature or direct human thermal exposure.",
    "Several layers are satellite-derived indicators or processed analytical outputs, so they should be interpreted as spatial representations and comparative indicators rather than perfect ground truth.",
    "The mapped patterns depend on data source, spatial resolution, seasonal selection, preprocessing choices, and availability of valid observations.",
    "The heat patterns shown are best read as broad spatial patterns rather than exact point measurements everywhere.",
    "Hotspots & Coldspots are statistical clustering results and should not be confused with direct temperature values.",
    "LCZ and 3D Buildings add important contextual information, but they do not directly measure heat on their own.",
    "The dashboard is a prototype under development, so some features, styling choices, or interaction details may still evolve.",
    "The most reliable use of the dashboard is for exploration, interpretation, and comparison of spatial patterns, especially when several layers are considered together."
  ],
  refs: []
},

      lst: {
  title: "LST (°C)",
  subtitle: "Land Surface Temperature (surface ‘skin’ temperature)",
  what: `This layer shows Land Surface Temperature (LST), which represents how hot the ground and other surface materials are at the time the sensor records them. In practical terms, it describes the temperature of the Earth’s outer surface, such as roofs, roads, bare soil, paved areas, and vegetation canopies, rather than the temperature of the air measured at human height.

The layer is based on ECOSTRESS thermal data. ECOSTRESS is a thermal sensor that measures the heat emitted from the Earth’s surface and uses it to estimate surface temperature. In this dashboard, the mapped values are shown in degrees Celsius and represent daytime summer surface conditions for the selected city and year.

Using ECOSTRESS is especially useful for urban heat studies because it is designed to observe surface temperature in relatively high spatial detail compared with many broader-scale thermal satellite products. This makes it better suited for showing temperature differences within cities, where heat can vary strongly between built-up areas, vegetation, transport surfaces, and open land. Another important difference is that ECOSTRESS observations come from the International Space Station, so acquisition times are not fixed in exactly the same way as some traditional satellites. This makes the dataset particularly valuable for studying surface temperature patterns under different daytime conditions.

LST should therefore be understood as a satellite-derived surface temperature measurement, not as near-surface air temperature. A surface can become much hotter than the surrounding air under strong sunlight, especially where materials are dark, dry, sealed, or exposed.

This layer is useful because it helps identify where the city surface is heating more strongly during the day. It can be interpreted together with SUHI, vegetation, built-up patterns, water-related layers, albedo, LCZ, and urban form in order to understand how land cover and urban structure relate to spatial heat patterns.`,
  units: "LST is expressed in degrees Celsius (°C).",
  interpret: [
    "Higher LST values indicate hotter surface conditions at the time of observation.",
    "Lower LST values indicate cooler surface conditions.",
    "Built-up, sealed, and sparsely vegetated areas often show higher daytime LST, while vegetation and water-related surfaces often show lower values.",
    "The layer should be interpreted as a map of surface temperature, not of human-experienced air temperature."
  ],
  limitations: [
    "LST depends on the time of satellite observation and represents conditions only at that observation time.",
    "Cloud cover, atmospheric conditions, shadows, and surface moisture can influence the result.",
    "Surface temperature does not directly equal air temperature, thermal comfort, or heat exposure experienced by people.",
    "The mapped pattern is also influenced by land cover, material properties, solar exposure, and seasonal conditions."
  ],
  refs: []
},

      suhi: {
  title: "SUHI (°C)",
  subtitle: "Surface Urban Heat Island intensity (urban vs. rural surface temperature)",
  what: `This layer shows Surface Urban Heat Island (SUHI) intensity, which describes how much warmer or cooler urban surfaces are compared with a rural reference. It is based on Land Surface Temperature (LST) rather than air temperature.

In this dashboard, SUHI was derived from the ECOSTRESS-based LST data. The calculation compares urban surface temperatures against a rural baseline so that the mapped values show the relative surface heat difference between urban and rural conditions. In simple terms, it does not just show whether a place is hot, but whether it is hotter or cooler than the rural reference used for that city and year.

For this project, the rural reference was defined using non-urban LCZ classes, and SUHI was calculated as the difference between the local surface temperature and that rural reference value. This means the layer should be understood as a relative surface temperature indicator, not as an absolute temperature map on its own.

This layer is useful because it highlights where urban surfaces show stronger heat amplification relative to surrounding rural conditions. It therefore helps show the spatial pattern of the urban heat island more clearly than LST alone. It can be interpreted together with vegetation, built-up patterns, water-related layers, albedo, LCZ, hotspots, and urban form to understand why some urban areas show stronger heat island effects than others.`,
  units: "SUHI is expressed in degrees Celsius (°C) difference.",
  interpret: [
    "Positive SUHI values indicate surfaces that are warmer than the rural reference.",
    "Negative SUHI values indicate surfaces that are cooler than the rural reference.",
    "Higher positive values indicate a stronger surface urban heat island effect.",
    "The layer should be interpreted as a map of urban-rural surface temperature difference, not as a direct map of air temperature or human heat stress."
  ],
  limitations: [
    "SUHI depends on how the urban and rural areas are defined and on how the rural reference is calculated.",
    "It is based on surface temperature, so it is not the same as canopy-layer or air-temperature urban heat island.",
    "The result depends on the observation time, seasonal conditions, and the quality of the underlying LST data.",
    "SUHI values can vary across cities and years depending on land cover, moisture conditions, vegetation, and the chosen rural baseline."
  ],
  refs: []
},

      hotspots: { 
  title: "Hotspots & Coldspots",
  subtitle: "Statistically clustered hot and cool surface areas",
  what: `This layer shows areas where relatively high or relatively low SUHI values form statistically significant spatial clusters within the urban part of the city. It is based on a Getis-Ord Gi* hotspot analysis applied to urban SUHI values on a pixel-aligned analysis grid. Only urban cells were included in the analysis, using LCZ classes 1-10 to define the urban area.

In practical terms, the method evaluates each urban grid cell together with its neighbouring urban cells and tests whether high or low SUHI values are clustered more strongly than would be expected by chance. Neighbours were defined using Queen contiguity, meaning cells were treated as neighbours when they touched by an edge or by a corner.

A cell was classified as part of a hotspot when it belonged to a statistically significant cluster of relatively high SUHI values, and as part of a coldspot when it belonged to a statistically significant cluster of relatively low SUHI values. The final class used in the project was the spot field, which combined FDR-corrected significance with the sign of the Gi* z-score: significant positive clustering was labelled hotspot, significant negative clustering was labelled coldspot, and all other cells were treated as not significant.

For dashboard display, the original 70 m grid-based result was simplified for clearer visualization. Only hotspot and coldspot cells were kept, touching cells of the same class were dissolved together, and the final polygons were converted to GeoJSON for web display. This means the dashboard layer is a cleaner cartographic version of the analytical result rather than the raw grid itself.

This layer is useful because it highlights where urban heat or urban coolness is spatially concentrated, rather than only showing isolated high or low values. It can therefore be interpreted together with SUHI, LST, vegetation, built-up patterns, water-related layers, LCZ, and urban form. This helps show where broader heat concentration patterns occur within the city.`,
  units: "This is a categorical statistical output. It does not represent temperature in degrees Celsius, but hotspot and coldspot classes derived from Gi* clustering analysis.",
  interpret: [
    "Hotspots indicate statistically significant clusters of relatively high SUHI values within urban areas.",
    "Coldspots indicate statistically significant clusters of relatively low SUHI values within urban areas.",
    "The layer should be read as a map of where heat or coolness is spatially concentrated, not as a map of exact SUHI values.",
    "It is most useful when interpreted together with SUHI, LST, vegetation, built-up patterns, water-related layers, LCZ, and urban form."
  ],
  limitations: [
    "The result depends on the hotspot analysis design, including how neighbourhood relationships are defined.",
    "A hotspot does not necessarily mean the single highest SUHI value in the city; it means a statistically significant cluster of relatively high values.",
    "Likewise, a coldspot does not necessarily mean the single lowest SUHI value; it means a statistically significant cluster of relatively low values.",
    "The displayed polygons are a dissolved visualization of the analytical result, so they are intended for clear interpretation rather than for showing the original grid cell boundaries."
  ],
  refs: []
},

      ndvi: {
  title: "Greenness",
  subtitle: "NDVI – Normalized Difference Vegetation Index",
  what: `This layer indicates where vegetation is more or less present across the study area. It is based on NDVI, which stands for Normalized Difference Vegetation Index.

NDVI is calculated from satellite data. In practical terms, the satellite records how strongly the ground surface returns incoming sunlight in different parts of light beyond normal photography. Vegetation behaves differently from built-up surfaces, bare soil, or water. Healthy green vegetation tends to return more energy in the near-infrared part of light and less in the red part, and NDVI uses this contrast to make vegetated areas stand out more clearly in the mapped output.

In this dashboard, the layer should therefore be understood as a satellite-derived indicator of vegetation presence and relative greenness, rather than as a direct field measurement collected on the ground. It provides environmental context that can be interpreted together with LST, SUHI, built-up patterns, water-related layers, and the urban form layers.

This layer is useful because vegetation can influence local thermal conditions through shading, evapotranspiration, and surface moisture. Areas with stronger vegetation presence often show reduced daytime surface heating compared with more sealed or sparsely vegetated surfaces. However, the strength of this relationship depends on several other factors, including vegetation type, density, seasonal condition, soil moisture, and surrounding urban structure.`,
  units: "NDVI is a unitless index. This means it is expressed as numerical values rather than in physical units such as metres or degrees Celsius.",
  interpret: [
    "Higher NDVI values generally indicate a stronger presence of vegetation or healthier and denser green cover.",
    "Lower NDVI values generally indicate non-vegetated surfaces such as built-up land, bare soil, or water.",
    "The layer should be read as an indicator of vegetation-related surface conditions visible in the satellite data.",
    "It is most useful when interpreted alongside the other environmental layers in the dashboard."
  ],
  limitations: [
    "NDVI is derived from satellite-based surface observations and is therefore an estimation method rather than a perfect representation of reality.",
    "Sparse vegetation, exposed soil, shadows, and mixed land cover can affect the result.",
    "Very dense vegetation can reach similar high NDVI values, which reduces separation at the upper end of the scale.",
    "Seasonal conditions and differences in vegetation growth can also influence the mapped pattern over time."
  ],
  refs: []
},

      ndbi: {
  title: "Built-up",
  subtitle: "NDBI – Normalized Difference Built-up Index",
  what: `This layer indicates where built-up and more sealed surfaces are more likely to occur within the study area. It is based on NDBI, which stands for Normalized Difference Built-up Index.

NDBI is calculated from satellite data. In practical terms, the satellite records how strongly the ground surface returns incoming sunlight in different parts of light beyond normal photography. Built-up surfaces such as roofs, concrete, paved areas, and other impervious materials often show a different response from vegetation or water. NDBI uses this contrast to make built-up areas stand out more clearly in the mapped output.

In this dashboard, the layer should therefore be understood as a satellite-derived indicator of built-up surface presence or intensity, rather than as a direct measurement collected on the ground. It provides environmental context that can be interpreted together with LST, SUHI, vegetation, water-related layers, and the urban form layers.

This layer is useful because built-up and sealed surfaces are often associated with stronger daytime heating, lower moisture availability, and reduced evaporative cooling. However, the strength of this relationship depends on several other factors, including surface material, shading, vegetation cover, building density, and surrounding urban structure.`,
  units: "NDBI is a unitless index. This means it is expressed as numerical values rather than in physical units such as metres or degrees Celsius.",
  interpret: [
    "Higher NDBI values generally indicate a stronger likelihood of built-up, sealed, or impervious surfaces.",
    "Lower NDBI values generally indicate non-built surfaces, especially vegetation or water.",
    "The layer should be read as an indicator of built-up surface conditions visible in the satellite data.",
    "It is most useful when interpreted alongside the other environmental layers in the dashboard."
  ],
  limitations: [
    "NDBI is derived from satellite-based surface observations and is therefore an estimation method rather than a perfect representation of reality.",
    "Bright bare soil, dry ground, and some non-urban surfaces can sometimes produce values similar to built-up areas.",
    "Shadows, mixed land cover, and spatial resolution can affect the result.",
    "Seasonal surface conditions can also influence the mapped pattern, especially where vegetation cover changes over time."
  ],
  refs: []
},

      ndwi: {
  title: "Water Proximity",
  subtitle: "Water presence/proximity indicator (MNDWI-based information)",
  what: `This layer indicates where open water or strongly water-influenced surfaces are likely to occur within the study area. It was produced in Google Earth Engine using the Modified Normalized Difference Water Index (MNDWI).

The method is based on satellite observations. In practical terms, the satellite records how much incoming sunlight is returned from the ground surface in different parts of light beyond normal photography. Because water, vegetation, soil, roads, and buildings return sunlight differently, these differences can be used to distinguish water-related surfaces from surrounding land cover. MNDWI is a standard index that enhances this contrast so that water features can be identified more clearly in the mapped output.

In this dashboard, the layer should therefore be understood as a satellite-derived indicator of water presence or water influence, rather than as a direct field measurement. It provides environmental context that can be interpreted together with LST, SUHI, vegetation, and built-up patterns.

This layer is useful because water bodies and wet surfaces can influence local surface energy balance and, in some settings, help moderate nearby daytime heating. However, the strength and extent of this influence depend on several other factors, including the size of the water body, surrounding land cover, wind conditions, urban form, and seasonal surface moisture.`,
  units: "MNDWI is a unitless index. This means it is expressed as numerical values rather than in physical units such as metres or degrees Celsius.",
  interpret: [
    "Higher MNDWI values generally indicate a stronger likelihood of open water or wetter surface conditions.",
    "Lower MNDWI values generally indicate non-water surfaces such as built-up land, dry soil, or vegetation.",
    "The layer should be read as an indicator of water-related surface conditions visible in the satellite data.",
    "It is most useful when interpreted alongside the other environmental layers in the dashboard."
  ],
  limitations: [
    "MNDWI is derived from satellite-based surface observations and is therefore an estimation method rather than a perfect representation of reality.",
    "Dark surfaces, shadows, wet ground, and mixed land-cover conditions can affect the result.",
    "Very small or narrow water bodies may not always be represented clearly, depending on spatial resolution.",
    "Seasonal differences in water extent, vegetation condition, and surface moisture can also influence the mapped pattern."
  ],
  refs: []
},

      albedo: {
        title: "Surface Albedo (Sunlight Reflectivity)",
        subtitle: "Sunlight reflectivity of the surface",
        what:
          "Surface albedo shows how much sunlight a surface reflects. Darker surfaces such as asphalt, dark roofs, shaded ground, water, or dense vegetation usually reflect less sunlight and absorb more energy, while brighter surfaces such as light roofs, bright concrete, or dry bare soil usually reflect more. In this dashboard, the albedo maps represent seasonal summer conditions for Essen, Wuppertal, and Soest in 2022 and 2024. This means the map does not show just one satellite image from one day. Instead, it summarizes the typical surface reflectivity pattern during the summer period from 1 June to 31 August, so the result is more stable and less affected by short-term weather or one unusual observation. The maps were created from Sentinel-2, a satellite mission that captures reflected sunlight from the Earth’s surface in several wavelength bands, and the final outputs are shown at 20 m resolution, meaning each pixel represents an area of about 20 by 20 metres on the ground.\n\nThis layer is useful because it helps show how different surface materials may influence daytime heating patterns across the city. Lower albedo values are commonly linked to darker and less reflective surfaces, while higher albedo values are more often linked to brighter and more reflective ones. In summer, these differences can be especially meaningful because surfaces are exposed to strong incoming solar radiation, so the contrast between materials that absorb more energy and materials that reflect more energy becomes easier to see in the overall spatial pattern. Even so, albedo should be understood as a property of the surface itself, not as a direct temperature measurement.\n\nAlbedo is therefore not the same as temperature. A bright surface can still be part of a hot urban area if there is little shade, little vegetation, or strong heat storage in the surrounding built environment. In other words, a place may reflect sunlight well but still remain thermally uncomfortable because other factors also affect surface heating and cooling. For that reason, this layer is best interpreted together with LST, SUHI, vegetation, water proximity, and built-up layers rather than on its own.\n\nThese maps should be read as broad summer reflectivity patterns rather than exact momentary conditions. Some variation can still come from cloud masking, surface moisture, seasonal drying or greening, and the satellite-based estimation method itself. Put simply, cloud masking means that cloudy pixels were removed before the map was made, surface moisture matters because wet surfaces often reflect differently from dry ones, and seasonal conditions matter because vegetation and bare soil can change across the summer. To create the final maps, Sentinel-2 summer scenes were first selected for each city and year, very cloudy scenes were removed, cloudy pixels were masked, scenes with too little valid city coverage were discarded, the required spectral bands were brought to a common 20 m grid, and broadband shortwave albedo was then estimated for each remaining scene. Finally, these scene-level albedo images were combined using a median composite to produce one robust summer albedo map per city-year.",
        units: "Broadband shortwave surface albedo shown as a unitless reflectivity value, mapped at 20 m spatial resolution.",
        interpret: [],
        limitations: [],
        refs: []
      },

      lcz: {
        title: "Local Climate Zones (LCZ)",
        subtitle: "Classification of urban and land-cover types based on built form and land cover",
        what:
          "Local Climate Zones, or LCZs, classify the city into standard urban and natural types based on built form and land cover. Unlike LST, SUHI, or the spectral index layers, this layer does not show one continuous physical measurement. Instead, it shows what kind of physical setting is present in each area. In simple terms, it helps describe whether a place is characterized by compact tall buildings, open low-rise neighborhoods, industrial land, trees, grass, bare ground, or water. This makes it easier to understand the physical character of different parts of the city in a consistent way.\n\nThis layer is useful because cities are not built in the same way everywhere. Some areas are compact and heavily built, while others are open, greener, or closer to natural land cover. LCZ helps organize these differences into a standardized classification system, so places with similar urban form or surface cover can be compared more clearly within the city and across different cities. In this dashboard, it provides important urban-form and land-cover context for interpreting spatial patterns together with the other layers.\n\nThe LCZ classes shown in this dashboard are listed below. These classes should be read as broad and standardized place types rather than exact descriptions of every local detail.",
        units: "Categorical LCZ classes representing standardized urban and land-cover types.",
        interpret: [
          "Class 1 – Compact high-rise: dense clusters of tall buildings with very little open space",
          "Class 2 – Compact mid-rise: dense areas of medium-height buildings close to one another",
          "Class 3 – Compact low-rise: dense low-rise built-up areas with limited open space",
          "Class 4 – Open high-rise: tall buildings with more spacing between them",
          "Class 5 – Open mid-rise: medium-height buildings in a more open arrangement",
          "Class 6 – Open low-rise: low-rise buildings with visible open land between them",
          "Class 7 – Lightweight low-rise: low-rise built-up areas made mainly of lightweight materials",
          "Class 8 – Large low-rise: large-footprint low-rise buildings such as warehouses, retail halls, or industrial units",
          "Class 9 – Sparsely built: scattered buildings mixed with large amounts of open land or vegetation",
          "Class 10 – Heavy industry: industrial zones with large structures, paved ground, and specialized land use",
          "Class 11 – Dense trees: areas dominated by closely spaced tree cover",
          "Class 12 – Scattered trees: areas with trees present but more spaced out",
          "Class 13 – Bush, scrub: low woody vegetation and shrub-covered land",
          "Class 14 – Low plants: grass, cropland, or other low vegetation cover",
          "Class 15 – Bare rock or paved: exposed rock, hard surfaces, or strongly sealed ground with little vegetation",
          "Class 16 – Bare soil or sand: loose natural ground with little or no vegetation cover",
          "Class 17 – Water: rivers, lakes, canals, reservoirs, or other water bodies"
        ],
        limitations: [
          "These maps should still be understood as generalized representations of city structure and land cover.",
          "Real places can be mixed, transitional, or more complex than one single class.",
          "The quality of the result also depends on the source data, mapping approach, and spatial resolution used to produce the LCZ dataset.",
          "Because of this, the layer is best read as a broad and standardized description of place type rather than a perfect representation of every local detail."
        ],
        refs: []
      },

      buildings3d: {
        title: "3D Buildings (Urban Form Context)",
        subtitle: "3D representation of urban form",
        what:
          "The 3D Buildings layer shows the shape and height of buildings across the city. It helps the user see how built-up areas are arranged in space, rather than showing temperature directly. In this dashboard, the building data was provided by the municipalities themselves and is available in Level of Detail 2 (LoD2). In simple terms, this means the buildings are shown in a more realistic 3D form than simple blocks, with roof shapes and building structure represented in more detail. Where height information is available, it is generally expressed in metres.\n\nThis layer is useful because the shape of the city can influence how heat behaves. Tall buildings, dense building clusters, and narrow streets between buildings can affect how much sunlight reaches the ground, how easily air can move, and how heat is stored and released. For example, closely spaced tall buildings can create more shade during the day, but they can also reduce ventilation and slow cooling later in the day or at night. In this way, the 3D Buildings layer helps give physical context to the heat patterns seen in LST, SUHI, and the other environmental layers.\n\nHowever, this layer should not be read as a heat map by itself. It shows urban form, not surface temperature. A place with tall or dense buildings is not automatically hotter in every situation, because urban heat also depends on vegetation, materials, moisture, water, and local airflow. The 3D view is therefore best used together with the other layers in the dashboard to better understand why some parts of the city may appear hotter or cooler than others.\n\nThe building data is served in the dashboard through Cesium ion. The municipality-provided LoD2 dataset was uploaded there, tiled for web visualization, and then displayed here as 3D city data within Cesium. This makes it possible to view complex building models smoothly in the browser. For more detailed information about the buildings themselves, the respective municipalities can be consulted, since they are the original data providers.",
        units: "Geometry; where height information is available, it is generally expressed in metres.",
        interpret: [],
        limitations: [],
        refs: []
      }
    };

    const LAYER_INFO_DE = {
      overview: {
        title: "Dashboard-Überblick",
        subtitle: "SUHI-Muster und mögliche Treiber erkunden",
        what:
          "Dieses Dashboard unterstützt dich dabei, Oberflächen-Hitzemuster (LST und SUHI) sowie begleitende Umwelt- und Kontextlayer für ausgewählte Städte und Jahre zu erkunden. So kannst du vergleichen, wo Oberflächen heißer/kühler sind und wie Vegetation, Bebauung, Wasser, Albedo, LCZ-Klassen und die 3D-Stadtform damit zusammenhängen können.",
        units:
          "Je nach Layer: °C (LST/SUHI), dimensionslose Indizes (z. B. NDVI/NDBI/Albedo) oder kategoriale Klassen (LCZ).",
        interpret: [
          "Wähle oben Stadt und Jahr.",
          "Schalte Ebenen links ein/aus; klicke auf das Info-Symbol für Definitionen und Hinweise.",
          "Zoome hinein, um Nachbarschaftsmuster zu sehen, und vergleiche Layer (z. B. SUHI vs. Vegetation/Bebauung)."
        ],
        limitations: [
          "LST/SUHI sind oberflächenbasiert und unterscheiden sich von der Lufttemperatur-Belastung für Menschen.",
          "Muster hängen stark von Aufnahmezeitpunkt, Saison, Wolkenmaskierung und Auflösung ab – eher als relative Muster interpretieren.",
          "Hotspots hängen von Methode/Parametern ab und sind Hinweise zur weiteren Untersuchung."
        ],
        refs: [
          "Voogt & Oke (2003) – Thermal remote sensing of urban climates.",
          "Stewart & Oke (2012) – Local Climate Zones framework.",
          "Weng (2009) – Thermal infrared remote sensing for urban climate studies."
        ]
      },

      lst: {
        title: "LST (°C)",
        subtitle: "Landoberflächentemperatur ('Skin'-Temperatur)",
        what:
          "LST ist die aus thermalen Satellitenmessungen abgeleitete Temperatur der Oberfläche (Dächer, Asphalt, Boden, Vegetation). Sie ist nicht identisch mit der bodennahen Lufttemperatur.",
        units: "Grad Celsius (°C).",
        interpret: [
          "Hohe LST tritt häufig auf stark versiegelten Flächen bei starker Sonneneinstrahlung auf.",
          "Vegetation und Wasser sind tagsüber oft kühler (Schatten, Evapotranspiration bzw. hohe Wärmekapazität).",
          "Immer zusammen mit Landbedeckung sowie Zeitpunkt/Saison interpretieren."
        ],
        limitations: [
          "Stark abhängig von Aufnahmezeitpunkt, Wolken/Atmosphäre und Korrekturen.",
          "Topographie, Schatten und Sichtgeometrie können Werte beeinflussen.",
          "Für Hitzebelastung sind zusätzlich Lufttemperatur, Feuchte, Wind und Strahlung wichtig."
        ],
        refs: ["Voogt & Oke (2003).", "Weng (2009)."]
      },

      suhi: {
        title: "SUHI (°C)",
        subtitle: "Oberflächen-Stadtwärmeinsel (Stadt vs. Umland)",
        what:
          "SUHI beschreibt den Temperaturunterschied der Oberflächen zwischen städtischen und ländlichen Referenzflächen (basierend auf LST).",
        units: "Temperaturdifferenz in °C.",
        interpret: [
          "Positiver SUHI: städtische Oberflächen sind wärmer als die Referenz.",
          "Muster hängen oft mit Versiegelung, Vegetation, Stadtform und Feuchte zusammen.",
          "Beachte, wie 'urban'/'rural' definiert wurde (z. B. LCZ-basiert)."
        ],
        limitations: [
          "Stark abhängig von der Wahl/Definition der Referenzflächen.",
          "Oberflächen-UHI unterscheidet sich vom Lufttemperatur-UHI; Größenordnungen können abweichen.",
          "Tag/Nacht und saisonale Unterschiede können groß sein."
        ],
        refs: ["Oke (1982).", "Stewart & Oke (2012)."]
      },

      hotspots: {
        title: "Hotspots & Coldspots",
        subtitle: "Statistisch gehäufte heiße und kühle Oberflächenbereiche",
        what:
          "Dieser Layer zeigt aufgelöste Gi*-Clusterpolygone für die gewählte Stadt und das gewählte Jahr. Rote Polygone markieren Hotspots (Cluster relativ hoher Oberflächenwärme), blaue Polygone markieren Coldspots (Cluster relativ kühler Oberflächenbedingungen).",
        units: "Kategoriale Hotspot-/Coldspot-Klassen aus der Hotspot-Analyse.",
        interpret: [
          "Schalte zuerst den Hauptschalter Hotspots ein; danach kannst du mit den Unter-Schaltern Hotspots und Coldspots beide Klassen getrennt ein- oder ausblenden.",
          "Hotspots weisen oft auf dichte, stärker versiegelte und vegetationsarme Bereiche hin; Coldspots fallen häufig mit grüneren, feuchteren oder weniger urbanen Flächen zusammen.",
          "Da es sich um räumliche Cluster handelt, zeigen die Polygone lokale Konzentrationsmuster und nicht nur einzelne extreme Pixel."
        ],
        limitations: [
          "Ergebnis hängt von Methode/Parametern ab (Nachbarschaft, Bandbreite, Schwellen).",
          "Randeffekte können die Analyse beeinflussen.",
          "Hotspot ≠ Risiko: Für Risiko braucht man Exposition (Bevölkerung, Nutzung etc.)."
        ],
        refs: ["Getis & Ord (1992); Ord & Getis (1995)."]
      },

      ndvi: {
        title: "Vegetation",
        subtitle: "NDVI – Normalized Difference Vegetation Index",
        what:
          "NDVI ist ein Spektralindex (NIR vs. Rot) als Indikator für Vegetationsbedeckung und Vitalität. Höhere Werte bedeuten meist mehr/gesündere Vegetation.",
        units: "Dimensionslos (typisch -1 bis +1).",
        interpret: [
          "Hohe NDVI-Werte: Parks/Wälder; niedrige: Bebauung, Boden oder Wasser.",
          "Vegetation kann tagsüber Oberflächen kühlen (Schatten + Evapotranspiration).",
          "Stark saisonal – immer mit der Jahreszeit vergleichen."
        ],
        limitations: [
          "Sättigung in dichter Vegetation; Bodenhintergrund kann Werte beeinflussen.",
          "Wolken/Schatten können NDVI verfälschen, wenn nicht sauber maskiert.",
          "Sensor/Prozessierung kann leichte Unterschiede erzeugen."
        ],
        refs: ["Tucker (1979).", "Huete et al. (2002)."]
      },

      ndbi: {
        title: "Bebauung",
        subtitle: "NDBI – Normalized Difference Built-up Index",
        what:
          "NDBI nutzt SWIR und NIR, um in vielen Landschaften bebaute/versiegelte Flächen hervorzuheben.",
        units: "Dimensionslos (oft -1 bis +1).",
        interpret: [
          "Höhere NDBI-Werte deuten häufig auf versiegelte/bebaute Flächen hin.",
          "Stärker versiegelte Bereiche sind oft mit höherer LST und stärkerem SUHI verbunden.",
          "Am besten zusammen mit NDVI und Wasser-Indizes interpretieren."
        ],
        limitations: [
          "Helle, trockene Böden können mit Bebauung verwechselt werden.",
          "Feuchte/Saison beeinflussen Werte; Schwellen sind nicht universell.",
          "Eher relativer Indikator als perfekte Bebauungskarte."
        ],
        refs: ["Zha, Gao & Ni (2003)."]
      },

      ndwi: {
        title: "Wassernähe",
        subtitle: "Wassereinfluss (NDWI/MNDWI-ähnlich) oder Distanz zu Wasser",
        what:
          "Dieser Layer beschreibt Wasserpräsenz bzw. den potenziellen Einfluss von Wasserflächen (z. B. über NDWI/MNDWI und/oder Distanz). Wasser kann Oberflächenhitze lokal dämpfen.",
        units: "Je nach Umsetzung: Index (dimensionslos) und/oder Distanz (m).",
        interpret: [
          "Wasserflächen sind tagsüber oft kühler und können umliegende Bereiche mitkühlen.",
          "Nutze den Layer mit LST/SUHI, um blaue Infrastruktur zu beurteilen.",
          "Bei Distanz-Layern: kleinere Werte = näher an Wasser."
        ],
        limitations: [
          "Wasserindizes hängen von Schatten, dunklen Oberflächen und Trübung ab; Schwellen variieren.",
          "Schmale Gewässer können bei grober Auflösung fehlen.",
          "Kühlwirkung hängt von Wetter, Größe und Stadtform ab."
        ],
        refs: ["McFeeters (1996).", "Xu (2006)."]
      },

      albedo: {
        title: "Albedo",
        subtitle: "Reflexionsgrad (kurzwellige Strahlung)",
        what:
          "Albedo ist der Anteil des einfallenden Sonnenlichts, der reflektiert wird. Hellere Oberflächen haben meist höhere Albedo und absorbieren weniger Strahlung.",
        units: "Dimensionslos (0–1) oder Prozent.",
        interpret: [
          "Höhere Albedo kann tagsüber LST reduzieren – aber Effekte hängen auch von Feuchte/Vegetation ab.",
          "Gut zum Vergleich von Dach-/Belagsmaterialien und trockenen Böden.",
          "In Städten sind Verschattung und 3D-Geometrie wichtig."
        ],
        limitations: [
          "Abhängig von Sonnenstand, Atmosphäre und der Schätzung von Breitband-Albedo.",
          "Saison/Wetness/Alterung verändern Albedo.",
          "Städtische 3D-Geometrie erschwert die Interpretation auf Quartiersebene."
        ],
        refs: ["Liang (2001)."]
      },

      lcz: {
        title: "Local Climate Zones (LCZ)",
        subtitle: "Standardisierte Stadt-/Umland-Klassen (Bauform + Landbedeckung)",
        what:
          "LCZ klassifiziert Flächen in Typen (z. B. kompakt hoch, offen niedrig, Bäume, Wasser) basierend auf Stadtstruktur und Landbedeckung – für konsistente Vergleiche zwischen Städten.",
        units: "Kategoriale Klassen (LCZ 1–17).",
        interpret: [
          "Bebaute LCZ-Klassen zeigen oft höhere Tages-LST als natürliche Klassen, abhängig von Saison/Feuchte.",
          "LCZ eignet sich, um 'urban' und 'rural' für SUHI konsistent zu definieren.",
          "Erleichtert 'like-with-like'-Vergleiche zwischen Städten."
        ],
        limitations: [
          "Qualität hängt von Eingangsdaten/Training/Auflösung ab.",
          "Übergangsbereiche und Mischpixel sind häufig.",
          "LCZ beschreibt typische Struktur, nicht jeden Mikrostadtraum."
        ],
        refs: ["Stewart & Oke (2012)."]
      },

      buildings3d: {
        title: "3D-Gebäude",
        subtitle: "3D-Stadtform (Visualisierung + Kontext)",
        what:
          "3D-Gebäude zeigen die Stadtstruktur und helfen, Hitzemuster über Geometrie (Höhe, Dichte, Straßenschluchten) zu interpretieren – wichtig für Verschattung, Durchlüftung und Wärmespeicherung.",
        units: "Geometrie (Höhen ggf. in Metern).",
        interpret: [
          "Dichte/tallere Bebauung kann Wärme speichern und nächtliche Abkühlung reduzieren; tagsüber kann Verschattung wirken.",
          "Nutze die 3D-Ansicht, um Hotspots im Kontext der Morphologie zu verstehen.",
          "Wenn Attribute vorhanden sind, lassen sich Morphometriken ableiten."
        ],
        limitations: [
          "3D-Visualisierung ≠ automatisch exakte Physik; Genauigkeit hängt von der Quelle ab.",
          "Höhen-/Datum-Unterschiede können Versätze erzeugen.",
          "Klimaeffekte hängen auch von Materialien, Vegetation, Feuchte und Wind ab."
        ],
        refs: ["Oke et al. (2017)."]
      }
    };

    function getLayerInfo(layerKey){
      if (currentLang === "de") return LAYER_INFO_DE[layerKey] || LAYER_INFO[layerKey];
      return LAYER_INFO[layerKey];
    }

    const UI_STR = {
      en: {
        app_title: "Surface Urban Heat Island (SUHI) Germany",
        app_subtitle: "Summer Daytime Heat patterns across Essen, Wuppertal & Soest",
        lang_label: "Language",
        city_label: "City",
        year_label: "Year",
        city_all: "All",
        all_cities: "All cities",
        controls_panel: "Controls Panel",
        active: "active",
        selected: "Selected",
        click_marker_title: "Click Marker",
        click_marker_group_label: "Click marker style",
        marker_pin: "Pin",
        marker_circle: "Circle",
        marker_crosshair: "Crosshair",
        layers: "Layers",
        legend_title: "LCZ Classes",
        legend_waiting: "Turn on LCZ to view the class legend here.",
        legend_palette_note: "LCZ palette based on Demuzere et al. (2022). Built classes use the official warm urban palette, vegetation uses greens, bare surfaces use black/sand, and water uses blue.",
        legend_group_built: "Built types (1–10)",
        legend_group_landcover: "Land-cover types (11–17)",
        heat_stressors: "Heat Stressors",
        env_drivers: "Environmental Drivers",
        morphometrics: "Urban Morphometrics",
        layer_hotspots: "Hotspots",
        layer_hotspots_hot: "Hotspots",
        layer_hotspots_cold: "Coldspots",
        layer_greenness: "Greenness",
        layer_builtup: "Built-up",
        layer_water: "Water Proximity",
        layer_albedo: "Surface Albedo",
        layer_lcz: "Local Climate Zones (LCZ)",
        layer_buildings3d: "3D Buildings",
        overview_btn: "Overview",
        overview_title: "Dashboard overview",
        theme_toggle: "Toggle theme",
        theme_light: "Light",
        theme_dark: "Dark",
        modal_what: "What it is",
        modal_units: "Units",
        modal_interpret: "How to interpret",
        modal_limitations: "Limitations",
        modal_refs: "Key references",
        references_prefix: "References: "
      },
      de: {
        app_title: "Oberflächen-Stadtwärmeinsel (SUHI) Deutschland",
        app_subtitle: "Sommerliche Tages-Hitzemuster für Essen, Wuppertal & Soest",
        lang_label: "Sprache",
        city_label: "Stadt",
        year_label: "Jahr",
        city_all: "Alle",
        all_cities: "Alle Städte",
        controls_panel: "Steuerung",
        active: "aktiv",
        selected: "Auswahl",
        click_marker_title: "Klickmarkierung",
        click_marker_group_label: "Stil der Klickmarkierung",
        marker_pin: "Pin",
        marker_circle: "Kreis",
        marker_crosshair: "Fadenkreuz",
        layers: "Ebenen",
        legend_title: "LCZ-Klassen",
        legend_waiting: "Schalte LCZ ein, damit die Klassenlegende hier erscheint.",
        legend_palette_note: "LCZ-Farbpalette nach Demuzere et al. (2022). Gebaute Klassen nutzen die offizielle warme Stadtpalette, Vegetation Grüntöne, offene/bare Flächen Schwarz/Sand und Wasser Blau.",
        legend_group_built: "Bebaute Typen (1–10)",
        legend_group_landcover: "Landbedeckungstypen (11–17)",
        heat_stressors: "Hitzetreiber",
        env_drivers: "Umweltfaktoren",
        morphometrics: "Stadtmorphometrie",
        layer_hotspots: "Hotspots",
        layer_hotspots_hot: "Hotspots",
        layer_hotspots_cold: "Coldspots",
        layer_greenness: "Vegetation",
        layer_builtup: "Bebauung",
        layer_water: "Wassernähe",
        layer_albedo: "Albedo",
        layer_lcz: "Lokale Klimazonen (LCZ)",
        layer_buildings3d: "3D-Gebäude",
        overview_btn: "Überblick",
        overview_title: "Dashboard-Überblick",
        theme_toggle: "Theme wechseln",
        theme_light: "Hell",
        theme_dark: "Dunkel",
        modal_what: "Was es ist",
        modal_units: "Einheiten",
        modal_interpret: "Interpretation",
        modal_limitations: "Einschränkungen",
        modal_refs: "Wichtige Quellen",
        references_prefix: "Quellen: "
      }
    };

    let currentLang =
      localStorage.getItem("lang") ||
      (((navigator.language || "en").toLowerCase().startsWith("de")) ? "de" : "en");

    function tr(key){
      return (UI_STR[currentLang] && UI_STR[currentLang][key]) || UI_STR.en[key] || key;
    }

    function syncLangPills(){
      const pills = document.getElementById("langPills");
      if (!pills) return;
      pills.querySelectorAll("button[data-lang]").forEach(b => {
        const isActive = b.dataset.lang === currentLang;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      const langLabel = document.getElementById("langLabel");
      if (langLabel) langLabel.textContent = tr("lang_label");
    }

    function applyLanguage(){
      document.documentElement.setAttribute("lang", currentLang);

      const titleEl = document.querySelector(".pillTitle");
      const subEl = document.querySelector(".pillSub");
      if (titleEl) titleEl.textContent = tr("app_title");
      if (subEl) subEl.textContent = tr("app_subtitle");

      const cityLabel = document.querySelector("#cityControl .pill-label");
      const yearLabel = document.querySelector("#yearControl .pill-label");
      if (cityLabel) cityLabel.textContent = tr("city_label");
      if (yearLabel) yearLabel.textContent = tr("year_label");

      const allBtn = document.querySelector('#cityPills button[data-city="ALL"]');
      if (allBtn) allBtn.textContent = tr("city_all");

      const panelTitle = document.querySelector("#leftPanel .panelHeader .h");
      if (panelTitle) panelTitle.textContent = tr("controls_panel");
      const dot = document.querySelector("#leftPanel .panelHeader .dot");
      if (dot) dot.setAttribute("title", tr("active"));

      const selectedCardTitle = document.getElementById("selectedCardTitle");
      const legendCardTitle = document.getElementById("legendCardTitle");
      const layersCardTitle = document.getElementById("layersCardTitle");
      if (selectedCardTitle) selectedCardTitle.textContent = tr("selected");
      if (legendCardTitle) legendCardTitle.textContent = tr("legend_title");
      if (layersCardTitle) layersCardTitle.textContent = tr("layers");

      renderLegend();

      const secTitles = document.querySelectorAll(".layerSectionTitle");
      if (secTitles && secTitles.length >= 3) {
        secTitles[0].textContent = tr("heat_stressors");
        secTitles[1].textContent = tr("env_drivers");
        secTitles[2].textContent = tr("morphometrics");
      }

      const setLayerName = (key, labelKey) => {
        const el = document.querySelector(`.layerRow[data-toggle-row="${key}"] .layerName`);
        if (el) el.textContent = tr(labelKey);
      };
      setLayerName("hotspots", "layer_hotspots");
      const hotspotHotEl = document.querySelector('.subLayerRow[data-toggle-row="hotspots_hot"] .subLayerName');
      const hotspotColdEl = document.querySelector('.subLayerRow[data-toggle-row="hotspots_cold"] .subLayerName');
      if (hotspotHotEl) hotspotHotEl.textContent = tr("layer_hotspots_hot");
      if (hotspotColdEl) hotspotColdEl.textContent = tr("layer_hotspots_cold");
      setLayerName("ndvi", "layer_greenness");
      setLayerName("ndbi", "layer_builtup");
      setLayerName("ndwi", "layer_water");
      setLayerName("albedo", "layer_albedo");
      setLayerName("lcz", "layer_lcz");
      setLayerName("buildings3d", "layer_buildings3d");

      const overviewBtn = document.getElementById("overviewBtn");
      if (overviewBtn) {
        overviewBtn.textContent = tr("overview_btn");
        overviewBtn.title = tr("overview_title");
        overviewBtn.setAttribute("aria-label", tr("overview_title"));
      }

      const themeToggle = document.getElementById("themeToggle");
      if (themeToggle) themeToggle.title = tr("theme_toggle");
    }

    function setLanguage(lang){
      currentLang = (lang === "de") ? "de" : "en";
      localStorage.setItem("lang", currentLang);
      syncLangPills();
      applyLanguage();

      if (typeof applyTheme === "function") {
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        applyTheme(theme);
      }
      if (typeof updateSelectedLabel === "function") updateSelectedLabel();

      const overlay = document.getElementById("infoModalOverlay");
      if (overlay && overlay.classList.contains("open") && window.__lastInfoKey) {
        openInfoModal(window.__lastInfoKey);
      }
    }

    function updateSelectedLabel(){
      selectedInfo.textContent =
        (selectedCity === "ALL" ? tr("all_cities") : selectedCity) + " • " + selectedYear;
    }

    const infoOverlay = document.getElementById("infoModalOverlay");
    const infoCloseBtn = document.getElementById("infoModalCloseBtn");
    const infoTitleEl = document.getElementById("infoModalTitle");
    const infoSubtitleEl = document.getElementById("infoModalSubtitle");
    const infoContentEl = document.getElementById("infoModalContent");
    let lastFocusedEl = null;

    function buildSection(title, { text = "", bullets = null, refs = null } = {}) {
      const sec = document.createElement("div");
      sec.className = "modalSection";

      const h = document.createElement("h4");
      h.textContent = title;
      sec.appendChild(h);

      if (text) {
        const p = document.createElement("p");
        p.textContent = text;
        sec.appendChild(p);
      }

      if (Array.isArray(bullets) && bullets.length) {
        const ul = document.createElement("ul");
        bullets.forEach(b => {
          const li = document.createElement("li");
          li.textContent = b;
          ul.appendChild(li);
        });
        sec.appendChild(ul);
      }

      if (Array.isArray(refs) && refs.length) {
        const r = document.createElement("div");
        r.className = "modalRef";
        r.textContent = tr("references_prefix") + refs.join(" • ");
        sec.appendChild(r);
      }

      return sec;
    }

    function openInfoModal(layerKey, openerEl) {
      window.__lastInfoKey = layerKey;
      const item = getLayerInfo(layerKey);
      if (!item) return;

      lastFocusedEl = openerEl || document.activeElement;
      infoTitleEl.textContent = item.title || "Layer information";
      infoSubtitleEl.textContent = item.subtitle || "";

      infoContentEl.innerHTML = "";
      infoContentEl.appendChild(buildSection(tr("modal_what"), { text: item.what || "" }));
      infoContentEl.appendChild(buildSection(tr("modal_units"), { text: item.units || "" }));
      if (item.interpret?.length) infoContentEl.appendChild(buildSection(tr("modal_interpret"), { bullets: item.interpret }));
      if (item.limitations?.length) infoContentEl.appendChild(buildSection(tr("modal_limitations"), { bullets: item.limitations }));
      if (item.refs?.length) infoContentEl.appendChild(buildSection(tr("modal_refs"), { refs: item.refs }));

      infoOverlay.classList.add("open");
      infoOverlay.setAttribute("aria-hidden", "false");
      setTimeout(() => infoCloseBtn.focus(), 0);
    }

    function closeInfoModal() {
      if (!infoOverlay.classList.contains("open")) return;
      infoOverlay.classList.remove("open");
      infoOverlay.setAttribute("aria-hidden", "true");

      if (lastFocusedEl && typeof lastFocusedEl.focus === "function") {
        setTimeout(() => lastFocusedEl.focus(), 0);
      }
      lastFocusedEl = null;
    }

    infoOverlay.addEventListener("click", (e) => {
      if (e.target === infoOverlay) closeInfoModal();
    });

    infoCloseBtn.addEventListener("click", closeInfoModal);

    document.addEventListener("keydown", (e) => {
      if (!infoOverlay.classList.contains("open")) return;

      if (e.key === "Escape") {
        e.preventDefault();
        closeInfoModal();
        return;
      }

      if (e.key === "Tab") {
        const focusables = infoOverlay.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const list = Array.from(focusables).filter(el => !el.disabled && el.offsetParent !== null);
        if (!list.length) return;

        const first = list[0];
        const last = list[list.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    function rgbToCss(rgb){
      return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }

    function getLegendLayerLabel(key){
      return document.querySelector(`.layerRow[data-toggle-row="${key}"] .layerName`)?.textContent?.trim() || (RASTER_SPECS[key]?.title || "Legend");
    }

    function renderContinuousLegend(key){
      const spec = RASTER_SPECS[key];
      const ticks = getRasterLegendTicks(spec, selectedYear);
      const tickHtml = ticks.map((tick) => `<span class="legendTick">${tick}</span>`).join("");
      return `
        <div class="legendScaleCard">
          <div class="legendGradientBar" style="background:${buildLegendGradientCss(key, selectedYear)}"></div>
          <div class="legendTickRow">${tickHtml}</div>

        </div>`;
    }

    function renderLczLegend(){
      const buildItems = LCZ_LEGEND_ORDER.filter((id) => id <= 10).map((id) => {
        const cls = LCZ_CLASSES[id];
        return `
          <div class="legendItem">
            <span class="legendSwatch" style="background:${rgbToCss(cls.color)}"></span>
            <span class="legendClassCode">${cls.code}</span>
            <span class="legendClassLabel">${cls.label}</span>
          </div>`;
      }).join("");

      const landCoverItems = LCZ_LEGEND_ORDER.filter((id) => id >= 11).map((id) => {
        const cls = LCZ_CLASSES[id];
        return `
          <div class="legendItem">
            <span class="legendSwatch" style="background:${rgbToCss(cls.color)}"></span>
            <span class="legendClassCode">${cls.code}</span>
            <span class="legendClassLabel">${cls.label} <span class="legendClassAlias">(${cls.alias})</span></span>
          </div>`;
      }).join("");

      return `
        <div class="legendGroup">
          <div class="legendGroupTitle">${tr("legend_group_built")}</div>
          <div class="legendList">${buildItems}</div>
        </div>
        <div class="legendGroup">
          <div class="legendGroupTitle">${tr("legend_group_landcover")}</div>
          <div class="legendList">${landCoverItems}</div>
        </div>`;
    }

    function renderHotspotLegend(){
      const items = [];
      if (getHotspotChildEnabled("hotspot")) {
        const hotAlpha = Math.max(0.28, Math.min(0.92, HOTSPOT_STYLES.hotspot.fillAlpha * getHotspotOpacity()));
        items.push(`
          <div class="legendItem">
            <span class="legendSwatch" style="background: rgba(255, 82, 82, ${hotAlpha.toFixed(2)});"></span>
            <span class="legendClassCode">Hot</span>
            <span class="legendClassLabel">Hotspot clusters</span>
          </div>`);
      }
      if (getHotspotChildEnabled("coldspot")) {
        const coldAlpha = Math.max(0.28, Math.min(0.92, HOTSPOT_STYLES.coldspot.fillAlpha * getHotspotOpacity()));
        items.push(`
          <div class="legendItem">
            <span class="legendSwatch" style="background: rgba(58, 160, 255, ${coldAlpha.toFixed(2)});"></span>
            <span class="legendClassCode">Cold</span>
            <span class="legendClassLabel">Coldspot clusters</span>
          </div>`);
      }
      if (!items.length) return "";
      return `
        <div class="legendGroup">
          <div class="legendGroupTitle">Hotspots</div>
          <div class="legendList">${items.join("")}</div>
        </div>`;
    }

    function renderLegend(){
      const panel = document.getElementById("mapLegendPanel");
      const card = document.getElementById("mapLegendCard");
      const titleEl = document.getElementById("mapLegendTitle");
      if (!panel || !card || !titleEl) return;

      const sections = [];
      const topKey = getTopVisibleRasterKey();
      const hotspotLegend = getHotspotParentEnabled() ? renderHotspotLegend() : "";

      if (topKey) {
        if (topKey === "lcz") {
          sections.push(renderLczLegend());
        } else {
          sections.push(renderContinuousLegend(topKey));
        }
      }
      if (hotspotLegend) sections.push(hotspotLegend);

      if (!sections.length) {
        card.classList.remove("open");
        panel.innerHTML = "";
        titleEl.textContent = "Legend";
        return;
      }

      titleEl.textContent = topKey ? getLegendLayerLabel(topKey) : "Legend";
      panel.innerHTML = sections.join("");
      card.classList.add("open");
    }

    function wireInfoButtons() {
      document.querySelectorAll(".infoBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInfoModal(btn.dataset.info, btn);
        });
      });
    }


    function buildImageryProviderViewModels(){
      const models = Cesium.createDefaultImageryProviderViewModels();
      const blockedNames = new Set(["Sentinel-2", "Blue Marble", "Earth at night", "Earth at Night"]);
      return models.filter((m) => m && !blockedNames.has(m.name));
    }

    function getDefaultOsmImageryViewModel(models){
      if (!Array.isArray(models)) return undefined;
      return models.find((m) => /open\s*street\s*map/i.test(m?.name || ""))
          || models.find((m) => /open\s*street\s*map/i.test(m?.tooltip || ""))
          || models[0];
    }

    function resetAllDashboardLayersOff(){
      const offState = {
        lst: false,
        suhi: false,
        hotspots: false,
        hotspots_hot: true,
        hotspots_cold: true,
        ndvi: false,
        ndbi: false,
        ndwi: false,
        albedo: false,
        lcz: false,
        buildings3d: false
      };
      setLayerState(offState);
      return offState;
    }

    function wireLayerSwitches(){
      document.querySelectorAll(".layerRow, .subLayerRow").forEach((row) => {
        row.addEventListener("click", (e) => {
          if (e.target && (e.target.tagName === "INPUT" || e.target.classList.contains("slider"))) return;
          if (e.target && e.target.closest && e.target.closest(".infoBtn")) return;

          const key = row.getAttribute("data-toggle-row");
          const cb = document.querySelector(`.layerSwitch[data-layer="${key}"]`);
          if (!cb) return;
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });

      document.querySelectorAll(".layerSwitch").forEach((cb) => {
        const key = cb.dataset.layer;
        const state = getLayerState();
        cb.checked = Object.prototype.hasOwnProperty.call(state, key) ? !!state[key] : false;

        if (RASTER_KEYS.includes(key)) {
          updateOpacityControlVisibility(key, cb.checked);
          applyRasterOpacity(key, getRasterOpacity(key));
          if (cb.checked) markRasterPriority(key);
        } else if (key === "buildings3d") {
          buildingsEnabled = cb.checked;
          updateBuildingOpacityControlVisibility(cb.checked);
          void updateBuildingsVisibility().catch(console.error);
        } else if (key === "hotspots" || key === "hotspots_hot" || key === "hotspots_cold") {
          updateHotspotSubLayerGroup();
          updateHotspotOpacityControlVisibility(getLayerEnabled("hotspots"));
          applyHotspotVisibility();
        } else {
          setVisible(LAYER_REGISTRY[key], cb.checked);
        }

        cb.addEventListener("change", async (e) => {
          const on = e.target.checked;
          const s = getLayerState();
          s[key] = on;
          setLayerState(s);

          if (key === "buildings3d") {
            buildingsEnabled = on;
            updateBuildingOpacityControlVisibility(on);
            void updateBuildingsVisibility().catch(console.error);
            renderLegend();
            return;
          }

          if (RASTER_KEYS.includes(key)) {
            updateOpacityControlVisibility(key, on);
            if (on) {
              applyRasterOpacity(key, getRasterOpacity(key));
              markRasterPriority(key);
              await refreshRasterLayers();
            } else {
              const rs = rasterStates[key];
              hideRasterStateLayers(rs);
              if (getTopVisibleRasterKey() !== key) removeValueLabel();
              if (!getTopVisibleRasterKey()) removeValueLabel();
            }
            renderLegend();
            return;
          }

          if (key === "hotspots" || key === "hotspots_hot" || key === "hotspots_cold") {
            updateHotspotSubLayerGroup();
            updateHotspotOpacityControlVisibility(getLayerEnabled("hotspots"));
            await refreshHotspotLayers();
            return;
          }

          const ref = LAYER_REGISTRY[key];
          if (!ref) {
            console.warn(`Layer "${key}" is not registered yet. Once you add it, the switch will control it.`);
            return;
          }
          setVisible(ref, on);
        });
      });

      updateHotspotSubLayerGroup();
    }

    (async () => {
      const terrainProvider = await Cesium.createWorldTerrainAsync({
        requestVertexNormals: true,
        requestWaterMask: true
      });

      const imageryProviderViewModels = buildImageryProviderViewModels();
      const selectedImageryProviderViewModel = getDefaultOsmImageryViewModel(imageryProviderViewModels);

      viewer = new Cesium.Viewer("cesiumContainer", {
        timeline: false,
        animation: false,
        geocoder: true,
        homeButton: true,
        sceneModePicker: true,
        baseLayerPicker: true,
        imageryProviderViewModels,
        selectedImageryProviderViewModel,
        navigationHelpButton: true,
        fullscreenButton: true,
        vrButton: false,
        infoBox: false,
        selectionIndicator: false,
        fullscreenElement: appFrameEl,
        terrainProvider
      });

      viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
      viewer.scene.globe.depthTestAgainstTerrain = true;
      viewer.scene.globe.enableLighting = false;
      viewer.scene.postRender.addEventListener(updateValueOverlayScreenPosition);

      // Keep the dashboard in controlled top-down navigation:
      // disable Cesium's default double-click camera action so the map
      // does not tilt into an oblique 3D view after a double click.
      viewer.cesiumWidget?.screenSpaceEventHandler?.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
      );

      viewer.homeButton.viewModel.command.beforeExecute.addEventListener(function(e){
        e.cancel = true;
        flyToBoundaryTopDown(selectedCity);
      });

      setupPills("cityPills", "city", async (city) => {
        selectedCity = city;
        await handleSelectionChange({ flyToCity: true });
      });

      setupPills("yearPills", "year", async (year) => {
        selectedYear = year;
        await handleSelectionChange({ flyToCity: false });
      });

      setupPills("langPills", "lang", (lang) => {
        setLanguage(lang);
      });

      try {
        for (const a of ASSETS) {
          const ds = await addBoundaryFromIon(a.id, a.color, a.name);
          loadedByName.set(a.name, ds);
        }
        applyBoundaryVisibility();
      } catch (err) {
        console.error("Boundary load failed:", err);
      }

      wireInfoButtons();
      resetAllDashboardLayersOff();
      createClickMarkerControls();
      createOpacityControls();
      createHotspotOpacityControl();
      createBuildingOpacityControl();
      wireLayerSwitches();
      renderLegend();

      await handleSelectionChange({ flyToCity: true });
      setupRasterClickValueHandler();

      window.viewer = viewer;
      window.registerLayer = registerLayer;
      window.LAYER_REGISTRY = LAYER_REGISTRY;
      window.refreshRasterLayers = refreshRasterLayers;
      window.refreshHotspotLayers = refreshHotspotLayers;
      window.removeValueLabel = removeValueLabel;
      window.setClickMarkerStyle = setClickMarkerStyle;
    })();

    const themeToggle = document.getElementById("themeToggle");
    const themeIcon = document.getElementById("themeIcon");
    const themeText = document.getElementById("themeText");
    const siteLogo = document.getElementById("siteLogo");

    function applyTheme(theme){
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("theme", theme);
      themeIcon.textContent = (theme === "light") ? "☀︎" : "☾";
      themeText.textContent = (theme === "light") ? tr("theme_light") : tr("theme_dark");

      if (siteLogo) {
        siteLogo.src = (theme === "dark")
          ? "./assets/logo_2.png"
          : "./assets/logo.png";
      }

      if (buildingTilesets.size) {
        applyBuildingAppearance();
      }
    }

    const saved = localStorage.getItem("theme");
    const systemPrefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(saved || (systemPrefersLight ? "light" : "dark"));

    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(current === "dark" ? "light" : "dark");
    });

    const overviewBtn = document.getElementById("overviewBtn");
    if (overviewBtn){
      overviewBtn.addEventListener("click", (e) => {
        e.preventDefault();
        openInfoModal("overview");
      });
    }

    window.addEventListener("load", () => {
      openInfoModal("overview");
    }, { once: true });

    setLanguage(currentLang);