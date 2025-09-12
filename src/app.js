const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const { auth } = require("./middleware/auth");
const tradesRouter = require("./routes/trades");
const martingaleRouter = require("./metaapi/martingale");

const app = express();

/**
 * TRUST PROXY:
 * - If app is directly behind ONE proxy (Cloudflare OR nginx), use 1.
 * - If behind Cloudflare -> nginx -> Node (two hops), use 2.
 * - If no proxy, use 0 (or remove this line).
 */
app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS || "0", 10)); // 0 if no proxy, 1 if CF/nginx, etc.


// Basic hardening
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
/**
 * Rate limit
 * - Uses req.ip (now trustworthy because trust proxy is NOT permissive).
 * - Skips rate limiting for allowed IPs and/or hosts.
 */
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,             // 60 requests/min per IP
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,
    skip: (req) =>
      allowIps.has(req.ip) ||
      allowHosts.has((req.hostname || "").toLowerCase()),
  })
);

// --- Block everyone else ---
app.use((req, res, next) => {
  const ipAllowed   = allowIps.has(req.ip);
  const hostAllowed = allowHosts.has((req.hostname || "").toLowerCase());
  if (ipAllowed || hostAllowed) return next();
  return res.status(403).send("Forbidden");
});

/**
 * Allow-lists
 * - Put your own public IP(s) in ALLOW_IPS env as comma-separated list.
 *   e.g. ALLOW_IPS="203.0.113.45,127.0.0.1,::1"
 * - Optionally allow a specific Host header (convenience, not security).
 */
const allowIps = new Set(
  (process.env.ALLOW_IPS || "").split(",").map(s => s.trim()).filter(Boolean)
);
const allowHosts = new Set(
  (process.env.ALLOW_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Routes
app.use("/api/trades", tradesRouter(auth));

// Place Trades Martingale
app.use("/api/trades", martingaleRouter(auth));

// (Optional) public healthcheck for Cloudflare
app.get("/healthz", (req, res) => res.send("ok"));

module.exports = app;
