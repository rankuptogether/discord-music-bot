const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const yts = require('yt-search');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ]
});

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, { songs: [], player: null, connection: null, playing: false, loop: false, volume: 1 });
  }
  return queues.get(guildId);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function searchSong(query) {
  if (query.includes('spotify.com/track')) {
    try { query = new URL(query).pathname.split('/').pop(); } catch (e) {}
  }

  if (query.includes('youtube.com/watch') || query.includes('youtu.be/')) {
    return new Promise((resolve) => {
      const ytdlp = spawn('yt-dlp', ['--no-playlist', '--print', '%(title)s\n%(duration)s\n%(uploader)s\n%(thumbnail)s\n%(webpage_url)s', query]);
      let output = '';
      ytdlp.stdout.on('data', (d) => output += d.toString());
      ytdlp.on('close', () => {
        const lines = output.trim().split('\n');
        if (lines.length < 5) return resolve(null);
        resolve({ title: lines[0], duration: formatDuration(parseInt(lines[1]) || 0), author: lines[2], thumbnail: lines[3], url: lines[4] });
      });
      ytdlp.on('error', () => resolve(null));
    });
  }

  try {
    const result = await yts(query);
    const video = result.videos[0];
    if (!video) return null;
    return { title: video.title, url: video.url, duration: video.timestamp, thumbnail: video.thumbnail, author: video.author.name };
  } catch (e) { return null; }
}

function createStream(url) {
  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio', '--no-playlist', '-o', '-', '--quiet', url]);
  const ffmpeg = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-loglevel', 'quiet', 'pipe:1']);
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ytdlp.stderr.on('data', () => {});
  ffmpeg.stderr.on('data', () => {});
  return ffmpeg.stdout;
}

