
const express = require("express");

const cors = require("cors");
const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const SYMBOLS = (process.env.SYMBOLS || "EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD,NZD/USD,EUR/GBP,XAU/USD")
  .split(",").map(s => s.trim()).filter(Boolean);

const CONFIG = {
  intervals: ["5min", "15min", "1h"],
  bars: Number(process.env.BARS || 250),
  minTests: Number(process.env.MIN_TESTS || 2),
  rr: Number(process.env.RR || 2),
  riskPct: Number(process.env.RISK_PCT || 2),
  zoneAtrMult: Number(process.env.ZONE_ATR_MULT || 0.35),
  swingLeft: 3,
  swingRight: 3,
};

let lastScan = {
  status: "waiting_for_api_key",
  updatedAt: null,
  signals: []
};
let hasValidScan = false;
function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a,b)=>a+b,0) / slice.length;
}

function swings(bars) {
  const out = [];
  for (let i = CONFIG.swingLeft; i < bars.length - CONFIG.swingRight; i++) {
    const b = bars[i];
    let hi = true, lo = true;
    for (let j=1;j<=CONFIG.swingLeft;j++) {
      if (bars[i-j].high >= b.high) hi = false;
      if (bars[i-j].low <= b.low) lo = false;
    }
    for (let j=1;j<=CONFIG.swingRight;j++) {
      if (bars[i+j].high >= b.high) hi = false;
      if (bars[i+j].low <= b.low) lo = false;
    }
    if (hi) out.push({type:"resistance", price:b.high, i});
    if (lo) out.push({type:"support", price:b.low, i});
  }
  return out;
}

function makeZones(bars) {
  const a = atr(bars);
  if (!a) return [];
  const tolerance = a * CONFIG.zoneAtrMult;
  const pts = swings(bars);
  const zones = [];

  for (const p of pts) {
    let z = zones.find(x => Math.abs(x.center - p.price) <= tolerance && x.type === p.type);
    if (!z) {
      z = { type:p.type, center:p.price, prices:[], indices:[], tests:0 };
      zones.push(z);
    }
    z.prices.push(p.price);
    z.indices.push(p.i);
    z.center = z.prices.reduce((s,v)=>s+v,0)/z.prices.length;
  }

  for (const z of zones) {
    z.tests = z.prices.length;
    z.width = tolerance;
    z.low = z.center - tolerance/2;
    z.high = z.center + tolerance/2;
    z.score = Math.min(100, 35 + z.tests*12 + Math.min(25, (z.indices[z.indices.length-1] / bars.length)*25));
    z.lastTest = Math.max(...z.indices);
  }

  return zones
    .filter(z => z.tests >= CONFIG.minTests)
    .filter(z => z.lastTest >= bars.length * 0.35);
}

function analyze(symbol, bars) {
  if (!bars.length) return null;
  const current = bars[bars.length-1].close;
  const a = atr(bars);
  const zones = makeZones(bars);
  if (!a || !zones.length) return {symbol, status:"WAIT", price:current, zones:[]};

  const nearest = zones
    .map(z => ({...z, distance: Math.abs(current-z.center)}))
    .sort((x,y)=>x.distance-y.distance)[0];

  const approachDistance = a * 0.9;
  if (nearest.distance > approachDistance) {
    return {symbol, status:"WAIT", price:current, nearestZone:nearest};
  }

  const recent = bars.slice(-3);
  const last = recent[recent.length-1];
  const prev = recent[recent.length-2];

  let direction = null;
  let confirmation = false;

  if (nearest.type === "support") {
    const rejected = last.low <= nearest.high && last.close > last.open;
    const bullishFollow = last.close > prev.high;
    if (rejected || bullishFollow) { direction = "BUY"; confirmation = true; }
  }

  if (nearest.type === "resistance") {
    const rejected = last.high >= nearest.low && last.close < last.open;
    const bearishFollow = last.close < prev.low;
    if (rejected || bearishFollow) { direction = "SELL"; confirmation = true; }
  }

  if (!confirmation) {
    return {symbol, status:"APPROACH", price:current, nearestZone:nearest};
  }

  const entry = current;
  let sl, tp;
  if (direction === "BUY") {
    sl = nearest.low - a*0.15;
    tp = entry + (entry-sl)*CONFIG.rr;
  } else {
    sl = nearest.high + a*0.15;
    tp = entry - (sl-entry)*CONFIG.rr;
  }

  return {
    symbol,
    status:"SIGNAL",
    direction,
    price:current,
    zone: {type:nearest.type, low:nearest.low, high:nearest.high, tests:nearest.tests, score:Math.round(nearest.score)},
    entry, sl, tp,
    rr: CONFIG.rr,
    riskPct: CONFIG.riskPct,
    note: "Segnale tecnico: zona + reazione. Nessun ordine automatico."
  };
}

