/* ═══════════════════════════════════════════════════════
   app.js  –  MapLibre GL JS v4 + OSRM routing
              Aucun token requis — 100% open source
   ═══════════════════════════════════════════════════════ */

// ── Config ────────────────────────────────────────────
const GEOJSON_PATH = 'loc.geojson';
// API OSRM publique (open source, gratuite, pas de token)
const OSRM_API = 'https://router.project-osrm.org/route/v1/driving';

// ── État global ───────────────────────────────────────
let userPosition          = null;   // [lng, lat]
let userMarker            = null;
let destMarker            = null;
let selectedFeatureId     = null;
let selectedCoords        = null;   // [lng, lat] du point cliqué, utilisé pour le lien Google Maps
let routeVisible          = false;
let routeAbortController  = null;     // Gestion de la concurrence réseau OSRM

// ── Carte MapLibre ────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-2.3088, 48.2634],
  zoom: 3,
  pitch: 55,
  bearing: -10,
  antialias: true,
});

map.on('load', () => {

  // ── Repère commun pour empiler proprement les fonds de carte ──
  // FIX : on calcule cet identifiant UNE SEULE FOIS, avant tout ajout.
  // firstSymbolId marque la frontière entre les couches "données" du
  // style vecteur (background, landuse, eau, routes…) et les couches
  // "labels" (symbol). C'est l'ancre qu'on utilise pour empiler à la
  // fois le satellite et les bâtiments 3D au bon endroit.
  const baseLayers    = map.getStyle().layers;
  const firstSymbolId = baseLayers.find(l => l.type === 'symbol')?.id;

  // ── Source & Couche Satellite Google ──────────────────
  // FIX : précédemment insérée avant la toute première couche du style
  // (donc sous le fond opaque "background"/landuse/eau/routes), ce qui
  // la rendait invisible même à raster-opacity:1. On l'insère désormais
  // juste avant firstSymbolId : elle vient donc se poser AU-DESSUS de
  // tous les remplissages opaques du fond OSM vecteur et masque
  // correctement celui-ci une fois activée, tout en restant SOUS les
  // bâtiments 3D et les labels.
  map.addSource('google-satellite-source', {
    type: 'raster',
    tiles: [
      "https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      "https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      "https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
    ],
    tileSize: 256
  });

  // FIX : plus de bouton manuel — la transition OSM → Satellite se fait
  // maintenant automatiquement et en fondu via une expression 'interpolate'
  // sur le zoom : opacité 0 jusqu'à z13 (fond OSM seul visible), puis
  // montée linéaire et douce jusqu'à opacité 1 à z14 (satellite pleinement
  // visible). Aucun JS supplémentaire requis ensuite : MapLibre réévalue
  // cette expression à chaque frame de zoom, d'où le "smooth" demandé.
  map.addLayer({
    id: 'google-satellite-layer',
    type: 'raster',
    source: 'google-satellite-source',
    paint: {
      'raster-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13, 0,
        14, 1,
      ],
      'raster-opacity-transition': { duration: 0 }, // l'interpolation gère déjà le fondu ; pas de double-transition
    }
  }, firstSymbolId);

  // ── Bâtiments 3D ──────────────────────────────────
  // FIX : ajoutés avec le MÊME ancrage (firstSymbolId) que le satellite.
  // Comme addLayer(layer, beforeId) insère juste avant la couche cible,
  // ce second appel avec le même beforeId place les bâtiments
  // au-dessus du satellite (et toujours sous les labels) :
  //   [fonds vecteur opaques] → [satellite] → [bâtiments 3D] → [labels]
  // Le fond actif (OSM ou satellite) est donc visible sous les
  // bâtiments dans les deux modes.
  if (!map.getLayer('3d-buildings')) {
    map.addLayer(
      {
        id: '3d-buildings',
        source: 'openmaptiles',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 13,
        paint: {
          // FIX : on enveloppe l'entrée dans un coalesce, exactement comme pour
          // la hauteur. Sans ce repli, quand render_height est absent (tuiles
          // de zoom moins détaillé), interpolate recevait une valeur invalide
          // et MapLibre retombait sur la couleur par défaut du calque, à savoir
          // noir — c'est ce qui causait le flash noir observé en zoomant.
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 10],
            0,   '#1a2035',
            20,  '#1e2d4a',
            100, '#243660',
          ],
          // FIX : suppression de l'effet de fade-in par zoom (qui forçait
          // la hauteur à 0 entre les zooms 13 et 14, alors que la base
          // restait égale à render_min_height — ce qui pouvait produire
          // une base supérieure à la hauteur, donc une extrusion
          // inversée/invalide). Les bâtiments affichent maintenant
          // directement leur hauteur réelle dès l'entrée en minzoom.
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          // FIX : opacité désormais liée au même intervalle de zoom (13→14)
          // que le fondu du satellite, pour que les bâtiments s'atténuent
          // progressivement et laissent voir la photo aérienne au fur et
          // à mesure qu'elle apparaît, au lieu d'un saut brusque déclenché
          // par un clic.
          'fill-extrusion-opacity': [
            'interpolate', ['linear'], ['zoom'],
            13, 0.85,
            14, 0.2,
          ],
        },
      },
      firstSymbolId
    );
  }

  // ── Source route (tracé vide au départ) ──────────
  // Inchangé pour l'instant : ajoutée sans "beforeId", donc au sommet
  // de la pile au moment de sa création → la route reste au-dessus des
  // labels textuels, comme demandé.
  map.addSource('route-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'route-shadow',
    type: 'line',
    source: 'route-source',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': 'rgba(0,0,0,0.3)',
      'line-width': 10,
      'line-blur': 4,
      'line-translate': [2, 3],
    },
  });

  map.addLayer({
    id: 'route-layer',
    type: 'line',
    source: 'route-source',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#4a9eff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7],
      'line-opacity': 0.92,
    },
  });

  map.addLayer({
    id: 'route-dash',
    type: 'line',
    source: 'route-source',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#fff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 2.5],
      'line-dasharray': [0, 4, 3],
      'line-opacity': 0.5,
    },
  });

  // Les points sont chargés EN DERNIER → ils s'affichent par-dessus tout
  // (y compris les labels), inchangé pour l'instant.
  loadPoints();
});

