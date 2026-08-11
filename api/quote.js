
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. POST only." });
    return;
  }

  const apiKey = process.env.EASYPOST_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "EASYPOST_API_KEY is not set on this deployment. Add it in Vercel -> Project Settings -> Environment Variables, then redeploy."
    });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const { packages, from, to, unit } = body;

  if (!Array.isArray(packages) || packages.length === 0) {
    res.status(400).json({ error: "No packages provided." });
    return;
  }
  if (!from || !from.zip || !from.country || !to || !to.zip || !to.country) {
    res.status(400).json({ error: "Origin and destination must each include at least a zip and country." });
    return;
  }

  // EasyPost parcels are always inches / ounces.
  const toInches = (v) => (unit === "cm-kg" ? Number(v) / 2.54 : Number(v));
  const toOunces = (v) => (unit === "cm-kg" ? Number(v) * 35.274 : Number(v) * 16);

  const auth = "Basic " + Buffer.from(apiKey + ":").toString("base64");

  try {
    const perPackageRates = [];
    const allCarrierMessages = [];

    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      const shipmentBody = {
        shipment: {
          from_address: {
            zip: from.zip,
            country: from.country,
            city: from.city || undefined,
            state: from.state || undefined
          },
          to_address: {
            zip: to.zip,
            country: to.country,
            city: to.city || undefined,
            state: to.state || undefined,
            residential: !!to.residential
          },
          parcel: {
            length: toInches(pkg.length),
            width: toInches(pkg.width),
            height: toInches(pkg.height),
            weight: toOunces(pkg.weight)
          }
        }
      };

      const epResp = await fetch("https://api.easypost.com/v2/shipments", {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(shipmentBody)
      });

      const epData = await epResp.json();

      if (!epResp.ok) {
        const msg = (epData && epData.error && epData.error.message) || "EasyPost request failed.";
        res.status(epResp.status >= 400 && epResp.status < 600 ? epResp.status : 502).json({ error: msg });
        return;
      }

      // EasyPost includes a "messages" array on the shipment with per-carrier
      // errors (e.g. a carrier account isn't set up, or an address is
      // insufficient for that carrier) even when the request itself succeeds.
      // These are the actual reason a carrier produced no rate, so surface
      // them instead of a generic "no rates" message.
      if (Array.isArray(epData.messages) && epData.messages.length) {
        for (const m of epData.messages) {
          allCarrierMessages.push(
            "Package " + (i + 1) + " - " + (m.carrier || "unknown carrier") + ": " + (m.message || m.type || "rate error")
          );
        }
      }

      perPackageRates.push(epData.rates || []);
    }

    // Combine: keep only carrier+service combos present for every package, sum the cost.
    const [firstRates, ...restRates] = perPackageRates;
    const combined = [];

    for (const rate of firstRates) {
      const key = rate.carrier + "|" + rate.service;
      let total = parseFloat(rate.rate);
      let maxDays = rate.delivery_days || null;
      let presentInAll = true;

      for (const rates of restRates) {
        const match = rates.find((r) => r.carrier + "|" + r.service === key);
        if (!match) {
          presentInAll = false;
          break;
        }
        total += parseFloat(match.rate);
        if (match.delivery_days && (!maxDays || match.delivery_days > maxDays)) {
          maxDays = match.delivery_days;
        }
      }

      if (presentInAll) {
        combined.push({
          carrier: rate.carrier,
          service: rate.service,
          total: Math.round(total * 100) / 100,
          deliveryDays: maxDays
        });
      }
    }

    combined.sort((a, b) => a.total - b.total);

    if (combined.length === 0) {
      const rawCounts = perPackageRates.map((r) => r.length).join(", ");
      let reason;
      if (allCarrierMessages.length) {
        reason = "EasyPost carrier errors: " + allCarrierMessages.join(" | ");
      } else if (packages.length > 1) {
        reason = "EasyPost returned rates for each package (raw counts: " + rawCounts + "), but no carrier + service was offered for every package, so nothing could be combined.";
      } else {
        reason = "EasyPost returned 0 rates and did not report a specific carrier error. This usually means no carrier accounts are enabled on this EasyPost account yet (a fresh account normally has USPS enabled by default) or the API key is a test/sandbox key.";
      }
      res.status(502).json({ error: reason });
      return;
    }

    res.status(200).json({ rates: combined, packageCount: packages.length, carrierMessages: allCarrierMessages });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : "Unexpected server error." });
  }
};
