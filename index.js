const { Client, GatewayIntentBits, Events, ActivityType, Partials, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require("@discordjs/voice");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const Groq = require("groq-sdk");
const fetch = require("node-fetch");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BOT_PREFIX = process.env.BOT_PREFIX || "Caine";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "Kamu adalah AI asisten perempuan bernama Caine yang nyantai dan gaul. Jawab pake bahasa Indonesia slang yang natural, kayak ngobrol sama pacar dan memanggil user dengan panggilan mesra seperti sayang, baby,dll. Tetep informatif dan tepat tapi ga kaku. Jangan pake bahasa formal atau kaku.";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1503911709897785464";
const CLIENT_ID = "1503728763416875118";
const MUSIC_DIR = process.env.MUSIC_DIR || "/storage/emulated/0/Music";

const groq = new Groq({ apiKey: GROQ_API_KEY });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel, Partials.Message],
});

const conversationHistory = new Map();
const warnData = new Map();
const bannedWords = new Set();
const disabledChannels = new Set();
const players = new Map();
const MAX_HISTORY = 30;
const startTime = Date.now();

// ============================================================
// HISTORY
// ============================================================
function getHistoryKey(message) { return message.guild ? `server-${message.channelId}` : `dm-${message.author.id}`; }
function getHistory(key) { if (!conversationHistory.has(key)) conversationHistory.set(key, []); return conversationHistory.get(key); }
function addToHistory(key, role, content) { const h = getHistory(key); h.push({ role, content }); if (h.length > MAX_HISTORY * 2) h.splice(0, 2); }
function clearHistory(key) { conversationHistory.delete(key); }

// ============================================================
// UPTIME
// ============================================================
function getUptime() {
  const ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m % 60}m ${s % 60}s`;
}

// ============================================================
// LOGGING
// ============================================================
async function sendLog(embed) {
  try { const ch = await client.channels.fetch(LOG_CHANNEL_ID); if (ch) await ch.send({ embeds: [embed] }); } catch (e) { console.error("Log error:", e); }
}

async function logChat(message, userText, reply) {
  const { EmbedBuilder } = require("discord.js");
  await sendLog(new EmbedBuilder().setColor(0x5865f2).setTitle("💬 Chat Log").addFields(
    { name: "User", value: `${message.author.tag}`, inline: true },
    { name: "Channel", value: message.guild ? `<#${message.channelId}>` : "DM", inline: true },
    { name: "Pertanyaan", value: userText?.slice(0, 1000) || "(kosong)" },
    { name: "Jawaban", value: reply?.slice(0, 1000) || "(kosong)" }
  ).setTimestamp());
}

async function logMod(action, moderator, target, reason) {
  const { EmbedBuilder } = require("discord.js");
  await sendLog(new EmbedBuilder().setColor(0xff0000).setTitle(`🔨 Moderasi — ${action}`).addFields(
    { name: "Moderator", value: `${moderator.tag}`, inline: true },
    { name: "Target", value: `${target?.tag || target}`, inline: true },
    { name: "Alasan", value: reason || "Tidak ada alasan" }
  ).setTimestamp());
}

async function logReport(reporter, target, reason, message) {
  const { EmbedBuilder } = require("discord.js");
  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
  const embed = new EmbedBuilder().setColor(0xff6600).setTitle("🚨 Report Masuk").addFields(
    { name: "Reporter", value: `${reporter.tag}`, inline: true },
    { name: "Target", value: `${target?.tag || target}`, inline: true },
    { name: "Alasan", value: reason || "Tidak ada alasan" },
    { name: "Channel", value: `<#${message.channelId}>` }
  ).setTimestamp();
  const admins = message.guild.members.cache.filter(m => m.permissions.has(PermissionsBitField.Flags.Administrator) && !m.user.bot);
  await logChannel.send({ content: `📢 **Report baru!** ${admins.map(a => `<@${a.id}>`).join(" ")}`, embeds: [embed] });
}

