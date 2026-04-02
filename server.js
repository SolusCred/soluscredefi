const express = require("express");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());

// Sanitize PEM certificates
const cert = (process.env.EFI_CERTIFICATE_PEM || "").replace(/\\n/g, "\n");
const key = (process.env.EFI_CERTIFICATE_KEY || "").replace(/\\n/g, "\n");

let agent = null;
try {
  if (cert && key) {
    agent = new https.Agent({ cert, key });
    console.log("mTLS Agent created successfully");
  } else {
    console.warn("WARNING: Certificate or Key is empty — mTLS agent NOT created");
  }
} catch (err) {
  console.error("FATAL: Failed to create mTLS Agent:", err.message);
}

// ── Helper: make HTTPS request with mTLS agent (no external deps) ──
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
      agent: options.agent || undefined,
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: data, headers: res.headers });
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// ── Token cache ──
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (!agent) throw new Error("mTLS agent not available — check certificates");
  if (!process.env.EFI_CLIENT_ID || !process.env.EFI_CLIENT_SECRET) {
    throw new Error("EFI_CLIENT_ID or EFI_CLIENT_SECRET not set");
  }
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const res = await makeRequest("https://pix.api.efipay.com.br/oauth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(process.env.EFI_CLIENT_ID + ":" + process.env.EFI_CLIENT_SECRET).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
    agent,
  });

  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error("Failed to get access token: " + res.body);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

// ── Health check ──
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    agent_ready: !!agent,
    cert_length: cert.length,
    key_length: key.length,
    efi_client_id_set: !!process.env.EFI_CLIENT_ID,
    efi_pix_key_set: !!process.env.EFI_PIX_KEY,
    supabase_url_set: !!process.env.SUPABASE_URL,
    timestamp: new Date().toISOString(),
  });
});

// ── Create PIX charge ──
app.post("/create-pix", async (req, res) => {
  try {
    console.log("POST /create-pix body:", JSON.stringify(req.body));
    const accessToken = await getAccessToken();

    const pixRes = await makeRequest("https://pix.api.efipay.com.br/v2/cob", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
      agent,
    });

    const data = JSON.parse(pixRes.body);
    console.log("Efí /v2/cob response:", pixRes.status, pixRes.body);

    if (data.loc && data.loc.id) {
      try {
        const qrRes = await makeRequest("https://pix.api.efipay.com.br/v2/loc/" + data.loc.id + "/qrcode", {
          method: "GET",
          headers: { Authorization: "Bearer " + accessToken },
          agent,
        });
        const qrData = JSON.parse(qrRes.body);
        data.qrcode = qrData.qrcode;
        data.imagemQrcode = qrData.imagemQrcode;
        data.pixCopiaECola = qrData.qrcode;
        console.log("QR code fetched for loc:", data.loc.id);
      } catch (qrErr) {
        console.error("QR code fetch error:", qrErr.message);
      }
    }

    res.json(data);
  } catch (err) {
    console.error("create-pix error:", err.message || err);
    res.status(500).json({ error: "Erro ao criar Pix", details: String(err.message || err) });
  }
});

// ── Webhook endpoints ──
async function forwardToSupabase(body, res) {
  try {
    console.log("Forwarding to pix-webhook:", JSON.stringify(body));
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("SUPABASE_URL or SUPABASE_ANON_KEY not configured");
      return res.status(200).end();
    }

    const fwdRes = await makeRequest(supabaseUrl + "/functions/v1/pix-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseAnonKey },
      body: JSON.stringify(body),
    });
    console.log("pix-webhook response:", fwdRes.status, fwdRes.body);
    res.status(200).end();
  } catch (err) {
    console.error("forward error:", err.message || err);
    res.status(200).end();
  }
}

app.get("/webhook/efi", (_req, res) => {
  console.log("Efí webhook handshake GET");
  res.status(200).end();
});

app.post("/webhook/efi", async (req, res) => {
  console.log("Efí webhook POST:", JSON.stringify(req.body));
  await forwardToSupabase(req.body, res);
});

app.post("/webhook/efi/pix", async (req, res) => {
  console.log("Efí webhook POST /pix:", JSON.stringify(req.body));
  await forwardToSupabase(req.body, res);
});

// ── Register webhook ──
app.post("/register-webhook", async (req, res) => {
  try {
    let { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: "webhookUrl is required" });

    const pixKey = process.env.EFI_PIX_KEY;
    if (!pixKey) return res.status(500).json({ error: "EFI_PIX_KEY not configured" });

    if (!webhookUrl.includes("?")) webhookUrl += "?ignorar=";

    console.log("Registering webhook:", pixKey, webhookUrl);
    const accessToken = await getAccessToken();

    const response = await makeRequest("https://pix.api.efipay.com.br/v2/webhook/" + encodeURIComponent(pixKey), {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        "x-skip-mtls-checking": "true",
      },
      body: JSON.stringify({ webhookUrl }),
      agent,
    });

    console.log("Webhook registration:", response.status, response.body);
    res.status(response.status).type("application/json").send(response.body);
  } catch (err) {
    console.error("register-webhook error:", err.message || err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ── List webhooks ──
app.get("/list-webhooks", async (_req, res) => {
  try {
    const pixKey = process.env.EFI_PIX_KEY;
    if (!pixKey) return res.status(500).json({ error: "EFI_PIX_KEY not configured" });

    const accessToken = await getAccessToken();
    const response = await makeRequest("https://pix.api.efipay.com.br/v2/webhook/" + encodeURIComponent(pixKey), {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken },
      agent,
    });
    res.status(response.status).type("application/json").send(response.body);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ── Catch-all ──
app.use((req, res) => {
  console.log("Unhandled route:", req.method, req.url);
  res.status(404).json({ error: "Not found", path: req.url, method: req.method });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => console.log("Efi mTLS proxy listening on 0.0.0.0:" + PORT));
