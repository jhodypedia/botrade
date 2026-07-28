import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  DisconnectReason
} from 'baileys';
import dotenv from 'dotenv';
import qrcode from 'qrcode-terminal';
import P from 'pino';
import OpenAI from 'openai';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const BOT_NAME = process.env.BOT_NAME || 'Scalp Analyst';
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info';
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 8);
const TIMEFRAME_HINT = process.env.TIMEFRAME_HINT || '1m,3m,5m,15m';
const AI_MODEL = process.env.AI_MODEL || 'gpt-5.6';
const ALLOWED_PRIVATE_NUMBERS = new Set(
  (process.env.ALLOWED_PRIVATE_NUMBERS || '')
    .split(',')
    .map(v => v.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean)
);

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY belum diisi di .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const processingMap = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeNumber(jid = '') {
  return jid.split('@')[0].replace(/[^0-9]/g, '');
}

function isGroupJid(jid = '') {
  return jid.endsWith('@g.us');
}

function isPrivateJid(jid = '') {
  return jid.endsWith('@s.whatsapp.net');
}

function isBroadcastJid(jid = '') {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast');
}

function isAllowedNumber(jid = '') {
  if (ALLOWED_PRIVATE_NUMBERS.size === 0) return true;
  return ALLOWED_PRIVATE_NUMBERS.has(normalizeNumber(jid));
}

function bytesToMb(bytes = 0) {
  return bytes / 1024 / 1024;
}

function getTextMessage(message = {}) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.ephemeralMessage?.message?.conversation ||
    message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ''
  );
}

function getImagePayload(message = {}) {
  if (message?.imageMessage) {
    return { imageMessage: message.imageMessage, caption: message.imageMessage.caption || '' };
  }

  if (message?.ephemeralMessage?.message?.imageMessage) {
    const imageMessage = message.ephemeralMessage.message.imageMessage;
    return { imageMessage, caption: imageMessage.caption || '' };
  }

  if (message?.viewOnceMessage?.message?.imageMessage) {
    const imageMessage = message.viewOnceMessage.message.imageMessage;
    return { imageMessage, caption: imageMessage.caption || '' };
  }

  if (message?.viewOnceMessageV2?.message?.imageMessage) {
    const imageMessage = message.viewOnceMessageV2.message.imageMessage;
    return { imageMessage, caption: imageMessage.caption || '' };
  }

  if (message?.viewOnceMessageV2Extension?.message?.imageMessage) {
    const imageMessage = message.viewOnceMessageV2Extension.message.imageMessage;
    return { imageMessage, caption: imageMessage.caption || '' };
  }

  return { imageMessage: null, caption: '' };
}

function getTrigger(caption = '') {
  const value = caption.trim().toLowerCase();
  if (value === '.forex') return 'forex';
  if (value === '.crypto') return 'crypto';
  return null;
}

function buildScalpingPrompt(assetType) {
  const market = assetType === 'forex' ? 'forex' : 'crypto';

  return [
    `Kamu adalah analis chart ${market} untuk kebutuhan scalping manual.`,
    `Analisa hanya dari screenshot chart yang terlihat. Jangan klaim harga realtime atau data di luar gambar.`,
    `Target user adalah trader scalping dengan timeframe kecil seperti ${TIMEFRAME_HINT}.`,
    `Fokus ke struktur market, impuls, pullback, breakout, retest, support/resistance, liquidity sweep, invalidation cepat, dan momentum dekat area entry.`,
    `Jika chart tidak jelas, blur, pair tidak terlihat, atau setup tidak valid, jawab NO TRADE.`,
    `Jawaban harus ringkas, realistis, dan actionable dalam Bahasa Indonesia.`,
    `Gunakan format persis berikut:`,
    `Pair/Asset:`,
    `Bias Utama:`,
    `Timeframe Terlihat:`,
    `Kondisi Market Saat Ini:`,
    `Area Penting:`,
    `Setup Scalping:`,
    `- Arah:`,
    `- Entry ideal:`,
    `- Stop loss ketat:`,
    `- TP cepat 1:`,
    `- TP cepat 2:`,
    `- Invalidation:`,
    `Konfirmasi Sebelum Entry:`,
    `Keputusan:`,
    `Risk Note:`,
    `Skor Setup (0-10):`,
    ``,
    `Aturan tambahan:`,
    `- Jika tidak layak entry, pada bagian Keputusan tulis NO TRADE.`,
    `- Jangan memberi nasihat investasi umum.`,
    `- Jangan terlalu panjang.`,
    `- Jangan membuat angka yang terlihat tidak ada di chart.`
  ].join('\n');
}

async function sendTyping(sock, jid, ms = 1500) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(ms);
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
}

async function sendTextWithTyping(sock, jid, text, quoted = undefined, typingMs = 1200) {
  await sendTyping(sock, jid, typingMs);
  await sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
}