// ── Chargement des points GeoJSON ─────────────────────
function loadPoints() {
  fetch(GEOJSON_PATH)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} — ${GEOJSON_PATH}`);
      return r.json();
    })
    .then((geojson) => {
      // FIX : on ne touche PAS aux ids manuellement quand generateId:true est actif.
      // generateId:true génère automatiquement des ids entiers séquentiels (0, 1, 2…)
      // et les conflits avec des ids existants dans les features corrompent le rendu
      // sous MapLibre GL JS v4. On supprime donc tout id existant dans les features.
      geojson.features = geojson.features.map((f) => {
        const clean = { ...f };
        delete clean.id;   // laisser generateId faire son travail
        return clean;
      });

      map.addSource('points-source', {
        type: 'geojson',
        data: geojson,
        generateId: true,  // MapLibre attribue des ids 0, 1, 2… sans conflit
      });

      // FIX : aucun 4e argument → les layers de points sont ajoutés AU SOMMET
      // de la pile de rendu et s'affichent donc par-dessus les bâtiments 3D.
      map.addLayer({
        id: 'points-halo',
        type: 'circle',
        source: 'points-source',
        paint: {
          'circle-radius':       ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 22],
          'circle-color':        'rgba(0,212,170,0.13)',
          'circle-stroke-width': 0,
        },
      });

      map.addLayer({
        id: 'points-layer',
        type: 'circle',
        source: 'points-source',
        paint: {
          'circle-radius':       ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11],
          'circle-color':        ['case', ['boolean', ['feature-state', 'selected'], false], '#ff6b6b', '#00d4aa'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#fff',
          'circle-opacity':      0.95,
        },
      });

      map.on('mouseenter', 'points-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'points-layer', () => { map.getCanvas().style.cursor = ''; });
      map.on('click', 'points-layer', onPointClick);

      centerOnPoints(geojson);
    })
    .catch((err) => {
      console.error('[app.js] GeoJSON :', err);
      showToast('Impossible de charger les points.', true);
    });
}

// ── Clic sur un point ─────────────────────────────────
function onPointClick(e) {
  const feature = e.features[0];
  const coords  = feature.geometry.coordinates.slice();

  // FIX : Ajustement pour éviter les sauts hors-limite géographiques si l'utilisateur zoome en arrière arrière
  while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
    coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
  }

  if (selectedFeatureId !== null) {
    map.setFeatureState({ source: 'points-source', id: selectedFeatureId }, { selected: false });
  }
  // FIX : avec generateId:true, l'id est sur feature.id (entier auto-généré)
  selectedFeatureId = feature.id;
  map.setFeatureState({ source: 'points-source', id: selectedFeatureId }, { selected: true });

  document.getElementById('hint-tap').classList.add('hidden');

  const props = feature.properties || {};
  const label = props.nom || props.name || props.label || props.titre
               || props.id  || `Point ${selectedFeatureId ?? ''}`;

  if (destMarker) {
    destMarker.setLngLat(coords);
  } else {
    const el = document.createElement('div');
    el.className = 'dest-marker';
    destMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(coords)
      .addTo(map);
  }

  document.getElementById('route-dest-label').textContent = label;

  // On mémorise les coordonnées du point sélectionné : le bouton
  // "Voir sur Google Maps" du panneau s'en sert pour ouvrir la bonne URL.
  selectedCoords = coords;

  openPanel();
  setStatsLoading();

  if (!userPosition) {
    showToast('Activez la géolocalisation pour calculer l\'itinéraire.', true);
    return;
  }

  calculateRoute(userPosition, coords);
}

// ── Calcul d'itinéraire OSRM (open source, gratuit) ──
async function calculateRoute(origin, destination) {
  // Annuler la requête précédente si elle est encore en cours
  if (routeAbortController) {
    routeAbortController.abort();
  }
  // Initialisation du nouveau contrôleur pour le processus asynchrone courant
  routeAbortController = new AbortController();

  const url =
    `${OSRM_API}/${origin[0]},${origin[1]};${destination[0]},${destination[1]}` +
    `?geometries=geojson&overview=full`;

  try {
    const res  = await fetch(url, { signal: routeAbortController.signal });
    const data = await res.json();

    if (!data.routes || !data.routes.length) {
      showToast('Aucun itinéraire trouvé.', true);
      setStatsError();
      return;
    }

    const route    = data.routes[0];
    const duration = route.duration;
    const distance = route.distance;

    map.getSource('route-source').setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: route.geometry }],
    });

    document.getElementById('val-duration').textContent = formatDuration(duration);
    document.getElementById('val-distance').textContent = formatDistance(distance);
    document.getElementById('val-duration').classList.remove('loading');
    document.getElementById('val-distance').classList.remove('loading');

    const coords = route.geometry.coordinates;
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, {
      padding: { top: 80, bottom: 240, left: 40, right: 40 },
      pitch: 45,
      duration: 1200,
    });

    routeVisible = true;

  } catch (err) {
    // Si l'erreur est provoquée par l'annulation volontaire via AbortController, on l'ignore silencieusement
    if (err.name === 'AbortError') return;

    console.error('[app.js] OSRM :', err);
    showToast('Erreur lors du calcul d\'itinéraire.', true);
    setStatsError();
  }
}

// ── Fond de carte : transition automatique gérée entièrement dans
// map.on('load') via des expressions 'interpolate' sur le zoom (voir
// plus haut). Plus de bouton ni de gestionnaire de clic nécessaires ici.

// ── Formatage ─────────────────────────────────────────
function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h}h ${r}min` : `${h}h`;
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// ── Panel ─────────────────────────────────────────────
function openPanel()  { document.getElementById('route-panel').classList.add('open'); }

