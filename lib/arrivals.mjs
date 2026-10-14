// Arrivals: ships heading to UK steel ports (live AIS via aisstream.io) and
// the monthly HMRC picture of where steel comes in, and how.
//
// AIS gives a ship's position, type, size, draught, destination and ETA,
// never its cargo. We infer "likely steel" from where a ship has been:
// a cargo ship seen at a steel-exporting port with a UK steel port as its
// destination is a strong signal. It's a guess, and it's labelled as one.

export const AIS_URL = "wss://stream.aisstream.io/v0/stream";

// UK ports that handle a lot of imported steel. `match` is tested against
// the free-text AIS destination (crews type it: "GB HUL", "IMMINGHAM", ...).
export const UK_PORTS = [
  { id: "HUL", name: "Hull", lat: 53.74, lon: -0.29, match: /\b(GB ?HUL|HULL)\b/i },
  { id: "IMM", name: "Immingham", lat: 53.63, lon: -0.19, match: /\b(GB ?IMM|IMMINGHAM)\b/i },
  { id: "GOO", name: "Goole", lat: 53.70, lon: -0.87, match: /\b(GB ?GOO|GOOLE)\b/i },
  { id: "GSY", name: "Grimsby", lat: 53.58, lon: -0.07, match: /\b(GB ?GSY|GRIMSBY)\b/i },
  { id: "TEE", name: "Teesport", lat: 54.61, lon: -1.16, match: /\b(GB ?TEE|GB ?MID|TEES(PORT)?|MIDDLESBRO(UGH)?)\b/i },
  { id: "BOS", name: "Boston", lat: 52.97, lon: -0.02, match: /\b(GB ?BOS|BOSTON ?UK|BOSTON,? ?(LINCS|GB|UK))\b/i },
  { id: "KLN", name: "King's Lynn", lat: 52.76, lon: 0.39, match: /\b(GB ?KLN|KINGS? ?LYNN)\b/i },
  { id: "TIL", name: "Tilbury / Thames", lat: 51.45, lon: 0.35, match: /\b(GB ?TIL|TILBURY|GB ?LON|THAMESPORT|PURFLEET|DAGENHAM|ERITH)\b/i },
  { id: "SSS", name: "Sheerness", lat: 51.44, lon: 0.74, match: /\b(GB ?SSS|SHEERNESS)\b/i },
  { id: "NPT", name: "Newport", lat: 51.55, lon: -2.99, match: /\b(GB ?NPT|NEWPORT ?(UK|GB|WALES|GWENT)?)\b/i },
  { id: "PTB", name: "Port Talbot", lat: 51.58, lon: -3.81, match: /\b(GB ?PTB|PORT ?TALBOT)\b/i },
  { id: "AVO", name: "Avonmouth / Bristol", lat: 51.50, lon: -2.71, match: /\b(GB ?AVO|AVONMOUTH|GB ?BRS|BRISTOL|PORTBURY)\b/i },
  { id: "LIV", name: "Liverpool", lat: 53.45, lon: -3.02, match: /\b(GB ?LIV|LIVERPOOL|SEAFORTH|GB ?BKD|BIRKENHEAD|ELLESMERE)\b/i },
  { id: "SHO", name: "Shoreham", lat: 50.83, lon: -0.24, match: /\b(GB ?SHO|SHOREHAM)\b/i },
  { id: "LEI", name: "Leith / Forth", lat: 55.98, lon: -3.17, match: /\b(GB ?LEI|LEITH|GRANGEMOUTH|ROSYTH)\b/i },
];

// Big steel-exporting ports. Ships loading here and heading to the UK are
// the strongest "likely steel" signal we can get from public data.
export const STEEL_PORTS = [
  { id: "ISK", name: "Iskenderun bay, Turkey", country: "TR", box: [[36.45, 35.85], [36.98, 36.32]] },
  { id: "MAR", name: "Marmara (Ereğli, Izmit), Turkey", country: "TR", box: [[40.62, 27.70], [41.12, 29.95]] },
  { id: "ALI", name: "Aliağa, Turkey", country: "TR", box: [[38.70, 26.82], [38.92, 27.02]] },
  { id: "BIO", name: "Bilbao, Spain", country: "ES", box: [[43.28, -3.20], [43.47, -2.88]] },
  { id: "GIJ", name: "Gijón / Avilés, Spain", country: "ES", box: [[43.50, -6.05], [43.66, -5.55]] },
  { id: "RAV", name: "Ravenna, Italy", country: "IT", box: [[44.42, 12.18], [44.56, 12.40]] },
  { id: "TAR", name: "Taranto, Italy", country: "IT", box: [[40.38, 17.05], [40.52, 17.30]] },
  { id: "GDN", name: "Gdańsk / Gdynia, Poland", country: "PL", box: [[54.30, 18.45], [54.60, 18.80]] },
];

