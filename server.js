require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const methodOverride = require('method-override');
const { Server } = require('socket.io');
const { bootstrapDatabase } = require('./db/init');
const { exposeLocals } = require('./middleware/exposeLocals');
const siteRoutes = require('./routes/siteRoutes');
const authRoutes = require('./routes/authRoutes');
const memberRoutes = require('./routes/memberRoutes');
const adminRoutes = require('./routes/adminRoutes');
const apiRoutes = require('./routes/apiRoutes');
const { initRealtime, heartbeat } = require('./services/realtimeService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(methodOverride('_method'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-super-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(exposeLocals);
app.set('io', io);

app.use('/', siteRoutes);
app.use('/auth', authRoutes);
app.use('/member', memberRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);
app.use((req, res) => res.status(404).render('pages/landing/404', { title: '404' }));

initRealtime(io);
heartbeat(io);

(async () => {
  await bootstrapDatabase();
  const port = Number(process.env.PORT || 3010);
  server.listen(port, () => console.log(`Integrated app listening on http://localhost:${port}`));
})();
