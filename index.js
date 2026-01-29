require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder,
    PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle 
} = require('discord.js');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ]
});

let db;
let activeSplits = new Map();

const http = require('http');

// Crear un servidor web básico para que Render no apague el bot
http.createServer((req, res) => {
    res.write('Bot de Albion Online esta funcionando!');
    res.end();
}).listen(process.env.PORT || 3000);

// 1. INICIALIZACIÓN DE BASE DE DATOS
(async () => {
   db = await open({ filename: './data/database.sqlite', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            discord_id TEXT PRIMARY KEY, 
            nombre_ingame TEXT, 
            balance INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY, 
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            user_id TEXT, 
            amount INTEGER, 
            reason TEXT, 
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log("✅ Base de Datos vinculada y lista.");
})();

// 2. DEFINICIÓN DE COMANDOS
const commands = [
    new SlashCommandBuilder()
        .setName('registro')
        .setDescription('Regístrate con tu nombre de Albion Online')
        .addStringOption(opt => opt.setName('nombre').setDescription('Tu nombre exacto in-game').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('split')
        .setDescription('Inicia un reparto de botín con evidencia fotográfica')
        .addNumberOption(opt => opt.setName('monto').setDescription('Total a repartir').setRequired(true))
        .addAttachmentOption(opt => opt.setName('foto').setDescription('Captura de pantalla de los jugadores').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('pagar')
        .setDescription('Descuenta saldo a un jugador cuando le entregas las monedas físicamente')
        .addUserOption(opt => opt.setName('usuario').setDescription('El usuario al que le pagaste').setRequired(true))
        .addNumberOption(opt => opt.setName('monto').setDescription('Cantidad de monedas entregadas').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('perfil')
        .setDescription('Mira tu saldo acumulado y nombre registrado'),
        new SlashCommandBuilder()
        .setName('exportar')
        .setDescription('Exporta la lista de balances a un archivo Excel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('importar')
        .setDescription('Importa un Excel para actualizar balances masivamente')
        .addAttachmentOption(opt => opt.setName('archivo').setDescription('El archivo Excel modificado').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('config-logs')
        .setDescription('Configura el canal para el historial de transacciones')
        .addChannelOption(opt => opt.setName('canal').setDescription('Canal de texto para los logs').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(c => c.toJSON());

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ Bot Albion Contable online como ${client.user.tag}`);
});

// 3. MANEJO DE INTERACCIONES
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // COMANDO: REGISTRO
        if (commandName === 'registro') {
            const nombre = interaction.options.getString('nombre');
            await db.run('INSERT INTO users (discord_id, nombre_ingame, balance) VALUES (?, ?, 0) ON CONFLICT(discord_id) DO UPDATE SET nombre_ingame = ?', [interaction.user.id, nombre, nombre]);
            return interaction.reply({ content: `✅ Registrado exitosamente como **${nombre}**.`, ephemeral: true });
        }

        // COMANDO: CONFIG LOGS
        if (commandName === 'config-logs') {
            const canal = interaction.options.getChannel('canal');
            await db.run('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', ['log_channel', canal.id, canal.id]);
            return interaction.reply(`✅ Canal de logs establecido en ${canal}.`);
        }

        // COMANDO: PERFIL
        if (commandName === 'perfil') {
            const user = await db.get('SELECT * FROM users WHERE discord_id = ?', interaction.user.id);
            if (!user) return interaction.reply({ content: "❌ No estás registrado. Usa `/registro`.", ephemeral: true });
            
            const embed = new EmbedBuilder()
                .setTitle(`Banco de ${interaction.user.username}`)
                .setColor(0x00FF00)
                .addFields(
                    { name: "Personaje Albion", value: user.nombre_ingame, inline: true },
                    { name: "Balance Actual", value: `💰 ${user.balance.toLocaleString()}`, inline: true }
                );
            return interaction.reply({ embeds: [embed] });
        }

        // COMANDO: PAGAR (CAJERO)
        if (commandName === 'pagar') {
            const target = interaction.options.getUser('usuario');
            const monto = interaction.options.getNumber('monto');

            const userDB = await db.get('SELECT * FROM users WHERE discord_id = ?', target.id);
            if (!userDB) return interaction.reply({ content: "❌ Este usuario no está registrado.", ephemeral: true });
            if (userDB.balance < monto) return interaction.reply({ content: `❌ Saldo insuficiente. El usuario tiene **${userDB.balance.toLocaleString()}**.`, ephemeral: true });

            const balViejo = userDB.balance;
            const balNuevo = balViejo - monto;

            await db.run('UPDATE users SET balance = ? WHERE discord_id = ?', [balNuevo, target.id]);
            await db.run('INSERT INTO history (user_id, amount, reason) VALUES (?, ?, ?)', [target.id, -monto, 'Retiro en mano']);

            const logId = await db.get('SELECT value FROM config WHERE key = ?', 'log_channel');
            const logChannel = logId ? await client.channels.fetch(logId.value).catch(() => null) : null;

            if (logChannel) {
                const logPay = new EmbedBuilder()
                    .setTitle("💸 Retiro de Saldo Registrado")
                    .setDescription(`Se ha descontado saldo tras entrega física de monedas.`)
                    .addFields(
                        { name: "Jugador", value: userDB.nombre_ingame, inline: true },
                        { name: "Admin", value: `<@${interaction.user.id}>`, inline: true },
                        { name: "Transacción", value: `\`${balViejo.toLocaleString()}\` - \`${monto.toLocaleString()}\` = **${balNuevo.toLocaleString()}**` }
                    )
                    .setColor(0xe74c3c).setTimestamp();
                await logChannel.send({ embeds: [logPay] });
            }
            return interaction.reply(`✅ Pago registrado. Nuevo saldo de **${userDB.nombre_ingame}**: **${balNuevo.toLocaleString()}**.`);
        }

        // COMANDO: SPLIT
        if (commandName === 'split') {
            const monto = interaction.options.getNumber('monto');
            const foto = interaction.options.getAttachment('foto');

            const embed = new EmbedBuilder()
                .setTitle("💰 Nuevo Reparto Iniciado")
                .setDescription(`**Monto Total:** ${monto.toLocaleString()}\n\n*Inscríbanse o esperen a ser agregados por el líder.*`)
                .setImage(foto.url).setColor(0xFFA500)
                .addFields({ name: "Participantes (0)", value: "Lista vacía" });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('join_split').setLabel('Unirme').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('finish_modal').setLabel('Finalizar').setStyle(ButtonStyle.Success)
            );

            const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
            activeSplits.set(msg.id, { ownerId: interaction.user.id, monto, ids: [], fotoUrl: foto.url });
        }
        // LOGICA EXPORTAR
        if (commandName === 'exportar') {
            const rows = await db.all('SELECT discord_id, nombre_ingame, balance FROM users');
            const worksheet = XLSX.utils.json_to_sheet(rows);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Balances");

            const filePath = path.join(__dirname, 'balances_export.xlsx');
            XLSX.writeFile(workbook, filePath);

            await interaction.reply({ content: "📊 Aquí tienes el reporte actual:", files: [filePath] });
            fs.unlinkSync(filePath); // Borra el archivo temporal
        }

        // LOGICA IMPORTAR
        if (commandName === 'importar') {
            const archivo = interaction.options.getAttachment('archivo');
            if (!archivo.name.endsWith('.xlsx')) return interaction.reply("❌ Por favor sube un archivo .xlsx válido.");

            await interaction.deferReply({ ephemeral: true });

            const response = await fetch(archivo.url);
            const buffer = await response.arrayBuffer();
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

            let actualizados = 0;
            for (const row of data) {
                if (row.discord_id && row.balance !== undefined) {
                    await db.run(
                        'INSERT INTO users (discord_id, nombre_ingame, balance) VALUES (?, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET balance = ?, nombre_ingame = ?',
                        [row.discord_id.toString(), row.nombre_ingame, row.balance, row.balance, row.nombre_ingame]
                    );
                    actualizados++;
                }
            }

            return interaction.editReply(`✅ Se han actualizado/creado **${actualizados}** registros desde el Excel.`);
        }
    }

    // BOTONES
    if (interaction.isButton()) {
        const session = activeSplits.get(interaction.message.id);
        if (!session) return interaction.reply({ content: "Sesión caducada.", ephemeral: true });

        if (interaction.customId === 'join_split') {
            const userDB = await db.get('SELECT nombre_ingame FROM users WHERE discord_id = ?', interaction.user.id);
            if (!userDB) return interaction.reply({ content: "❌ Regístrate con `/registro` primero.", ephemeral: true });
            if (session.ids.includes(interaction.user.id)) return interaction.reply({ content: "Ya estás anotado.", ephemeral: true });

            session.ids.push(interaction.user.id);
            await actualizarLista(interaction.message, session);
            await interaction.reply({ content: "Anotado.", ephemeral: true });
        }

        if (interaction.customId === 'finish_modal') {
            if (interaction.user.id !== session.ownerId) return interaction.reply({ content: "Solo el dueño puede cerrar.", ephemeral: true });
            if (session.ids.length === 0) return interaction.reply({ content: "Lista vacía.", ephemeral: true });

            const modal = new ModalBuilder().setCustomId('modal_finalizar').setTitle('Cierre de Reparto');
            const input = new TextInputBuilder().setCustomId('concepto').setLabel("Concepto (Ej: Dungeon T8)").setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }
    }

    // MODAL FINALIZAR
    if (interaction.isModalSubmit() && interaction.customId === 'modal_finalizar') {
        const session = activeSplits.get(interaction.message.id);
        const concepto = interaction.fields.getTextInputValue('concepto');
        const pagoIndividual = Math.floor(session.monto / session.ids.length);
        
        const logId = await db.get('SELECT value FROM config WHERE key = ?', 'log_channel');
        const logChannel = logId ? await client.channels.fetch(logId.value).catch(() => null) : null;

        if (logChannel) {
            const resumen = new EmbedBuilder()
                .setTitle("📊 Resumen de Split")
                .addFields(
                    { name: "Concepto", value: concepto, inline: false },
                    { name: "Total", value: session.monto.toLocaleString(), inline: true },
                    { name: "C/U", value: pagoIndividual.toLocaleString(), inline: true },
                    { name: "N°", value: session.ids.length.toString(), inline: true }
                ).setImage(session.fotoUrl).setColor(0x3498db).setTimestamp();
            await logChannel.send({ embeds: [resumen] });

            for (const rid of session.ids) {
                const userData = await db.get('SELECT nombre_ingame, balance FROM users WHERE discord_id = ?', rid);
                const balViejo = userData.balance;
                const balNuevo = balViejo + pagoIndividual;
                await db.run('UPDATE users SET balance = ? WHERE discord_id = ?', [balNuevo, rid]);
                await db.run('INSERT INTO history (user_id, amount, reason) VALUES (?, ?, ?)', [rid, pagoIndividual, concepto]);

                const indEmbed = new EmbedBuilder()
                    .setAuthor({ name: `Abono: ${userData.nombre_ingame}` })
                    .setColor(0x2ecc71)
                    .addFields({ name: "Cálculo", value: `\`${balViejo.toLocaleString()}\` + \`${pagoIndividual.toLocaleString()}\` = **${balNuevo.toLocaleString()}**` });
                await logChannel.send({ embeds: [indEmbed] });
            }
        }
        await interaction.update({ content: `✅ Finalizado: ${concepto}`, embeds: [], components: [] });
        activeSplits.delete(interaction.message.id);
    }
});

// GESTIÓN MANUAL !add / !remove
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const sessionEntry = [...activeSplits.entries()].find(([_, data]) => data.ownerId === message.author.id);
    if (!sessionEntry) return;
    const [msgId, session] = sessionEntry;
    const msgPrincipal = await message.channel.messages.fetch(msgId);

    if (message.content.startsWith('!add ')) {
        const nombre = message.content.slice(5).trim();
        const userDB = await db.get('SELECT discord_id FROM users WHERE nombre_ingame = ? COLLATE NOCASE', nombre);
        if (userDB && !session.ids.includes(userDB.discord_id)) {
            session.ids.push(userDB.discord_id);
            await actualizarLista(msgPrincipal, session);
        }
        message.delete().catch(() => {});
    }

    if (message.content.startsWith('!remove ')) {
        const nombre = message.content.slice(8).trim();
        const userDB = await db.get('SELECT discord_id FROM users WHERE nombre_ingame = ? COLLATE NOCASE', nombre);
        if (userDB) {
            session.ids = session.ids.filter(id => id !== userDB.discord_id);
            await actualizarLista(msgPrincipal, session);
        }
        message.delete().catch(() => {});
    }
});

async function actualizarLista(message, session) {
    const userList = await Promise.all(session.ids.map(async id => {
        const data = await db.get('SELECT nombre_ingame FROM users WHERE discord_id = ?', id);
        return `- ${data.nombre_ingame}`;
    }));
    const embed = EmbedBuilder.from(message.embeds[0]);
    embed.setFields({ name: `Participantes (${session.ids.length})`, value: userList.join("\n") || "Vacío" });
    await message.edit({ embeds: [embed] });
}

client.login(process.env.TOKEN);