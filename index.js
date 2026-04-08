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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_FILE = path.join(__dirname, 'messages_store.json');

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

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN = 'verify_token_default',
  INSTAGRAM_ACCESS_TOKEN,
  INSTAGRAM_PAGE_ID,
  PORT = 3000,
} = process.env;

const GRAPH = 'https://graph.facebook.com/v19.0';
const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Meta MCP Server', version: '1.0.0' });
});

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const msgs = change.value?.messages;
        if (!msgs) return;
        msgs.forEach(msg => {
          messageStore.whatsapp.unshift({ id: msg.id, from: msg.from, timestamp: msg.timestamp, type: msg.type, text: msg.text?.body ?? '', image: msg.image?.id ?? null, audio: msg.audio?.id ?? null, receivedAt: new Date().toISOString() });
        });
        messageStore.whatsapp = messageStore.whatsapp.slice(0, 200);
        saveMessages(messageStore);
      });
    });
  }
  res.sendStatus(200);
});

app.get('/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook/instagram', (req, res) => {
  const body = req.body;
  if (body.object === 'instagram') {
    body.entry?.forEach(entry => {
      entry.messaging?.forEach(event => {
        if (!event.message) return;
        messageStore.instagram.unshift({ id: event.message.mid, senderId: event.sender.id, recipientId: event.recipient.id, timestamp: event.timestamp, text: event.message.text ?? '', receivedAt: new Date().toISOString() });
      });
    });
    messageStore.instagram = messageStore.instagram.slice(0, 200);
    saveMessages(messageStore);
  }
  res.sendStatus(200);
});

function createMcpServer() {
  const server = new McpServer({ name: 'meta-messaging', version: '1.0.0' });

  server.tool('whatsapp_send_message', 'Envoie un message texte WhatsApp Ã  un numÃ©ro de tÃ©lÃ©phone.', { to: z.string().describe('NumÃ©ro destinataire avec indicatif pays, ex +33612345678'), message: z.string().describe('Contenu du message') }, async ({ to, message }) => {
    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return { content: [{ type: 'text', text: 'Credentials WhatsApp manquants.' }] };
    try {
      const r = await axios.post(`${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type: 'text', text: { body: message } }, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
      return { content: [{ type: 'text', text: `Message envoye a ${to}. ID: ${r.data.messages?.[0]?.id}` }] };
    } catch (e) { return { content: [{ type: 'text', text: `Erreur: ${e.response?.data?.error?.message ?? e.message}` }] }; }
  });

  server.tool('whatsapp_get_recent_messages', 'Recup messages WhatsApp recus via webhook.', { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => {
    const messages = messageStore.whatsapp.slice(0, limit);
    if (!messages.length) return { content: [{ type: 'text', text: 'Aucun message WhatsApp. Configure le webhook Meta.' }] };
    return { content: [{ type: 'text', text: messages.map((m, i) => `[${i + 1}] ${m.receivedAt} | De: +${m.from} | ${m.text}`).join('\n---\n') }] };
  });

  server.tool('whatsapp_mark_as_read', 'Marque un message WA comme lu.', { message_id: z.string() }, async ({ message_id }) => {
    try {
      await axios.post(`${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id }, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } });
      return { content: [{ type: 'text', text: `Message ${message_id} marque comme lu.` }] };
    } catch (e) { return { content: [{ type: 'text', text: `Erreur: ${e.response?.data?.error?.message ?? e.message}` }] }; }
  });

  server.tool('instagram_get_conversations', 'Liste conversations DM Instagram.', { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => {
    if (!INSTAGRAM_ACCESS_TOKEN || !IMSTARRAM_PAGE_ID) return { content: [{ type: 'text', text: 'Credentials Instagram manquants.' }] };
    try {
      const r = await axios.get(`${GRAPH}/${INSTAGRAM_PAGE_ID}/conversations`, { params: { platform: 'instagram', limit, fields: 'id,participants,updated_time,message_count', access_token: INSTAGRAM_ACCESS_TOKEN } });
      const convs = r.data.data;
      if (!convs?.length) return { content: [{ type: 'text', text: 'Aucune conversation Instagram trouvee.' }] };
      return { content: [{ type: 'text', text: convs.map((c, i) => `[${i + 1}] ID : ${c.id} | ${c.participants?.data?.map(p => p.name || p.id).join(', ')} | ${c.updated_time}`).join('\n---\n') }] };
    } catch (e) { return { content: [{ type: 'text', text: `Erreur: ${e.response?.data?.error?.message ?? e.message}` }] }; }
  });

  server.tool('instagram_get_messages', 'Recup messages dune conversation Instagram.', { conversation_id: z.string(), limit: z.number().int().min(1).max(50).default(10) }, async ({ conversation_id, limit }) => {
    try {
      const r = await axios.get(`${GRAPH}/${conversation_id}/messages`, { params: { limit, fields: 'id,message,from,created_time', access_token: INSTAGRAM_ACCESS_TOKEN } });
      const msgs = r.data.data;
      if (!msgs?.length) return { content: [{ type: 'text', text: 'Aucun message.' }] };
      return { content: [{ type: 'text', text: msgs.map((m, i) => `[${i + 1}] ${m.created_time} | ${m.from?.name || m.from?.id}: ${m.message}`).join('\n---\n') }] };
    } catch (e) { return { content: [{ type: 'text', text: `Erreur: ${e.response?.data?.error?.message ?? e.message}` }] }; }
  });

  server.tool('instagram_send_message', 'Envoie un DM Instagram.', { recipient_id: z.string(), message: z.string() }, async ({ recipient_id, message }) => {
    if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_PAGE_ID) return { content: [{ type: 'text', text: 'Credentials Instagram manquants.' }] };
    try {
      const r = await axios.post(`${GRAPH}/${INSTAGRAM_PAGE_ID}/messages`, { recipient: { id: recipient_id }, message: { text: message } }, { params: { access_token: INSTAGRAM_ACCESS_TOKEN }, headers: { 'Content-Type': 'application/json' } });
      return { content: [{ type: 'text', text: `Message Instagram envoye a ${recipient_id}. ID: ${r.data.message_id ?? r.data.id}` }] };
    } catch (e) { return { content: [{ type: 'text', text: `Erreur: ${e.response?.data?.error?.message ?? e.message}` }] }; }
  });

  server.tool('instagram_get_recent_webhook_messages', 'Recup messages Instagram recus via webhook.', { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => {
    const messages = messageStore.instagram.slice(0, limit);
    if (!messages.length) return { content: [{ type: 'text', text: 'Aucun message Instagram recu via webhook.' }] };
    return { content: [{ type: 'text', text: messages.map((m, i) => `[${i + 1}] ${m.receivedAt} | De: ${m.senderId} | ${m.text}`).join('\n---\n') }] };
  });

  return server;
}

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on('close', () => { transport.close().catch(()=>{}); server.close().catch(()=>{}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Meta MCP Server sur le port ${PORT}`);
  if (!WHATSAPP_ACCESS_TOKEN) console.warn('WHATSAPP_ACCESS_TOKEN manquant');
  if (!INSTAGRAM_ACCESS_TOKEN) console.warn('INSTAGRAM_ACCESS_TOKEN manquant');
});
