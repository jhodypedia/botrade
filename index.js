import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const BOT_NAME = process.env.BOT_NAME || 'Scalp Analyst';
const TIMEFRAME_HINT = process.env.TIMEFRAME_HINT || '1m,3m,5m,15m';
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 8);
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info';
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
const processingUsers = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeNumber(jid = '') {
  return jid.split('@')[0].replace(/[^0-9]/g, '');
}

function isPrivateChat(jid = '') {
  return jid.endsWith('@s.whatsapp.net');
}

function isGroupChat(jid = '') {
  return jid.endsWith('@g.us');
}

function isBroadcastChat(jid = '') {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast');
}

function isAllowedPrivateNumber(jid = '') {
  if (ALLOWED_PRIVATE_NUMBERS.size === 0) return true;
  return ALLOWED_PRIVATE_NUMBERS.has(normalizeNumber(jid));
}

function bytesToMb(bytes = 0) {
  return bytes / (1024 * 1024);
}

function getImageMessageContent(message = {}) {
  if (message.imageMessage) {
    return { imageMessage: message.imageMessage, caption: message.imageMessage.caption || '' };
  }

  if (message.ephemeralMessage?.message?.imageMessage) {
    const img = message.ephemeralMessage.message.imageMessage;
    return { imageMessage: img, caption: img.caption || '' };
  }

  if (message.viewOnceMessage?.message?.imageMessage) {
    const img = message.viewOnceMessage.message.imageMessage;
    return { imageMessage: img, caption: img.caption || '' };
  }

  if (message.viewOnceMessageV2?.message?.imageMessage) {
    const img = message.viewOnceMessageV2.message.imageMessage;
    return { imageMessage: img, caption: img.caption || '' };
  }

  if (message.viewOnceMessageV2Extension?.message?.imageMessage) {
    const img = message.viewOnceMessageV2Extension.message.imageMessage;
    return { imageMessage: img, caption: img.caption || '' };
  }

  return { imageMessage: null, caption: '' };
}

function getTrigger(caption = '') {
  const text = caption.trim().toLowerCase();
  if (text === '.forex') return 'forex';
  if (text === '.crypto') return 'crypto';
  return null;
}

function getMimeExtension(mimetype = '') {
  if (mimetype.includes('png')) return 'png';
  if (mimetype.includes('webp')) return 'webp';
  return 'jpeg';
}

function buildScalpingPrompt(assetType) {
  const marketLabel = assetType === 'forex' ? 'forex' : 'crypto';

  return [
    `Kamu adalah analyst chart ${marketLabel} untuk scalping.` ,
    `Tugasmu hanya menganalisis screenshot chart yang terlihat pada gambar, bukan data realtime di luar gambar.`,
    `Gunakan pendekatan scalping yang fokus pada momentum, struktur market, support/resistance, liquidity area, breakout/retest, dan invalidation cepat.`,
    `Asumsikan user ingin keputusan cepat untuk timeframe kecil seperti ${TIMEFRAME_HINT}.`,
    `Jangan membuat klaim pasti profit. Jangan bilang entry jika chart tidak layak.`,
    `Jawab dalam Bahasa Indonesia dengan format persis berikut:`,
    `Pair/Asset:`,
    `Bias:`,
    `Timeframe Terlihat:`,
    `Kondisi Chart:`,
    `Area Penting:`,
    `Rencana Scalp:`,
    `- Entry ideal:`,
    `- Stop loss:`,
    `- Take profit cepat:`,
    `- Invalidation:`,
    `Konfirmasi Tambahan:`,
    `Risk Note:`,
    `Skor Setup (0-10):`,
    ``,
    `Aturan analisis:`,
    `- Jika gambar blur, terlalu kecil, atau level tidak jelas, tulis bahwa chart tidak cukup jelas.`,
    `- Jika tidak ada setup bagus untuk scalping, bilang NO TRADE.`,
    `- Fokus ke reaksi harga yang terlihat di screenshot saja.`,
    `- Hindari paragraf panjang, gunakan jawaban ringkas dan actionable.`
  ].join('\n');
}