async function playSong(guildId, textChannel) {
  const queue = getQueue(guildId);
  if (queue.songs.length === 0) {
    queue.playing = false;
    setTimeout(() => { const q = getQueue(guildId); if (q.songs.length === 0 && q.connection) { q.connection.destroy(); queues.delete(guildId); } }, 30000);
    return;
  }

  const song = queue.songs[0];
  queue.playing = true;

  try {
    const stream = createStream(song.url);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(queue.volume);

    if (!queue.player) queue.player = createAudioPlayer();
    queue.player.play(resource);
    queue.connection.subscribe(queue.player);

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.player.on(AudioPlayerStatus.Idle, () => { if (!queue.loop) queue.songs.shift(); playSong(guildId, textChannel); });
    queue.player.on('error', (err) => { console.error('Player error:', err.message); queue.songs.shift(); playSong(guildId, textChannel); });

    const embed = new EmbedBuilder()
      .setColor('#1DB954').setTitle('🎵 Şimdi Çalıyor')
      .setDescription(`**[${song.title}](${song.url})**`)
      .addFields(
        { name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true },
        { name: '🎤 Kanal', value: song.author || 'Bilinmiyor', inline: true },
        { name: '📋 Kuyruk', value: `${queue.songs.length} şarkı`, inline: true }
      )
      .setThumbnail(song.thumbnail || null)
      .setFooter({ text: `İsteyen: ${song.requestedBy}` });
    textChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Çalma hatası:', err);
    queue.songs.shift();
    playSong(guildId, textChannel);
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith('!')) return;
  const args = message.content.slice(1).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (cmd === 'play' || cmd === 'p') {
    if (!message.member.voice.channel) return message.reply('❌ Önce bir ses kanalına gir!');
    const query = args.join(' ');
    if (!query) return message.reply('❌ Bir şarkı adı veya link yaz!');
    const loadMsg = await message.reply('🔍 Aranıyor...');
    const song = await searchSong(query);
    if (!song) return loadMsg.edit('❌ Şarkı bulunamadı!');
    song.requestedBy = message.author.username;
    const queue = getQueue(message.guild.id);
    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
      queue.connection = joinVoiceChannel({ channelId: message.member.voice.channel.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
    }
    queue.songs.push(song);
    if (!queue.playing) {
      await loadMsg.delete().catch(() => {});
      playSong(message.guild.id, message.channel);
    } else {
      const embed = new EmbedBuilder().setColor('#FF9500').setTitle('➕ Kuyruğa Eklendi')
        .setDescription(`**[${song.title}](${song.url})**`)
        .addFields({ name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true }, { name: '📍 Sıra', value: `#${queue.songs.length}`, inline: true })
        .setThumbnail(song.thumbnail || null);
      loadMsg.edit({ content: '', embeds: [embed] });
    }
  }
  else if (cmd === 'skip' || cmd === 's') { const q = getQueue(message.guild.id); if (!q.playing) return message.reply('❌ Çalan bir şarkı yok!'); q.player?.stop(); message.reply('⏭️ Şarkı geçildi!'); }
  else if (cmd === 'stop' || cmd === 'dur') { const q = getQueue(message.guild.id); q.songs = []; q.loop = false; q.player?.stop(); q.connection?.destroy(); queues.delete(message.guild.id); message.reply('⏹️ Durduruldu!'); }
  else if (cmd === 'pause' || cmd === 'duraklat') { const q = getQueue(message.guild.id); q.player?.pause(); message.reply('⏸️ Duraklatıldı!'); }
  else if (cmd === 'resume' || cmd === 'devam') { const q = getQueue(message.guild.id); q.player?.unpause(); message.reply('▶️ Devam ediyor!'); }
  else if (cmd === 'loop' || cmd === 'tekrar') { const q = getQueue(message.guild.id); q.loop = !q.loop; message.reply(`🔁 Loop: ${q.loop ? '✅ Açık' : '❌ Kapalı'}`); }
  else if (cmd === 'ses' || cmd === 'volume') { const vol = parseInt(args[0]); if (isNaN(vol) || vol < 1 || vol > 100) return message.reply('❌ 1-100 arası gir!'); const q = getQueue(message.guild.id); q.volume = vol / 100; message.reply(`🔊 Ses: **${vol}%**`); }
  else if (cmd === 'queue' || cmd === 'kuyruk' || cmd === 'q') {
    const q = getQueue(message.guild.id);
    if (q.songs.length === 0) return message.reply('📭 Kuyruk boş!');
    const list = q.songs.slice(0, 10).map((s, i) => `${i === 0 ? '▶️' : `\`${i}.\``} **${s.title}** \`${s.duration || '?'}\``).join('\n');
    message.reply({ embeds: [new EmbedBuilder().setColor('#7289DA').setTitle('📋 Müzik Kuyruğu').setDescription(list).setFooter({ text: `Toplam ${q.songs.length} şarkı | Loop: ${q.loop ? '✅' : '❌'}` })] });
  }
  else if (cmd === 'np' || cmd === 'ne') {
    const q = getQueue(message.guild.id);
    if (!q.playing || !q.songs[0]) return message.reply('❌ Çalan bir şarkı yok!');
    const s = q.songs[0];
    message.reply({ embeds: [new EmbedBuilder().setColor('#1DB954').setTitle('🎵 Şu An Çalıyor').setDescription(`**[${s.title}](${s.url})**`).setThumbnail(s.thumbnail || null).addFields({ name: '⏱️ Süre', value: s.duration || '?', inline: true }, { name: '🎤 Kanal', value: s.author || '?', inline: true })] });
  }
  else if (cmd === 'help' || cmd === 'yardim') {
    message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🎵 Komutlar').addFields(
      { name: '▶️ Çalma', value: '`!play [şarkı/link]` veya `!p`' },
      { name: '⏯️ Kontrol', value: '`!skip` `!dur` `!duraklat` `!devam`' },
      { name: '📋 Kuyruk', value: '`!kuyruk` `!loop` `!ses [1-100]`' },
      { name: '📊 Bilgi', value: '`!np` `!yardim`' }
    ).setFooter({ text: 'YouTube + Spotify desteklenir 🎶' })] });
  }
});

client.once('clientReady', () => {
  console.log(`✅ Bot aktif: ${client.user.tag}`);
  client.user.setActivity('🎵 !play ile müzik çal', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);