async function getSeries(symbol, interval) {
  if (!API_KEY) throw new Error("TWELVE_DATA_API_KEY non configurata");
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(CONFIG.bars));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Data provider HTTP ${r.status}`);
  const data = await r.json();
  if (data.status === "error") throw new Error(data.message || "Errore provider");
  return (data.values || []).reverse().map(v => ({
    time:v.datetime,
    open:Number(v.open), high:Number(v.high), low:Number(v.low), close:Number(v.close)
  }));
}
const CACHE_MS = 5 * 60 * 1000;

function combineTimeframes(timeframeResults) {
  const results = Object.values(timeframeResults);

  const valid = results.filter(r => r && r.status !== "ERROR");

  const buys = valid.filter(
    r => r.status === "SIGNAL" && r.direction === "BUY"
  ).length;

  const sells = valid.filter(
    r => r.status === "SIGNAL" && r.direction === "SELL"
  ).length;

  if (buys >= 2 && sells === 0) {
    return {
      status: "SIGNAL",
      direction: "BUY",
      confirmation: `${buys}/3 timeframe concordi`
    };
  }

  if (sells >= 2 && buys === 0) {
    return {
      status: "SIGNAL",
      direction: "SELL",
      confirmation: `${sells}/3 timeframe concordi`
    };
  }

  if (buys > 0 && sells > 0) {
    return {
      status: "CONFLICT",
      direction: null,
      confirmation: "Timeframe in conflitto"
    };
  }

  return {
    status: "WAIT",
    direction: null,
    confirmation: "Nessuna conferma sufficiente"
  };
}

async function scanAll() {
  if (
    lastScan.status === "online" &&
    lastScan.updatedAt &&
    Date.now() - new Date(lastScan.updatedAt).getTime() < CACHE_MS
  ) {
    return lastScan;
  }

  if (!API_KEY) {
    lastScan = {
      status: "waiting_for_api_key",
      updatedAt: new Date().toISOString(),
      signals: []
    };

    return lastScan;
  }

  const results = [];

  for (const symbol of SYMBOLS) {
    const timeframeResults = {};

    for (const interval of CONFIG.intervals) {
      try {
        const bars = await getSeries(symbol, interval);

        timeframeResults[interval] = analyze(symbol, bars);

      } catch (e) {
        timeframeResults[interval] = {
          symbol,
          status: "ERROR",
          error: e.message
        };
      }
    }

    const finalResult = combineTimeframes(timeframeResults);

    results.push({
      symbol,
      ...finalResult,
      timeframes: timeframeResults
    });
  }

  lastScan = {
    status: "online",
    updatedAt: new Date().toISOString(),
    config: CONFIG,
    signals: results
  };

  hasValidScan = true;

  return lastScan;
}, (req,res)=>res.json({ok:true, service:"market-sentinel-engine"}));
app.get("/api/signals", async (req, res) => {
  try {
    const tests = Number(req.query.tests);

    if ([2, 3, 4].includes(tests)) {
      CONFIG.minTests = tests;
    }

    res.json(await scanAll());

  } catch (e) {
    res.status(500).json({
      status: "error",
      message: e.message
    });
  }
});

app.listen(PORT,"0.0.0.0",()=>console.log(`Market Sentinel Engine listening on ${PORT}`));
