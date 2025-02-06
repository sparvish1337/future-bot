const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField } = require('discord.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

app.use(express.static(path.join(__dirname, 'public')));

const APPROVAL_CHANNEL_ID = '1335708929560150078';
const CONFIRMATION_CHANNEL_ID = '1334160136796770307';
const FREE_AGENT_ROLE_ID = '1335707059638767736';
const TRANSFER_LOG_CHANNEL_ID = '1334160298323611730';
const ALLOWED_TEAM_ROLE_IDS = ['1335707053607616646', '1335707058921803937'];

app.get('/api/players.json', async (req, res) => {
  try {
    const data = await fs.readFile('./players.json', 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    console.error('Error reading players file:', err);
    res.status(500).json({ error: 'Failed to read players data.' });
  }
});

app.get('/api/teams.json', async (req, res) => {
  try {
    const data = await fs.readFile('./teams.json', 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    console.error('Error reading teams file:', err);
    res.status(500).json({ error: 'Failed to read teams data.' });
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: [
        new SlashCommandBuilder()
          .setName('confirm')
          .setDescription('Request to join a role for a number of seasons.')
          .addRoleOption(option => option.setName('role').setDescription('The role you want to join').setRequired(true))
          .addIntegerOption(option => option.setName('seasons').setDescription('Number of seasons (1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
          .toJSON(),
        new SlashCommandBuilder()
          .setName('register')
          .setDescription('Register yourself in the system.')
          .addStringOption(option => option.setName('steamlink').setDescription('Link to your Steam account.').setRequired(true))
          .toJSON()
      ] }
    );
    console.log('Commands registered!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName, options, channel } = interaction;

  if (commandName === 'confirm') {
    if (channel.id !== CONFIRMATION_CHANNEL_ID) {
      return interaction.reply({ content: 'This command can only be used in the designated confirmation channel.', ephemeral: true });
    }

    const role = options.getRole('role');
    const seasons = options.getInteger('seasons');

    if (!interaction.member.roles.cache.has(FREE_AGENT_ROLE_ID)) {
      return interaction.reply({ content: 'You can only confirm if you are a Free Agent.', ephemeral: true });
    }

    if (!ALLOWED_TEAM_ROLE_IDS.includes(role.id)) {
      return interaction.reply({ content: 'You can only confirm to a designated team role.', ephemeral: true });
    }

    const approvalChannel = interaction.guild.channels.cache.get(APPROVAL_CHANNEL_ID);
    if (!approvalChannel) return;

    const approveButton = new ButtonBuilder().setCustomId('approve').setLabel('Approve').setStyle(ButtonStyle.Success);
    const denyButton = new ButtonBuilder().setCustomId('deny').setLabel('Deny').setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(approveButton, denyButton);

    const confirmationMessage = await interaction.reply({
      content: `${interaction.user} requests to join ${role} for ${seasons} season(s).`,
      fetchReply: true
    });

    const approvalMessage = await approvalChannel.send({
      content: `${interaction.user} has requested to join ${role} for ${seasons} season(s).`,
      components: [row]
    });

    const collector = approvalMessage.createMessageComponentCollector({
      filter: i => i.isButton() && i.member.permissions.has(PermissionsBitField.Flags.ManageRoles),
      time: 60000
    });

    collector.on('collect', async i => {
      if (i.customId === 'approve') {
        await interaction.member.roles.remove(FREE_AGENT_ROLE_ID);
        await interaction.member.roles.add(role.id);

        const transferLogChannel = interaction.guild.channels.cache.get(TRANSFER_LOG_CHANNEL_ID);
        if (transferLogChannel) {
          await transferLogChannel.send(`:bust_in_silhouette: Free Agent :arrow_right: <@&${role.id}>
> <@${interaction.user.id}>
> for ${seasons} season(s).
*(from <@${i.user.id}>)*`);
        }

        await i.update({ content: `${interaction.user} approved to join ${role} for ${seasons} season(s) by ${i.user}.`, components: [] });
        await confirmationMessage.edit({ content: `${interaction.user} has been approved to join ${role} for ${seasons} season(s).` });
      } else if (i.customId === 'deny') {
        await i.update({ content: `${interaction.user}'s request to join ${role} for ${seasons} season(s) denied by ${i.user}.`, components: [] });
        await confirmationMessage.edit({ content: `${interaction.user}'s request to join ${role} for ${seasons} season(s) has been denied.` });
      }

      collector.stop();
    });

    collector.on('end', collected => {
      if (collected.size === 0) {
        approvalMessage.edit({ content: 'The confirmation request has timed out.', components: [] });
        confirmationMessage.edit({ content: 'Your confirmation request has timed out.' });
      }
    });
  }

  if (commandName === 'register') {
    const discordId = interaction.user.id;
    const steamLink = options.getString('steamlink');
    registerPlayer(discordId, interaction, steamLink);
  }
});

async function registerPlayer(userId, interaction, steamLink) {
  const filePath = path.join(__dirname, 'players.json');

  let players;
  try {
    const data = await fs.readFile(filePath, 'utf8');
    players = JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error reading players.json:', err);
      return interaction.reply({ content: 'Failed to register you. Please try again later.', ephemeral: true });
    }
    players = [];
  }

  const existingPlayerIndex = players.findIndex(player => player.id.toString() === userId.toString());
  if (existingPlayerIndex !== -1) {
    return interaction.reply({ content: 'You are already registered!', ephemeral: true });
  }

  const newPlayer = {
    id: parseInt(userId),
    name: interaction.user.username,
    position: 'N/A',
    rating: 70,
    team: 'N/A',
    averageScorePosition: 0,
    estimatedWorthEbits: 100000,
    negativeTraits: {},
    positiveTraits: {},
    allTimeStats: {},
    steamAccountLink: steamLink
  };

  players.push(newPlayer);

  try {
    await fs.writeFile(filePath, JSON.stringify(players, null, 2), 'utf8');
    interaction.reply({ content: 'You have been registered successfully!', ephemeral: true });
  } catch (err) {
    console.error('Error writing to players.json:', err);
    return interaction.reply({ content: 'Failed to register you. Please try again later.', ephemeral: true });
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
