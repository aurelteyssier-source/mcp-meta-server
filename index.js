/**
 * MCP Meta Server â WhatsApp Business API + Instagram Messaging API
 * Compatible avec Claude (Remote MCP Server via HTTP Streamable Transport)
 *
 * Endpoints:
 *   POST /mcp                    â Point de connexion MCP pour Claude
 *   GET  /webhook/whatsapp       â VÃ©rification webhook Meta
 *   POST /webhook/whatsapp       â RÃ©ception messages WhatsApp entrants
 *   GET  /webhook/instagram      â VÃ©rification webhook Instagram
 *   POST /webhook/instagram      â RÃ©ception messages Instagram entrants
 *   GET  /                       â Health check
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

// âââ Chemins ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_FILE = path.join(__dirname, 'messages_store.json');

// âââ Stockage des messages reÃ§us (webhook) ââââââââââââââââââââââââââââââââââ
function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    }
  } catch (_) {}
  return { whatsapp: [], instagram: [] };
}

function saveMessages(data) {
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Erreur sauvegarde messages:', e.message);
  }
}

let messageStore = loadMessages();

// âââ Config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN = 'verify_token_default',
  INSTAGRAM_ACCESS_TOKEN,
  INSTAGRAM_PAGE_ID,
  PORT = 3000,
} = process.env;

const GRAPH = 'https://graph.facebook.com/v19.0';

// âââ Express ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const app = express();
app.use(express.json());

// ââ Health check âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Meta MCP Server',
    version: '1.0.0',
    tools: [
      'whatsapp_send_message',
      'whatsapp_get_recent_messages',
      'whatsapp_mark_as_read',
      'instagram_get_conversations',
      'instagram_get_messages',
      'instagram_send_message',
      'instagram_get_recent_webhook_messages',
    ],
  });
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// WEBHOOKS META
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// ââ WhatsApp â vÃ©rification ââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('â Webhook WhatsApp vÃ©rifiÃ©');
    return res.status(200).send(challenge);
  }
  console.warn('â ï¸  Webhook WhatsApp : token incorrect');
  res.sendStatus(403);
});

// ââ WhatsApp â rÃ©ception messages âââââââââââââââââââââââââââââââââââââââ
app.post('/webhook/whatsapp', (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const msgs = change.value?.messages;
        if (!msgs) return;

        msgs.forEach(msg => {
          const stored = {
            id:         msg.id,
            from:       msg.from,
            timestamp:  msg.timestamp,
            type:       msg.type,
            text:       msg.text?.body ?? '',
            image:      msg.image?.id  ?? null,
            audio:      msg.audio?.id  ?? null,
            receivedAt: new Date().toISOString(),
          };
          messageStore.whatsapp.unshift(stored);
          console.log(`ð© WhatsApp reÃ§u de +${msg.from}: ${stored.text}`);
        });

        messageStore.whatsapp = messageStore.whatsapp.slice(0, 200);
        saveMessages(messageStore);
      });
    });
  }

  res.sendStatus(200);
});

// ââ Instagram â vÃ©rification ââââââââââââââââââââââââââââââââââââââââââââ
app.get('/webhook/instagram', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('â Webhook Instagram vÃ©rifiÃ©');
    return res.status(200).send(challenge);
  }
  console.warn('â ï¸  Webhook Instagram : token incorrect');
  res.sendStatus(403);
});

// ââ Instagram â rÃ©ception messages ââââââââââââââââââââââââââââââââââââââ
app.post('/webhook/instagram', (req, res) => {
  const body = req.body;

  if (body.object === 'instagram') {
    body.entry?.forEach(entry => {
      entry.messaging?.forEach(event => {
        if (!event.message) return;

        const stored = {
          id:         event.message.mid,
          senderId:   event.sender.id,
          recipientId:event.recipient.id,
          timestamp:  event.timestamp,
          text:       event.message.text ?? '',
          receivedAt: new Date().toISOString(),
        };
        messageStore.instagram.unshift(stored);
        console.log(`ð© Instagram reÃ§u de ${event.sender.id}: ${stored.text}`);
      });
    });

    messageStore.instagram = messageStore.instagram.slice(0, 200);
    saveMessages(messageStore);
  }

  res.sendStatus(200);
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// MCP SERVER â OUTILS
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function createMcpServer() {
  const server = new McpServer({
    name: 'meta-messaging',
    version: '1.0.0',
  });

  // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // WHATSAPP
  // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

  /**
   * Envoyer un message WhatsApp
   */
  server.tool(
    'whatsapp_send_message',
    'Envoie un message texte WhatsApp Ã  un numÃ©ro de tÃ©lÃ©phone.',
    {
      to: z
        .string()
        .describe('NumÃ©ro destinataire avec indicatif pays, ex : +33612345678'),
      message: z
        .string()
        .describe('Contenu du message texte Ã  envoyer'),
    },
    async ({ to, message }) => {
      if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        return { content: [{ type: 'text', text: 'â WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID manquant dans les variables d\'environnement.' }] };
      }

      try {
        const r = await axios.post(
          `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: to.replace(/\D/g, ''),   // garder uniquement les chiffres
            type: 'text',
            text: { body: message },
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const msgId = r.data.messages?.[0]?.id ?? 'inconnu';
        return {
          content: [{
            type: 'text',
            text: `â Message WhatsApp envoyÃ© Ã  ${to}.\nID: ${msgId}`,
          }],
        };
      } catch (e) {
        const err = e.response?.data?.error?.message ?? e.message;
        return { content: [{ type: 'text', text: `â Erreur WhatsApp: ${err}` }] };
      }
    }
  );

  /**
   * Lire les derniers messages WhatsApp reÃ§us
   */
  server.tool(
    'whatsapp_get_recent_messages',
    'RÃ©cupÃ¨re les derniers messages WhatsApp reÃ§us via webhook.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Nombre de messages Ã  retourner (max 50)'),
    },
    async ({ limit }) => {
      const messages = messageStore.whatsapp.slice(0, limit);

      if (messages.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Aucun message WhatsApp reÃ§u pour l\'instant.\n\n' +
                  'Assure-toi que :\n' +
                  '1. Le webhook est configurÃ© dans Meta Business Suite\n' +
                  '2. L\'URL de webhook pointe vers ton serveur Railway : https://ton-app.up.railway.app/webhook/whatsapp\n' +
                  '3. Les Ã©vÃ©nements "messages" sont bien souscrits',
          }],
        };
      }

      const lines = messages.map((m, i) =>
        `[${i + 1}] ${m.receivedAt}\n` +
        `De : +${m.from}\n` +
        `Type : ${m.type}\n` +
        `Message : ${m.text || '(media)'}` +
        (m.image ? `\nImage ID : ${m.image}` : '') +
        `\nID message : ${m.id}`
      );

      return {
        content: [{
          type: 'text',
          text: `ð© ${messages.length} message(s) WhatsApp :\n\n${lines.join('\n\nâââââââââââââââââââââ\n\n')}`,
        }],
      };
    }
  );

  /**
   * Marquer un message WhatsApp comme lu
   */
  server.tool(
    'whatsapp_mark_as_read',
    'Marque un message WhatsApp comme lu (affiche les deux coches bleues).',
    {
      message_id: z
        .string()
        .describe('ID du message WhatsApp Ã  marquer comme lu'),
    },
    async ({ message_id }) => {
      if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        return { content: [{ type: 'text', text: 'â Credentials WhatsApp manquants.' }] };
      }

      try {
        await axios.post(
          `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id,
          },
          { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
        );

        return { content: [{ type: 'text', text: `â Message ${message_id} marquÃ© comme lu.` }] };
      } catch (e) {
        const err = e.response?.data?.error?.message ?? e.message;
        return { content: [{ type: 'text', text: `â Erreur: ${err}` }] };
      }
    }
  );

  // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // INSTAGRAM
  // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

  /**
   * Lister les conversations Instagram
   */
  server.tool(
    'instagram_get_conversations',
    'Liste les conversations DM Instagram de ton compte Business/Creator.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Nombre de conversations Ã  retourner'),
    },
    async ({ limit }) => {
      if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_PAGE_ID) {
        return { content: [{ type: 'text', text: 'â INSTAGRAM_ACCESS_TOKEN ou INSTAGRAM_PAGE_ID manquant.' }] };
      }

      try {
        const r = await axios.get(`${GRAPH}/${INSTAGRAM_PAGE_ID}/conversations`, {
          params: {
            platform: 'instagram',
            limit,
            fields: 'id,participants,updated_time,message_count',
            access_token: INSTAGRAM_ACCESS_TOKEN,
          },
        });

        const convs = r.data.data;

        if (!convs?.length) {
          return { content: [{ type: 'text', text: 'Aucune conversation Instagram trouvÃ©e.' }] };
        }

        const lines = convs.map((c, i) => {
          const parts = c.participants?.data?.map(p => `${p.name ?? '?'} (${p.id})`).join(', ') ?? '?';
          return `[${i + 1}] ID conversation : ${c.id}\n` +
                 `Participants : ${parts}\n` +
                 `DerniÃ¨re activitÃ© : ${c.updated_time}\n` +
                 `Nb messages : ${c.message_count ?? '?'}`;
        });

        return {
          content: [{
            type: 'text',
            text: `ð¬ ${convs.length} conversation(s) Instagram :\n\n${lines.join('\n\nâââââââââââââââââââââ\n\n')}`,
          }],
        };
      } catch (e) {
        const err = e.response?.data?.error?.message ?? e.message;
        return { content: [{ type: 'text', text: `â Erreur Instagram: ${err}` }] };
      }
    }
  );

  /**
   * Lire les messages d'une conversation Instagram
   */
  server.tool(
    'instagram_get_messages',
    'RÃ©cupÃ¨re les messages d\'une conversation Instagram DM.',
    {
      conversation_id: z
        .string()
        .describe('ID de la conversation (obtenu via instagram_get_conversations)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Nombre de messages Ã  retourner'),
    },
    async ({ conversation_id, limit }) => {
      if (!INSTAGRAM_ACCESS_TOKEN) {
        return { content: [{ type: 'text', text: 'â INSTAGRAM_ACCESS_TOKEN manquant.' }] };
      }

      try {
        const r = await axios.get(`${GRAPH}/${conversation_id}/messages`, {
          params: {
            limit,
            fields: 'id,message,from,created_time,attachments',
            access_token: INSTAGRAM_ACCESS_TOKEN,
          },
        });

        const msgs = r.data.data;

        if (!msgs?.length) {
          return { content: [{ type: 'text', text: 'Aucun message dans cette conversation.' }] };
        }

        const lines = msgs.map((m, i) => {
          const sender = m.from?.name ?? m.from?.id ?? '?';
          const attachments = m.attachments?.data?.length
            ? ` [+ ${m.attachments.data.length} piÃ¨ce(s) jointe(s)]`
            : '';
          return `[${i + 1}] ${m.created_time}\n${sender} : ${m.message ?? '(media)'}${attachments}`;
        });

        return {
          content: [{
            type: 'text',
            text: `ð¨ ${msgs.length} message(s) :\n\n${lines.join('\n\nâââââââââââââââââââââ\n\n')}`,
          }],
        };
      } catch (e) {
        const err = e.response?.data?.error?.message ?? e.message;
        return { content: [{ type: 'text', text: `â Erreur Instagram: ${err}` }] };
      }
    }
  );

  /**
   * Envoyer un message Instagram DM
   */
  server.tool(
    'instagram_send_message',
    'Envoie un message DM Instagram Ã  un utilisateur.',
    {
      recipient_id: z
        .string()
        .describe('ID Instagram de l\'utilisateur destinataire'),
      message: z
        .string()
        .describe('Texte du message Ã  envoyer'),
    },
    async ({ recipient_id, message }) => {
      if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_PAGE_ID) {
        return { content: [{ type: 'text', text: 'â Credentials Instagram manquants.' }] };
      }

      try {
        const r = await axios.post(
          `${GRAPH}/${INSTAGRAM_PAGE_ID}/messages`,
          {
            recipient: { id: recipient_id },
            message:   { text: message },
          },
          {
            params:  { access_token: INSTAGRAM_ACCESS_TOKEN },
            headers: { 'Content-Type': 'application/json' },
          }
        );

        const msgId = r.data.message_id ?? r.data.id ?? 'inconnu';
        return {
          content: [{
            type: 'text',
            text: `â Message Instagram envoyÃ© Ã  ${recipient_id}.\nID: ${msgId}`,
          }],
        };
      } catch (e) {
        const err = e.response?.data?.error?.message ?? e.message;
        return { content: [{ type: 'text', text: `â Erreur Instagram: ${err}` }] };
      }
    }
  );

  /**
   * Lire les messages Instagram reÃ§us via webhook (temps rÃ©el)
   */
  server.tool(
    'instagram_get_recent_webhook_messages',
    'RÃ©cupÃ¨re les derniers messages Instagram reÃ§us en temps rÃ©el via webhook.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Nombre de messages Ã  retourner'),
    },
    async ({ limit }) => {
      const messages = messageStore.instagram.slice(0, limit);

      if (messages.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Aucun message Instagram reÃ§u via webhook pour l\'instant.\n\n' +
                  'Configure le webhook Instagram dans Meta Business Suite :\n' +
                  'â URL : https://ton-app.up.railway.app/webhook/instagram\n' +
                  'â ÃvÃ©nements : messages',
          }],
        };
      }

      const lines = messages.map((m, i) =>
        `[${i + 1}] ${m.receivedAt}\n` +
        `De : ${m.senderId}\n` +
        `Message : ${m.text || '(media)'}` +
        `\nID : ${m.id}`
      );

      return {
        content: [{
          type: 'text',
          text: `ð© ${messages.length} message(s) Instagram :\n\n${lines.join('\n\nâââââââââââââââââââââ\n\n')}`,
        }],
      };
    }
  );

  return server;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ENDPOINT MCP (Streamable HTTP â compatible Claude Remote MCP)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // mode stateless : une session par requÃªte
  });

  const server = createMcpServer();

  // Nettoyage Ã  la fermeture de la connexion
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// DÃMARRAGE
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.listen(PORT, () => {
  console.log(`\nð Meta MCP Server dÃ©marrÃ© sur le port ${PORT}`);
  console.log(`\nð Endpoints :`);
  console.log(`   MCP Claude     : POST http://localhost:${PORT}/mcp`);
  console.log(`   Webhook WA     : GET/POST http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`   Webhook IG     : GET/POST http://localhost:${PORT}/webhook/instagram`);
  console.log(`   Health check   : GET http://localhost:${PORT}/`);

  // Avertissements si variables manquantes
  if (!WHATSAPP_ACCESS_TOKEN)    console.warn('\nâ ï¸  WHATSAPP_ACCESS_TOKEN non dÃ©fini');
  if (!WHATSAPP_PHONE_NUMBER_ID) console.warn('â ï¸  WHATSAPP_PHONE_NUMBER_ID non dÃ©fini');
  if (!INSTAGRAM_ACCESS_TOKEN)   console.warn('â ï¸  INSTAGRAM_ACCESS_TOKEN non dÃ©fini');
  if (!INSTAGRAM_PAGE_ID)        console.warn('â ï¸  INSTAGRAM_PAGE_ID non dÃ©fini');
});
