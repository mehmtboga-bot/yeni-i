const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

export async function sendTelegramAlert(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram bilgileri tanımlı değil (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
    return;
  }

  try {
    const response = await fetch(TELEGRAM_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      console.error(`❌ Telegram gönderimi başarısız: ${response.status}`);
      return;
    }

    console.log(`✅ Telegram bildirim gönderildi`);
  } catch (err) {
    console.error(`❌ Telegram hatası:`, (err as Error).message);
  }
}

export async function sendRugPullAlert(symbol: string, mintAddress: string, lossAmount: number): Promise<void> {
  const message = `
🚨 <b>RUG PULL DETECTED!</b>

<b>Token:</b> ${symbol}
<b>Mint:</b> <code>${mintAddress}</code>
<b>Zarar:</b> -${lossAmount.toFixed(4)} SOL (-100%)

<i>Pozisyon kapatılmıştır.</i>
  `.trim();

  await sendTelegramAlert(message);
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendWalletMintAlert(
  slot: number,
  token: {
    name: string;
    symbol: string;
    mintAddress: string;
    creator: string;
    detectedAt: number;
    liquidityUsd?: number;
    solscanVerified: boolean;
    solscanMessage?: string;
    jupiterUrl: string;
    dexscreenerUrl: string;
    pumpfunUrl: string;
  },
): Promise<void> {
  const liquidity = token.liquidityUsd !== undefined
    ? `$${Math.round(token.liquidityUsd).toLocaleString("en-US")}`
    : "Henüz yok";
  const message = [
    `👀 <b>İZLENEN CÜZDAN ${slot + 1}: YENİ TOKEN</b>`,
    ``,
    `<b>Ad:</b> ${escapeHtml(token.name)}`,
    `<b>Sembol:</b> ${escapeHtml(token.symbol)}`,
    `<b>Mint:</b> <code>${token.mintAddress}</code>`,
    `<b>Cüzdan:</b> <code>${token.creator}</code>`,
    `<b>Likidite:</b> ${liquidity}`,
    `<b>Solscan:</b> ${token.solscanVerified ? "Doğrulandı" : "Doğrulanamadı"}${token.solscanMessage ? ` (${escapeHtml(token.solscanMessage)})` : ""}`,
    `<b>Zaman:</b> ${new Date(token.detectedAt).toISOString()}`,
    ``,
    `<a href="${token.jupiterUrl}">Jupiter</a> | <a href="${token.dexscreenerUrl}">DexScreener</a> | <a href="${token.pumpfunUrl}">Pump.fun</a>`,
  ].join("\n");

  await sendTelegramAlert(message);
}
