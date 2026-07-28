import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
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
  console.error('OPENAI_API_KEY belum diisi di file .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const processingMap = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeNumber(jid = '') {
  return jid.split('@')[0].replace(/[^0-9]/g, '');
}

function isPrivateJid(jid = '') {
  return jid.endsWith('@s.whatsapp.net');
}

function isGroupJid(jid = '') {
  return jid.endsWith('@g.us');
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

function unwrapMessageContent(message = {}) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message
  );
}

function getTextMessage(message = {}) {
  const msg = unwrapMessageContent(message);
  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    ''
  );
}

function extractImageAndCaption(message = {}) {
  const msg = unwrapMessageContent(message);

  if (msg?.imageMessage) {
    return {
      imageMessage: msg.imageMessage,
      caption: (msg.imageMessage.caption || '').trim().toLowerCase()
    };
  }

  return {
    imageMessage: null,
    caption: ''
  };
}

function getTrigger(caption = '') {
  if (caption === '.forex') return 'forex';
  if (caption === '.crypto') return 'crypto';
  return null;
}

function buildScalpingPrompt(assetType) {
  const market = assetType === 'forex' ? 'forex' : 'crypto';

  return [
    `Kamu adalah analis chart ${market} untuk trader scalping manual.`,
    `Analisa hanya berdasarkan screenshot chart yang terlihat pada gambar.`,
    `Jangan mengklaim data realtime, order book realtime, atau harga live di luar gambar.`,
    `Fokus pada setup scalping timeframe kecil seperti ${TIMEFRAME_HINT}.`,
    `Perhatikan struktur market, impuls, pullback, breakout, retest, support resistance, momentum, volume visual, dan invalidation cepat.`,
    `Jika chart tidak jelas, pair tidak terlihat, angka tidak terbaca, atau setup tidak layak, tulis NO TRADE.`,
    `Jawab singkat, realistis, dan langsung bisa dipakai dalam Bahasa Indonesia.`,
    ``,
    `Format jawaban wajib:`,
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
    `- Jika tidak layak entry, di bagian Keputusan tulis NO TRADE.`,
    `- Jangan membuat angka yang tidak terlihat di chart.`,
    `- Jangan terlalu panjang.`,
    `- Hindari bahasa promosi atau janji profit.`
  ].join('\n');
}

async function sendTyping(sock, jid, ms = 1200) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(ms);
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    console.error('presence error:', err?.message || err);
  }
}

async function sendTextWithTyping(sock, jid, text, quoted = undefined, typingMs = 1200) {
  await sendTyping(sock, jid, typingMs);
  return sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
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
    `Bot ini membaca screenshot chart untuk analisa scalping.`,
    '',
    `*Cara pakai:*`,
    `1. Kirim gambar chart ke chat pribadi`,
    `2. Caption wajib salah satu:`,
    `- .forex`,
    `- .crypto`,
    '',
    `*Tips hasil lebih akurat:*`,
    `- Gunakan timeframe kecil (${TIMEFRAME_HINT})`,
    `- Pastikan candle terlihat jelas`,
    `- Jangan blur`,
    `- Usahakan pair/asset terlihat`,
    `- Sertakan area price terbaru`
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
    console.log('UPSERT TYPE:', type);

    for (const m of messages) {
      const jid = m?.key?.remoteJid || '';

      try {
        if (!m?.message) continue;
        if (m.key?.fromMe) continue;
        if (!jid) continue;

        console.log('REMOTE JID:', jid);
        console.log('RAW MESSAGE:', JSON.stringify(m.message, null, 2));

        if (isGroupJid(jid)) continue;
        if (isBroadcastJid(jid)) continue;
        if (!isPrivateJid(jid)) continue;
        if (!isAllowedNumber(jid)) continue;

        const plainText = getTextMessage(m.message).trim().toLowerCase();

        if (plainText === '.menu' || plainText === '.help' || plainText === 'help') {
          await sendMenu(sock, jid, m);
          continue;
        }

        const { imageMessage, caption } = extractImageAndCaption(m.message);

        console.log('HAS IMAGE:', !!imageMessage);
        console.log('CAPTION:', caption);

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
            'Masih ada analisa sebelumnya yang sedang diproses. Tunggu sebentar ya.',
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
          `Chart ${trigger} diterima. Sedang saya baca dan susun setup scalping-nya...`,
          m,
          1200
        );

        let mediaBuffer;
        try {
          mediaBuffer = await downloadMediaMessage(
            m,
            'buffer',
            {},
            { reuploadRequest: sock.updateMediaMessage }
          );
        } catch (err) {
          console.error('download media error:', err);
          await sendTextWithTyping(
            sock,
            jid,
            'Gagal mengambil gambar dari WhatsApp. Coba kirim ulang screenshot yang lebih jelas.',
            m,
            700
          );
          processingMap.delete(jid);
          continue;
        }

        if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer)) {
          await sendTextWithTyping(
            sock,
            jid,
            'Gambar tidak bisa dibaca. Coba kirim ulang screenshot lain.',
            m,
            700
          );
          processingMap.delete(jid);
          continue;
        }

        console.log('BUFFER SIZE:', mediaBuffer.length);

        const mimetype = imageMessage.mimetype || 'image/jpeg';

        await sendTyping(sock, jid, 1800);

        let analysis;
        try {
          analysis = await analyzeChartImage(mediaBuffer, mimetype, trigger);
        } catch (err) {
          console.error('openai analysis error:', err);
          await sendTextWithTyping(
            sock,
            jid,
            `Analisa gagal: ${err?.message || 'unknown error'}`,
            m,
            700
          );
          processingMap.delete(jid);
          continue;
        }

        const reply = [
          `*Analisa Scalping ${trigger.toUpperCase()}*`,
          '',
          analysis,
          '',
          `_Disclaimer: analisa ini berdasarkan screenshot yang dikirim, bukan feed harga realtime. Tetap cek spread, volatilitas, dan risk management sebelum entry._`
        ].join('\n');

        await sendTextWithTyping(sock, jid, reply, m, 1600);
        processingMap.delete(jid);
      } catch (error) {
        console.error('message processing error:', error);

        if (jid) {
          await sendTextWithTyping(
            sock,
            jid,
            `Terjadi error: ${error?.message || 'unknown error'}`,
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
