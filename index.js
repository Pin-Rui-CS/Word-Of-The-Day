const { Client, LocalAuth } = require('whatsapp-web.js');
const { google }            = require('googleapis');
const { GoogleAuth }        = require('google-auth-library');
const qrcode                = require('qrcode-terminal');

// ── Config ────────────────────────────────────────────────────────────────────

const GROUP_CHAT_ID  = process.env.WHATSAPP_GROUP_CHAT_ID;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const GOOGLE_CREDS   = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

const CUTOFF_HOUR = 4;        // Before 4 am SGT → counts as previous day
const SGT_OFFSET  = 8 * 3600; // UTC+8 in seconds
const SHEET_NAME  = 'Sheet1';
const HEADERS     = ['Date', 'Word', 'Meaning',
                     'Sentence 1', 'Sentence 2', 'Sentence 3',
                     'Sentence 4', 'Sentence 5'];

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Unix seconds → 'YYYY-MM-DD' in SGT with 4 am cutoff. */
function toSGTDate(unixSeconds) {
    const sgtSec = unixSeconds + SGT_OFFSET;
    const d      = new Date(sgtSec * 1000); // treat as UTC to read SGT fields
    const hour   = d.getUTCHours();
    if (hour < CUTOFF_HOUR) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' + n days → 'YYYY-MM-DD'. */
function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Today's date in SGT as 'YYYY-MM-DD'. */
function todaySGT() {
    return toSGTDate(Math.floor(Date.now() / 1000));
}

/** Inclusive list of dates between start and end. */
function dateRange(start, end) {
    const dates = [];
    let d = start;
    while (d <= end) {
        dates.push(d);
        d = addDays(d, 1);
    }
    return dates;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/** Return { word, meaning, sentences } if text is a Word of the Day message. */
function parseWOTD(text) {
    if (!text || !/word of the day/i.test(text)) return null;

    // Match: Word: _meaning_   (word may include spaces/hyphens)
    const wordMatch = text.match(/^([A-Za-z][A-Za-z\s\-]*):\s*_(.+?)_/m);
    if (!wordMatch) return null;

    const word    = wordMatch[1].trim();
    const meaning = wordMatch[2].trim();

    // All "..." sentences
    const sentences = [];
    const re = /"(.+?)"/gs;
    let m;
    while ((m = re.exec(text)) !== null) sentences.push(m[1].trim());

    return { word, meaning, sentences };
}

// ── Assignment logic ──────────────────────────────────────────────────────────

/**
 * submissions  : [{ date, word, meaning, sentences, timestamp }, ...]
 *                sorted oldest → newest
 * datesNeeded  : ['YYYY-MM-DD', ...] sorted, all dates requiring a word
 *
 * Rules
 * ─────
 * Process batches in chronological order.
 * For each batch: "needed" = all unfilled dates ≤ submission date.
 * Always fill the most recent slots first (newest → oldest), using the
 * latest words. This means a single word always lands on the submission
 * date; gaps further back stay as `none`.
 *
 *   - words ≤ needed  →  latest N words fill the N most recent slots.
 *   - words > needed  →  latest N fill all slots; oldest extras become
 *                        additional rows on the submission date itself.
 *
 * Returns { 'YYYY-MM-DD': [wordObj, ...], ... }
 * (multiple entries on the same date = extras stacked on submission day)
 */
function assign(submissions, datesNeeded) {
    const byDate = {};
    for (const s of submissions) {
        (byDate[s.date] ??= []).push(s);
    }

    const unfilled    = new Set(datesNeeded);
    const assignments = {};

    for (const subDate of Object.keys(byDate).sort()) {
        const words   = byDate[subDate];
        const nWords  = words.length;
        // Sort needed dates oldest→newest, then take the most recent N
        const needed  = datesNeeded.filter(d => d <= subDate && unfilled.has(d)).sort();
        const nNeeded = needed.length;

        if (nWords <= nNeeded) {
            // Fill the nWords most recent slots with the latest nWords words
            const slotsToFill = needed.slice(nNeeded - nWords); // most recent N
            const wordsToUse  = words.slice(nWords - nWords);   // all words (latest first within batch)
            for (let i = 0; i < slotsToFill.length; i++) {
                (assignments[slotsToFill[i]] ??= []).push(wordsToUse[i]);
                unfilled.delete(slotsToFill[i]);
            }
        } else {
            // More words than needed slots — latest nNeeded fill all slots
            const extras  = words.slice(0, nWords - nNeeded);
            const toPlace = words.slice(nWords - nNeeded);
            for (let i = 0; i < needed.length; i++) {
                (assignments[needed[i]] ??= []).push(toPlace[i]);
                unfilled.delete(needed[i]);
            }
            // Extras become additional rows on the submission day
            for (const w of extras) {
                (assignments[subDate] ??= []).push(w);
            }
        }
    }

    return assignments;
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

async function sheetsClient() {
    const auth = new GoogleAuth({
        credentials: GOOGLE_CREDS,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
}

async function ensureHeader(sheets) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:A1`,
    });
    if (!res.data.values?.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [HEADERS] },
        });
        console.log('Header row written.');
    }
}

async function getLastDate(sheets) {
    const res  = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:A`,
    });
    const rows = res.data.values ?? [];
    let latest = null;
    for (const row of rows.slice(1)) {
        if (row[0] && row[0] !== 'none' && (!latest || row[0] > latest)) {
            latest = row[0];
        }
    }
    return latest; // 'YYYY-MM-DD' or null
}

async function appendRows(sheets, rows) {
    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:A`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(client) {
    const sheets    = await sheetsClient();
    await ensureHeader(sheets);

    const yesterday = addDays(todaySGT(), -1);
    const lastDate  = await getLastDate(sheets);
    const start     = lastDate ? addDays(lastDate, 1) : addDays(yesterday, -30);

    if (start > yesterday) {
        console.log('Sheet is already up to date.');
        return;
    }

    const datesNeeded = dateRange(start, yesterday);
    console.log(`Filling ${datesNeeded.length} date(s): ${start} → ${yesterday}`);

    // Fetch messages from the group
    const chat     = await client.getChatById(GROUP_CHAT_ID);
    const messages = await chat.fetchMessages({ limit: 2000 });

    const submissions = [];
    for (const msg of messages) {
        const parsed = parseWOTD(msg.body);
        if (!parsed) continue;
        const msgDate = toSGTDate(msg.timestamp);
        if (msgDate >= start && msgDate <= yesterday) {
            submissions.push({ date: msgDate, ...parsed, timestamp: msg.timestamp });
        }
    }
    submissions.sort((a, b) => a.timestamp - b.timestamp);

    const wordMap = assign(submissions, datesNeeded);

    const rows = [];
    for (const d of datesNeeded) {
        if (wordMap[d]) {
            for (const w of wordMap[d]) {
                rows.push([d, w.word, w.meaning, ...w.sentences]);
            }
        } else {
            rows.push([d, 'none', 'none']);
        }
    }

    await appendRows(sheets, rows);
    console.log(`Appended ${rows.length} row(s).`);
}

// ── WhatsApp client bootstrap ─────────────────────────────────────────────────

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
        // Use system Chrome on GitHub Actions; falls back to bundled Chromium locally
        ...(process.env.CHROME_BIN && { executablePath: process.env.CHROME_BIN }),
    },
});

// If no saved session → QR code appears in the logs; scan it with your phone
client.on('qr', qr => {
    console.log('\nScan this QR code with WhatsApp on your phone:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('WhatsApp connected.');
    clearTimeout(connectionTimer);
    try {
        await run(client);
    } catch (err) {
        console.error('Error during sync:', err);
        process.exitCode = 1;
    } finally {
        await client.destroy();
        process.exit(process.exitCode ?? 0);
    }
});

client.on('auth_failure', msg => {
    console.error('WhatsApp auth failed — session may have expired. Re-run to scan QR again.');
    console.error(msg);
    process.exitCode = 1;
    client.destroy();
});

// Fail the job if WhatsApp never connects (e.g. session expired + no one scanned QR)
const CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const connectionTimer = setTimeout(() => {
    console.error('Timed out waiting for WhatsApp to connect. Session may have expired.');
    process.exit(1);
}, CONNECTION_TIMEOUT);

client.initialize();