async function logAutomod(message, word) {
  const { EmbedBuilder } = require("discord.js");
  await sendLog(new EmbedBuilder().setColor(0xffaa00).setTitle("🤖 Automod — Pesan Dihapus").addFields(
    { name: "User", value: `${message.author.tag}`, inline: true },
    { name: "Channel", value: `<#${message.channelId}>`, inline: true },
    { name: "Kata Terlarang", value: `||${word}||` },
    { name: "Pesan", value: message.content.slice(0, 500) }
  ).setTimestamp());
}

// ============================================================
// AI
// ============================================================
async function askGroq(key, userMessage, displayName = "User") {
  const history = getHistory(key);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT + `\n\nPENTING: Percakapan ini terjadi di Discord. Setiap pesan user diawali dengan nama mereka dalam format [NamaUser]. Ingat dan bedakan setiap user berdasarkan nama mereka.` },
    ...history,
    { role: "user", content: `[${displayName}]: ${userMessage}` },
  ];
  const res = await Promise.race([
    groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages,
      max_tokens: 1024,
      temperature: 0.8,
      tools: [{ type: "browser_search" }],
      tool_choice: "auto",
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 20000))
  ]);
  const reply = res.choices[0].message.content;
  addToHistory(key, "user", `[${displayName}]: ${userMessage}`);
  addToHistory(key, "assistant", reply);
  return reply;
}

async function askVision(key, userMessage, imageUrl, displayName = "User") {
  const imgRes = await fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!imgRes.ok) throw new Error(`Gagal fetch gambar: ${imgRes.status}`);
  const base64Image = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
  const mimeType = imgRes.headers.get("content-type")?.split(";")[0] || "image/png";
  const prompt = userMessage || "Deskripsiin gambar ini secara detail.";
  const res = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }, { type: "text", text: `[${displayName}]: ${prompt}` }] }
    ],
    max_tokens: 1024,
  });
  const reply = res.choices[0].message.content;
  addToHistory(key, "user", `[${displayName}]: [kirim gambar] ${prompt}`);
  addToHistory(key, "assistant", reply);
  return reply;
}

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const chunks = []; let current = "";
  for (const line of text.split("\n")) {
    if ((current + line).length > maxLength) { if (current) chunks.push(current.trim()); current = line + "\n"; }
    else current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ============================================================
// PERMISSION
// ============================================================
function userHasPerm(message, perm) { return message.member?.permissions.has(perm); }
function botHasPerm(message, perm) { return message.guild?.members.me.permissions.has(perm); }

// ============================================================
// WARNING
// ============================================================
function getWarnings(userId, guildId) { const k = `${guildId}-${userId}`; if (!warnData.has(k)) warnData.set(k, []); return warnData.get(k); }
function addWarning(userId, guildId, reason) { const w = getWarnings(userId, guildId); w.push({ reason, time: new Date().toISOString() }); return w.length; }
function clearWarnings(userId, guildId) { warnData.delete(`${guildId}-${userId}`); }

// ============================================================
// MUSIC
// ============================================================
function findLocalFile(query) {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const files = fs.readdirSync(MUSIC_DIR).filter(f => /\.(flac|mp3|m4a|wav|ogg|opus)$/i.test(f));
  const q = query.toLowerCase();
  return files.find(f => f.toLowerCase().includes(q)) || null;
}

function listLocalFiles() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  return fs.readdirSync(MUSIC_DIR).filter(f => /\.(flac|mp3|m4a|wav|ogg|opus)$/i.test(f));
}

