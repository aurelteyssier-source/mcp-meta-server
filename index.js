/**
 * MCP Meta Server - WhatsApp Business API + Instagram Messaging API
 * v1.1.0 - fix: axios timeout 15s global
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

// FIX: timeout global pour eviter les blocages indefinis sur graph.facebook.com
axios.defaults.timeout = 15000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_FILE = path.join(__dirname, 'messages_store.json');

function loadMessages() {
  try { if (fs.existsSync(MESSAGES_FILE)) return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); } catch (_) {}
  return { whatsapp: [], instagram: [] };
}
function saveMessages(data) {
  try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e.message); }
}
let messageStore = loadMessages();

const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN = 'verify_token_default', INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_PAGE_ID, PORT = 3000 } = process.env;
const GRAPH = 'https://graph.facebook.com/v19.0';
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'Meta MCP Server', version: '1.1.0', wa_phone_id: WHATSAPP_PHONE_NUMBER_ID, ig_page_id: INSTAGRAM_PAGE_ID }));

app.get('/debug', async (_req, res) => {
  try { const r = await axios.get(GRAPH+'/me', { params: { access_token: WHATSAPP_ACCESS_TOKEN, fields: 'id,name' } }); res.json({ ok: true, data: r.data }); }
  catch (e) { res.json({ ok: false, error: e.response?.data?.error?.message ?? e.message }); }
});

app.get('/webhook/whatsapp', (req, res) => {
  if (req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===WHATSAPP_VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook/whatsapp', (req, res) => {
  if (req.body.object==='whatsapp_business_account') {
    req.body.entry?.forEach(e => e.changes?.forEach(c => {
      c.value?.messages?.forEach(m => { messageStore.whatsapp.unshift({ id:m.id, from:m.from, timestamp:m.timestamp, type:m.type, text:m.text?.body??'', receivedAt:new Date().toISOString() }); });
      messageStore.whatsapp = messageStore.whatsapp.slice(0,200); saveMessages(messageStore);
    }));
  }
  res.sendStatus(200);
});
app.get('/webhook/instagram', (req, res) => {
  if (req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===WHATSAPP_VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook/instagram', (req, res) => {
  if (req.body.object==='instagram') {
    req.body.entry?.forEach(e => e.messaging?.forEach(ev => { if (ev.message) messageStore.instagram.unshift({ id:ev.message.mid, senderId:ev.sender.id, recipientId:ev.recipient.id, timestamp:ev.timestamp, text:ev.message.text??'', receivedAt:new Date().toISOString() }); }));
    messageStore.instagram = messageStore.instagram.slice(0,200); saveMessages(messageStore);
  }
  res.sendStatus(200);
});

function createMcpServer() {
  const server = new McpServer({ name: 'meta-messaging', version: '1.1.0' });

  server.tool('whatsapp_send_message', 'Envoie un message WhatsApp.', { to: z.string(), message: z.string() }, async ({ to, message }) => {
    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return { content: [{ type:'text', text:'Erreur: credentials manquants.' }] };
    try {
      const r = await axios.post(GRAPH+'/'+WHATSAPP_PHONE_NUMBER_ID+'/messages', { messaging_product:'whatsapp', to:to.replace(/\D/g,''), type:'text', text:{body:message} }, { headers:{Authorization:'Bearer '+WHATSAPP_ACCESS_TOKEN,'Content-Type':'application/json'} });
      return { content: [{ type:'text', text:'Message envoye a '+to+'. ID: '+(r.data.messages?.[0]?.id??'inconnu') }] };
    } catch(e) { return { content: [{ type:'text', text:'Erreur WhatsApp: '+(e.response?.data?.error?.message??e.message) }] }; }
  });

  server.tool('whatsapp_get_recent_messages', 'Recupere les messages WhatsApp recus.', { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => {
    const msgs = messageStore.whatsapp.slice(0,limit);
    if (!msgs.length) return { content: [{ type:'text', text:'Aucun message WhatsApp.' }] };
    return { content: [{ type:'text', text:msgs.map((m,i)=>'['+i+'] De:+'+m.from+'\n'+m.text).join('\n---\n') }] };
  });

  server.tool('whatsapp_mark_as_read', 'Marque un message comme lu.', { message_id: z.string() }, async ({ message_id }) => {
    if (!WHATSAPP_ACCESS_TOKEN||!WHATSAPP_PHONE_NUMBER_ID) return { content: [{ type:'text', text:'Erreur: credentials manquants.' }] };
    try { await axios.post(GRAPH+'/'+WHATSAPP_PHONE_NUMBER_ID+'/messages', { messaging_product:'whatsapp', status:'read', message_id }, { headers:{Authorization:'Bearer '+WHATSAPP_ACCESS_TOKEN} }); return { content: [{ type:'text', text:'Lu: '+message_id }] }; }
    catch(e) { return { content: [{ type:'text', text:'Erreur: '+(e.response?.data?.error?.message??e.message) }] }; }
  });

  server.tool('instagram_get_conversations', 'Liste les conversations DM Instagram.', { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => {
    if (!INSTAGRAM_ACCESS_TOKEN||!INSTAGRAM_PAGE_ID) return { content: [{ type:'text', text:'Erreur: INSTAGRAM_ACCESS_TOKEN ou INSTAGRAM_PAGE_ID manquant.' }] };
    try {
      const r = await axios.get(GRAPH+'/'+INSTAGRAM_PAGE_ID+'/conversations', { params:{platform:'instagram',limit,fields:'id,participants,updated_time,message_count',access_token:INSTAGRAM_ACCESS_TOKEN} });
      const convs = r.data.data;
      if (!convs?.length) return { content: [{ type:'text', text:'Aucune conversation.' }] };
      return { content: [{ type:'text', text:convs.map((c,i)=>'['+i+'] '+c.id+'\n'+(c.participants?.data?.map(p=>p.name+'('+p.id+')').join(','))+'\n'+c.updated_time).join('\n---\n') }] };
    } catch(e) { return { content: [{ type:'text', text:'Erreur Instagram: '+(e.response?.data?.error?.message??e.message) }] }; }
  });

  server.tool('instagram_get_messages', 'Recupere les messages d une conversation.', { conversation_id: z.string(), limit: z.number().int().min(1).max(50).default(10) }, async ({ conversation_id, limit }) => {
    if (!INSTAGRAM_ACCESS_TOKEN) return { content: [{ type:'text', text:'Erreur: token manquant.' }] };
    try {
      const r = await axios.get(GRAPH+'/'+conversation_id+'/messages', { params:{limit,fields:'id,message,from,created_time',access_token:INSTAGRAM_ACCESS_TOKEN} });
      const msgs = r.data.data;
      if (!msgs?.length) return { content: [{ type:'text', text:'Aucun message.' }] };
      return { content: [{ type:'text', text:msgs.map((m,i)=>'['+i+'] '+(m.from?.name??m.from?.id)+': '+(m.message??'(media)')).join('\n') }] };
    } catch(e) { return { content: [{ type:'text', text:'Erreur Instagram: '+(e.response?.data?.error?.message??e.message) }] }; }
  });

  server.tool('instagram_send_message', 'Envoie un DM Instagram.', { recipient_id: z.string(), message: z.string() }, async ({ recipient_id, message }) => {
    if (!INSTAGRAM_ACCESS_TOKEN||!INSTAGRAM_PAGE_ID) return { content: [{ type:'text', text:'Erreur: credentials manquants.' }] };
    try {
      const r = await axios.post(GRAPH+'/'+INSTAGRAM_PAGE_ID+'/messages', { recipient:{id:recipient_id}, message:{text:message} }, { params:{access_token:INSTAGRAM_ACCESS_TOKEN}, headers:{'Content-Type':'application/json'} });
      return { content: [{ type:'text', text:'DM envoye a '+recipient_id+'. ID: '+(r.data.message_id??r.data.id??'inconnu') }] };
    } catch(e) { return { content: [{ type:'text', text:'Erreur Instagram: '+(e.response?.data?.error?.message??e.message) }] }; }
  });

  server.tool('instagram_get_recent_webhook_messages', 'Recupere les messages Instagram recus via webhook.', { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => {
    const msgs = messageStore.instagram.slice(0,limit);
    if (!msgs.length) return { content: [{ type:'text', text:'Aucun message Instagram.' }] };
    return { content: [{ type:'text', text:msgs.map((m,i)=>'['+i+'] De:'+m.senderId+'\n'+m.text).join('\n---\n') }] };
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
  console.log('Meta MCP Server v1.1.0 port '+PORT);
  if (!WHATSAPP_ACCESS_TOKEN) console.warn('WARN: WHATSAPP_ACCESS_TOKEN manquant');
  if (!WHATSAPP_PHONE_NUMBER_ID) console.warn('WARN: WHATSAPP_PHONE_NUMBER_ID manquant');
  if (!INSTAGRAM_ACCESS_TOKEN) console.warn('WARN: INSTAGRAM_ACCESS_TOKEN manquant');
  if (!INSTAGRAM_PAGE_ID) console.warn('WARN: INSTAGRAM_PAGE_ID manquant');
});
