/**
 * Map one MT5 deal to SR_Hedge__c fields.
 * Adjust the target field API names to match your org.
 */
function mapDealToHedge(deal) {
  return {
    attributes: { type: "SR_Hedge__c" },

    // Suggested custom fields — rename to your actual API names:
    //Deal_Id__c: deal.id,
    //Platform__c: deal.platform,
    //Deal_Type__c: deal.type,
    //Deal_Time__c: deal.time,
    //Broker_Time__c: deal.brokerTime,
    //Commission__c: deal.commission,
    //Swap__c: deal.swap,
    //Profit__c: deal.profit,
    //Symbol__c: deal.symbol || null,
    //Magic__c: deal.magic ?? null,
    Oanda_Trade_Id__c: deal.positionId || null,
    UUID_Text__c: 'AT-0010-' + deal.positionId,
    //Position_Id__c: deal.positionId || null,
    //Volume__c: deal.volume ?? null,
    //Price__c: deal.price ?? null,
    //Entry_Type__c: deal.entryType || null,
    //Reason__c: deal.reason || null,
    //Account_Currency_Exchange_Rate__c: deal.accountCurrencyExchangeRate ?? null
    Trading_Account__c: '0017Q00001AvONhQAN',
    Side__c: deal.entryType == 'DEAL_ENTRY_IN' ? deal.type == 'DEAL_TYPE_SELL' ? 'SELL' : 'BUY' : null,
    X1st_Trade_Profit__c: deal.entryType == 'DEAL_ENTRY_OUT' ? deal.profit : null
    // Do shit in here to get price on entry close out etc
  };
}

/**
 * Consolidate an array of MT5 deals into 1 record per positionId.
 * (Your original body unchanged)
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
      Trading_Account__c: tradingAccountId,
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

module.exports = { mapDealToHedge, consolidateDealsToHedges };