async function handleMusic(message, userText) {
  const args = userText.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const musicCmds = ["play", "playfile", "stop", "list"];
  if (!musicCmds.includes(cmd)) return false;

  const guildId = message.guild.id;

  if (cmd === "list") {
    const files = listLocalFiles();
    if (files.length === 0) return message.reply(`❌ Folder musik kosong atau ga bisa diakses: \`${MUSIC_DIR}\``), true;
    const list = files.slice(0, 30).map((f, i) => `${i + 1}. ${f}`).join("\n");
    const chunks = splitMessage(`🎵 **Musik lokal lo (${files.length} file):**\n\`\`\`\n${list}\n\`\`\``);
    for (const chunk of chunks) await message.reply(chunk);
    return true;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return message.reply("❌ Kamu harus di voice channel dulu sayang!"), true;

  if (cmd === "stop") {
    const current = players.get(guildId);
    if (!current) return message.reply("❌ Ga ada yang lagi diplay sayang!"), true;
    current.player.stop();
    current.connection.destroy();
    players.delete(guildId);
    return message.reply("⏹️ Musik dihentiin sayang!"), true;
  }

  if (cmd === "play") {
    const query = args.slice(1).join(" ");
    if (!query) return message.reply("❌ Masukin nama lagu sayang!"), true;

    // Cek lokal dulu
    const localFile = findLocalFile(query);
    if (localFile) {
      const filePath = path.join(MUSIC_DIR, localFile);
      const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: message.guild.voiceAdapterCreator });
      const resource = createAudioResource(filePath);
      const player = createAudioPlayer();
      player.play(resource);
      connection.subscribe(player);
      players.set(guildId, { player, connection });
      player.on(AudioPlayerStatus.Idle, () => { connection.destroy(); players.delete(guildId); });
      return message.reply(`▶️ Playing lokal: **${localFile}**`), true;
    }

    // Fallback ke YouTube
    const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: message.guild.voiceAdapterCreator });
    const ytdlp = spawn("yt-dlp", ["-f", "bestaudio", "-o", "-", `ytsearch1:${query}`]);
    const resource = createAudioResource(ytdlp.stdout);
    const player = createAudioPlayer();
    player.play(resource);
    connection.subscribe(player);
    players.set(guildId, { player, connection });
    player.on(AudioPlayerStatus.Idle, () => { connection.destroy(); players.delete(guildId); });
    return message.reply(`▶️ Playing: **${query}**`), true;
  }

  if (cmd === "playfile") {
    const query = args.slice(1).join(" ");
    if (!query) return message.reply("❌ Masukin nama file sayang!"), true;

    const localFile = findLocalFile(query);
    if (!localFile) return message.reply(`❌ File **${query}** ga ketemu di folder musik sayang. Coba \`Caine list\` buat liat file yang ada.`), true;

    const filePath = path.join(MUSIC_DIR, localFile);
    const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: message.guild.voiceAdapterCreator });
    const resource = createAudioResource(filePath);
    const player = createAudioPlayer();
    player.play(resource);
    connection.subscribe(player);
    players.set(guildId, { player, connection });
    player.on(AudioPlayerStatus.Idle, () => { connection.destroy(); players.delete(guildId); });
    return message.reply(`▶️ Playing lokal: **${localFile}**`), true;
  }

  return false;
}

