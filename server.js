const express = require("express");
const https = require("https");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());

/* ── certificado mTLS ── */
const rawCert = (process.env.EFI_CERTIFICATE_PEM || "").replace(/\\n/g, "\n");
const rawKey  = (process.env.EFI_CERTIFICATE_KEY || "").replace(/\\n/g, "\n");

const agent = rawCert && rawKey
  ? new https.Agent({ cert: rawCert, key: rawKey, rejectUnauthorized: true })
  : null;

const EFI_BASE = "https://pix.api.efipay.com.br";

/* ── OAuth token ── */
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const creds = Buffer.from(
    `${process.env.EFI_CLIENT_ID}:${process.env.EFI_CLIENT_SECRET}`
  ).toString("base64");
  const r = await fetch(`${EFI_BASE}/oauth/token`, {
    method: "POST",
    agent,
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("OAuth falhou: " + JSON.stringify(j));
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
  return tokenCache.token;
}

/* ── Health ── */
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    agent_ready: !!agent,
    cert_length: rawCert.length,
    key_length: rawKey.length,
    has_client_id: !!process.env.EFI_CLIENT_ID,
  })
);

/* ── Criar cobrança PIX ── */
app.post("/create-pix", async (req, res) => {
  try {
    const token = await getToken();
    const { calendario, devedor, valor, chave, solicitacaoPagador, infoAdicionais } = req.body;

    const cobRes = await fetch(`${EFI_BASE}/v2/cob`, {
      method: "POST",
      agent,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        calendario: calendario || { expiracao: 3600 },
        devedor: devedor || undefined,
        valor: { original: valor?.original || valor },
        chave: chave || process.env.EFI_PIX_KEY,
        solicitacaoPagador: solicitacaoPagador || "Pagamento de creditos",
        infoAdicionais: infoAdicionais || [],
      }),
    });
    const cob = await cobRes.json();
    if (!cob.loc?.id) return res.status(400).json({ error: "Cobrança sem loc", cob });

    const qrRes = await fetch(`${EFI_BASE}/v2/loc/${cob.loc.id}/qrcode`, {
      method: "GET",
      agent,
      headers: { Authorization: `Bearer ${token}` },
    });
    const qr = await qrRes.json();

    return res.json({
      txid: cob.txid,
      pixCopiaECola: cob.pixCopiaECola || qr.qrcode,
      qrcode: qr.imagemQrcode || qr.qrcode,
      loc: cob.loc,
    });
  } catch (e) {
    console.error("create-pix error:", e);
    return res.status(500).json({ error: e.message });
  }
});

/* ── Webhook (GET = handshake, POST = notificação) ── */
app.get("/webhook/efi", (_req, res) => res.status(200).send("OK"));
app.get("/webhook/efi/pix", (_req, res) => res.status(200).send("OK"));

app.post("/webhook/efi", forwardWebhook);
app.post("/webhook/efi/pix", forwardWebhook);

async function forwardWebhook(req, res) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (supabaseUrl && supabaseKey) {
      await fetch(`${supabaseUrl}/functions/v1/pix-webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify(req.body),
      });
    }
    res.status(200).json({ received: true });
  } catch (e) {
    console.error("webhook forward error:", e);
    res.status(200).json({ received: true });
  }
}

/* ── Registrar webhook ── */
app.post("/register-webhook", async (req, res) => {
  try {
    const token = await getToken();
    const webhookUrl = req.body.webhookUrl || `https://${req.hostname}/webhook/efi?ignorar=`;
    const r = await fetch(`${EFI_BASE}/v2/webhook/${process.env.EFI_PIX_KEY}`, {
      method: "PUT",
      agent,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-skip-mtls-checking": "true",
      },
      body: JSON.stringify({ webhookUrl }),
    });
    const j = await r.json();
    res.json({ ok: r.ok, response: j, registeredUrl: webhookUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Start ── */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => console.log(`Efi mTLS proxy listening on 0.0.0.0:${PORT}`));
