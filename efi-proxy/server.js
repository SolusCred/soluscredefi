import express from "express";
import https from "https";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const agent = new https.Agent({
  cert: process.env.EFI_CERTIFICATE_PEM,
  key: process.env.EFI_CERTIFICATE_KEY,
});

app.post("/create-pix", async (req, res) => {
  try {
    const tokenResponse = await fetch("https://pix.api.efipay.com.br/oauth/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.EFI_CLIENT_ID + ":" + process.env.EFI_CLIENT_SECRET
          ).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
      agent,
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    const pixResponse = await fetch(
      "https://pix.api.efipay.com.br/v2/cob",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req.body),
        agent,
      }
    );

    const data = await pixResponse.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar Pix" });
  }
});

app.listen(3000, () => console.log("Proxy rodando na porta 3000"));
