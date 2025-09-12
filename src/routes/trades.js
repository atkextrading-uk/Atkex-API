const express = require("express");
const axios = require("axios");
const { sfLogin } = require("../middleware/auth");
const { sfBatchUpsertHedgesByUUID } = require("../salesforce/upsert");
const { consolidateDealsToHedges } = require("../logic/consolidate");

module.exports = (auth) => {
  const router = express.Router();

  // GET /api/trades/import
  router.get("/import", auth, async (req, res) => {
    try {
      const url =
        "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/ddd6cbbc-7fb5-4d96-a082-3c1c0fbd249d/history-deals/time/2025-09-01T11:00:00Z/2025-09-30T14:48:47Z";

      const response = await axios.get(url, {
        headers: { "auth-token": `${process.env.METATRADER_TOKEN}` },
      });

      const deals = Array.isArray(response.data) ? response.data : [];
      if (!deals.length) {
        return res.json({ message: "No deals returned from MT5." });
      }

      const consolidated = consolidateDealsToHedges(deals);

      // Ensure we’re logged in to SF
      // (authState usage is internal to sfLogin/salesforce helpers)
      await sfLogin();

      // 2) upsert by UUID_text__c
      const sfResults = await sfBatchUpsertHedgesByUUID(consolidated);

      // Summarize successes & errors
      const summary = {
        totalDealsInApiCall: deals.length,
        consolidatedPositions: consolidated.length,
        success: sfResults.filter(r => r.success).length,
        created: sfResults.filter(r => r.created).length,
        updated: sfResults.filter(r => r.success && !r.created).length,
        errors: sfResults
          .map((r, i) => ({ index: i, id: r.id || null, errors: r.errors || [] }))
          .filter(x => x.errors && x.errors.length > 0),
      };

      return res.json({ summary, consolidatedPreview: consolidated.slice(0, 5), rawResults: sfResults });

    } catch (error) {
      console.error("Import error:", error.response?.data || error.message);
      return res.status(500).json({ error: "Failed to import trades to Salesforce" });
    }
  });

  return router;
};
