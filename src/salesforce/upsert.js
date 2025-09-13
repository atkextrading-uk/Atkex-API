const axios = require("axios");
const { authState, sfLogin } = require("../middleware/auth");

/** Simple array chunker */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * Batch **upsert** SR_Hedge__c records by External ID field UUID_Text__c
 * Endpoint: PATCH /services/data/v60.0/composite/sobjects/SR_Hedge__c/UUID_Text__c
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
        //await sfLogin();
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

module.exports = {
  chunk,
  sfBatchUpsertHedgesByUUID,
  sfBatchInsertHedges
};