// UK approach areas we watch (lat, lon corners).
export const UK_BOXES = [
  { id: "humber", name: "Humber & The Wash", box: [[52.70, -0.95], [54.10, 1.40]] },
  { id: "tees", name: "Tees & Tyne", box: [[54.45, -1.40], [55.10, -0.60]] },
  { id: "thames", name: "Thames estuary", box: [[51.25, 0.20], [51.70, 1.70]] },
  { id: "bristol", name: "Bristol Channel", box: [[51.15, -4.40], [51.70, -2.60]] },
  { id: "mersey", name: "Mersey & Liverpool Bay", box: [[53.25, -3.70], [53.75, -2.90]] },
  { id: "forth", name: "Firth of Forth", box: [[55.90, -3.50], [56.15, -2.40]] },
];

export const isCargo = (type) => type >= 70 && type <= 79;
export const inBox = (lat, lon, box) => lat >= box[0][0] && lat <= box[1][0] && lon >= box[0][1] && lon <= box[1][1];
export const matchUkPort = (dest = "") => (dest ? UK_PORTS.find((p) => p.match.test(dest)) || null : null);
export function nearestUkPort(lat, lon) {
  let best = null;
  for (const p of UK_PORTS) { const d = distanceNm(lat, lon, p.lat, p.lon); if (!best || d < best.nm) best = { port: p, nm: d }; }
  return best;
}
export function distanceNm(lat1, lon1, lat2, lon2) {
  const r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 3440.065 * 2 * Math.asin(Math.sqrt(a));
}

export function subscription(apiKey, extraMmsi = []) {
  const boxes = [...UK_BOXES.map((b) => b.box), ...STEEL_PORTS.map((p) => p.box)];
  return { APIKey: apiKey, BoundingBoxes: boxes, FilterMessageTypes: ["PositionReport", "ShipStaticData", "StandardClassBPositionReport"] };
}
// A second connection follows your own shipments anywhere in the world.
export function trackedSubscription(apiKey, mmsis) {
  return { APIKey: apiKey, BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: mmsis.slice(0, 200).map(String), FilterMessageTypes: ["PositionReport", "ShipStaticData"] };
}

function etaIso(eta, now = new Date()) {
  if (!eta || !eta.Month || !eta.Day || eta.Month > 12 || eta.Day > 31) return null;
  let year = now.getUTCFullYear();
  const d = new Date(Date.UTC(year, eta.Month - 1, eta.Day, eta.Hour < 24 ? eta.Hour : 0, eta.Minute < 60 ? eta.Minute : 0));
  if (d.getTime() < now.getTime() - 60 * 86_400_000) d.setUTCFullYear(year + 1); // ETA in January seen in December
  return d.toISOString();
}

// Fold one aisstream message into the vessel table. Returns the vessel.
export function applyMessage(vessels, msg, now = new Date()) {
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || meta.mmsi || "");
  if (!/^\d{9}$/.test(mmsi)) return null;
  const v = vessels[mmsi] || (vessels[mmsi] = { mmsi, firstSeen: now.toISOString() });
  const lat = meta.latitude ?? meta.Latitude, lon = meta.longitude ?? meta.Longitude;
  if (meta.ShipName && meta.ShipName.trim()) v.name = meta.ShipName.trim();
  const body = msg.Message || {};
  const pos = body.PositionReport || body.StandardClassBPositionReport;
  if (pos || (Number.isFinite(lat) && Number.isFinite(lon))) {
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      v.lat = lat; v.lon = lon; v.at = now.toISOString();
      const uk = UK_BOXES.find((b) => inBox(lat, lon, b.box));
      const sp = STEEL_PORTS.find((p) => inBox(lat, lon, p.box));
      v.area = uk ? uk.name : sp ? sp.name : "At sea";
      if (uk) { v.inUk = { area: uk.name, at: now.toISOString() }; const n = nearestUkPort(lat, lon); v.nearPort = n && n.nm < 12 ? n.port.id : null; }
      if (sp) v.steelPort = { id: sp.id, name: sp.name, country: sp.country, at: now.toISOString(), draught: v.draught ?? null };
    }
    if (pos) { v.sog = pos.Sog; v.cog = pos.Cog; v.navStatus = pos.NavigationalStatus; }
  }
  const st = body.ShipStaticData;
  if (st) {
    if (st.Name && st.Name.trim()) v.name = st.Name.trim();
    if (st.ImoNumber) v.imo = String(st.ImoNumber);
    if (Number.isFinite(st.Type)) v.type = st.Type;
    if (st.Destination !== undefined) v.destination = String(st.Destination).replace(/@+/g, "").trim();
    const eta = etaIso(st.Eta, now); if (eta) v.eta = eta;
    if (Number.isFinite(st.MaximumStaticDraught) && st.MaximumStaticDraught > 0) {
      if (v.draught && st.MaximumStaticDraught > v.draught + 1) v.draughtUp = { from: v.draught, to: st.MaximumStaticDraught, at: now.toISOString() };
      v.draught = st.MaximumStaticDraught;
    }
    if (st.Dimension) v.length = (st.Dimension.A || 0) + (st.Dimension.B || 0) || v.length;
  }
  const port = matchUkPort(v.destination);
  v.destPort = port ? port.id : null;
  return v;
}