// ============================================================
// MODERATION
// ============================================================
async function handleModeration(message, userText) {
  if (!message.guild) return false;
  const args = userText.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const mention = message.mentions.members?.first();
  const mentionUser = message.mentions.users?.first();
  const modCmds = ["kick","ban","unban","timeout","untimeout","warn","warnings","clearwarn","clear","lock","unlock","slowmode","nick","role","report","addword","removeword","words","enable","disable"];
  if (!modCmds.includes(cmd)) return false;

  if (cmd === "report") {
    if (!mentionUser) return message.reply("❌ Mention dulu siapa yang mau di-report."), true;
    await logReport(message.author, mentionUser, args.slice(2).join(" ") || "Tidak ada alasan", message);
    return message.reply("✅ Report kamu udah dikirim ke admin sayang!"), true;
  }
  if (cmd === "kick") {
    if (!userHasPerm(message, PermissionsBitField.Flags.KickMembers)) return message.reply("❌ Kamu ga punya permission buat kick sayang."), true;
    if (!botHasPerm(message, PermissionsBitField.Flags.KickMembers)) return message.reply("❌ Aku ga punya permission buat kick."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-kick."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.kick(reason); await logMod("Kick", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-kick.`), true;
  }
  if (cmd === "ban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Kamu ga punya permission buat ban sayang."), true;
    if (!botHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Aku ga punya permission buat ban."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-ban."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.ban({ reason }); await logMod("Ban", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-ban.`), true;
  }
  if (cmd === "unban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const userId = args[1]; if (!userId) return message.reply("❌ Masukin user ID yang mau di-unban."), true;
    await message.guild.members.unban(userId); await logMod("Unban", message.author, userId, "-");
    return message.reply(`✅ User **${userId}** udah di-unban.`), true;
  }
  if (cmd === "timeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-timeout."), true;
    const menit = parseInt(args[2]) || 10; const reason = args.slice(3).join(" ") || "Tidak ada alasan";
    await mention.timeout(menit * 60 * 1000, reason); await logMod("Timeout", message.author, mention.user, `${menit} menit — ${reason}`);
    return message.reply(`✅ **${mention.user.tag}** di-timeout ${menit} menit.`), true;
  }
  if (cmd === "untimeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-untimeout."), true;
    await mention.timeout(null); await logMod("Untimeout", message.author, mention.user, "-");
    return message.reply(`✅ Timeout **${mention.user.tag}** udah dicabut.`), true;
  }
  if (cmd === "warn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-warn."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    const totalWarns = addWarning(mention.id, message.guild.id, reason);
    await logMod(`Warn (${totalWarns}x)`, message.author, mention.user, reason);
    if (totalWarns >= 5) { await mention.ban({ reason: "Auto-ban: 5 warnings" }); await logMod("Auto-Ban", client.user, mention.user, "5 warnings"); return message.reply(`⛔ **${mention.user.tag}** dapat warn ke-5, otomatis di-ban!`), true; }
    if (totalWarns >= 3) { await mention.timeout(10 * 60 * 1000, "Auto-timeout: 3 warnings"); return message.reply(`⚠️ **${mention.user.tag}** dapat warn ke-${totalWarns}, di-timeout 10 menit!`), true; }
    return message.reply(`⚠️ **${mention.user.tag}** dapat warning ke-${totalWarns}. Alasan: ${reason}`), true;
  }
  if (cmd === "warnings") {
    if (!mention) return message.reply("❌ Mention siapa yang mau dicek warningnya."), true;
    const warns = getWarnings(mention.id, message.guild.id);
    if (warns.length === 0) return message.reply(`✅ **${mention.user.tag}** belum punya warning.`), true;
    return message.reply(`⚠️ **${mention.user.tag}** punya **${warns.length} warning:**\n${warns.map((w, i) => `${i+1}. ${w.reason}`).join("\n")}`), true;
  }
  if (cmd === "clearwarn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau dihapus warningnya."), true;
    clearWarnings(mention.id, message.guild.id); return message.reply(`✅ Warning **${mention.user.tag}** udah dihapus.`), true;
  }
  if (cmd === "clear") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageMessages)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const amount = parseInt(args[1]) || 10;
    await message.channel.bulkDelete(Math.min(amount + 1, 100), true);
    await logMod("Clear", message.author, `#${message.channel.name}`, `${amount} pesan`);
    return true;
  }
  if (cmd === "lock") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    return message.reply("🔒 Channel dikunci!"), true;
  }
  if (cmd === "unlock") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
    return message.reply("🔓 Channel dibuka!"), true;
  }
  if (cmd === "slowmode") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const detik = parseInt(args[1]) || 0;
    await message.channel.setRateLimitPerUser(detik);
    return message.reply(`✅ Slowmode diset ke ${detik} detik.`), true;
  }
  if (cmd === "nick") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageNicknames)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau diganti nicknya."), true;
    const newNick = args.slice(2).join(" ") || null;
    await mention.setNickname(newNick);
    return message.reply(`✅ Nickname **${mention.user.tag}** diganti ke: ${newNick || "(reset)"}`), true;
  }
  if (cmd === "role") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageRoles)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const sub = args[1]?.toLowerCase(); const roleId = message.mentions.roles?.first()?.id;
    if (!mention || !roleId) return message.reply("❌ Format: Caine role add/remove @user @role"), true;
    if (sub === "add") { await mention.roles.add(roleId); return message.reply(`✅ Role ditambahin ke **${mention.user.tag}**.`), true; }
    if (sub === "remove") { await mention.roles.remove(roleId); return message.reply(`✅ Role dihapus dari **${mention.user.tag}**.`), true; }
  }
  if (cmd === "addword") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    const word = args[1]?.toLowerCase(); if (!word) return message.reply("❌ Masukin kata yang mau diblacklist."), true;
    bannedWords.add(word); return message.reply(`✅ Kata **${word}** ditambahin ke blacklist.`), true;
  }
  if (cmd === "removeword") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    bannedWords.delete(args[1]?.toLowerCase());
    return message.reply("✅ Kata dihapus dari blacklist."), true;
  }
  if (cmd === "words") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    if (bannedWords.size === 0) return message.reply("📋 Blacklist masih kosong."), true;
    return message.reply(`📋 **Kata blacklist:**\n${[...bannedWords].join(", ")}`), true;
  }
  if (cmd === "enable") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    disabledChannels.delete(message.channelId);
    return message.reply("✅ Aku udah diaktifin di channel ini sayang! 💕"), true;
  }
  if (cmd === "disable") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    disabledChannels.add(message.channelId);
    return message.reply("✅ Aku dinonaktifin di channel ini. Sampai jumpa sayang! 👋"), true;
  }
  return false;
}