function closePanel() {
  document.getElementById('route-panel').classList.remove('open');
  if (map.getSource('route-source')) {
    map.getSource('route-source').setData({ type: 'FeatureCollection', features: [] });
  }
  if (destMarker) { destMarker.remove(); destMarker = null; }
  selectedCoords = null;
  if (selectedFeatureId !== null) {
    map.setFeatureState({ source: 'points-source', id: selectedFeatureId }, { selected: false });
    selectedFeatureId = null;
  }
  routeVisible = false;
  document.getElementById('hint-tap').classList.remove('hidden');
}

function setStatsLoading() {
  ['val-duration', 'val-distance'].forEach(id => {
    document.getElementById(id).textContent = '';
    document.getElementById(id).classList.add('loading');
  });
}

function setStatsError() {
  ['val-duration', 'val-distance'].forEach(id => {
    document.getElementById(id).classList.remove('loading');
    document.getElementById(id).textContent = '--';
  });
}

document.getElementById('btn-close-route').addEventListener('click', closePanel);

// ── Ouvrir le point sélectionné dans Google Maps ──────
// Utilise le format d'URL officiel "Google Maps URLs" (sans clé API,
// sans token, juste un lien) : https://developers.google.com/maps/documentation/urls
const btnOpenGmaps = document.getElementById('btn-open-gmaps');
if (btnOpenGmaps) {
  btnOpenGmaps.addEventListener('click', () => {
    if (!selectedCoords) {
      showToast('Aucun point sélectionné.', true);
      return;
    }
    const [lng, lat] = selectedCoords;
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
}

// ── Géolocalisation ───────────────────────────────────
const btnLocate = document.getElementById('btn-locate');
btnLocate.addEventListener('click', locateUser);

function locateUser() {
  if (!navigator.geolocation) {
    showToast('Géolocalisation non disponible sur cet appareil.', true);
    return;
  }
  btnLocate.classList.add('locating');
  showToast('Localisation en cours…');
  navigator.geolocation.getCurrentPosition(
    onLocationSuccess, onLocationError,
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function onLocationSuccess(position) {
  btnLocate.classList.remove('locating');
  const { longitude, latitude } = position.coords;
  userPosition = [longitude, latitude];

  if (userMarker) {
    userMarker.setLngLat(userPosition);
  } else {
    const el = document.createElement('div');
    el.className = 'user-dot';
    userMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(userPosition)
      .addTo(map);
  }

  if (selectedFeatureId !== null && destMarker) {
    const lngLat = destMarker.getLngLat();
    setStatsLoading();
    calculateRoute(userPosition, [lngLat.lng, lngLat.lat]);
  } else {
    map.flyTo({
      center: userPosition, zoom: 14, pitch: 55,
      bearing: map.getBearing(), duration: 1400, essential: true,
    });
    showToast('Position trouvée ! Appuyez sur un point.');
  }
}

function onLocationError(err) {
  btnLocate.classList.remove('locating');
  const messages = {
    1: 'Permission refusée. Autorisez la géolocalisation.',
    2: 'Position introuvable. Vérifiez votre connexion.',
    3: 'La demande a expiré. Réessayez.',
  };
  showToast(messages[err.code] || 'Erreur de géolocalisation.', true);
}

// ── Centrer sur les points ────────────────────────────
function centerOnPoints(geojson) {
  const coords = geojson.features
    .filter((f) => f.geometry?.type === 'Point')
    .map((f) => f.geometry.coordinates);
  if (!coords.length) return;
  if (coords.length === 1) { map.flyTo({ center: coords[0], zoom: 14, pitch: 55 }); return; }
  const bounds = coords.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(coords[0], coords[0])
  );
  map.fitBounds(bounds, {
    padding: { top: 80, bottom: 120, left: 40, right: 40 },
    pitch: 55, maxZoom: 15, duration: 1200,
  });
}

// ── Toast ─────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}