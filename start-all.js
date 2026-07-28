require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');

const root = __dirname;
const children = [];
let shuttingDown = false;

function runNodeScript(name, scriptFile) {
  const child = spawn(process.execPath, [path.join(root, scriptFile)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${name}] exited with code=${code} signal=${signal}`);
      shutdown(code || 1);
    }
  });

  child.on('error', (error) => {
    console.error(`[${name}] failed:`, error.message);
    shutdown(1);
  });

  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch (error) {}
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

runNodeScript('web', 'server.js');
runNodeScript('bot', 'bot/whatsapp-bot.js');
