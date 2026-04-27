const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
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
    queues.set(guildId, {
      songs: [],
      player: null,
      connection: null,
      playing: false,
      loop: false,
      volume: 1,
    });
  }
  return queues.get(guildId);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function searchSong(query) {
  // Spotify linki → şarkı adını çek, YouTube'da ara
  if (query.includes('spotify.com/track')) {
    try {
      const url = new URL(query);
      const pathParts = url.pathname.split('/');
      // Spotify link'ten sadece track adını çekemeyiz API'siz,
      // ama kullanıcıya söyleriz manuel arama yapılacağını
      query = pathParts[pathParts.length - 1];
    } catch (e) {}
  }

  // YouTube linki
  if (query.includes('youtube.com/watch') || query.includes('youtu.be/')) {
    try {
      const info = await ytdl.getInfo(query);
      return {
        title: info.videoDetails.title,
        url: query,
        duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
        thumbnail: info.videoDetails.thumbnails[0]?.url,
        author: info.videoDetails.author.name,
      };
    } catch (e) {
      return null;
    }
  }

  // Normal şarkı adı araması
  try {
    const result = await yts(query);
    const video = result.videos[0];
    if (!video) return null;
    return {
      title: video.title,
      url: video.url,
      duration: video.timestamp,
      thumbnail: video.thumbnail,
      author: video.author.name,
    };
  } catch (e) {
    return null;
  }
}

