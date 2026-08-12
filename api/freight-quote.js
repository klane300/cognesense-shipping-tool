// api/freight-quote.js
//
// Serverless function that proxies LTL freight quote requests to Warp
// (https://www.wearewarp.com). Warp's /ltl/quote endpoint is actually keyless —
// it works without an API key at a lower rate limit (60 requests/hour/IP). We
// still hold WARP_API_KEY server-side (Vercel -> Project Settings ->
// Environment Variables) so:
//   1) it's never exposed to the browser, consistent with how EASYPOST_API_KEY
//      is handled in api/quote.js, and
//   2) requests get a much higher rate limit (1,000/hr sandbox, 10,000/hr live)
//      and are ready for booking-related endpoints later if this ever expands
//      beyond quoting.
//
// If WARP_API_KEY isn't set yet, this function still works — it just omits the
// Authorization header and quotes at the lower anonymous rate limit.
//
// NOTE ON FIELD NAMES: the request/response shape below is built from Warp's
// published docs and code samples (wearewarp.com/freight-api and the
// wearewarp/warp-api-examples repo), cross-checked across multiple pages for
// consistency. A few accessorial/field names (e.g. "inside-delivery") aren't
// explicitly confirmed in the docs we could access and are deliberately left
// out rather than guessed, to avoid the API silently rejecting an unrecognized
// enum value. If real quotes come back with errors referencing a specific
// field, that's the signal to adjust the mapping below.

const WARP_API_BASE = "https://www.wearewarp.com/api/v1";

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
  if (apiKey) {
    headers.Authorization = "Bearer " + apiKey;
  }

  try {
    const warpResp = await fetch(WARP_API_BASE + "/ltl/quote", {
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

    if (typeof data.price_usd !== "number") {
      res.status(502).json({
        error: "Warp returned a response with no price (unexpected shape). Raw response: " + rawText.slice(0, 500)
      });
      return;
    }

    res.status(200).json({
      quote: {
        priceUsd: data.price_usd,
        currency: data.currency || "USD",
        transitDays: data.transit_days || null,
        pickupDate: data.pickup_date || null,
        deliveryDate: data.delivery_date || null,
        quoteId: data.quote_id || null,
        quoteTier: data.quote_tier || null,
        expiresAt: data.expires_at || null,
        bookingUrl: data.booking_url || null,
        includedAtNoCharge: (data.service && data.service.included_at_no_charge) || [],
        missingForShip: data.missing_for_ship || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : "Unexpected server error calling Warp." });
  }
};
