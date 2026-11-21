'use strict';

// Owner-only: link another WhatsApp number and remove it again.
//   .pair 265991234567     → sends a linking code; once the number enters it
//                            the number stays connected until .remove
//   .remove 265991234567   → logs it out of WhatsApp and forgets it
// The restrictions between the owner and linked numbers are unchanged
// (see gateway/guards.js): a linked number only acts from its own account.

const accountSockets = require('../../lib/accountSockets');

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

const digits = (raw) => String(raw || '').replace(/\D/g, '');
const validNumber = (n) => /^\d{7,15}$/.test(n);

function formatCode(code) {
  const c = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : String(code);
}

module.exports = [
  {
    name: 'pair',
    aliases: ['link'],
    category: 'admin',
    description: 'Link another WhatsApp number',
    usage: '.pair <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const number = digits(args[0]);
      if (!validNumber(number)) return extra.reply('Usage: .pair <number>\nExample: .pair 265991234567 (digits only, country code first)');
      await react(sock, msg, '⏳');
      let result;
      try { result = await accountSockets.pairNumber(number); }
      catch (err) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ ${String(err?.message || 'Could not request a linking code.')}`);
      }
      await react(sock, msg, '✅');
      return extra.reply([
        `🔗 *Linking code for +${number}*`,
        '',
        `*${formatCode(result.code)}*`,
        '',
        `On that phone: WhatsApp → Linked devices → Link a device → Link with phone number instead, then enter the code within about ${result.expiresInSeconds || 60} seconds.`,
        '',
        `It stays connected until you send .remove ${number}`,
      ].join('\n'));
    },
  },
  {
    name: 'sessionid',
    aliases: ['recoverystring'],
    category: 'admin',
    description: 'Get a recovery string that can restore a login on a fresh deploy',
    usage: '.sessionid [number]',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const target = args[0] ? digits(args[0]) : accountSockets.sessionKey(sock);
      if (args[0] && !validNumber(target)) return extra.reply('Usage: .sessionid [number]\nExample: .sessionid 265991234567 — with no number you get the recovery string of the account you are sending from.');
      await react(sock, msg, '⏳');
      let result;
      try { result = await accountSockets.recoveryString(target); }
      catch (err) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ ${String(err?.message || 'Could not build a recovery string.')}`);
      }
      await react(sock, msg, '✅');
      const label = result.number ? `+${result.number}` : 'the owner account';
      // The string is long, so it goes as a small text file the owner can
      // save; a chat message would truncate it.
      try {
        await sock.sendMessage(msg.key.remoteJid, {
          document: Buffer.from(String(result.token), 'utf8'),
          fileName: `zafar-session-${result.number || 'owner'}.txt`,
          mimetype: 'text/plain',
        });
      } catch {
        return extra.reply('⚠️ Could not send the recovery file. Try again in a moment.');
      }
      return extra.reply([
        `🔑 *Recovery string for ${label}*`,
        '',
        'The file above contains a full login snapshot for that account (credentials + session keys).',
        'Anyone who has it can take over the account — store it like a password, never share it.',
        '',
        `To use it on a fresh deploy, put it in the SESSION_IDS environment variable as ${result.number ? `${result.number}=` : 'owner='}<string>, or give the owner string on its own as SESSION_ID.`,
        ...(result.encrypted
          ? ['This string is encrypted: the new deploy also needs the same SESSION_RECOVERY_SECRET.']
          : ['Tip: set SESSION_RECOVERY_SECRET before creating strings so they are stored encrypted.']),
        'An older string never overwrites a newer login, and WhatsApp can still log the device out from the phone itself.',
      ].join('\n'));
    },
  },
  {
    name: 'remove',
    aliases: ['unlink'],
    category: 'admin',
    description: 'Disconnect and forget a linked number',
    usage: '.remove <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const number = digits(args[0]);
      if (!validNumber(number)) return extra.reply('Usage: .remove <number>\nExample: .remove 265991234567');
      await react(sock, msg, '⏳');
      let result;
      try { result = await accountSockets.removeNumber(number); }
      catch (err) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ ${err?.statusCode === 404 ? `+${number} is not linked.` : String(err?.message || 'Could not remove that number.')}`);
      }
      await react(sock, msg, '✅');
      return extra.reply(result.loggedOut
        ? `🗑️ Removed +${number}. It was logged out of WhatsApp.`
        : `🗑️ Removed +${number} from the bot. WhatsApp could not be reached, so if the device still shows in that phone's Linked devices, they can log it out there.`);
    },
  },
];