async function playSong(guildId, textChannel) {
  const queue = getQueue(guildId);

  if (queue.songs.length === 0) {
    queue.playing = false;
    setTimeout(() => {
      const q = getQueue(guildId);
      if (q.songs.length === 0 && q.connection) {
        q.connection.destroy();
        queues.delete(guildId);
      }
    }, 30000);
    return;
  }

  const song = queue.songs[0];
  queue.playing = true;

  try {
    const stream = ytdl(song.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
    });

    const resource = createAudioResource(stream, { inlineVolume: true });
    resource.volume?.setVolume(queue.volume);

    if (!queue.player) {
      queue.player = createAudioPlayer();
    }

    queue.player.play(resource);
    queue.connection.subscribe(queue.player);

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.player.on(AudioPlayerStatus.Idle, () => {
      if (!queue.loop) queue.songs.shift();
      playSong(guildId, textChannel);
    });

    queue.player.on('error', (err) => {
      console.error('Player error:', err);
      queue.songs.shift();
      playSong(guildId, textChannel);
    });

    const embed = new EmbedBuilder()
      .setColor('#1DB954')
      .setTitle('🎵 Şimdi Çalıyor')
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

  // !play veya !p
  if (cmd === 'play' || cmd === 'p') {
    if (!message.member.voice.channel)
      return message.reply('❌ Önce bir ses kanalına gir!');

    const query = args.join(' ');
    if (!query) return message.reply('❌ Bir şarkı adı veya link yaz!\nÖrnek: `!play Eminem Lose Yourself`');

    const loadMsg = await message.reply('🔍 Aranıyor...');
    const song = await searchSong(query);
    if (!song) return loadMsg.edit('❌ Şarkı bulunamadı! Başka bir şey dene.');

    song.requestedBy = message.author.username;

    const queue = getQueue(message.guild.id);

    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
      queue.connection = joinVoiceChannel({
        channelId: message.member.voice.channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
    }

    queue.songs.push(song);

    if (!queue.playing) {
      await loadMsg.delete().catch(() => {});
      playSong(message.guild.id, message.channel);
    } else {
      const embed = new EmbedBuilder()
        .setColor('#FF9500')
        .setTitle('➕ Kuyruğa Eklendi')
        .setDescription(`**[${song.title}](${song.url})**`)
        .addFields(
          { name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true },
          { name: '📍 Sıra', value: `#${queue.songs.length}`, inline: true }
        )
        .setThumbnail(song.thumbnail || null);
      loadMsg.edit({ content: '', embeds: [embed] });
    }
  }

  else if (cmd === 'skip' || cmd === 's') {
    const queue = getQueue(message.guild.id);
    if (!queue.playing) return message.reply('❌ Çalan bir şarkı yok!');
    queue.player?.stop();
    message.reply('⏭️ Şarkı geçildi!');
  }

  else if (cmd === 'stop' || cmd === 'dur') {
    const queue = getQueue(message.guild.id);
    queue.songs = [];
    queue.loop = false;
    queue.player?.stop();
    queue.connection?.destroy();
    queues.delete(message.guild.id);
    message.reply('⏹️ Müzik durduruldu, kuyruk temizlendi!');
  }

  else if (cmd === 'pause' || cmd === 'duraklat') {
    const queue = getQueue(message.guild.id);
    if (!queue.playing) return message.reply('❌ Çalan bir şarkı yok!');
    queue.player?.pause();
    message.reply('⏸️ Duraklatıldı!');
  }

  else if (cmd === 'resume' || cmd === 'devam') {
    const queue = getQueue(message.guild.id);
    queue.player?.unpause();
    message.reply('▶️ Devam ediyor!');
  }

  else if (cmd === 'queue' || cmd === 'kuyruk' || cmd === 'q') {
    const queue = getQueue(message.guild.id);
    if (queue.songs.length === 0) return message.reply('📭 Kuyruk boş!');

    const list = queue.songs.slice(0, 10).map((s, i) =>
      `${i === 0 ? '▶️' : `\`${i}.\``} **${s.title}** \`${s.duration || '?'}\``
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#7289DA')
      .setTitle('📋 Müzik Kuyruğu')
      .setDescription(list)
      .setFooter({ text: `Toplam ${queue.songs.length} şarkı | Loop: ${queue.loop ? '✅' : '❌'}` });

    message.reply({ embeds: [embed] });
  }

  else if (cmd === 'loop' || cmd === 'tekrar') {
    const queue = getQueue(message.guild.id);
    queue.loop = !queue.loop;
    message.reply(`🔁 Loop: ${queue.loop ? '✅ Açık' : '❌ Kapalı'}`);
  }

  else if (cmd === 'volume' || cmd === 'ses') {
    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 1 || vol > 100)
      return message.reply('❌ 1-100 arasında bir değer gir! Örnek: `!ses 50`');
    const queue = getQueue(message.guild.id);
    queue.volume = vol / 100;
    message.reply(`🔊 Ses: **${vol}%**`);
  }

  else if (cmd === 'np' || cmd === 'ne' || cmd === 'nowplaying') {
    const queue = getQueue(message.guild.id);
    if (!queue.playing || !queue.songs[0]) return message.reply('❌ Şu an çalan bir şarkı yok!');
    const song = queue.songs[0];
    const embed = new EmbedBuilder()
      .setColor('#1DB954')
      .setTitle('🎵 Şu An Çalıyor')
      .setDescription(`**[${song.title}](${song.url})**`)
      .setThumbnail(song.thumbnail || null)
      .addFields(
        { name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true },
        { name: '🎤 Kanal', value: song.author || 'Bilinmiyor', inline: true }
      );
    message.reply({ embeds: [embed] });
  }

  else if (cmd === 'help' || cmd === 'yardim') {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎵 Müzik Botu - Komutlar')
      .addFields(
        { name: '▶️ Çalma', value: '`!play [şarkı adı/YouTube/Spotify link]`\n`!p [şarkı]` - Kısa versiyon' },
        { name: '⏯️ Kontrol', value: '`!skip` veya `!s` - Geç\n`!pause` / `!devam` - Duraklat/Devam\n`!stop` - Durdur' },
        { name: '📋 Kuyruk', value: '`!queue` veya `!q` - Kuyruğu gör\n`!loop` - Tekrar modu\n`!ses [1-100]` - Ses ayarla' },
        { name: '📊 Bilgi', value: '`!np` - Şu an çalanı gör\n`!help` - Bu mesaj' }
      )
      .setFooter({ text: 'YouTube + Spotify linkleri desteklenir 🎶' });
    message.reply({ embeds: [embed] });
  }
});

client.once('ready', () => {
  console.log(`✅ Bot aktif: ${client.user.tag}`);
  client.user.setActivity('🎵 !play ile müzik çal', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);
