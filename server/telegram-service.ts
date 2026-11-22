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
