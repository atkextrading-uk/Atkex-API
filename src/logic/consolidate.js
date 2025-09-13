/**
 * Consolidate an array of MT5 deals into 1 record per positionId.
 * (Your original body unchanged)
 */
function consolidateDealsToHedges(
  deals,
  { deps: { symbolCatalog } } = {}
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
    
    const entryType = any.entryType;
    const time = any.time;
    const price = any.price;
    const volume = any.volume;
    const profit = any.profit;
    
    // Build SR_Hedge__c record (fixed)
    const currencyId =
      symbol &&
      symbolCatalog &&
      typeof symbolCatalog.getIdBySymbolName === "function"
        ? (symbolCatalog.getIdBySymbolName(symbol) || null)
        : null;

    // prefer explicit first OUT for "first close price" semantics;
    // keep volume-weighted closePrice for the consolidated close price.
    const firstOut = outs.length ? outs[0] : null;

    const rec = {
      UUID_Text__c: positionKey,
      attributes: { type: "SR_Hedge__c" },

      // Safe symbol lookup
      Currency__c: currencyId,

      // Side from your computed net; fixes the ternary that referenced entryType wrongly
      Side__c: side,

      // Profit consolidation (you said profit was fine)
      X1st_Trade_Profit__c: totalProfit,

      // OPEN fields (from first IN)
      X1st_Trade_Open_Price__c: firstIn ? firstIn.price : null,
      Open_Date_Time__c: openTime || null,
      X1st_Trade_Units__c: firstIn ? firstIn.volume : null,
      Open_Comments__c: firstIn ? "API" : null,
      Open_Screenshot__c: firstIn ? "API" : null,

      // CLOSE fields (from OUT legs; use last OUT time and either first OUT price or VWAP)
      // If you want the consolidated close price, use `closePrice`; if you want first OUT, use `firstOut?.price`.
      X1st_Trade_Close_Price__c: firstOut ? firstOut.price : (closePrice ?? null),
      Close_Date_Time__c: closeTime || null,
      Closing_Comments__c: outs.length ? "API" : null,
      Close_Screenshot__c: outs.length ? "API" : null,

      // (Optional but often useful—uncomment if you have these fields)
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

module.exports = { mapDealToHedge, consolidateDealsToHedges };
