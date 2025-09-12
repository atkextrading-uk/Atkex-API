const crypto = require("crypto");
const axios = require("axios");

let authState = {
  instanceUrl: null,
  accessToken: null,
  issuedAt: 0
};

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
  
  authState.instanceUrl = res.data.instance_url;
  authState.accessToken = res.data.access_token;
  authState.issuedAt = Date.now();

  //log.info('Salesforce auth success.');
}

module.exports = { auth, authState, sfLogin };
