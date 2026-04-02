const express = require("express");
const https = require("https");
const app = express();

app.use(express.json());

const PROXY_SECRET = process.env.PROXY_SECRET || "";

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!PROXY_SECRET || token !== PROXY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function getCerts() {
  const cert = (process.env.EFI_CERTIFICATE_PEM || "").replace(/\\n/g, "\n");
  const key = (process.env.EFI_CERTIFICATE_KEY || "").replace(/\\n/g, "\n");
  if (!cert || !key) throw new Error("Certificados Efi nao configurados");
  return { cert, key };
}

function efiRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const { cert, key } = getCerts();
    const url = new URL(path, "https://pix.api.efipay.com.br");
    const opts = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      port: 443,
      headers,
      cert,
      key,
      rejectUnauthorized: true,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken() {
  const clientId = process.env.EFI_CLIENT_ID;
  const clientSecret = process.env.EFI_CLIENT_SECRET;
  const creds = Buffer.from(clientId + ":" + clientSecret).toString("base64");

  const res = await efiRequest("POST", "/oauth/token", {
    "Content-Type": "application/json",
    Authorization: "Basic " + creds,
  }, JSON.stringify({ grant_type: "client_credentials" }));

  if (res.status !== 200) {
    throw new Error("Efi OAuth failed: " + res.status + " " + res.body);
  }
  return JSON.parse(res.body).access_token;
}

// Health check
app.get("/health", function(req, res) {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Create PIX charge
app.post("/create-pix", auth, async function(req, res) {
  try {
    const accessToken = await getAccessToken();
    const cobBody = JSON.stringify(req.body);

    const cobRes = await efiRequest("POST", "/v2/cob", {
      "Content-Type": "application/json",
      Authorization: "Bearer " + accessToken,
    }, cobBody);

    const cobData = JSON.parse(cobRes.body);

    // If we have a loc but no pixCopiaECola, fetch QR code
    if (cobData.loc && cobData.loc.id && !cobData.pixCopiaECola) {
      try {
        const qrRes = await efiRequest("GET", "/v2/loc/" + cobData.loc.id + "/qrcode", {
          Authorization: "Bearer " + accessToken,
        });
        if (qrRes.status === 200) {
          const qrData = JSON.parse(qrRes.body);
          cobData.qrcode = qrData.qrcode;
          cobData.imagemQrcode = qrData.imagemQrcode;
        }
      } catch (e) {
        console.error("QR fetch error:", e.message);
      }
    }

    res.status(cobRes.status).json(cobData);
  } catch (e) {
    console.error("Create charge error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// Register webhook URL with Efí
app.post("/register-webhook", auth, async function(req, res) {
  try {
    const { webhookUrl } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({ error: "webhookUrl is required" });
    }

    const accessToken = await getAccessToken();
    const pixKey = process.env.EFI_PIX_KEY;

    if (!pixKey) {
      return res.status(500).json({ error: "EFI_PIX_KEY not configured" });
    }

    const webhookRes = await efiRequest("PUT", "/v2/webhook/" + encodeURIComponent(pixKey), {
      "Content-Type": "application/json",
      Authorization: "Bearer " + accessToken,
    }, JSON.stringify({ webhookUrl: webhookUrl }));

    console.log("Webhook registration response:", webhookRes.status, webhookRes.body);
    res.status(webhookRes.status).json(JSON.parse(webhookRes.body || "{}"));
  } catch (e) {
    console.error("Webhook registration error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Efi mTLS proxy listening on port " + PORT);
});
