/* ═══════════════════════════════════════════════════════
   app.js  –  Carte Mapbox Standard 3D + points GeoJSON
              + calcul d'itinéraire voiture (Directions API)
   ═══════════════════════════════════════════════════════ */

// ── Config ────────────────────────────────────────────

mapboxgl.accessToken = 'pk.eyJ1Ijoic2FpZGtoYXRpciIsImEiOiJjbHNrZHJpamcwMm03MmpuYWN4MWsxdHJrIn0.Lv3Bzhrab6Qw2sKs5rHarw';

const GEOJSON_PATH   = 'loc.geojson';
const DIRECTIONS_API = 'https://api.mapbox.com/directions/v5/mapbox/driving';

// ── État global ───────────────────────────────────────
let userPosition  = null;   // [lng, lat]
let userMarker    = null;
let destMarker    = null;
let routeVisible  = false;

// ── Carte ─────────────────────────────────────────────
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  center: [2.3488, 48.8534],
  zoom: 12,
  pitch: 55,
  bearing: -10,
  antialias: true,
});

map.on('style.load', () => {

  // Source + couche pour le tracé de route
  map.addSource('route-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Couche ombre (épaisse, sombre)
  map.addLayer({
    id: 'route-shadow',
    type: 'line',
    source: 'route-source',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': 'rgba(0,0,0,0.35)',
      'line-width': 10,
      'line-blur': 4,
      'line-translate': [2, 3],
    },
  });

  // Couche principale de la route
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

  // Couche pointillé animé par-dessus
  map.addLayer({
    id: 'route-dash',
    type: 'line',
    source: 'route-source',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#fff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 2.5],
      'line-dasharray': [0, 4, 3],
      'line-opacity': 0.55,
    },
  });

  loadPoints();
});

// ── Chargement des points GeoJSON ─────────────────────
function loadPoints() {
  fetch(GEOJSON_PATH)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((geojson) => {
      map.addSource('points-source', { type: 'geojson', data: geojson });

      map.addLayer({
        id: 'points-halo',
        type: 'circle',
        source: 'points-source',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 20],
          'circle-color': 'rgba(0,212,170,0.14)',
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

      // Curseur
      map.on('mouseenter', 'points-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'points-layer', () => { map.getCanvas().style.cursor = ''; });

      // Clic sur un point → calculer l'itinéraire
      map.on('click', 'points-layer', onPointClick);

      centerOnPoints(geojson);
    })
    .catch((err) => {
      console.error('[app.js] GeoJSON :', err);
      showToast('Impossible de charger les points.', true);
    });
}

// ── Clic sur un point de la couche ───────────────────
let selectedFeatureId = null;

function onPointClick(e) {
  const feature = e.features[0];
  const coords  = feature.geometry.coordinates.slice();

  // Reset état visuel du précédent point sélectionné
  if (selectedFeatureId !== null) {
    map.setFeatureState({ source: 'points-source', id: selectedFeatureId }, { selected: false });
  }
  selectedFeatureId = feature.id;
  map.setFeatureState({ source: 'points-source', id: selectedFeatureId }, { selected: true });

  // Masquer le hint
  document.getElementById('hint-tap').classList.add('hidden');

  // Nom du point (adapte selon tes propriétés GeoJSON)
  const props = feature.properties || {};
  const label = props.nom || props.name || props.label || props.titre
             || props.id  || `Point ${selectedFeatureId ?? ''}`;

  // Marqueur destination
  if (destMarker) {
    destMarker.setLngLat(coords);
  } else {
    const el = document.createElement('div');
    el.className = 'dest-marker';
    destMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat(coords)
      .addTo(map);
  }

  // Mettre à jour le label dans le panel
  document.getElementById('route-dest-label').textContent = label;

  if (!userPosition) {
    openPanel();
    setStatsLoading();
    showToast('Activez la géolocalisation pour calculer l\'itinéraire.', true);
    return;
  }

  openPanel();
  setStatsLoading();
  calculateRoute(userPosition, coords);
}

// ── Calcul d'itinéraire via Mapbox Directions ─────────
async function calculateRoute(origin, destination) {
  const url =
    `${DIRECTIONS_API}/${origin[0]},${origin[1]};${destination[0]},${destination[1]}` +
    `?geometries=geojson&overview=full&steps=false` +
    `&access_token=${mapboxgl.accessToken}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.routes || !data.routes.length) {
      showToast('Aucun itinéraire trouvé.', true);
      setStatsError();
      return;
    }

    const route    = data.routes[0];
    const duration = route.duration; // secondes
    const distance = route.distance; // mètres

    // Afficher le tracé
    map.getSource('route-source').setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: route.geometry }],
    });

    // Mettre à jour les stats
    document.getElementById('val-duration').textContent = formatDuration(duration);
    document.getElementById('val-distance').textContent = formatDistance(distance);
    document.getElementById('val-duration').classList.remove('loading');
    document.getElementById('val-distance').classList.remove('loading');

    // Cadrer sur la route
    const bounds = route.geometry.coordinates.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(
        route.geometry.coordinates[0],
        route.geometry.coordinates[0]
      )
    );
    map.fitBounds(bounds, {
      padding: { top: 80, bottom: 240, left: 40, right: 40 },
      pitch: 45,
      duration: 1200,
    });

    routeVisible = true;

  } catch (err) {
    console.error('[app.js] Directions API :', err);
    showToast('Erreur lors du calcul d\'itinéraire.', true);
    setStatsError();
  }
}

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

// ── Helpers panel ─────────────────────────────────────
function openPanel() {
  document.getElementById('route-panel').classList.add('open');
}

function closePanel() {
  document.getElementById('route-panel').classList.remove('open');
  // Effacer le tracé
  if (map.getSource('route-source')) {
    map.getSource('route-source').setData({ type: 'FeatureCollection', features: [] });
  }
  // Retirer le marqueur destination
  if (destMarker) { destMarker.remove(); destMarker = null; }
  // Reset couleur point sélectionné
  if (selectedFeatureId !== null) {
    map.setFeatureState({ source: 'points-source', id: selectedFeatureId }, { selected: false });
    selectedFeatureId = null;
  }
  routeVisible = false;
  // Réafficher le hint
  document.getElementById('hint-tap').classList.remove('hidden');
}

function setStatsLoading() {
  document.getElementById('val-duration').textContent = '';
  document.getElementById('val-distance').textContent = '';
  document.getElementById('val-duration').classList.add('loading');
  document.getElementById('val-distance').classList.add('loading');
}

function setStatsError() {
  document.getElementById('val-duration').classList.remove('loading');
  document.getElementById('val-distance').classList.remove('loading');
  document.getElementById('val-duration').textContent = '--';
  document.getElementById('val-distance').textContent = '--';
}

document.getElementById('btn-close-route').addEventListener('click', closePanel);

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
    onLocationSuccess,
    onLocationError,
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
    userMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat(userPosition)
      .addTo(map);
  }

  // Si un point est déjà sélectionné, recalculer maintenant qu'on a la position
  if (selectedFeatureId !== null && destMarker) {
    const destLngLat = destMarker.getLngLat();
    setStatsLoading();
    calculateRoute(userPosition, [destLngLat.lng, destLngLat.lat]);
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
    new mapboxgl.LngLatBounds(coords[0], coords[0])
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
