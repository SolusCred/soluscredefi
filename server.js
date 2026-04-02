import express from "express";
import https from "https";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const cert = (process.env.EFI_CERTIFICATE_PEM || "").replace(/\\n/g, "\n");
const key = (process.env.EFI_CERTIFICATE_KEY || "").replace(/\\n/g, "\n");

console.log("Cert length:", cert.length, "| Key length:", key.length);

let agent = null;
try {
  if (cert && key) {
    agent = new https.Agent({ cert, key });
    console.log("mTLS Agent created successfully");
  } else {
    console.warn("WARNING: Certificate or Key is empty");
  }
} catch (err) {
  console.error("FATAL: Failed to create mTLS Agent:", err.message);
}

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

async function getAccessToken() {
  if (!agent) throw new Error("mTLS agent not available");
  if (!process.env.EFI_CLIENT_ID || !process.env.EFI_CLIENT_SECRET) {
    throw new Error("EFI_CLIENT_ID or EFI_CLIENT_SECRET not set");
  }
  const tokenResponse = await fetch("https://pix.api.efipay.com.br/oauth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(process.env.EFI_CLIENT_ID + ":" + process.env.EFI_CLIENT_SECRET).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
    agent,
  });
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) throw new Error("Failed to get token: " + JSON.stringify(tokenData));
  return tokenData.access_token;
}

app.post("/create-pix", async (req, res) => {
  try {
    console.log("POST /create-pix body:", JSON.stringify(req.body));
    const accessToken = await getAccessToken();
    const pixResponse = await fetch("https://pix.api.efipay.com.br/v2/cob", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
      agent,
    });
    const data = await pixResponse.json();
    console.log("Efi /v2/cob response:", pixResponse.status);
    if (data.loc?.id) {
      try {
        const qrRes = await fetch(`https://pix.api.efipay.com.br/v2/loc/${data.loc.id}/qrcode`, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
          agent,
        });
        const qrData = await qrRes.json();
        data.qrcode = qrData.qrcode;
        data.imagemQrcode = qrData.imagemQrcode;
        data.pixCopiaECola = qrData.qrcode;
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

async function forwardToSupabase(body, res) {
  try {
    console.log("Forwarding to pix-webhook:", JSON.stringify(body));
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("SUPABASE_URL or SUPABASE_ANON_KEY not configured");
      return res.status(200).end();
    }
    const forwardRes = await fetch(`${supabaseUrl}/functions/v1/pix-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseAnonKey },
      body: JSON.stringify(body),
    });
    const forwardText = await forwardRes.text();
    console.log("pix-webhook response:", forwardRes.status, forwardText);
    res.status(200).end();
  } catch (err) {
    console.error("forward error:", err.message || err);
    res.status(200).end();
  }
}

app.get("/webhook/efi", (req, res) => {
  console.log("Efi webhook handshake GET");
  res.status(200).end();
});

app.post("/webhook/efi", async (req, res) => {
  console.log("Efi webhook POST /webhook/efi:", JSON.stringify(req.body));
  await forwardToSupabase(req.body, res);
});

app.post("/webhook/efi/pix", async (req, res) => {
  console.log("Efi webhook POST /webhook/efi/pix:", JSON.stringify(req.body));
  await forwardToSupabase(req.body, res);
});

app.post("/register-webhook", async (req, res) => {
  try {
    let { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: "webhookUrl is required" });
    const pixKey = process.env.EFI_PIX_KEY;
    if (!pixKey) return res.status(500).json({ error: "EFI_PIX_KEY not configured" });
    if (!webhookUrl.includes("?")) webhookUrl += "?ignorar=";
    console.log("Registering webhook:", pixKey, webhookUrl);
    const accessToken = await getAccessToken();
    const response = await fetch(`https://pix.api.efipay.com.br/v2/webhook/${encodeURIComponent(pixKey)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "x-skip-mtls-checking": "true",
      },
      body: JSON.stringify({ webhookUrl }),
      agent,
    });
    const text = await response.text();
    console.log("Webhook registration:", response.status, text);
    res.status(response.status).type("application/json").send(text);
  } catch (err) {
    console.error("register-webhook error:", err.message || err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/list-webhooks", async (req, res) => {
  try {
    const pixKey = process.env.EFI_PIX_KEY;
    if (!pixKey) return res.status(500).json({ error: "EFI_PIX_KEY not configured" });
    const accessToken = await getAccessToken();
    const response = await fetch(`https://pix.api.efipay.com.br/v2/webhook/${encodeURIComponent(pixKey)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      agent,
    });
    const text = await response.text();
    res.status(response.status).type("application/json").send(text);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.use((req, res) => {
  console.log("Unhandled route:", req.method, req.url);
  res.status(404).json({ error: "Not found", path: req.url, method: req.method });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => console.log(`Efi mTLS proxy listening on 0.0.0.0:${PORT}`));
