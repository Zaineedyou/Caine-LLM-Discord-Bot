const { Client, GatewayIntentBits, Events, ActivityType, Partials, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { spawn } = require("child_process");
const Groq = require("groq-sdk");
const fetch = require("node-fetch");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const BOT_PREFIX = process.env.BOT_PREFIX || "Caine";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "Kamu adalah AI asisten perempuan bernama Caine yang nyantai dan gaul. Jawab pake bahasa Indonesia slang yang natural, kayak ngobrol sama pacar dan memanggil user dengan panggilan mesra seperti sayang, baby,dll. Tetep informatif dan tepat tapi ga kaku. Jangan pake bahasa formal atau kaku.";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1503911709897785464";
const CLIENT_ID = "1503728763416875118";

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
const queues = new Map();
const MAX_HISTORY = 30;
const startTime = Date.now();

// ============================================================
// SPOTIFY TOKEN
// ============================================================
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

async function getSpotifyTrack(trackId) {
  const token = await getSpotifyToken();
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return `${data.artists[0].name} ${data.name}`;
}

async function getSpotifyPlaylist(playlistId) {
  const token = await getSpotifyToken();
  let tracks = [], offset = 0;
  while (true) {
    const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50&offset=${offset}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const items = data.items?.filter(i => i.track) || [];
    tracks.push(...items.map(i => `${i.track.artists[0].name} ${i.track.name}`));
    if (!data.next) break;
    offset += 50;
  }
  return tracks;
}

async function getSpotifyAlbum(albumId) {
  const token = await getSpotifyToken();
  const res = await fetch(`https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const albumRes = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, { headers: { Authorization: `Bearer ${token}` } });
  const albumData = await albumRes.json();
  return data.items.map(t => `${albumData.artists[0].name} ${t.name}`);
}

function parseSpotifyUrl(url) {
  const match = url.match(/spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

// ============================================================
// MUSIC CORE
// ============================================================
function getQueue(guildId) { if (!queues.has(guildId)) queues.set(guildId, []); return queues.get(guildId); }

async function playNext(guildId, message) {
  const queue = getQueue(guildId);
  if (queue.length === 0) {
    const current = players.get(guildId);
    if (current) { current.connection.destroy(); players.delete(guildId); }
    return;
  }

  const query = queue.shift();
  const current = players.get(guildId);
  if (!current) return;

  try {
    const ytdlp = spawn("yt-dlp", ["-f", "bestaudio", "--no-playlist", "-o", "-", `ytsearch1:${query}`]);
    ytdlp.stderr.on("data", d => console.error("yt-dlp:", d.toString()));
    const resource = createAudioResource(ytdlp.stdout, { inputType: StreamType.Arbitrary });
    current.player.play(resource);
    if (message) message.channel.send(`▶️ Playing: **${query}**`).catch(() => {});
  } catch (err) {
    console.error("playNext error:", err);
    playNext(guildId, message);
  }
}

async function handleMusic(message, userText) {
  const args = userText.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const musicCmds = ["play", "stop", "skip", "queue"];
  if (!musicCmds.includes(cmd)) return false;

  const guildId = message.guild.id;

  if (cmd === "queue") {
    const q = getQueue(guildId);
    if (q.length === 0) return message.reply("📭 Queue kosong sayang!"), true;
    return message.reply(`📋 **Queue (${q.length} lagu):**\n${q.slice(0, 20).map((t, i) => `${i+1}. ${t}`).join("\n")}`), true;
  }

  if (cmd === "stop") {
    const current = players.get(guildId);
    if (!current) return message.reply("❌ Ga ada yang lagi diplay sayang!"), true;
    queues.set(guildId, []);
    current.player.stop();
    current.connection.destroy();
    players.delete(guildId);
    return message.reply("⏹️ Musik dihentiin sayang!"), true;
  }

  if (cmd === "skip") {
    const current = players.get(guildId);
    if (!current) return message.reply("❌ Ga ada yang lagi diplay sayang!"), true;
    current.player.stop();
    return message.reply("⏭️ Skipped!"), true;
  }

  if (cmd === "play") {
    const input = args.slice(1).join(" ");
    if (!input) return message.reply("❌ Masukin nama lagu atau link Spotify sayang!"), true;

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply("❌ Lo harus di voice channel dulu sayang!"), true;

    let current = players.get(guildId);
    if (!current) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
      const player = createAudioPlayer();
      connection.subscribe(player);
      current = { player, connection };
      players.set(guildId, current);
      player.on("error", err => { console.error("Player error:", err); playNext(guildId, message); });
      player.on(AudioPlayerStatus.Idle, () => playNext(guildId, message));
    }

    const spotifyInfo = parseSpotifyUrl(input);
    if (spotifyInfo) {
      if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return message.reply("❌ Spotify API belum dikonfigurasi sayang!"), true;
      try {
        let tracks = [];
        if (spotifyInfo.type === "track") tracks = [await getSpotifyTrack(spotifyInfo.id)];
        else if (spotifyInfo.type === "playlist") tracks = await getSpotifyPlaylist(spotifyInfo.id);
        else if (spotifyInfo.type === "album") tracks = await getSpotifyAlbum(spotifyInfo.id);
        getQueue(guildId).push(...tracks);
        await message.reply(`✅ **${tracks.length} lagu** dari Spotify ditambahkan ke queue!`);
        if (current.player.state.status === AudioPlayerStatus.Idle) await playNext(guildId, message);
      } catch (err) {
        console.error("Spotify error:", err);
        return message.reply("❌ Gagal fetch data Spotify sayang!"), true;
      }
      return true;
    }

    getQueue(guildId).push(input);
    if (current.player.state.status === AudioPlayerStatus.Idle) {
      await playNext(guildId, message);
    } else {
      await message.reply(`✅ **${input}** ditambahkan ke queue!`);
    }
    return true;
  }

  return false;
}

// ============================================================
// HISTORY
// ============================================================
function getHistoryKey(message) { return message.guild ? `server-${message.channelId}` : `dm-${message.author.id}`; }
function getHistory(key) { if (!conversationHistory.has(key)) conversationHistory.set(key, []); return conversationHistory.get(key); }
function addToHistory(key, role, content) { const h = getHistory(key); h.push({ role, content }); if (h.length > MAX_HISTORY * 2) h.splice(0, 2); }
function clearHistory(key) { conversationHistory.delete(key); }

function getUptime() {
  const ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
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
    { role: "system", content: SYSTEM_PROMPT + `\n\nPENTING: Percakapan ini terjadi di Discord. Setiap pesan user diawali dengan nama mereka dalam format [NamaUser].` },
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
  const res = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }, { type: "text", text: `[${displayName}]: ${userMessage || "Deskripsiin gambar ini."}` }] }
    ],
    max_tokens: 1024,
  });
  const reply = res.choices[0].message.content;
  addToHistory(key, "user", `[${displayName}]: [kirim gambar] ${userMessage}`);
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

function userHasPerm(message, perm) { return message.member?.permissions.has(perm); }
function botHasPerm(message, perm) { return message.guild?.members.me.permissions.has(perm); }
function getWarnings(userId, guildId) { const k = `${guildId}-${userId}`; if (!warnData.has(k)) warnData.set(k, []); return warnData.get(k); }
function addWarning(userId, guildId, reason) { const w = getWarnings(userId, guildId); w.push({ reason, time: new Date().toISOString() }); return w.length; }
function clearWarnings(userId, guildId) { warnData.delete(`${guildId}-${userId}`); }

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
    if (!userHasPerm(message, PermissionsBitField.Flags.KickMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-kick."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.kick(reason); await logMod("Kick", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-kick.`), true;
  }
  if (cmd === "ban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-ban."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.ban({ reason }); await logMod("Ban", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-ban.`), true;
  }
  if (cmd === "unban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const userId = args[1]; if (!userId) return message.reply("❌ Masukin user ID."), true;
    await message.guild.members.unban(userId); await logMod("Unban", message.author, userId, "-");
    return message.reply(`✅ User **${userId}** udah di-unban.`), true;
  }
  if (cmd === "timeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-timeout."), true;
    const menit = parseInt(args[2]) || 10; const reason = args.slice(3).join(" ") || "Tidak ada alasan";
    await mention.timeout(menit * 60 * 1000, reason); await logMod("Timeout", message.author, mention.user, `${menit} menit`);
    return message.reply(`✅ **${mention.user.tag}** di-timeout ${menit} menit.`), true;
  }
  if (cmd === "untimeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa."), true;
    await mention.timeout(null); await logMod("Untimeout", message.author, mention.user, "-");
    return message.reply(`✅ Timeout **${mention.user.tag}** dicabut.`), true;
  }
  if (cmd === "warn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    const totalWarns = addWarning(mention.id, message.guild.id, reason);
    await logMod(`Warn (${totalWarns}x)`, message.author, mention.user, reason);
    if (totalWarns >= 5) { await mention.ban({ reason: "Auto-ban: 5 warnings" }); return message.reply(`⛔ **${mention.user.tag}** auto-ban karena 5 warnings!`), true; }
    if (totalWarns >= 3) { await mention.timeout(10 * 60 * 1000, "Auto-timeout: 3 warnings"); return message.reply(`⚠️ **${mention.user.tag}** warn ke-${totalWarns}, di-timeout 10 menit!`), true; }
    return message.reply(`⚠️ **${mention.user.tag}** warning ke-${totalWarns}. Alasan: ${reason}`), true;
  }
  if (cmd === "warnings") {
    if (!mention) return message.reply("❌ Mention siapa."), true;
    const warns = getWarnings(mention.id, message.guild.id);
    if (warns.length === 0) return message.reply(`✅ **${mention.user.tag}** belum punya warning.`), true;
    return message.reply(`⚠️ **${mention.user.tag}** punya **${warns.length} warning:**\n${warns.map((w, i) => `${i+1}. ${w.reason}`).join("\n")}`), true;
  }
  if (cmd === "clearwarn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa."), true;
    clearWarnings(mention.id, message.guild.id);
    return message.reply(`✅ Warning **${mention.user.tag}** dihapus.`), true;
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