// How likely is this ship to be bringing steel into the UK?
export function steelLikelihood(v) {
  if (v.type !== undefined && !isCargo(v.type)) return { level: "none", why: "Not a cargo ship" };
  const fromSteel = v.steelPort;
  const toUk = v.destPort;
  if (fromSteel && toUk) return { level: "high", why: `Seen at ${fromSteel.name} with ${portName(toUk)} as its destination` };
  if (fromSteel && v.inUk && Date.parse(v.inUk.at) > Date.parse(fromSteel.at)) return { level: "high", why: `Came from ${fromSteel.name}, now in the ${v.inUk.area}` };
  if (fromSteel) return { level: "watch", why: `At ${fromSteel.name}${v.destination ? `, heading for “${v.destination}”` : ""}` };
  if (toUk && v.type >= 70 && v.type <= 79 && (v.length || 0) >= 80 && (v.length || 0) <= 200) return { level: "medium", why: `General cargo ship for ${portName(toUk)}; we haven't seen where it loaded` };
  if (toUk) return { level: "low", why: `Cargo ship for ${portName(toUk)}` };
  return { level: "low", why: "Cargo ship in UK waters" };
}
export const portName = (id) => (UK_PORTS.find((p) => p.id === id) || {}).name || id;

export function pruneVessels(vessels, now = Date.now(), days = 30) {
  for (const [k, v] of Object.entries(vessels)) if (!v.at || now - Date.parse(v.at) > days * 86_400_000) delete vessels[k];
}

// ---------------------------------------------------------------- HMRC
export const MODES = { 10: "Sea", 20: "Rail", 30: "Road", 40: "Air", 50: "Post", 60: "Ro-Ro", 70: "Fixed", 80: "Inland water", 90: "Own power" };
export const modeGroup = (m) => (m === "10" ? "Sea" : m === "30" || m === "60" ? "Road / Ro-Ro" : m === "20" || m === "70" ? "Rail / tunnel" : "Other");

// Tonnes by UK port and by route for your codes, month by month.
export function portsAndRoutes(trade, yourCodes, { months = 12 } = {}) {
  const pfx = yourCodes.map((c) => c.slice(0, 6));
  const periods = Object.keys(trade).sort().slice(-months);
  const ports = {}, routes = {}, monthly = [];
  let withPorts = 0;
  for (const p of periods) {
    const m = { p, total: 0, routes: {} };
    for (const [code, c] of Object.entries(trade[p] || {})) {
      if (!pfx.some((x) => code.startsWith(x))) continue;
      m.total += c.t;
      if (c.pt) {
        withPorts++;
        for (const [port, t] of Object.entries(c.pt)) { (ports[port] ||= { port, total: 0, byMonth: {}, routes: {} }); ports[port].total += t; ports[port].byMonth[p] = (ports[port].byMonth[p] || 0) + t; }
      }
      if (c.md) for (const [mode, t] of Object.entries(c.md)) { const g = modeGroup(mode); routes[g] = (routes[g] || 0) + t; m.routes[g] = (m.routes[g] || 0) + t; }
      if (c.pm) for (const [key, t] of Object.entries(c.pm)) { const [port, mode] = key.split("|"); if (ports[port]) { const g = modeGroup(mode); ports[port].routes[g] = (ports[port].routes[g] || 0) + t; } }
    }
    monthly.push(m);
  }
  return { periods, hasPorts: withPorts > 0, ports: Object.values(ports).sort((a, b) => b.total - a.total), routes, monthly };
}
