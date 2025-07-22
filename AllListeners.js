// AllListeners.js
const Imap             = require('node-imap');
const { simpleParser } = require('mailparser');
const { google }       = require('googleapis');
const admin            = require('firebase-admin');

// ——— Init Firebase Admin
const serviceAccount = require('./AllAccountServer.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://cookies-9077d-default-rtdb.asia-southeast1.firebasedatabase.app"
});

// Helper to encode email into a safe RTDB key
function encodeEmail(email) {
  return email.replace(/\./g, ',');
}

// Build the Base64‑encoded XOAUTH2 string
function buildXoauth2Token(user, accessToken) {
  const auth = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(auth).toString('base64');
}

// Kick off all listeners
async function startAllListeners() {
  const snap = await admin.database().ref('/gmailAccounts').once('value');
  const accounts = snap.val();
  if (!accounts) {
    console.error('No /gmailAccounts found!');
    return;
  }

  for (const key of Object.keys(accounts)) {
    const { creds, tokens } = accounts[key];
    const email = key.replace(/,/g, '.'); // decode back to real address

    if (!creds || !tokens) {
      console.warn(`Skipping ${email}—missing creds or tokens`);
      continue;
    }

    // 1) Build OAuth2 client for this account
    const oAuth2 = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      (creds.redirect_uris && creds.redirect_uris[0]) || 'urn:ietf:wg:oauth:2.0:oob'
    );
    oAuth2.setCredentials(tokens);

    // 2) Refresh to get a fresh access_token
    let accessToken;
    try {
      ({ credentials: { access_token: accessToken } } =
        await oAuth2.refreshAccessToken());
    } catch (e) {
      console.error(`[${email}] Token refresh failed:`, e);
      continue;
    }
    const xoauth2 = buildXoauth2Token(email, accessToken);

    // 3) Start IMAP listener
    startImapFor(email, xoauth2, oAuth2);
  }
}

// Start a single IMAP listener
function startImapFor(user, xoauth2, oAuth2Client) {
  const imap = new Imap({
    user,
    xoauth2,
    host: 'imap.gmail.com',
    port: 993,
    tls: true
  });

  imap.once('ready', () => {
    imap.openBox('OTP', false, (err, box) => {
      if (err) {
        return console.error(`[${user}] openBox error:`, err);
      }
      console.log(`[${user}] watching OTP (total ${box.messages.total})`);
      fetchLatestOtps(imap, user);
      imap.on('mail', () => fetchLatestOtps(imap, user));
    });
  });

  imap.once('error', async err => {
    console.error(`[${user}] IMAP error:`, err);
    if (err.source === 'authentication') {
      console.log(`[${user}] reauthenticating…`);
      try {
        const { credentials } = await oAuth2Client.refreshAccessToken();
        const xo = buildXoauth2Token(user, credentials.access_token);
        startImapFor(user, xo, oAuth2Client);
      } catch (e) {
        console.error(`[${user}] re‑auth failed:`, e);
      }
    }
  });

  imap.once('end', () => console.log(`[${user}] connection ended`));
  imap.connect();
}

// Fetch and process all unseen OTP mails
function fetchLatestOtps(imap, user) {
  imap.search(['UNSEEN'], (err, results) => {
    if (err) {
      return console.error(`[${user}] search err:`, err);
    }
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

    fetcher.once('error', e => console.error(`[${user}] fetch err:`, e));
    fetcher.once('end', () => console.log(`[${user}] done processing`));
  });
}

// Start everything
startAllListeners().catch(console.error);
