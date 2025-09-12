// server.js
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;

// If you're behind Cloudflare/proxy, this makes Express use CF-Connecting-IP for req.ip
app.set("trust proxy", true);

// Basic hardening
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,             // 60 requests/min per IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// --- Auth middleware (Bearer token) ---
function auth(req, res, next) {
  const header = req.get("Authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const expected = process.env.API_TOKEN || "";
  // Constant-time compare
  const a = Buffer.from(token);
  const b = Buffer.from(expected);

  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

// ————————————————————————————————————————————————————————————————
// Salesforce Auth (basic method)
// ————————————————————————————————————————————————————————————————
let authState = {
instanceUrl: null,
accessToken: null,
issuedAt: 0
};


async function sfLogin() {
	const {
		SF_GRANT_TYPE,
		SF_CLIENT_ID,
		SF_CLIENT_SECRET,
		SF_USERNAME,
		SF_PASSWORD,
		SF_LOGIN_URL
	} = process.env;


	const body = new URLSearchParams();
	body.set('grant_type', SF_GRANT_TYPE);
	body.set('client_id', SF_CLIENT_ID);
    body.set('client_secret', SF_CLIENT_SECRET);
	body.set('username', SF_USERNAME);
	body.set('password', SF_PASSWORD);


	const tokenUrl = `${SF_LOGIN_URL}/services/oauth2/token`;
	const res = await axios.post(tokenUrl, body.toString(), {
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
	});


	authState = {
		instanceUrl: res.data.instance_url,
		accessToken: res.data.access_token,
		issuedAt: Date.now()
	};

	//log.info('Salesforce auth success.');
}

/*app.get("/api/trades/import", auth, async (req, res) => {
	try {
		const url = "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/6667ecda-b334-4fdb-9ea6-60c74e6745cc/history-deals/time/2025-08-01T11:00:00Z/2025-08-26T14:48:47Z";
	//	  "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/6667ecda-b334-4fdb-9ea6-60c74e6745cc/history-deals/time/2025-08-01T11:00:00Z/2025-08-29T14:48:47Z";

		const response = await axios.get(url, {
		  headers: {
			'auth-token': `${process.env.METATRADER_TOKEN}`,
		  },
		});
		
		// Auth into salesforce
		if (!authState.accessToken) {
			await sfLogin();
		}
		
		console.log(authState.accessToken);

		// Send back the data
		res.json(authState.accessToken);
	  } catch (error) {
		console.error("MetaTrader API error:", error.message);
		res.status(500).json({ error: "Failed to fetch MetaTrader trades" });
	  }
	
	deal
});*/
app.get("/api/trades/import", auth, async (req, res) => {
  try {
    const url =
      "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/ddd6cbbc-7fb5-4d96-a082-3c1c0fbd249d/history-deals/time/2025-09-01T11:00:00Z/2025-09-09T14:48:47Z";

    const response = await axios.get(url, {
      headers: { "auth-token": `${process.env.METATRADER_TOKEN}` },
    });

    const deals = Array.isArray(response.data) ? response.data : [];
    if (!deals.length) {
      return res.json({ message: "No deals returned from MT5." });
    }
    
    const consolidated = consolidateDealsToHedges(deals);

    // Ensure we’re logged in to SF
    if (!authState.accessToken) await sfLogin();

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


// Protected route
app.get("/hello", auth, (req, res) => {
  res.json({ message: "Hello world" });
});

// (Optional) public healthcheck for Cloudflare
app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

// ————————————————————————————————————————————————————————————————
// Salesforce: map, chunk, and batch-insert SR_Hedge__c records
// ————————————————————————————————————————————————————————————————

/**
 * Map one MT5 deal to SR_Hedge__c fields.
 * Adjust the target field API names to match your org.
 */
function mapDealToHedge(deal) {
  return {
    attributes: { type: "SR_Hedge__c" },

    // Suggested custom fields — rename to your actual API names:
    //Deal_Id__c: deal.id,                                // Text(??)
    //Platform__c: deal.platform,                         // Picklist/Text
    //Deal_Type__c: deal.type,                            // Picklist/Text
    //Deal_Time__c: deal.time,                            // Datetime
    //Broker_Time__c: deal.brokerTime,                    // Datetime/Text
    //Commission__c: deal.commission,                     // Number
    //Swap__c: deal.swap,                                 // Number
    //Profit__c: deal.profit,                             // Number(16,2)?
    //Symbol__c: deal.symbol || null,                     // Text
    //Magic__c: deal.magic ?? null,                       // Number
    Oanda_Trade_Id__c: deal.positionId || null,                  // Text
    UUID_Text__c: 'AT-0010-' + deal.positionId,
    //Position_Id__c: deal.positionId || null,            // Text
    //Volume__c: deal.volume ?? null,                     // Number(16,2)?
    //Price__c: deal.price ?? null,                       // Number(16,5)?
    //Entry_Type__c: deal.entryType || null,              // Picklist/Text
    //Reason__c: deal.reason || null,                     // Picklist/Text
    //Account_Currency_Exchange_Rate__c: deal.accountCurrencyExchangeRate ?? null
    Trading_Account__c: '0017Q00001AvONhQAN',
    Side__c: deal.entryType == 'DEAL_ENTRY_IN' ? deal.type == 'DEAL_TYPE_SELL' ? 'SELL' : 'BUY' : null,
    X1st_Trade_Profit__c: deal.entryType == 'DEAL_ENTRY_OUT' ? deal.profit : null
    // Do shit in here to get price on entry close out etc
  };
}

/** Simple array chunker */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
/**
 * Batch **upsert** SR_Hedge__c records by External ID field UUID_text__c
 * Endpoint: PATCH /services/data/v60.0/composite/sobjects/SR_Hedge__c/UUID_text__c
 * Accepts up to 200 records per call.
 * Returns an array of per-record results: {id, success, errors, created}
 */
async function sfBatchUpsertHedgesByUUID(records) {
  if (!authState.accessToken) await sfLogin();

  const base = `${authState.instanceUrl}/services/data/v60.0/composite/sobjects/SR_Hedge__c/UUID_Text__c`;
  const batches = chunk(records, 200);
  const results = [];

  for (const part of batches) {
    try {
      const resp = await axios.patch(
        base,
        { allOrNone: false, records: part },
        {
          headers: {
            Authorization: `Bearer ${authState.accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );
      results.push(...resp.data);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        await sfLogin();
        const retry = await axios.patch(
          base,
          { allOrNone: false, records: part },
          {
            headers: {
              Authorization: `Bearer ${authState.accessToken}`,
              "Content-Type": "application/json"
            }
          }
        );
        results.push(...retry.data);
      } else {
        throw err;
      }
    }
  }

  return results;
}
/**
 * Batch insert SR_Hedge__c records using sObject Collections API.
 * Docs: POST /services/data/v60.0/composite/sobjects
 */
async function sfBatchInsertHedges(records) {
  if (!authState.accessToken) await sfLogin();

  const url = `${authState.instanceUrl}/services/data/v60.0/composite/sobjects`;
  // SF allows up to 200 records per request to this endpoint
  const chunks200 = chunk(records, 200);

  const results = [];

  for (const part of chunks200) {
    try {
      const resp = await axios.post(
        url,
        {
          allOrNone: false, // continue on partial errors
          records: part
        },
        {
          headers: {
            Authorization: `Bearer ${authState.accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );
      results.push(...resp.data); // each item has success, id, errors[]
    } catch (err) {
      // If token expired, re-login once and retry this chunk
      if (err.response && err.response.status === 401) {
        await sfLogin();
        const retry = await axios.post(
          url,
          { allOrNone: false, records: part },
          {
            headers: {
              Authorization: `Bearer ${authState.accessToken}`,
              "Content-Type": "application/json"
            }
          }
        );
        results.push(...retry.data);
      } else {
        throw err;
      }
    }
  }

  return results;
}

/**
 * Consolidate an array of MT5 deals into 1 record per positionId.
 * - Groups by positionId
 * - Uses earliest IN as open; aggregates OUTs (handles partial closes)
 * - Sums profit/commission/swap
 * - Computes weighted avg close price across outs
 * - If there are no OUTs yet, Close* fields remain null (still-open position)
 *
 * Returns SR_Hedge__c-shaped objects with UUID_text__c set to positionId (as text).
 * Adjust field API names to match your org.
 */
 function consolidateDealsToHedges(
  deals,
  { tradingAccountId = "0017Q00001AvONhQAN" } = {}
) {
  // Filter to actual trade legs only
  const tradeDeals = deals.filter(
    d => d.entryType === "DEAL_ENTRY_IN" || d.entryType === "DEAL_ENTRY_OUT"
  );

  // group by positionId; fallback to orderId -> id
  const groups = new Map();
  for (const d of tradeDeals) {
    const key = (d.positionId || d.orderId || d.id || "").toString();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const hedges = [];

  for (const [positionKey, arr] of groups.entries()) {
    // sort by time to be safe
    arr.sort((a, b) => new Date(a.time) - new Date(b.time));

    const ins  = arr.filter(x => x.entryType === "DEAL_ENTRY_IN");
    const outs = arr.filter(x => x.entryType === "DEAL_ENTRY_OUT");

    // derive some basics
    const any = arr[0] || {};
    const symbol   = any.symbol || null;
    const platform = any.platform || null;

    // open leg (first IN)
    const firstIn = ins[0];
    const openTime = firstIn ? firstIn.time : null;
    const openPrice = firstIn ? firstIn.price : null;

    // sums/volumes
    const totalInVolume  = ins.reduce((s, x) => s + (x.volume || 0), 0);
    const totalOutVolume = outs.reduce((s, x) => s + (x.volume || 0), 0);

    // Close aggregation (volume-weighted)
    const closeTime = outs.length ? outs[outs.length - 1].time : null;
    let wCloseNum = 0;
    for (const o of outs) if (o.volume && o.price) wCloseNum += o.price * o.volume;
    const closePrice = totalOutVolume > 0 ? wCloseNum / totalOutVolume : null;

    // money
    const totalProfit     = arr.reduce((s, x) => s + (Number(x.profit) || 0), 0);
    const totalCommission = arr.reduce((s, x) => s + (Number(x.commission) || 0), 0);
    const totalSwap       = arr.reduce((s, x) => s + (Number(x.swap) || 0), 0);

    // determine side from IN legs (robust for partial-ins)
    // net > 0 => BUY bias, net < 0 => SELL bias
    let net = 0;
    for (const i of ins) {
      if (i.type === "DEAL_TYPE_BUY")  net += (i.volume || 0);
      if (i.type === "DEAL_TYPE_SELL") net -= (i.volume || 0);
    }
    let side = null;
    if (net > 0) side = "BUY";
    else if (net < 0) side = "SELL";
    else if (firstIn) side = (firstIn.type === "DEAL_TYPE_SELL" ? "SELL" : "BUY");

    // optional: first OUT profit if you want that meaning for X1st_Trade_Profit__c
    const firstOutProfit = outs.length ? Number(outs[0].profit) || 0 : 0;

    // Build SR_Hedge__c record
    const rec = {
      // Upsert key
      UUID_Text__c: 'AT-0010-' + positionKey,
	attributes: { type: "SR_Hedge__c" },
      // Your requested fields
      //Trading_Account__c: tradingAccountId,
      Side__c: side,
      X1st_Trade_Profit__c: totalProfit, // or use totalProfit if you intended that
      //Profit__c: totalProfit,

      // (Optional but handy — uncomment if you have these fields)
      // Position_Id__c: positionKey,
      // Platform__c: platform,
      // Symbol__c: symbol,
      // Open_Time__c: openTime,
      // Open_Price__c: openPrice,
      // Open_Volume__c: totalInVolume || null,
      // Close_Time__c: closeTime,
      // Close_Price__c: closePrice,
      // Close_Volume__c: totalOutVolume || null,
      // Commission__c: totalCommission,
      // Swap__c: totalSwap,
      // Status__c: (totalOutVolume >= totalInVolume && totalInVolume > 0) ? "Closed" : "Open"
    };

    hedges.push(rec);
  }

  return hedges;
}
