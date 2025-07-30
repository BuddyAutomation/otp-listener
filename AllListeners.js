// AllListeners.js (Render.com Deployment)
// ——————————————————————————————————————————————————————————
// 1) PUT your Firebase service account JSON into the
//    SERVICE_ACCOUNT_JSON env var (stringified).
// 2) PUT your RTDB URL into FIREBASE_DB_URL env var.
// 3) Render will set PORT for you; we expose a tiny HTTP server
//    so Render keeps the service alive.

// ——— HTTP “keep‑alive” server — listens on PORT
const http = require('http');
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AllListeners is running');
  })
  .listen(port, () => {
    console.log(`✅ HTTP server listening on port ${port}`);
  });

// ——— IMAP + Firebase logic
const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const admin = require('firebase-admin');

// ——— Init Firebase Admin from ENV
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

// Helper: email = RTDB key with commas → real dots
function decodeEmail(key) {
  return key.replace(/,/g, '.');
}

// Start listeners for every account in RTDB
async function startAllListeners() {
  const snap = await admin.database().ref('/gmailAccounts').once('value');
  const accounts = snap.val();
  if (!accounts) {
    console.error('⚠️  No /gmailAccounts found!');
    return;
  }

  for (const key of Object.keys(accounts)) {
    const { appPassword } = accounts[key];
    if (!appPassword) {
      console.warn(`Skipping ${key}—missing appPassword`);
      continue;
    }
    const email = decodeEmail(key);
    startImapFor(email, appPassword);
  }
}

// Create one IMAP connection per account
function startImapFor(user, password) {
  const imap = new Imap({
    user,
    password,
    host: 'imap.gmail.com',
    port: 993,
    tls: true
  });

  imap.once('ready', () => {
    imap.openBox('OTP', false, (err, box) => {
      if (err) return console.error(`[${user}] openBox error:`, err);
      console.log(`[${user}] watching OTP (total ${box.messages.total})`);
      fetchLatestOtps(imap, user);
      imap.on('mail', () => fetchLatestOtps(imap, user));
    });
  });

  imap.once('error', err => {
    console.error(`[${user}] IMAP error:`, err);
    console.log(`[${user}] reconnecting in 10s…`);
    setTimeout(() => imap.connect(), 10000);
  });

  imap.once('end', () => {
    console.log(`[${user}] connection ended—reconnecting…`);
    setTimeout(() => imap.connect(), 10000);
  });

  imap.connect();
}

// Pull unseen OTP emails and push into RTDB
function fetchLatestOtps(imap, user) {
  imap.search(['UNSEEN'], (err, results) => {
    if (err) return console.error(`[${user}] search err:`, err);
    if (!results.length) return;

    const fetcher = imap.fetch(results, { bodies: '', markSeen: true });
    fetcher.on('message', msg => {
        msg.on('body', async stream => {
            try {
              const parsed = await simpleParser(stream);
              const toAddr = parsed.to.value[0].address;
              const local  = toAddr.split('@')[0];
              const [name, num] = local.includes('+')
                ? local.split('+')
                : local.split(/(\d+)$/).filter(Boolean);
    
              // 1) Try your two HTML patterns first
              const html = (parsed.html || '').replace(/\r?\n/g, ' ');
              let m =
                html.match(/<div[^>]*>\s*<span[^>]*>\s*(\d{4,8})\s*<\/span>\s*<\/div>/) ||
                html.match(/<td[^>]*>\s*<p>\s*(\d{4,8})\s*<\/p>/);
    
              // 2) If that fails, fall back to exactly six digits in plain‑text
              if (!m) {
                const text = (parsed.text || '').trim();
                m = text.match(/\b(\d{6})\b/);
              }
    
              if (!m) {
                return console.warn(`[${user}] no OTP in ${toAddr}`);
              }
    
              const otp = m[1];
              await admin
                .database()
                .ref(`/OTP/${name.toLowerCase()}/${num}`)
                .set({ otp, ts: admin.database.ServerValue.TIMESTAMP });
    
              console.log(`[${user}] saved ${otp} → /OTP/${name.toLowerCase()}/${num}`);
            } catch (e) {
              console.error(`[${user}] msg handler err:`, e);
            }
        });
    });
    fetcher.once('end',   () => console.log(`[${user}] done processing`));
    fetcher.once('error', e => console.error(`[${user}] fetch err:`, e));
  });
}

// kick it all off
startAllListeners().catch(console.error);