// ============================================================
// SUMMARIZE
// ============================================================
async function summarizeChannel(message, amount = 30) {
  const msgs = await message.channel.messages.fetch({ limit: Math.min(amount, 100) });
  const text = msgs.reverse().map(m => `${m.author.displayName}: ${m.content}`).filter(t => t.length > 10).join("\n");
  if (!text) return message.reply("❌ Ga ada pesan yang bisa dirangkum sayang.");
  const result = await askGroq(getHistoryKey(message), `Rangkum percakapan berikut dalam beberapa poin penting, pake bahasa Indonesia yang santai:\n\n${text.slice(0, 3000)}`, "System");
  return message.reply(`📝 **Rangkuman:**\n\n${result}`);
}

// ============================================================
// READY + SLASH COMMAND
// ============================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: "custom", type: ActivityType.Custom, state: "Property Of Caineedyou | Developed By Zaineedyou" }] });
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: [new SlashCommandBuilder().setName("info").setDescription("Lihat info dan status bot Caine").toJSON()]
    });
    console.log("✅ Slash command /info terdaftar");
  } catch (e) { console.error("Slash error:", e); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "info") {
    const { EmbedBuilder } = require("discord.js");
    const embed = new EmbedBuilder()
      .setColor(0xff69b4)
      .setTitle("💕 Caine — AI Discord Bot")
      .setDescription("Halo! Aku Caine, AI asisten yang siap bantu kamu di server ini~")
      .addFields(
        { name: "👨‍💻 Developer", value: "Zaineedyou", inline: true },
        { name: "🖥️ Infrastructure", value: "Zaineedyou", inline: true },
        { name: "🤖 Text Model", value: "GPT OSS 120B (Groq)", inline: true },
        { name: "👁️ Vision Model", value: "Llama 4 Scout 17B (Groq)", inline: true },
        { name: "🔍 Web Search", value: "Built-in (GPT OSS)", inline: true },
        { name: "🎵 Music", value: `Local FLAC + YouTube`, inline: true },
        { name: "⏱️ Uptime", value: getUptime(), inline: true },
        { name: "📡 Status", value: "🟢 Online", inline: true },
        { name: "🏠 Server", value: interaction.guild?.name || "User Install", inline: true },
      )
      .setFooter({ text: "Property Of Caineedyou | Developed by Zaineedyou" })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
});

