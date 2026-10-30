// Mock backend: GET /api/catalog and POST /api/bookings
export const CATALOG = {
  SKU_AIRPODS_PRO2: { name: "AirPods Pro 2nd Gen", max_capacity_per_unit: 1, plans: { STD: 249.0, CARE: 279.0 } },
  SKU_MESH_WIFI6: { name: "AeroMesh Wi-Fi 6E Home Pack", max_capacity_per_unit: 2, plans: { STD: 399.0, PRO: 499.0 } },
  SKU_TEAM_HUB: { name: "SyncHub Conference Bar", max_capacity_per_unit: 3, plans: { STD: 899.0, PRO: 1150.0 } },
};

// Informal names / typos users actually type. Matching is deterministic, not LLM-guessed.
const ALIASES = {
  SKU_AIRPODS_PRO2: ["airpods", "air pods", "airpod", "airpods pro", "apple earbuds", "earpods"],
  SKU_MESH_WIFI6: ["aeromesh", "aero mesh", "arrow mesh", "arrowmesh", "aero mesh wifi", "mesh wifi", "mesh wi-fi", "wifi 6e", "aromesh"],
  SKU_TEAM_HUB: ["synchub", "sync hub", "sink hub", "synch hub", "conference bar", "sinc hub", "synk hub"],
};

// Competitor / non-catalog products: never fuzzy-match these onto our SKUs.
const BLOCKLIST = ["netgear", "orbi", "eero", "tp-link", "tplink", "deco", "google nest", "linksys", "bose", "sony", "jabra", "galaxy buds", "beats", "logitech", "poly ", "meeting owl"];

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Returns { matches: [{sku_id, ...item}], blocked?: string } */
export function get_catalog_info(query = "") {
  const q = query.toLowerCase().trim();
  if (!q) return { matches: Object.entries(CATALOG).map(([sku_id, v]) => ({ sku_id, ...v })) };

  const blocked = BLOCKLIST.find((b) => q.includes(b.trim()));
  if (blocked) return { matches: [], not_in_catalog: true, reason: `"${query}" is not a product we sell.` };

  const words = q.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  const scored = [];
  for (const [sku, aliases] of Object.entries(ALIASES)) {
    let best = Infinity;
    for (const alias of [...aliases, CATALOG[sku].name.toLowerCase()]) {
      if (q.includes(alias)) best = 0;
      const n = alias.split(" ").length;
      for (let i = 0; i + n <= words.length; i++) {
        const d = lev(words.slice(i, i + n).join(" "), alias);
        if (d / alias.length <= 0.25) best = Math.min(best, d);
      }
    }
    if (best !== Infinity) scored.push({ sku, best });
  }
  scored.sort((a, b) => a.best - b.best);
  if (!scored.length) return { matches: [], not_in_catalog: true, reason: `No catalog item matches "${query}".` };
  return { matches: scored.map(({ sku }) => ({ sku_id: sku, ...CATALOG[sku] })) };
}

// Mock POST /api/bookings with ~1.5s latency (as in the brief).
let seq = 1000;
export const BOOKINGS = [];
export async function create_booking_api(payload) {
  await new Promise((r) => setTimeout(r, 1500));
  const booking = { booking_id: `BK-${++seq}`, ...payload, created_at: new Date().toISOString() };
  BOOKINGS.push(booking);
  return booking;
}
