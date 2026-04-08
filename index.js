/**
 * MCP Meta Server - WhatsApp + Instagram + Meta Ads Marketing API
 * v1.2.0 - feat: Marketing API (campaigns, insights, recommendations)
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

axios.defaults.timeout = 15000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_FILE = path.join(__dirname, 'messages_store.json');

function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch (_) {}
  return { whatsapp: [], instagram: [] };
}
function saveMessages(data) {
  try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e.message); }
}
let messageStore = loadMessages();

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN = 'verify_token_default',
  INSTAGRAM_ACCESS_TOKEN,
  INSTAGRAM_PAGE_ID,
  META_USER_TOKEN,
  META_AD_ACCOUNT_ID,
  PORT = 3000
} = process.env;

const GRAPH = 'https://graph.facebook.com/v19.0';
const app = express();
app.use(express.json());

// ── Health check ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status: 'ok',
  service: 'Meta MCP Server',
  version: '1.2.1',
  wa_phone_id: WHATSAPP_PHONE_NUMBER_ID || 'not set',
  ig_page_id: INSTAGRAM_PAGE_ID || 'not set',
  ads_account: META_AD_ACCOUNT_ID || 'not set'
}));

// ── WhatsApp Webhook ─────────────────────────────────────────────────────────
app.get('/webhook/whatsapp', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const messages = changes?.messages;
    if (messages?.length) {
      const msg = messages[0];
      const contact = changes.contacts?.[0];
      messageStore.whatsapp.push({
        id: msg.id,
        from: msg.from,
        from_name: contact?.profile?.name || 'Unknown',
        type: msg.type,
        text: msg.text?.body || null,
        timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
        raw: msg
      });
      if (messageStore.whatsapp.length > 100) messageStore.whatsapp = messageStore.whatsapp.slice(-100);
      saveMessages(messageStore);
    }
  } catch (e) { console.error('WA webhook error:', e.message); }
  res.sendStatus(200);
});

// ── Instagram Webhook ─────────────────────────────────────────────────────────
app.get('/webhook/instagram', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

app.post('/webhook/instagram', (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (messaging && messaging.message) {
      messageStore.instagram.push({
        from_id: messaging.sender?.id,
        to_id: messaging.recipient?.id,
        text: messaging.message?.text || null,
        mid: messaging.message?.mid,
        timestamp: new Date(messaging.timestamp).toISOString(),
        raw: messaging
      });
      if (messageStore.instagram.length > 100) messageStore.instagram = messageStore.instagram.slice(-100);
      saveMessages(messageStore);
    }
  } catch (e) { console.error('IG webhook error:', e.message); }
  res.sendStatus(200);
});

// ── MCP Server Factory ───────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: 'meta-messaging', version: '1.2.1' });

  // ── WhatsApp Tools ──────────────────────────────────────────────────────────

  server.tool(
    'whatsapp_send_message',
    'Envoie un message WhatsApp à un destinataire.',
    {
      to: z.string().describe('Numéro de téléphone du destinataire (format international, ex: 33612345678)'),
      message: z.string().describe('Texte du message à envoyer')
    },
    async ({ to, message }) => {
      if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID)
        return { content: [{ type: 'text', text: 'Erreur: WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID non configuré.' }] };
      try {
        const r = await axios.post(
          `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } },
          { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return { content: [{ type: 'text', text: `✅ Message envoyé. ID: ${r.data.messages?.[0]?.id || 'unknown'}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'whatsapp_get_recent_messages',
    'Récupère les messages WhatsApp reçus récemment via le webhook.',
    { limit: z.number().int().min(1).max(50).default(10).describe('Nombre de messages à retourner') },
    async ({ limit }) => {
      const msgs = messageStore.whatsapp.slice(-limit).reverse();
      if (!msgs.length) return { content: [{ type: 'text', text: 'Aucun message WhatsApp reçu pour le moment.' }] };
      const text = msgs.map(m =>
        `[${m.timestamp}] De: ${m.from_name} (${m.from})\n${m.text || `[${m.type}]`}`
      ).join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'whatsapp_mark_as_read',
    'Marque un message WhatsApp comme lu.',
    { message_id: z.string().describe('ID du message WhatsApp à marquer comme lu') },
    async ({ message_id }) => {
      if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID)
        return { content: [{ type: 'text', text: 'Erreur: tokens non configurés.' }] };
      try {
        await axios.post(
          `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', status: 'read', message_id },
          { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return { content: [{ type: 'text', text: `✅ Message ${message_id} marqué comme lu.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  // ── Instagram Tools ─────────────────────────────────────────────────────────

  server.tool(
    'instagram_get_conversations',
    'Liste les conversations Instagram DM de la page.',
    { limit: z.number().int().min(1).max(25).default(10).describe('Nombre de conversations à lister') },
    async ({ limit }) => {
      if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_PAGE_ID)
        return { content: [{ type: 'text', text: 'Erreur: INSTAGRAM_ACCESS_TOKEN ou INSTAGRAM_PAGE_ID non configuré.' }] };
      try {
        const r = await axios.get(`${GRAPH}/${INSTAGRAM_PAGE_ID}/conversations`, {
          params: {
            platform: 'instagram',
            fields: 'id,participants,updated_time,message_count',
            limit,
            access_token: INSTAGRAM_ACCESS_TOKEN
          }
        });
        const convs = r.data.data || [];
        if (!convs.length) return { content: [{ type: 'text', text: 'Aucune conversation Instagram trouvée.' }] };
        const text = convs.map(c => {
          const parts = c.participants?.data?.map(p => p.name).join(', ') || 'Inconnu';
          return `ID: ${c.id}\nParticipants: ${parts}\nMaj: ${c.updated_time}\nMessages: ${c.message_count}`;
        }).join('\n\n---\n\n');
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'instagram_get_messages',
    'Récupère les messages d\'une conversation Instagram.',
    {
      conversation_id: z.string().describe('ID de la conversation Instagram'),
      limit: z.number().int().min(1).max(25).default(10).describe('Nombre de messages à récupérer')
    },
    async ({ conversation_id, limit }) => {
      if (!INSTAGRAM_ACCESS_TOKEN)
        return { content: [{ type: 'text', text: 'Erreur: INSTAGRAM_ACCESS_TOKEN non configuré.' }] };
      try {
        const r = await axios.get(`${GRAPH}/${conversation_id}/messages`, {
          params: {
            fields: 'id,message,from,created_time',
            limit,
            access_token: INSTAGRAM_ACCESS_TOKEN
          }
        });
        const msgs = r.data.data || [];
        if (!msgs.length) return { content: [{ type: 'text', text: 'Aucun message dans cette conversation.' }] };
        const text = msgs.map(m =>
          `[${m.created_time}] ${m.from?.name || 'Inconnu'}: ${m.message || '[media]'}`
        ).join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'instagram_send_message',
    'Envoie un message Instagram DM à un utilisateur (IGSID ou @username).',
    {
      recipient_id: z.string().describe('IGSID ou username Instagram (ex: "the.aurel") du destinataire'),
      message: z.string().describe('Texte du message à envoyer')
    },
    async ({ recipient_id, message }) => {
      if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_PAGE_ID)
        return { content: [{ type: 'text', text: 'Erreur: tokens Instagram non configurés.' }] };
      // Detect if recipient_id is a username (non-numeric) or an IGSID (numeric)
      const isUsername = isNaN(recipient_id.replace(/^@/, ''));
      const cleanUsername = recipient_id.replace(/^@/, '');
      const recipient = isUsername
        ? { username: cleanUsername }
        : { id: recipient_id };
      try {
        const r = await axios.post(
          `${GRAPH}/${INSTAGRAM_PAGE_ID}/messages`,
          { recipient, message: { text: message }, messaging_type: 'RESPONSE' },
          { params: { access_token: INSTAGRAM_ACCESS_TOKEN } }
        );
        return { content: [{ type: 'text', text: `✅ Message Instagram envoyé. ID: ${r.data.message_id || 'unknown'}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'instagram_get_recent_webhook_messages',
    'Récupère les messages Instagram reçus récemment via le webhook.',
    { limit: z.number().int().min(1).max(50).default(10).describe('Nombre de messages à retourner') },
    async ({ limit }) => {
      const msgs = messageStore.instagram.slice(-limit).reverse();
      if (!msgs.length) return { content: [{ type: 'text', text: 'Aucun message Instagram reçu via webhook pour le moment.' }] };
      const text = msgs.map(m =>
        `[${m.timestamp}] De: ${m.from_id}\n${m.text || '[media]'}\nMID: ${m.mid}`
      ).join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Meta Ads / Marketing API Tools ─────────────────────────────────────────

  server.tool(
    'meta_get_ad_accounts',
    'Liste les comptes publicitaires Meta accessibles avec le token configuré.',
    {},
    async () => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: Aucun token Meta configuré.' }] };
      try {
        const r = await axios.get(`${GRAPH}/me/adaccounts`, {
          params: {
            fields: 'id,name,account_status,currency,amount_spent',
            access_token: token
          }
        });
        const accounts = r.data.data || [];
        if (!accounts.length) return { content: [{ type: 'text', text: 'Aucun compte publicitaire trouvé. Assurez-vous que META_USER_TOKEN a la permission ads_read.' }] };
        const statusMap = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 9: 'IN_GRACE_PERIOD', 101: 'TEMPORARILY_UNAVAILABLE', 201: 'CLOSED' };
        const text = accounts.map(a =>
          `📊 ${a.name}\n  ID: ${a.id}\n  Statut: ${statusMap[a.account_status] || a.account_status}\n  Devise: ${a.currency}\n  Dépenses totales: ${(parseInt(a.amount_spent || 0) / 100).toFixed(2)} ${a.currency}`
        ).join('\n\n');
        return { content: [{ type: 'text', text: `Comptes publicitaires Meta:\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}\n\nAstuce: Vous avez besoin d'un User Access Token avec la permission ads_read. Configurez META_USER_TOKEN dans Railway.` }] };
      }
    }
  );

  server.tool(
    'meta_get_campaigns',
    'Liste les campagnes d\'un compte publicitaire Meta.',
    {
      ad_account_id: z.string().optional().describe('ID du compte publicitaire (ex: act_123456). Utilise META_AD_ACCOUNT_ID par défaut.'),
      status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED', 'ALL']).default('ALL').describe('Filtre par statut')
    },
    async ({ ad_account_id, status }) => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: META_USER_TOKEN non configuré.' }] };
      const accountId = ad_account_id || META_AD_ACCOUNT_ID;
      if (!accountId) return { content: [{ type: 'text', text: 'Erreur: Aucun compte publicitaire spécifié. Configurez META_AD_ACCOUNT_ID dans Railway.' }] };
      try {
        const params = {
          fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,spend_cap',
          access_token: token,
          limit: 25
        };
        if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
        const r = await axios.get(`${GRAPH}/${accountId}/campaigns`, { params });
        const campaigns = r.data.data || [];
        if (!campaigns.length) return { content: [{ type: 'text', text: `Aucune campagne trouvée (filtre: ${status}).` }] };
        const text = campaigns.map(c => {
          const budget = c.daily_budget
            ? `Budget journalier: ${(parseInt(c.daily_budget) / 100).toFixed(2)}€`
            : c.lifetime_budget
            ? `Budget total: ${(parseInt(c.lifetime_budget) / 100).toFixed(2)}€`
            : 'Budget: non défini';
          return `📢 ${c.name}\n  ID: ${c.id}\n  Statut: ${c.status}\n  Objectif: ${c.objective}\n  ${budget}`;
        }).join('\n\n');
        return { content: [{ type: 'text', text: `Campagnes (${campaigns.length}):\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'meta_get_campaign_insights',
    'Récupère les performances (insights) d\'une campagne, d\'un adset ou d\'une annonce Meta.',
    {
      object_id: z.string().describe('ID de la campagne, adset, ou annonce'),
      date_preset: z.enum(['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month']).default('last_30d').describe('Période d\'analyse')
    },
    async ({ object_id, date_preset }) => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: META_USER_TOKEN non configuré.' }] };
      try {
        const r = await axios.get(`${GRAPH}/${object_id}/insights`, {
          params: {
            fields: 'impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions,campaign_name',
            date_preset,
            access_token: token
          }
        });
        const data = r.data.data?.[0];
        if (!data) return { content: [{ type: 'text', text: 'Aucune donnée disponible pour cette période.' }] };
        const actions = data.actions || [];
        const purchases = actions.find(a => a.action_type === 'purchase')?.value || 0;
        const leads = actions.find(a => a.action_type === 'lead')?.value || 0;
        const linkClicks = actions.find(a => a.action_type === 'link_click')?.value || 0;
        const text = [
          `📊 Insights — Période: ${date_preset}`,
          data.campaign_name ? `Campagne: ${data.campaign_name}` : '',
          ``,
          `👁️  Impressions: ${parseInt(data.impressions || 0).toLocaleString('fr-FR')}`,
          `👥 Portée: ${parseInt(data.reach || 0).toLocaleString('fr-FR')}`,
          `🔁 Fréquence: ${parseFloat(data.frequency || 0).toFixed(2)}`,
          `🖱️  Clics: ${parseInt(data.clicks || 0).toLocaleString('fr-FR')}`,
          `📈 CTR: ${parseFloat(data.ctr || 0).toFixed(2)}%`,
          `💰 Dépenses: ${parseFloat(data.spend || 0).toFixed(2)}€`,
          `💵 CPC: ${parseFloat(data.cpc || 0).toFixed(2)}€`,
          `📣 CPM: ${parseFloat(data.cpm || 0).toFixed(2)}€`,
          purchases > 0 ? `🛒 Achats: ${purchases}` : '',
          leads > 0 ? `🎯 Leads: ${leads}` : '',
          linkClicks > 0 ? `🔗 Clics lien: ${linkClicks}` : '',
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'meta_get_ad_recommendations',
    'Analyse les campagnes actives et génère des recommandations d\'optimisation basées sur les performances.',
    {
      ad_account_id: z.string().optional().describe('ID du compte publicitaire. Utilise META_AD_ACCOUNT_ID par défaut.')
    },
    async ({ ad_account_id }) => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: META_USER_TOKEN non configuré.' }] };
      const accountId = ad_account_id || META_AD_ACCOUNT_ID;
      if (!accountId) return { content: [{ type: 'text', text: 'Erreur: META_AD_ACCOUNT_ID non configuré.' }] };
      try {
        const campaignsRes = await axios.get(`${GRAPH}/${accountId}/campaigns`, {
          params: {
            fields: 'id,name,status,objective',
            effective_status: JSON.stringify(['ACTIVE']),
            access_token: token,
            limit: 10
          }
        });
        const campaigns = campaignsRes.data.data || [];
        if (!campaigns.length) return { content: [{ type: 'text', text: 'Aucune campagne active trouvée. Impossible de générer des recommandations.' }] };

        const insightsResults = await Promise.allSettled(
          campaigns.map(c =>
            axios.get(`${GRAPH}/${c.id}/insights`, {
              params: {
                fields: 'impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions',
                date_preset: 'last_30d',
                access_token: token
              }
            }).then(r => ({ campaign: c, data: r.data.data?.[0] || null }))
          )
        );

        const recommendations = [];
        for (const result of insightsResults) {
          if (result.status === 'rejected' || !result.value?.data) continue;
          const { campaign, data } = result.value;
          const ctr = parseFloat(data.ctr || 0);
          const frequency = parseFloat(data.frequency || 0);
          const cpm = parseFloat(data.cpm || 0);
          const spend = parseFloat(data.spend || 0);
          const recs = [];

          if (ctr < 1.0) recs.push(`⚠️ CTR faible (${ctr.toFixed(2)}%) → Testez de nouveaux visuels ou textes publicitaires.`);
          if (frequency > 3.5) recs.push(`⚠️ Fréquence élevée (${frequency.toFixed(1)}x) → L'audience est saturée, élargissez ou rafraîchissez vos annonces.`);
          if (cpm > 15) recs.push(`⚠️ CPM élevé (${cpm.toFixed(2)}€) → Ajustez le ciblage pour réduire la concurrence sur l'audience.`);
          if (spend < 1 && data.impressions) recs.push(`ℹ️ Dépenses très faibles (${spend.toFixed(2)}€) → La campagne tourne avec un budget minimal.`);
          if (!recs.length) recs.push(`✅ Campagne performante — Maintenez les paramètres actuels.`);

          recommendations.push(
            `📢 **${campaign.name}** (${campaign.objective})\n` +
            `  CTR: ${ctr.toFixed(2)}% | Fréq: ${frequency.toFixed(1)} | CPM: ${cpm.toFixed(2)}€ | Dépenses: ${spend.toFixed(2)}€\n` +
            recs.map(r => `  ${r}`).join('\n')
          );
        }

        if (!recommendations.length) return { content: [{ type: 'text', text: 'Impossible de récupérer les données de performance des campagnes actives.' }] };
        return { content: [{ type: 'text', text: `🎯 Recommandations Meta Ads (30 derniers jours):\n\n${recommendations.join('\n\n')}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'meta_update_campaign_status',
    'Active ou met en pause une campagne Meta Ads.',
    {
      campaign_id: z.string().describe('ID de la campagne à modifier'),
      status: z.enum(['ACTIVE', 'PAUSED']).describe('Nouveau statut de la campagne')
    },
    async ({ campaign_id, status }) => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: META_USER_TOKEN non configuré.' }] };
      try {
        await axios.post(
          `${GRAPH}/${campaign_id}`,
          { status },
          { params: { access_token: token } }
        );
        const emoji = status === 'ACTIVE' ? '▶️' : '⏸️';
        return { content: [{ type: 'text', text: `${emoji} Campagne ${campaign_id} mise à jour → ${status}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'meta_create_campaign',
    'Crée une nouvelle campagne Meta Ads (créée en PAUSE par défaut pour validation avant activation).',
    {
      name: z.string().describe('Nom de la campagne'),
      objective: z.enum(['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION']).describe('Objectif de la campagne'),
      daily_budget_cents: z.number().int().min(100).describe('Budget journalier en centimes (ex: 1000 = 10€)'),
      ad_account_id: z.string().optional().describe('ID du compte publicitaire. Utilise META_AD_ACCOUNT_ID par défaut.')
    },
    async ({ name, objective, daily_budget_cents, ad_account_id }) => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: META_USER_TOKEN non configuré.' }] };
      const accountId = ad_account_id || META_AD_ACCOUNT_ID;
      if (!accountId) return { content: [{ type: 'text', text: 'Erreur: META_AD_ACCOUNT_ID non configuré.' }] };
      try {
        const r = await axios.post(
          `${GRAPH}/${accountId}/campaigns`,
          {
            name,
            objective,
            status: 'PAUSED',
            special_ad_categories: [],
            daily_budget: daily_budget_cents
          },
          { params: { access_token: token } }
        );
        return { content: [{ type: 'text', text: `✅ Campagne créée (en PAUSE):\n  ID: ${r.data.id}\n  Nom: ${name}\n  Objectif: ${objective}\n  Budget/jour: ${(daily_budget_cents / 100).toFixed(2)}€\n\nActivez-la avec meta_update_campaign_status quand vous êtes prêt.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  server.tool(
    'meta_get_ads',
    'Liste les annonces (ads) d\'une campagne ou d\'un adset Meta.',
    {
      object_id: z.string().describe('ID de la campagne ou de l\'adset'),
      status: z.enum(['ACTIVE', 'PAUSED', 'ALL']).default('ACTIVE').describe('Filtre par statut')
    },
    async ({ object_id, status }) => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: META_USER_TOKEN non configuré.' }] };
      try {
        const params = {
          fields: 'id,name,status,adset_id,creative{title,body,image_url}',
          access_token: token,
          limit: 20
        };
        if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
        const r = await axios.get(`${GRAPH}/${object_id}/ads`, { params });
        const ads = r.data.data || [];
        if (!ads.length) return { content: [{ type: 'text', text: `Aucune annonce trouvée (filtre: ${status}).` }] };
        const text = ads.map(a =>
          `🎨 ${a.name}\n  ID: ${a.id}\n  Statut: ${a.status}\n  AdSet ID: ${a.adset_id}`
        ).join('\n\n');
        return { content: [{ type: 'text', text: `Annonces (${ads.length}):\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
      }
    }
  );

  return server;
}

// ── MCP HTTP Transport ────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Meta MCP Server v1.2.0 running on port ${PORT}`);
  console.log(`  WA Phone ID: ${WHATSAPP_PHONE_NUMBER_ID || 'NOT SET'}`);
  console.log(`  IG Page ID:  ${INSTAGRAM_PAGE_ID || 'NOT SET'}`);
  console.log(`  Ads Account: ${META_AD_ACCOUNT_ID || 'NOT SET'}`);
  console.log(`  User Token:  ${META_USER_TOKEN ? '✅ set' : '❌ NOT SET'}`);
});
