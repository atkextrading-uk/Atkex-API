// symbolCatalog.js
const axios = require("axios");

class SymbolCatalog {
  /**
   * @param {object} opts
   * @param {string} opts.instanceUrl e.g. https://yourInstance.my.salesforce.com
   * @param {string} opts.accessToken OAuth access token with API scope
   * @param {number} [opts.ttlSeconds=300] cache time-to-live
   */
  constructor({ instanceUrl, accessToken, ttlSeconds = 300 }) {
    if (!instanceUrl || !accessToken) {
      throw new Error("instanceUrl and accessToken are required");
    }
    this.instanceUrl = instanceUrl.replace(/\/+$/, "");
    this.accessToken = accessToken;
    this.ttlMs = (ttlSeconds || 300) * 1000;
    this.cache = new Map();         // name(lowercased) -> Id
    this.cacheLoadedAt = 0;
  }

  async init() {
    await this.refresh();
    // Optional: background refresh
    this._interval = setInterval(() => this.refresh().catch(() => {}), this.ttlMs);
  }

  dispose() {
    if (this._interval) clearInterval(this._interval);
  }

  async refresh() {
    const url = `${this.instanceUrl}/services/data/v61.0/query`;
    const soql = encodeURIComponent("SELECT Id, Name FROM Currency__c");
    try {
      const records = [];
      let next = `${url}/?q=${soql}`;
      while (next) {
        const { data } = await axios.get(next, {
          headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (data && Array.isArray(data.records)) {
          records.push(...data.records);
        }
        next = data && data.nextRecordsUrl ? `${this.instanceUrl}${data.nextRecordsUrl}` : null;
      }

      const newCache = new Map();
      if (records && records.length) {
        for (const rec of records) {
          // null checks to avoid NPE-like errors
          const name = rec && rec.Name ? String(rec.Name).trim() : null;
          const id = rec && rec.Id ? String(rec.Id).trim() : null;
          if (name && id) {
            newCache.set(name.toLowerCase(), id);
          }
        }
      }
      this.cache = newCache;
      this.cacheLoadedAt = Date.now();
      return { count: this.cache.size };
    } catch (err) {
      // Robust error message, but avoid leaking tokens
      console.error(`SymbolCatalog.refresh failed: ${err?.message || err}`);
      throw err;
    }
  }

  /**
   * Resolve a symbol name to its Salesforce Id.
   * @param {string} name
   * @returns {string|null}
   */
  getIdBySymbolName(name) {
    if (!name) return null;
    const id = this.cache.get(String(name).toLowerCase());
    return id || null; // explicit null if not found
  }
}

module.exports = { SymbolCatalog };
