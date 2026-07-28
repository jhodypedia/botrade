require('dotenv').config();
const path = require('path');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { bootstrapDatabase } = require('../db/init');
const { initPool } = require('../db/connection');
const { updateSession, isAllowedWhatsapp, logAnalysis, findUserByWhatsapp } = require('../services/botStateService');

const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-vl-max';
const BOT_NAME = process.env.BOT_NAME || 'Qwen Scalp Analyst';
const AUTH_FOLDER = process.env.AUTH_FOLDER || './bot/auth_info';
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 8);
const TIMEFRAME_HINT = process.env.TIMEFRAME_HINT || '1m,3m,5m,15m';
const client = new OpenAI({ apiKey: QWEN_API_KEY, baseURL: QWEN_BASE_URL });
const processingMap = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeNumber(jid = '') { return jid.split('@')[0].replace(/[^0-9]/g, ''); }
function isPrivateJid(jid = '') { return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'); }
function isGroupJid(jid = '') { return jid.endsWith('@g.us'); }
function isBroadcastJid(jid = '') { return jid === 'status@broadcast' || jid.endsWith('@broadcast'); }
function bytesToMb(bytes = 0) { return bytes / 1024 / 1024; }
function unwrapMessageContent(message = {}) { return message?.ephemeralMessage?.message || message?.viewOnceMessage?.message || message?.viewOnceMessageV2?.message || message?.viewOnceMessageV2Extension?.message || message; }
function getTextMessage(message = {}) { const msg = unwrapMessageContent(message); return msg?.conversation || msg?.extendedTextMessage?.text || ''; }
function extractImageAndCaption(message = {}) { const msg = unwrapMessageContent(message); if (msg?.imageMessage) return { imageMessage: msg.imageMessage, caption: (msg.imageMessage.caption || '').trim().toLowerCase() }; return { imageMessage: null, caption: '' }; }
function getTrigger(caption = '') { if (caption === '.forex') return 'forex'; if (caption === '.crypto') return 'crypto'; return null; }
function buildScalpingPrompt(assetType) { const market = assetType === 'forex' ? 'forex' : 'crypto'; return [`Kamu adalah analis chart ${market} untuk trader scalping manual.`,`Analisa hanya berdasarkan screenshot chart yang terlihat pada gambar.`,`Jangan mengklaim data realtime di luar gambar.`,`Fokus pada setup scalping timeframe kecil seperti ${TIMEFRAME_HINT}.`,`Perhatikan struktur market, impuls, pullback, breakout, retest, support resistance, momentum, volume visual, dan invalidation cepat.`,`Jika chart tidak jelas atau setup tidak layak, tulis NO TRADE.`,`Jawab singkat dan langsung bisa dipakai dalam Bahasa Indonesia.`,`Format jawaban wajib:`,`Pair/Asset:`,`Bias Utama:`,`Timeframe Terlihat:`,`Kondisi Market Saat Ini:`,`Area Penting:`,`Setup Scalping:`,`- Arah:`,`- Entry ideal:`,`- Stop loss ketat:`,`- TP cepat 1:`,`- TP cepat 2:`,`- Invalidation:`,`Konfirmasi Sebelum Entry:`,`Keputusan:`,`Risk Note:`,`Skor Setup (0-10):`].join('\n'); }
async function sendTyping(sock, jid, ms = 1200) { try { await sock.presenceSubscribe(jid).catch(() => {}); await sleep(250); await sock.sendPresenceUpdate('composing', jid); await sleep(ms); await sock.sendPresenceUpdate('paused', jid); } catch (err) {} }
async function sendTextWithTyping(sock, jid, text, quoted = undefined, typingMs = 1200) { await sendTyping(sock, jid, typingMs); return sock.sendMessage(jid, { text }, quoted ? { quoted } : {}); }
async function markRead(sock, key) { try { await sock.readMessages([key]); } catch (err) {} }
function extractDecisionText(reply = '') { const line = reply.split('\n').find(v => v.toLowerCase().startsWith('keputusan:')); return line ? line.replace(/keputusan:/i, '').trim() : null; }
function extractSetupScore(reply = '') { const line = reply.split('\n').find(v => v.toLowerCase().startsWith('skor setup')); if (!line) return null; const m = line.match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; }
async function analyzeChartImage(buffer, mimetype, trigger) {
  const base64 = buffer.toString('base64');
  const completion = await client.chat.completions.create({
    model: QWEN_MODEL,
    messages: [
      { role: 'system', content: buildScalpingPrompt(trigger) },
      { role: 'user', content: [{ type: 'text', text: `Analisa chart ${trigger} ini untuk scalping berdasarkan screenshot saja.` }, { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64}` } }] }
    ],
    stream: false
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map(item => (item?.type === 'text' ? item.text : '')).join('\n').trim();
    if (text) return text;
  }
  return 'NO TRADE\nGambar tidak cukup jelas untuk dianalisa.';
}
async function sendMenu(sock, jid, quoted) {
  const text = [`*${BOT_NAME}*`,'','Bot ini memakai Qwen AI untuk membaca screenshot chart dan memberi analisa scalping.','','*Cara pakai:*','1. Kirim gambar chart ke chat pribadi','2. Caption wajib salah satu:','- .forex','- .crypto','','*Tips hasil lebih akurat:*',`- Gunakan timeframe kecil (${TIMEFRAME_HINT})`,'- Pastikan candle terlihat jelas','- Jangan blur','- Usahakan pair/asset terlihat','- Sertakan area price terbaru'].join('\n');
  await sendTextWithTyping(sock, jid, text, quoted, 900);
}
async function startSock() {
  await bootstrapDatabase();
  await initPool();
  const { state, saveCreds } = await useMultiFileAuthState(path.resolve(AUTH_FOLDER));
  const { version } = await fetchLatestBaileysVersion();
  await updateSession({ connection_status: 'CONNECTING', last_error: 'Connecting...' });
  const sock = makeWASocket({ version, auth: state, logger: P({ level: 'silent' }), browser: Browsers.ubuntu(BOT_NAME) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr, pairingCode }) => {
    if (qr) { qrcode.generate(qr, { small: true }); await updateSession({ connection_status: 'QR_READY', qr_text: qr, last_error: 'QR siap discan' }); }
    if (pairingCode) { await updateSession({ connection_status: 'PAIRING_READY', pairing_code: pairingCode, last_error: 'Pairing code tersedia' }); }
    if (connection === 'open') { console.log(`${BOT_NAME} connected`); await updateSession({ connection_status: 'OPEN', last_error: 'Connected successfully' }); }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      await updateSession({ connection_status: shouldReconnect ? 'CLOSED' : 'LOGGED_OUT', last_error: `Connection closed: ${code || 'unknown'}` });
      if (shouldReconnect) setTimeout(() => startSock(), 3000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      const jid = m?.key?.remoteJid || '';
      try {
        if (!m?.message || m.key?.fromMe || !jid) continue;
        if (isGroupJid(jid) || isBroadcastJid(jid) || !isPrivateJid(jid)) continue;
        const number = normalizeNumber(jid);
        const access = await isAllowedWhatsapp(number);
        if (!access) {
          await sendTextWithTyping(sock, jid, 'Nomor WhatsApp kamu belum aktif di sistem. Hubungi admin untuk aktivasi membership.', m, 800);
          continue;
        }
        await markRead(sock, m.key);
        const plainText = getTextMessage(m.message).trim().toLowerCase();
        if (plainText === '.menu' || plainText === '.help' || plainText === 'help') { await sendMenu(sock, jid, m); continue; }
        const { imageMessage, caption } = extractImageAndCaption(m.message);
        if (!imageMessage) continue;
        const trigger = getTrigger(caption);
        if (!trigger) { await sendTextWithTyping(sock, jid, 'Untuk analisa chart, kirim gambar dengan caption *.forex* atau *.crypto*.', m, 800); continue; }
        if (processingMap.get(jid)) { await sendTextWithTyping(sock, jid, 'Masih ada analisa sebelumnya yang sedang diproses. Tunggu sebentar ya.', m, 700); continue; }
        const imageBytes = Number(imageMessage.fileLength || 0);
        const imageMb = bytesToMb(imageBytes);
        if (imageBytes > 0 && imageMb > MAX_IMAGE_MB) { await sendTextWithTyping(sock, jid, `Ukuran gambar terlalu besar (${imageMb.toFixed(2)} MB). Maksimal ${MAX_IMAGE_MB} MB.`, m, 700); continue; }
        processingMap.set(jid, true);
        await sendTextWithTyping(sock, jid, `Chart ${trigger} diterima. Qwen sedang membaca screenshot dan menyusun setup scalping...`, m, 1400);
        let mediaBuffer;
        try {
          mediaBuffer = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage, logger: P({ level: 'silent' }) });
        } catch (err) {
          await sendTextWithTyping(sock, jid, 'Gagal mengambil gambar dari WhatsApp. Coba kirim ulang screenshot yang lebih jelas.', m, 700);
          processingMap.delete(jid);
          continue;
        }
        if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer)) {
          await sendTextWithTyping(sock, jid, 'Gambar tidak bisa dibaca. Coba kirim ulang screenshot lain.', m, 700);
          processingMap.delete(jid);
          continue;
        }
        const start = Date.now();
        let analysis;
        try {
          analysis = await analyzeChartImage(mediaBuffer, imageMessage.mimetype || 'image/jpeg', trigger);
        } catch (err) {
          await sendTextWithTyping(sock, jid, `Analisa gagal: ${err?.message || 'unknown error'}`, m, 700);
          await updateSession({ connection_status: 'ERROR', last_error: err?.message || 'analysis error' });
          processingMap.delete(jid);
          continue;
        }
        const reply = [`*Analisa Scalping ${trigger.toUpperCase()} - Qwen AI*`,'',analysis,'',`_Disclaimer: analisa ini berdasarkan screenshot yang dikirim, bukan feed harga realtime. Tetap cek spread, volatilitas, dan risk management sebelum entry._`].join('\n');
        await sendTextWithTyping(sock, jid, reply, m, 1800);
        const user = await findUserByWhatsapp(number);
        const score = extractSetupScore(analysis);
        const decision = extractDecisionText(analysis);
        await logAnalysis({ user_id: user?.id || null, whatsapp_number: number, asset_type: trigger === 'forex' ? 'FOREX' : 'CRYPTO', trigger_command: `.${trigger}`, model_name: QWEN_MODEL, decision_text: decision, raw_reply: analysis, setup_score: score, processing_ms: Date.now() - start, status: analysis.includes('NO TRADE') ? 'NO_TRADE' : 'SUCCESS' });
        processingMap.delete(jid);
      } catch (error) {
        await updateSession({ connection_status: 'ERROR', last_error: error?.message || 'message processing error' });
        processingMap.delete(jid);
      }
    }
  });
}
startSock().catch(async (err) => { console.error('failed to start bot:', err); await updateSession({ connection_status: 'ERROR', last_error: err?.message || 'failed to start bot' }); process.exit(1); });