// ============================================================
// AUTOMOD
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const lower = message.content.toLowerCase();
  for (const word of bannedWords) {
    if (lower.includes(word)) {
      try { await message.delete(); await logAutomod(message, word); await message.channel.send(`⚠️ Pesan <@${message.author.id}> dihapus karena mengandung kata terlarang.`); } catch {}
      return;
    }
  }
});

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (disabledChannels.has(message.channelId)) return;

  const content = message.content.trim();
  const isMentioned = message.mentions.has(client.user);
  const hasPrefix = content.toLowerCase().includes(BOT_PREFIX.toLowerCase());
  let isReply = false;
  if (message.reference) { try { const ref = await message.fetchReference(); isReply = ref.author.id === client.user.id; } catch {} }
  if (!hasPrefix && !isMentioned && !isReply) return;

  let userText = content;
  if (hasPrefix) { const idx = content.toLowerCase().indexOf(BOT_PREFIX.toLowerCase()); userText = (content.slice(0, idx) + content.slice(idx + BOT_PREFIX.length)).trim(); }
  else if (isMentioned) { userText = content.replace(`<@${client.user.id}>`, "").trim(); }

  const historyKey = getHistoryKey(message);
  const displayName = message.member?.displayName || message.author.displayName || message.author.username;

  if (userText.toLowerCase() === "reset" || userText.toLowerCase() === "clear") { clearHistory(historyKey); return message.reply("🧹 Memory kita udah di-reset sayang!"); }
  if (userText.toLowerCase().startsWith("summarize")) { return summarizeChannel(message, parseInt(userText.split(" ")[1]) || 30); }

  if (userText.toLowerCase() === "help") {
    return message.reply(
      "**Hai sayang! Ini cara pakai aku:**\n" +
      "`Caine <pertanyaan>` — tanya apapun\n" +
      "`Caine` + kirim gambar — analisis gambar\n" +
      "`Caine summarize [jumlah]` — rangkum chat\n" +
      "`Caine report @user alasan` — laporin user\n" +
      "`Caine reset` — hapus memory\n" +
      "`/info` — lihat info bot\n\n" +
      "**Musik:**\n" +
      "`Caine play <judul>` — play lokal dulu, fallback YouTube\n" +
      "`Caine playfile <nama>` — play file lokal spesifik\n" +
      "`Caine list` — lihat semua file musik lokal\n" +
      "`Caine stop` — stop musik\n\n" +
      "**Moderasi:** kick, ban, unban, timeout, untimeout, warn, warnings, clearwarn, clear, lock, unlock, slowmode, nick, role add/remove\n\n" +
      "**Admin:** addword, removeword, words, enable, disable"
    );
  }

  const isMusic = await handleMusic(message, userText);
  if (isMusic) return;

  const isMod = await handleModeration(message, userText);
  if (isMod) return;

  const imageAttachment = message.attachments.find(att => att.contentType?.startsWith("image/"));
  await message.channel.sendTyping();

  try {
    let reply;
    if (imageAttachment) {
      reply = await askVision(historyKey, userText, imageAttachment.url, displayName);
    } else {
      reply = await askGroq(historyKey, userText || "Seseorang baru manggil namamu. Balas dengan sapaan mesra seperti pacar, jangan pakai kata bro.", displayName);
    }
    const chunks = splitMessage(reply);
    for (const chunk of chunks) await message.reply(chunk);
    await logChat(message, userText, reply);
  } catch (err) {
    console.error("Error:", err);
    message.reply("❌ Ada error sayang, coba lagi ya 🙏");
  }
});

client.login(DISCORD_TOKEN);