async function analyzeChartWithVision(buffer, mimetype, assetType) {
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimetype};base64,${base64}`;

  const response = await openai.responses.create({
    model: 'gpt-5.6',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: buildScalpingPrompt(assetType) },
          { type: 'input_image', image_url: dataUrl, detail: 'high' }
        ]
      }
    ]
  });

  return response.output_text?.trim() || 'Analisa tidak tersedia.';
}

async function sendHelp(sock, jid) {
  const text = [
    `Halo, saya *${BOT_NAME}*`,
    `Kirim screenshot chart dalam chat pribadi dengan caption:`,
    `- .forex`,
    `- .crypto`,
    ``,
    `Khusus assist scalping.`,
    `Disarankan chart terlihat jelas, candle cukup besar, dan level harga tidak blur.`
  ].join('\n');

  await sock.sendMessage(jid, { text });
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.04.4']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('Scan QR di WhatsApp untuk login.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi tertutup. Reconnect:', shouldReconnect, 'status:', statusCode);
      if (shouldReconnect) {
        setTimeout(() => startSock(), 3000);
      }
    }

    if (connection === 'open') {
      console.log(`${BOT_NAME} connected.`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      try {
        if (!m?.message) continue;
        if (m.key?.fromMe) continue;

        const jid = m.key.remoteJid || '';
        if (!jid) continue;
        if (isGroupChat(jid)) continue;
        if (isBroadcastChat(jid)) continue;
        if (!isPrivateChat(jid)) continue;
        if (!isAllowedPrivateNumber(jid)) continue;

        const bodyText = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const normalizedBody = bodyText.trim().toLowerCase();

        if (normalizedBody === '.menu' || normalizedBody === '.help' || normalizedBody === 'help') {
          await sendHelp(sock, jid);
          continue;
        }

        const { imageMessage, caption } = getImageMessageContent(m.message);
        const trigger = getTrigger(caption);
        if (!imageMessage || !trigger) continue;

        if (processingUsers.get(jid)) {
          await sock.sendMessage(jid, { text: 'Masih memproses chart sebelumnya, tunggu sebentar.' });
          continue;
        }

        const fileLength = Number(imageMessage.fileLength || 0);
        const imageMb = bytesToMb(fileLength);
        if (fileLength > 0 && imageMb > MAX_IMAGE_MB) {
          await sock.sendMessage(jid, {
            text: `Ukuran gambar terlalu besar (${imageMb.toFixed(2)} MB). Maksimal ${MAX_IMAGE_MB} MB.`
          });
          continue;
        }

        processingUsers.set(jid, true);
        await sock.sendMessage(jid, {
          text: `Chart ${trigger} diterima. Sedang analisa untuk setup scalping...`
        });

        const buffer = await downloadMediaMessage(
          m,
          'buffer',
          {},
          { reuploadRequest: sock.updateMediaMessage }
        );

        if (!buffer || !Buffer.isBuffer(buffer)) {
          await sock.sendMessage(jid, { text: 'Gagal membaca gambar. Coba kirim ulang dengan resolusi lebih jelas.' });
          processingUsers.delete(jid);
          continue;
        }

        const mimetype = imageMessage.mimetype || `image/${getMimeExtension(imageMessage.mimetype || '')}`;
        const analysis = await analyzeChartWithVision(buffer, mimetype, trigger);

        const footer = [
          '',
          'Disclaimer: analisa berbasis screenshot, bukan data realtime. Selalu cek spread, volatilitas, dan risk per trade.'
        ].join('\n');

        await sock.sendMessage(jid, {
          text: `${analysis}${footer}`
        });

        await sleep(300);
        processingUsers.delete(jid);
      } catch (error) {
        console.error('Error saat memproses pesan:', error);
        const jid = m?.key?.remoteJid;
        if (jid) {
          await sock.sendMessage(jid, {
            text: 'Terjadi error saat analisa chart. Coba kirim ulang screenshot yang lebih jelas.'
          }).catch(() => {});
          processingUsers.delete(jid);
        }
      }
    }
  });
}

startSock().catch(err => {
  console.error('Gagal menjalankan bot:', err);
  process.exit(1);
});
