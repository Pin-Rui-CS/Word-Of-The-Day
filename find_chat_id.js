/**
 * Run this ONCE locally to find your WhatsApp group chat ID.
 *
 *   node find_chat_id.js
 *
 * Scan the QR code, wait for the list of groups to print, then Ctrl+C.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode                = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'finder' }),
    puppeteer: { headless: false },  // show browser window so QR is easier to scan
});

client.on('qr', qr => {
    console.log('\nScan this QR code:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\nYour WhatsApp groups:\n');
    const chats = await client.getChats();
    for (const chat of chats) {
        if (chat.isGroup) {
            console.log(`  Name : ${chat.name}`);
            console.log(`  ID   : ${chat.id._serialized}`);
            console.log('');
        }
    }
    console.log('Copy the ID for your group and save it as WHATSAPP_GROUP_CHAT_ID.');
    await client.destroy();
    process.exit(0);
});

client.initialize();
