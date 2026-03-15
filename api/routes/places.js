import express from 'express';

const router = express.Router();

const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || '';
const geoApiKey = process.env.GEOAPI_KEY || process.env.GEOAPI_ES_KEY || '';
const NOMINATIM_USER_AGENT = 'Tabolize-ERP/1.0';

async function fetchNominatimSuggestions(input) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(input)}&format=json&addressdetails=1&limit=5`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT },
  });
  const data = await resp.json();
  if (!Array.isArray(data)) return [];
  return data.map((r) => ({
    description: r.display_name || '',
    place_id: `nominatim:${r.osm_type || 'node'}:${r.osm_id || ''}`,
    lat: r.lat != null ? parseFloat(r.lat) : undefined,
    lng: r.lon != null ? parseFloat(r.lon) : undefined,
  }));
}

function getGeoApiName(item) {
  if (!item || typeof item !== 'object') return '';
  return item.NM ?? item.NOMBRE ?? item.name ?? item.nombre ?? '';
}

async function fetchZippopotam(cp) {
  const url = `https://api.zippopotam.us/es/${encodeURIComponent(cp)}`;
  const resp = await fetch(url);
  if (!resp.ok) return { municipio: '', provincia: '' };
  const data = await resp.json();
  const places = data.places;
  if (!Array.isArray(places) || places.length === 0) return { municipio: '', provincia: '' };
  const first = places[0];
  const municipio = (first['place name'] ?? first.place_name ?? '').trim();
  const provincia = (first.state ?? '').trim();
  return { municipio, provincia };
}

// GET /places/autocomplete
router.get('/places/autocomplete', async (req, res) => {
  const input = (req.query.input || '').toString().trim();
  if (!input || input.length < 2) {
    return res.json({ predictions: [] });
  }

  let predictions = [];
  let configOk = true;

  if (googleMapsKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${googleMapsKey}&language=es`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.status === 'OK' && Array.isArray(data.predictions) && data.predictions.length > 0) {
        predictions = (data.predictions || []).map((p) => ({
          description: p.description || '',
          place_id: p.place_id || '',
        }));
        return res.json({ predictions });
      }
    } catch (err) {
      console.error('Places autocomplete error:', err);
    }
  } else {
    configOk = false;
  }

  try {
    predictions = await fetchNominatimSuggestions(input);
  } catch (err) {
    console.error('Nominatim autocomplete error:', err);
  }

  res.json({ predictions, configOk: configOk ? undefined : false });
});

// GET /places/details
router.get('/places/details', async (req, res) => {
  const placeId = (req.query.place_id || '').toString().trim();
  if (!placeId || !googleMapsKey) {
    return res.json({ lat: null, lng: null });
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=geometry&key=${googleMapsKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const loc = data.result?.geometry?.location;
    if (!loc) return res.json({ lat: null, lng: null });
    res.json({ lat: loc.lat, lng: loc.lng });
  } catch (err) {
    console.error('Places details error:', err);
    res.json({ lat: null, lng: null });
  }
});

// GET /codigo-postal
router.get('/codigo-postal', async (req, res) => {
  const cp = (req.query.cp || '').toString().trim().replace(/\s/g, '');
  if (!cp || !/^\d{5}$/.test(cp)) {
    return res.json({ municipio: '', provincia: '' });
  }
  let municipio = '';
  let provincia = '';

  if (geoApiKey) {
    try {
      const [provResp, muniResp] = await Promise.all([
        fetch(`https://apiv1.geoapi.es/provincias/?CPOS=${encodeURIComponent(cp)}&FORMAT=json&KEY=${encodeURIComponent(geoApiKey)}`),
        fetch(`https://apiv1.geoapi.es/municipios/?CPOS=${encodeURIComponent(cp)}&FORMAT=json&KEY=${encodeURIComponent(geoApiKey)}`),
      ]);
      const provData = await provResp.json();
      const muniData = await muniResp.json();
      const provList = Array.isArray(provData) ? provData : (provData?.data ?? provData?.results ?? []);
      const muniList = Array.isArray(muniData) ? muniData : (muniData?.data ?? muniData?.results ?? []);
      provincia = getGeoApiName(provList[0]) || '';
      municipio = getGeoApiName(muniList[0]) || '';
    } catch (err) {
      console.error('Codigo postal GeoAPI error:', err);
    }
  }

  if (!municipio && !provincia) {
    try {
      const z = await fetchZippopotam(cp);
      municipio = z.municipio;
      provincia = z.provincia;
    } catch (err) {
      console.error('Codigo postal Zippopotam error:', err);
    }
  }

  res.json({ municipio, provincia });
});

export default router;
