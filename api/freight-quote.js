// api/freight-quote.js
//
// Serverless function that proxies LTL freight quote requests to Warp
// (https://www.wearewarp.com). Calls Warp's /ltl/market-options endpoint,
// which returns a ranked, multi-carrier price comparison (Warp's own network
// plus outside carriers) -- the same real-carrier comparison shown on Warp's
// own customer-facing quote page (customer.wearewarp.com/public/freight-quote).
//
// This function used to call /ltl/quote instead, which returns a single
// number Warp's docs label "quote_tier: indicative". In testing, that
// indicative number came back dramatically lower than every real carrier
// option shown on Warp's own booking page for the identical shipment (e.g.
// $115 vs. a real range of $241-$879 for carriers on the same lane) -- it's a
// rough, non-final placeholder, not something to show a customer as a quote.
// /ltl/market-options instead returns the same kind of real, ranked carrier
// list you see on Warp's site, which is why we switched.
//
// Warp's own docs note that market-options results are also marked
// "indicative" and "bookable": false unless you're authenticated -- so
// WARP_API_KEY (Vercel -> Project Settings -> Environment Variables) matters
// more here than it did for the old endpoint. This function still works
// without a key (Warp's endpoint is keyless), but the response's `note` field
// and `bookable` flags are the signal for whether you're seeing Warp's fuller
// authenticated pricing or just the free anonymous tier -- if quotes still
// look off, that's the first thing to check.
//
// NOTE ON FIELD NAMES: the request/response shape below is built from Warp's
// published docs and code samples (wearewarp.com/freight-api and the
// wearewarp/warp-api-examples repo), cross-checked across multiple pages for
// consistency. A few accessorial/field names (e.g. "inside-delivery") aren't
// explicitly confirmed in the docs we could access and are deliberately left
// out rather than guessed, to avoid the API silently rejecting an unrecognized
// enum value. If real quotes come back with errors referencing a specific
// field, that's the signal to adjust the mapping below.
//
// FALLBACK: /ltl/market-options does a live sweep across many outside
// carriers and can occasionally time out and return an empty list with
// "retryable": true. When that happens, Warp's own response says their
// single fast Warp-direct rate at /ltl/quote is unaffected -- so rather than
// failing the whole request (and dropping to our local estimate) on a
// transient timeout, this function falls back to that single rate and
// clearly labels it as Warp-direct-only, not a full market comparison.

const WARP_API_BASE = "https://www.wearewarp.com/api/v1";

async function fetchWarpDirectQuote(warpBody, headers) {
  const resp = await fetch(WARP_API_BASE + "/ltl/quote", {
    method: "POST",
    headers,
    body: JSON.stringify(warpBody)
  });
  const rawText = await resp.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave data empty */ }
  if (!resp.ok || typeof data.price_usd !== "number") return null;
  return {
    rank: 1,
    priceUsd: data.price_usd,
    transitDays: data.transit_days || null,
    carrierName: "Warp",
    serviceLevel: (data.service && data.service.vehicle) || "LTL",
    isWarp: true,
    bookable: false
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. POST only." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const { originZip, destZip, pickupDate, items, commodity, stackable, hazmat, accessorials } = body;

  if (!originZip || !destZip) {
    res.status(400).json({ error: "Origin and destination ZIP codes are required." });
    return;
  }
  if (!pickupDate) {
    res.status(400).json({ error: "A requested pickup date is required." });
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "At least one pallet is required." });
    return;
  }

  const warpBody = {
    origin_zip: originZip,
    destination_zip: destZip,
    pickup_date: pickupDate,
    items: items.map((it) => ({
      qty: it.qty || 1,
      length_in: it.length_in,
      width_in: it.width_in,
      height_in: it.height_in,
      weight_lbs_per_pallet: it.weight_lbs_per_pallet
    })),
    commodity: commodity || undefined,
    stackable: typeof stackable === "boolean" ? stackable : undefined,
    hazmat: typeof hazmat === "boolean" ? hazmat : undefined,
    accessorials: accessorials || undefined
  };

  const headers = { "Content-Type": "application/json" };
  const apiKey = process.env.WARP_API_KEY;
  const usedApiKey = !!apiKey;
  if (apiKey) {
    headers.Authorization = "Bearer " + apiKey;
  }

  try {
    const warpResp = await fetch(WARP_API_BASE + "/ltl/market-options", {
      method: "POST",
      headers,
      body: JSON.stringify(warpBody)
    });

    const rawText = await warpResp.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch (e) { /* fall through with empty data */ }

    if (!warpResp.ok) {
      const msg =
        (data && data.error && (data.error.message || data.error)) ||
        (data && data.message) ||
        (Array.isArray(data && data.errors) ? data.errors.join(" | ") : null) ||
        rawText ||
        "Warp request failed.";
      res.status(warpResp.status >= 400 && warpResp.status < 600 ? warpResp.status : 502).json({
        error: "Warp freight API error: " + msg
      });
      return;
    }

    const options = Array.isArray(data.market_options) ? data.market_options : [];

    if (options.length === 0) {
      // Market sweep came back empty (often a timeout, per Warp's own "retryable"
      // flag) -- fall back to Warp's single fast rate rather than failing outright.
      const fallback = await fetchWarpDirectQuote(warpBody, headers).catch(() => null);
      if (fallback) {
        res.status(200).json({
          quotes: [fallback],
          note: (data.note ? data.note + " " : "") +
            "Showing Warp's direct rate only -- the full multi-carrier comparison was unavailable for this request.",
          usedApiKey,
          marketComparisonUnavailable: true
        });
        return;
      }
      res.status(502).json({
        error: "Warp returned no market options for this lane" +
          (data.note ? " (" + data.note + ")" : "") +
          ", and the fallback direct rate also failed. Raw response: " + rawText.slice(0, 500)
      });
      return;
    }

    const quotes = options
      .map((o) => ({
        rank: o.rank || null,
        priceUsd: o.price_usd,
        transitDays: o.transit_days || null,
        carrierName: o.carrier_name || (o.is_warp ? "Warp" : "Unknown carrier"),
        serviceLevel: o.service_level || null,
        isWarp: !!o.is_warp,
        bookable: !!o.bookable
      }))
      .filter((q) => typeof q.priceUsd === "number")
      .sort((a, b) => a.priceUsd - b.priceUsd);

    res.status(200).json({
      quotes,
      note: data.note || null,
      usedApiKey
    });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : "Unexpected server error calling Warp." });
  }
};