async function analyzeChartImage(buffer, mimetype, trigger) {
  const base64 = buffer.toString('base64');

  const response = await openai.responses.create({
    model: AI_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildScalpingPrompt(trigger)
          },
          {
            type: 'input_image',
            image_url: `data:${mimetype};base64,${base64}`,
            detail: 'high'
          }
        ]
      }
    ]
  });

  return response.output_text?.trim() || 'NO TRADE\nGambar tidak cukup jelas untuk dianalisa.';
}

async function sendMenu(sock, jid, quoted) {
  const text = [
    `*${BOT_NAME}*`,
    '',
    `Bot ini khusus analisa chart untuk scalping dari screenshot di chat pribadi.`,
    '',
    `*Cara pakai:*`,
    `1. Buka chart yang jelas.`,
    `2. Pastikan candle dan level harga terlihat.`,
    `3. Screenshot chart.`,
    `4. Kirim ke bot dengan caption:`,
    `   - .forex`,
    `   - .crypto`,
    '',
    `*Tips agar hasil lebih real:*`,
    `- Pakai timeframe kecil: ${TIMEFRAME_HINT}`,
    `- Jangan crop terlalu sempit`,
    `- Hindari gambar blur`,
    `- Sertakan area price terakhir`,
    `- Lebih bagus jika terlihat struktur swing terbaru`
  ].join('\n');

  await sendTextWithTyping(sock, jid, text, quoted, 900);
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('Scan QR untuk login WhatsApp.');
    }

    if (connection === 'open') {
      console.log(`${BOT_NAME} connected`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connection closed:', code, 'Reconnect:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startSock(), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      const jid = m?.key?.remoteJid || '';

      try {
        if (!m?.message) continue;
        if (m.key?.fromMe) continue;
        if (!jid) continue;
        if (isGroupJid(jid)) continue;
        if (isBroadcastJid(jid)) continue;
        if (!isPrivateJid(jid)) continue;
        if (!isAllowedNumber(jid)) continue;

        const plainText = getTextMessage(m.message).trim().toLowerCase();
        if (plainText === '.menu' || plainText === '.help' || plainText === 'help') {
          await sendMenu(sock, jid, m);
          continue;
        }

        const { imageMessage, caption } = getImagePayload(m.message);
        if (!imageMessage) continue;

        const trigger = getTrigger(caption);
        if (!trigger) {
          await sendTextWithTyping(
            sock,
            jid,
            'Untuk analisa chart, kirim gambar dengan caption *.forex* atau *.crypto*.',
            m,
            800
          );
          continue;
        }

        if (processingMap.get(jid)) {
          await sendTextWithTyping(
            sock,
            jid,
            'Masih ada analisa sebelumnya yang sedang berjalan. Tunggu sebentar ya.',
            m,
            700
          );
          continue;
        }

        const imageBytes = Number(imageMessage.fileLength || 0);
        const imageMb = bytesToMb(imageBytes);
        if (imageBytes > 0 && imageMb > MAX_IMAGE_MB) {
          await sendTextWithTyping(
            sock,
            jid,
            `Ukuran gambar terlalu besar (${imageMb.toFixed(2)} MB). Maksimal ${MAX_IMAGE_MB} MB.`,
            m,
            700
          );
          continue;
        }

        processingMap.set(jid, true);

        await sendTextWithTyping(
          sock,
          jid,
          `Chart ${trigger} diterima. Saya baca dulu screenshot-nya lalu susun setup scalping yang paling masuk akal.`,
          m,
          1400
        );

        const mediaBuffer = await downloadMediaMessage(
          m,
          'buffer',
          {},
          { reuploadRequest: sock.updateMediaMessage }
        );

        if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer)) {
          await sendTextWithTyping(
            sock,
            jid,
            'Gagal membaca gambar. Coba kirim ulang screenshot yang lebih jelas.',
            m,
            800
          );
          processingMap.delete(jid);
          continue;
        }

        const mimetype = imageMessage.mimetype || 'image/jpeg';

        await sendTyping(sock, jid, 2200);
        const analysis = await analyzeChartImage(mediaBuffer, mimetype, trigger);

        const reply = [
          `*Analisa Scalping ${trigger.toUpperCase()}*`,
          '',
          analysis,
          '',
          '_Disclaimer: analisa berdasarkan screenshot yang kamu kirim, bukan feed realtime. Tetap cek spread, news, dan risk management sebelum entry._'
        ].join('\n');

        await sendTextWithTyping(sock, jid, reply, m, 1800);
        processingMap.delete(jid);
      } catch (error) {
        console.error('message processing error:', error);
        if (jid) {
          await sendTextWithTyping(
            sock,
            jid,
            'Terjadi kendala saat analisa chart. Kirim ulang screenshot yang lebih jelas dan pastikan caption sesuai trigger.',
            m,
            700
          ).catch(() => {});
        }
        processingMap.delete(jid);
      }
    }
  });
}

startSock().catch((err) => {
  console.error('failed to start bot:', err);
  process.exit(1);
});
