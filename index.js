/**
 * MCP Meta Server — WhatsApp + Instagram + Meta Ads + Growth Automation
 * v1.3.0 — Daily growth metrics: Stripe × Facebook Ads → CAC / ROAS / recommendations
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import axios from 'axios';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

axios.defaults.timeout = 15000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_FILE = path.join(__dirname, 'messages_store.json');
const GROWTH_REPORTS_FILE = path.join(__dirname, 'growth_reports.json');

// ── Persistent stores ─────────────────────────────────────────────────────────
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

function loadGrowthReports() {
  try {
    if (fs.existsSync(GROWTH_REPORTS_FILE)) return JSON.parse(fs.readFileSync(GROWTH_REPORTS_FILE, 'utf8'));
  } catch (_) {}
  return { daily: [] };
}
function saveGrowthReport(report) {
  const data = loadGrowthReports();
  data.daily.push(report);
  if (data.daily.length > 90) data.daily = data.daily.slice(-90);
  try { fs.writeFileSync(GROWTH_REPORTS_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e.message); }
}

// ── Environment ───────────────────────────────────────────────────────────────
const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN = 'verify_token_default',
  INSTAGRAM_ACCESS_TOKEN,
  INSTAGRAM_PAGE_ID,
  META_USER_TOKEN,
  META_AD_ACCOUNT_ID,
  STRIPE_SECRET_KEY,
  NOTIFICATION_PHONE,
  DAILY_REPORT_HOUR = '8',
  DAILY_REPORT_PRESET = 'last_7d',
  PORT = 3000
} = process.env;

const GRAPH = 'https://graph.facebook.com/v19.0';
const STRIPE_BASE = 'https://api.stripe.com/v1';

const app = express();
app.use(express.json());

// ── Stripe helpers ────────────────────────────────────────────────────────────
async function stripeGet(endpoint, params = {}) {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY non configuré');
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${STRIPE_BASE}/${endpoint}${qs ? '?' + qs : ''}`;
  const r = await axios.get(url, { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } });
  return r.data;
}

async function stripeGetAll(endpoint, params = {}) {
  const items = [];
  let hasMore = true;
  let startingAfter = null;
  while (hasMore) {
    const p = { ...params, limit: 100 };
    if (startingAfter) p.starting_after = startingAfter;
    const data = await stripeGet(endpoint, p);
    items.push(...(data.data || []));
    hasMore = data.has_more;
    if (hasMore && data.data?.length) startingAfter = data.data[data.data.length - 1].id;
    else hasMore = false;
  }
  return items;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function datePresetToUnixStart(preset) {
  const now = Math.floor(Date.now() / 1000);
  const today = now - (now % 86400);
  switch (preset) {
    case 'today':      return today;
    case 'yesterday':  return today - 86400;
    case 'last_7d':    return now - 7 * 86400;
    case 'last_14d':   return now - 14 * 86400;
    case 'last_30d':   return now - 30 * 86400;
    case 'last_90d':   return now - 90 * 86400;
    case 'this_month': {
      const d = new Date(); return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
    }
    case 'last_month': {
      const d = new Date(); return Math.floor(new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime() / 1000);
    }
    default: return now - 30 * 86400;
  }
}

// ── Core growth report engine ─────────────────────────────────────────────────
async function generateGrowthReport(datePreset = 'last_7d') {
  const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
  const accountId = META_AD_ACCOUNT_ID;

  const report = {
    date: new Date().toISOString().split('T')[0],
    period: datePreset,
    generated_at: new Date().toISOString(),
    ads: null,
    stripe: null,
    metrics: null,
    recommendations: { stop: [], scale: [], test: [], best_hooks: [], pricing_insights: [] }
  };

  // ── Pull Meta Ads data ──────────────────────────────────────────────────────
  if (token && accountId) {
    try {
      const campaignsRes = await axios.get(`${GRAPH}/${accountId}/campaigns`, {
        params: {
          fields: 'id,name,status,objective,daily_budget,lifetime_budget',
          effective_status: JSON.stringify(['ACTIVE', 'PAUSED']),
          access_token: token,
          limit: 50
        }
      });
      const campaigns = campaignsRes.data.data || [];

      const insightResults = await Promise.allSettled(
        campaigns.map(c =>
          axios.get(`${GRAPH}/${c.id}/insights`, {
            params: {
              fields: 'impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions',
              date_preset: datePreset,
              access_token: token
            }
          }).then(r => ({ ...c, insights: r.data.data?.[0] || null }))
        )
      );

      // Ad-level insights for hook analysis (top 5 campaigns by spend)
      const sortedCampaigns = insightResults
        .filter(r => r.status === 'fulfilled' && r.value.insights)
        .map(r => r.value)
        .sort((a, b) => parseFloat(b.insights.spend || 0) - parseFloat(a.insights.spend || 0));

      const adLevelResults = await Promise.allSettled(
        sortedCampaigns.slice(0, 5).map(c =>
          axios.get(`${GRAPH}/${c.id}/ads`, {
            params: {
              fields: 'id,name,status,creative{title,body,call_to_action_type}',
              access_token: token,
              limit: 20
            }
          }).then(async adsRes => {
            const ads = adsRes.data.data || [];
            const withInsights = await Promise.allSettled(
              ads.map(ad =>
                axios.get(`${GRAPH}/${ad.id}/insights`, {
                  params: {
                    fields: 'impressions,clicks,spend,ctr,cpc,actions',
                    date_preset: datePreset,
                    access_token: token
                  }
                }).then(r => ({ ...ad, insights: r.data.data?.[0] || null }))
              )
            );
            return withInsights.filter(r => r.status === 'fulfilled').map(r => r.value);
          })
        )
      );

      const campaignData = sortedCampaigns;
      const totalSpend = campaignData.reduce((s, c) => s + parseFloat(c.insights.spend || 0), 0);
      const totalClicks = campaignData.reduce((s, c) => s + parseInt(c.insights.clicks || 0), 0);
      const totalImpressions = campaignData.reduce((s, c) => s + parseInt(c.insights.impressions || 0), 0);
      const totalPurchases = campaignData.reduce((s, c) => {
        return s + parseInt(c.insights.actions?.find(a => a.action_type === 'purchase')?.value || 0);
      }, 0);

      const allAds = adLevelResults
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .filter(ad => ad.insights);

      report.ads = {
        total_spend: Math.round(totalSpend * 100) / 100,
        total_clicks: totalClicks,
        total_impressions: totalImpressions,
        total_purchases: totalPurchases,
        campaign_count: campaigns.length,
        campaigns: campaignData.map(c => ({
          id: c.id,
          name: c.name,
          status: c.status,
          objective: c.objective,
          spend: Math.round(parseFloat(c.insights.spend || 0) * 100) / 100,
          clicks: parseInt(c.insights.clicks || 0),
          impressions: parseInt(c.insights.impressions || 0),
          reach: parseInt(c.insights.reach || 0),
          ctr: Math.round(parseFloat(c.insights.ctr || 0) * 100) / 100,
          cpc: Math.round(parseFloat(c.insights.cpc || 0) * 100) / 100,
          cpm: Math.round(parseFloat(c.insights.cpm || 0) * 100) / 100,
          frequency: Math.round(parseFloat(c.insights.frequency || 0) * 100) / 100,
          purchases: parseInt(c.insights.actions?.find(a => a.action_type === 'purchase')?.value || 0),
          leads: parseInt(c.insights.actions?.find(a => a.action_type === 'lead')?.value || 0),
        })),
        top_ads: allAds
          .filter(ad => ad.insights)
          .sort((a, b) => parseFloat(b.insights.ctr || 0) - parseFloat(a.insights.ctr || 0))
          .slice(0, 5)
          .map(ad => ({
            id: ad.id,
            name: ad.name,
            title: ad.creative?.title || null,
            body: ad.creative?.body ? ad.creative.body.substring(0, 150) : null,
            cta: ad.creative?.call_to_action_type || null,
            ctr: Math.round(parseFloat(ad.insights.ctr || 0) * 100) / 100,
            clicks: parseInt(ad.insights.clicks || 0),
            spend: Math.round(parseFloat(ad.insights.spend || 0) * 100) / 100,
          }))
      };
    } catch (e) {
      report.ads = { error: e.message };
    }
  }

  // ── Pull Stripe data ────────────────────────────────────────────────────────
  if (STRIPE_SECRET_KEY) {
    try {
      const startTs = datePresetToUnixStart(datePreset);
      const endTs = Math.floor(Date.now() / 1000);

      const [newSubs, cancelledSubs, charges, activeSubsRes] = await Promise.all([
        stripeGetAll('subscriptions', { 'created[gte]': startTs, 'created[lte]': endTs }),
        stripeGetAll('subscriptions', { 'canceled_at[gte]': startTs, 'canceled_at[lte]': endTs, status: 'canceled' }),
        stripeGetAll('charges', { 'created[gte]': startTs, 'created[lte]': endTs }),
        stripeGet('subscriptions', { status: 'active', limit: 100 })
      ]);

      const successfulCharges = charges.filter(c => c.status === 'succeeded' && !c.refunded);
      const totalRevenue = successfulCharges.reduce((s, c) => s + c.amount, 0) / 100;

      // Plan breakdown — detect monthly / quarterly / yearly
      const planBreakdown = {};
      for (const sub of newSubs) {
        const plan = sub.plan || sub.items?.data?.[0]?.plan;
        if (!plan) continue;
        const interval = plan.interval;
        const intervalCount = plan.interval_count || 1;
        let key = 'other';
        if (interval === 'month' && intervalCount === 1) key = 'monthly';
        else if (interval === 'month' && intervalCount === 3) key = 'quarterly';
        else if (interval === 'year') key = 'yearly';
        if (!planBreakdown[key]) planBreakdown[key] = { count: 0, total_amount: 0 };
        planBreakdown[key].count++;
        planBreakdown[key].total_amount += (plan.amount || 0) / 100;
      }

      // MRR from active subscriptions
      const activeSubs = activeSubsRes.data || [];
      const mrr = activeSubs.reduce((s, sub) => {
        const plan = sub.plan || sub.items?.data?.[0]?.plan;
        if (!plan) return s;
        const amount = plan.amount / 100;
        if (plan.interval === 'month') return s + amount / (plan.interval_count || 1);
        if (plan.interval === 'year') return s + amount / 12;
        return s;
      }, 0);

      const totalActive = activeSubs.length;
      const churnRate = totalActive + cancelledSubs.length > 0
        ? (cancelledSubs.length / (totalActive + cancelledSubs.length) * 100)
        : 0;

      report.stripe = {
        total_revenue: Math.round(totalRevenue * 100) / 100,
        new_subscriptions: newSubs.length,
        cancelled_subscriptions: cancelledSubs.length,
        net_new_subscriptions: newSubs.length - cancelledSubs.length,
        active_subscriptions_total: totalActive,
        mrr: Math.round(mrr * 100) / 100,
        arr: Math.round(mrr * 12 * 100) / 100,
        churn_rate: Math.round(churnRate * 100) / 100,
        plan_breakdown: planBreakdown
      };
    } catch (e) {
      report.stripe = { error: e.message };
    }
  }

  // ── Combined metrics + recommendations ──────────────────────────────────────
  const adsOk = report.ads && !report.ads.error;
  const stripeOk = report.stripe && !report.stripe.error;

  if (adsOk && stripeOk) {
    const { total_spend, total_clicks, campaigns } = report.ads;
    const { new_subscriptions, total_revenue, mrr, active_subscriptions_total } = report.stripe;

    const cac = new_subscriptions > 0 ? Math.round(total_spend / new_subscriptions * 100) / 100 : null;
    const conversionRate = total_clicks > 0 ? Math.round(new_subscriptions / total_clicks * 10000) / 100 : 0;
    const roas = total_spend > 0 ? Math.round(total_revenue / total_spend * 100) / 100 : 0;
    const avgRevenuePerSub = active_subscriptions_total > 0 ? mrr / active_subscriptions_total : 0;
    const ltv = avgRevenuePerSub > 0 ? Math.round(avgRevenuePerSub * 12 * 100) / 100 : null;
    const payback = cac && avgRevenuePerSub > 0 ? Math.round(cac / avgRevenuePerSub * 10) / 10 : null;

    report.metrics = {
      blended_cac: cac,
      blended_conversion_rate_pct: conversionRate,
      roas,
      ltv_estimate_12m: ltv,
      payback_period_months: payback
    };

    // Per-campaign attribution (proportional by clicks)
    for (const c of campaigns) {
      const campaignShare = total_clicks > 0 ? c.clicks / total_clicks : 0;
      const estimatedSubs = new_subscriptions * campaignShare;
      const estimatedRevenue = total_revenue * campaignShare;
      const campaignCac = estimatedSubs > 0 ? c.spend / estimatedSubs : null;
      const campaignRoas = c.spend > 0 ? estimatedRevenue / c.spend : 0;

      // STOP
      if (c.spend > 10 && c.ctr < 0.5) {
        report.recommendations.stop.push({
          campaign: c.name, id: c.id,
          reason: `CTR trop faible (${c.ctr}%) — créatif ou audience épuisé`,
          spend: c.spend
        });
      } else if (c.spend > 20 && campaignRoas < 1) {
        report.recommendations.stop.push({
          campaign: c.name, id: c.id,
          reason: `ROAS négatif (${campaignRoas.toFixed(2)}x) — chaque euro dépensé génère moins d'un euro`,
          spend: c.spend
        });
      } else if (c.frequency > 4 && c.spend > 10) {
        report.recommendations.stop.push({
          campaign: c.name, id: c.id,
          reason: `Fréquence saturée (${c.frequency}x) — rafraîchir les créatifs ou changer l'audience`,
          spend: c.spend
        });
      }

      // SCALE
      if (campaignRoas > 3 && c.ctr > 2 && c.spend > 5) {
        report.recommendations.scale.push({
          campaign: c.name, id: c.id,
          reason: `ROAS excellent (${campaignRoas.toFixed(2)}x) + CTR fort (${c.ctr}%) → augmenter budget de 20–30%`,
          current_spend: c.spend, estimated_roas: campaignRoas.toFixed(2)
        });
      } else if (c.ctr > 3 && c.spend < 30) {
        report.recommendations.scale.push({
          campaign: c.name, id: c.id,
          reason: `CTR exceptionnel (${c.ctr}%) avec budget limité (${c.spend}€) — potentiel inexploité`,
          current_spend: c.spend, estimated_roas: campaignRoas.toFixed(2)
        });
      }
    }

    // TEST recommendations
    const avgCtr = campaigns.reduce((s, c) => s + c.ctr, 0) / (campaigns.length || 1);
    if (avgCtr < 1.5) {
      report.recommendations.test.push('Nouvelles accroches (hooks) — CTR moyen < 1.5% signale un problème de message ou de ciblage');
    }
    if (conversionRate < 0.5) {
      report.recommendations.test.push('Landing page ou offre d\'essai — taux de conversion post-clic faible (< 0.5%)');
    }
    if (roas < 2) {
      report.recommendations.test.push('Audience Lookalike basée sur les abonnés actifs Stripe — améliorer la qualité du trafic');
    }
    report.recommendations.test.push('Tester un angle "transformation / résultat concret" vs angle "communauté / appartenance"');
    report.recommendations.test.push('Vidéo UGC 15s avec hook direct dans les 3 premières secondes (stop-the-scroll)');

    // Best hooks (top ads by CTR)
    if (report.ads.top_ads?.length) {
      report.recommendations.best_hooks = report.ads.top_ads
        .filter(ad => ad.title || ad.body)
        .map(ad => ({
          title: ad.title || '(sans titre)',
          body: ad.body || '(sans texte)',
          ctr: ad.ctr,
          clicks: ad.clicks,
          spend: ad.spend
        }));
    }

    // Pricing insights
    const pb = report.stripe.plan_breakdown;
    if (pb) {
      const monthly = pb.monthly || { count: 0, total_amount: 0 };
      const quarterly = pb.quarterly || { count: 0, total_amount: 0 };
      const yearly = pb.yearly || { count: 0, total_amount: 0 };
      const total = monthly.count + quarterly.count + yearly.count;
      const insights = [];

      if (total > 0) {
        insights.push(
          `Mix abonnements: ${monthly.count} mensuels (${Math.round(monthly.count / total * 100)}%), ` +
          `${quarterly.count} trimestriels (${Math.round(quarterly.count / total * 100)}%), ` +
          `${yearly.count} annuels (${Math.round(yearly.count / total * 100)}%)`
        );

        if (yearly.count > 0 && monthly.count > 0) {
          const yearlyAvgMonthly = yearly.total_amount / yearly.count / 12;
          const monthlyAvg = monthly.total_amount / monthly.count;
          if (yearlyAvgMonthly > 0 && monthlyAvg > 0) {
            const uplift = (yearlyAvgMonthly / monthlyAvg * 100 - 100).toFixed(0);
            insights.push(`L'annuel génère ${uplift > 0 ? '+' : ''}${uplift}% de revenu mensuel vs mensuel pur`);
          }
        }

        if (yearly.count / total < 0.25) {
          insights.push(`Opportunité: seulement ${Math.round(yearly.count / total * 100)}% d'annuels → tester "2 mois offerts" pour pousser l'annuel`);
        }

        if (quarterly.count / total < 0.15 && total > 10) {
          insights.push(`Le trimestriel est sous-représenté (${Math.round(quarterly.count / total * 100)}%) — peut servir de marche entre mensuel et annuel`);
        }
      }

      if (report.stripe.churn_rate > 5) {
        insights.push(`⚠️ Churn élevé (${report.stripe.churn_rate}%) — tester un email de win-back J-3 avant expiration et un discount de fidélité`);
      } else if (report.stripe.churn_rate < 2) {
        insights.push(`✅ Churn faible (${report.stripe.churn_rate}%) — les abonnés The Five Club sont très engagés`);
      }

      if (ltv && cac && ltv > 0) {
        const ltvcac = Math.round(ltv / cac * 10) / 10;
        insights.push(`Ratio LTV/CAC estimé: ${ltvcac}x ${ltvcac >= 3 ? '✅ (sain)' : '⚠️ (cible: ≥ 3x)'}`);
      }

      report.recommendations.pricing_insights = insights;
    }
  } else if (adsOk && !stripeOk) {
    // Ads-only recommendations
    for (const c of (report.ads?.campaigns || [])) {
      if (c.ctr < 0.5 && c.spend > 10) {
        report.recommendations.stop.push({ campaign: c.name, id: c.id, reason: `CTR faible (${c.ctr}%)`, spend: c.spend });
      }
      if (c.ctr > 3 && c.spend < 30) {
        report.recommendations.scale.push({ campaign: c.name, id: c.id, reason: `CTR fort (${c.ctr}%) — potentiel`, current_spend: c.spend });
      }
    }
  }

  return report;
}

// ── Report formatter ──────────────────────────────────────────────────────────
function formatReport(report) {
  const lines = [
    `📊 RAPPORT GROWTH QUOTIDIEN — ${report.date}`,
    `📅 Période analysée: ${report.period}`,
    ``
  ];

  if (report.ads && !report.ads.error) {
    lines.push(`━━━ 📢 META ADS ━━━`);
    lines.push(`Dépenses: ${report.ads.total_spend}€ | Clics: ${report.ads.total_clicks.toLocaleString('fr-FR')} | Impressions: ${report.ads.total_impressions.toLocaleString('fr-FR')}`);
    lines.push(`Campagnes: ${report.ads.campaign_count} | Achats trackés: ${report.ads.total_purchases}`);
  } else if (report.ads?.error) {
    lines.push(`⚠️ Meta Ads: ${report.ads.error}`);
  }

  if (report.stripe && !report.stripe.error) {
    lines.push(``);
    lines.push(`━━━ 💳 STRIPE ━━━`);
    lines.push(`Revenus: ${report.stripe.total_revenue}€ | Nouveaux abonnés: ${report.stripe.new_subscriptions} | Churn: ${report.stripe.cancelled_subscriptions}`);
    lines.push(`MRR: ${report.stripe.mrr}€ | ARR: ${report.stripe.arr}€ | Taux de churn: ${report.stripe.churn_rate}%`);
    lines.push(`Abonnés actifs total: ${report.stripe.active_subscriptions_total}`);
  } else if (report.stripe?.error) {
    lines.push(`⚠️ Stripe: ${report.stripe.error}`);
  }

  if (report.metrics) {
    lines.push(``);
    lines.push(`━━━ 📈 MÉTRIQUES CLÉS ━━━`);
    lines.push(`CAC: ${report.metrics.blended_cac != null ? report.metrics.blended_cac + '€' : 'N/A'}`);
    lines.push(`Taux de conversion: ${report.metrics.blended_conversion_rate_pct}%`);
    lines.push(`ROAS: ${report.metrics.roas}x`);
    if (report.metrics.ltv_estimate_12m) lines.push(`LTV estimé (12m): ${report.metrics.ltv_estimate_12m}€`);
    if (report.metrics.payback_period_months) lines.push(`Payback: ${report.metrics.payback_period_months} mois`);
  }

  const recs = report.recommendations;

  if (recs.stop?.length) {
    lines.push(``);
    lines.push(`━━━ 🛑 À STOPPER ━━━`);
    recs.stop.forEach(r => lines.push(`• ${r.campaign} (${r.spend}€ dépensés)\n  → ${r.reason}`));
  }

  if (recs.scale?.length) {
    lines.push(``);
    lines.push(`━━━ 🚀 À SCALER ━━━`);
    recs.scale.forEach(r => lines.push(`• ${r.campaign}\n  → ${r.reason}`));
  }

  if (recs.test?.length) {
    lines.push(``);
    lines.push(`━━━ 🧪 À TESTER ━━━`);
    recs.test.forEach(t => lines.push(`• ${t}`));
  }

  if (recs.best_hooks?.length) {
    lines.push(``);
    lines.push(`━━━ 🎯 MEILLEURS HOOKS (par CTR) ━━━`);
    recs.best_hooks.forEach((h, i) => {
      lines.push(`${i + 1}. CTR ${h.ctr}% — "${h.title}"`);
      if (h.body) lines.push(`   ${h.body.substring(0, 120)}`);
    });
  }

  if (recs.pricing_insights?.length) {
    lines.push(``);
    lines.push(`━━━ 💰 INSIGHTS PRICING THE FIVE CLUB ━━━`);
    recs.pricing_insights.forEach(p => lines.push(`• ${p}`));
  }

  return lines.join('\n');
}

// ── Trend analyser ────────────────────────────────────────────────────────────
function analyzeTrends(reports) {
  if (reports.length < 2) return null;
  const sorted = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-7);
  const previous = sorted.slice(-14, -7);

  const avgMetric = (arr, key) => {
    const vals = arr.filter(r => r.metrics?.[key] != null).map(r => r.metrics[key]);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const trend = (recentVal, prevVal) => {
    if (recentVal == null || prevVal == null || prevVal === 0) return null;
    const pct = Math.round((recentVal - prevVal) / prevVal * 1000) / 10;
    return { recent: Math.round(recentVal * 100) / 100, previous: Math.round(prevVal * 100) / 100, change_pct: pct };
  };

  const trends = {};
  for (const metric of ['blended_cac', 'blended_conversion_rate_pct', 'roas']) {
    const t = trend(avgMetric(recent, metric), avgMetric(previous, metric));
    if (t) trends[metric] = t;
  }

  const recentMrr = recent.filter(r => r.stripe?.mrr).map(r => r.stripe.mrr);
  const prevMrr = previous.filter(r => r.stripe?.mrr).map(r => r.stripe.mrr);
  if (recentMrr.length && prevMrr.length) {
    trends.mrr = trend(
      recentMrr.reduce((a, b) => a + b, 0) / recentMrr.length,
      prevMrr.reduce((a, b) => a + b, 0) / prevMrr.length
    );
  }

  const recentSpend = recent.filter(r => r.ads?.total_spend).map(r => r.ads.total_spend);
  const prevSpend = previous.filter(r => r.ads?.total_spend).map(r => r.ads.total_spend);
  if (recentSpend.length && prevSpend.length) {
    trends.ad_spend = trend(
      recentSpend.reduce((a, b) => a + b, 0) / recentSpend.length,
      prevSpend.reduce((a, b) => a + b, 0) / prevSpend.length
    );
  }

  return trends;
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status: 'ok',
  service: 'Meta MCP Server',
  version: '1.3.0',
  wa_phone_id: WHATSAPP_PHONE_NUMBER_ID || 'not set',
  ig_page_id: INSTAGRAM_PAGE_ID || 'not set',
  ads_account: META_AD_ACCOUNT_ID || 'not set',
  stripe: STRIPE_SECRET_KEY ? 'configured' : 'not set',
  scheduler: `daily at ${DAILY_REPORT_HOUR}h Paris`
}));

// ── WhatsApp Webhook ──────────────────────────────────────────────────────────
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

// ── MCP Server Factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: 'meta-messaging', version: '1.3.0' });

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
      const isUsername = isNaN(recipient_id.replace(/^@/, ''));
      const cleanUsername = recipient_id.replace(/^@/, '');
      const recipient = isUsername ? { username: cleanUsername } : { id: recipient_id };
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

  // ── Meta Ads Tools ──────────────────────────────────────────────────────────

  server.tool(
    'meta_get_ad_accounts',
    'Liste les comptes publicitaires Meta accessibles avec le token configuré.',
    {},
    async () => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      if (!token) return { content: [{ type: 'text', text: 'Erreur: Aucun token Meta configuré.' }] };
      try {
        const r = await axios.get(`${GRAPH}/me/adaccounts`, {
          params: { fields: 'id,name,account_status,currency,amount_spent', access_token: token }
        });
        const accounts = r.data.data || [];
        if (!accounts.length) return { content: [{ type: 'text', text: 'Aucun compte publicitaire trouvé. Assurez-vous que META_USER_TOKEN a la permission ads_read.' }] };
        const statusMap = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 9: 'IN_GRACE_PERIOD', 101: 'TEMPORARILY_UNAVAILABLE', 201: 'CLOSED' };
        const text = accounts.map(a =>
          `📊 ${a.name}\n  ID: ${a.id}\n  Statut: ${statusMap[a.account_status] || a.account_status}\n  Devise: ${a.currency}\n  Dépenses totales: ${(parseInt(a.amount_spent || 0) / 100).toFixed(2)} ${a.currency}`
        ).join('\n\n');
        return { content: [{ type: 'text', text: `Comptes publicitaires Meta:\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.response?.data?.error?.message || e.message}` }] };
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
        if (!campaigns.length) return { content: [{ type: 'text', text: 'Aucune campagne active trouvée.' }] };

        const insightsResults = await Promise.allSettled(
          campaigns.map(c =>
            axios.get(`${GRAPH}/${c.id}/insights`, {
              params: { fields: 'impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions', date_preset: 'last_30d', access_token: token }
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
        await axios.post(`${GRAPH}/${campaign_id}`, { status }, { params: { access_token: token } });
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
          { name, objective, status: 'PAUSED', special_ad_categories: [], daily_budget: daily_budget_cents },
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
        const params = { fields: 'id,name,status,adset_id,creative{title,body,image_url}', access_token: token, limit: 20 };
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

  // ── Stripe Tools ────────────────────────────────────────────────────────────

  server.tool(
    'stripe_get_revenue',
    'Récupère les revenus et paiements Stripe pour une période donnée.',
    {
      date_preset: z.enum(['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month']).default('last_30d').describe('Période d\'analyse')
    },
    async ({ date_preset }) => {
      if (!STRIPE_SECRET_KEY) return { content: [{ type: 'text', text: 'Erreur: STRIPE_SECRET_KEY non configuré.' }] };
      try {
        const startTs = datePresetToUnixStart(date_preset);
        const endTs = Math.floor(Date.now() / 1000);

        const charges = await stripeGetAll('charges', { 'created[gte]': startTs, 'created[lte]': endTs });
        const successful = charges.filter(c => c.status === 'succeeded' && !c.refunded);
        const refunded = charges.filter(c => c.refunded);
        const failed = charges.filter(c => c.status === 'failed');

        const totalRevenue = successful.reduce((s, c) => s + c.amount, 0) / 100;
        const totalRefunded = refunded.reduce((s, c) => s + (c.amount_refunded || 0), 0) / 100;

        // Revenue by currency
        const byCurrency = {};
        for (const c of successful) {
          const cur = c.currency.toUpperCase();
          byCurrency[cur] = (byCurrency[cur] || 0) + c.amount / 100;
        }

        // MRR from active subscriptions
        const activeSubsRes = await stripeGet('subscriptions', { status: 'active', limit: 100 });
        const mrr = (activeSubsRes.data || []).reduce((s, sub) => {
          const plan = sub.plan || sub.items?.data?.[0]?.plan;
          if (!plan) return s;
          const amount = plan.amount / 100;
          if (plan.interval === 'month') return s + amount / (plan.interval_count || 1);
          if (plan.interval === 'year') return s + amount / 12;
          return s;
        }, 0);

        const lines = [
          `💳 Revenus Stripe — Période: ${date_preset}`,
          ``,
          `Revenus nets: ${totalRevenue.toFixed(2)}€`,
          `Paiements réussis: ${successful.length}`,
          `Remboursements: ${totalRefunded.toFixed(2)}€ (${refunded.length} ops)`,
          `Paiements échoués: ${failed.length}`,
          Object.keys(byCurrency).length > 1
            ? `Par devise: ${Object.entries(byCurrency).map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`).join(' | ')}`
            : '',
          ``,
          `MRR actuel: ${mrr.toFixed(2)}€`,
          `ARR projeté: ${(mrr * 12).toFixed(2)}€`,
        ].filter(v => v !== '').join('\n');

        return { content: [{ type: 'text', text: lines }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur Stripe: ${e.message}` }] };
      }
    }
  );

  server.tool(
    'stripe_get_subscriptions_breakdown',
    'Analyse les abonnements Stripe : répartition mensuel/trimestriel/annuel, churn, nouveaux abonnés.',
    {
      date_preset: z.enum(['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month']).default('last_30d').describe('Période pour les nouveaux abonnés et le churn')
    },
    async ({ date_preset }) => {
      if (!STRIPE_SECRET_KEY) return { content: [{ type: 'text', text: 'Erreur: STRIPE_SECRET_KEY non configuré.' }] };
      try {
        const startTs = datePresetToUnixStart(date_preset);
        const endTs = Math.floor(Date.now() / 1000);

        const [newSubs, cancelledSubs, activeSubsRes] = await Promise.all([
          stripeGetAll('subscriptions', { 'created[gte]': startTs, 'created[lte]': endTs }),
          stripeGetAll('subscriptions', { 'canceled_at[gte]': startTs, 'canceled_at[lte]': endTs, status: 'canceled' }),
          stripeGet('subscriptions', { status: 'active', limit: 100 })
        ]);

        const activeSubs = activeSubsRes.data || [];

        const classify = (sub) => {
          const plan = sub.plan || sub.items?.data?.[0]?.plan;
          if (!plan) return 'unknown';
          if (plan.interval === 'year') return 'yearly';
          if (plan.interval === 'month' && plan.interval_count === 3) return 'quarterly';
          if (plan.interval === 'month') return 'monthly';
          return 'other';
        };

        const breakdown = (subs) => {
          const result = {};
          for (const sub of subs) {
            const key = classify(sub);
            if (!result[key]) result[key] = { count: 0, revenue: 0 };
            result[key].count++;
            const plan = sub.plan || sub.items?.data?.[0]?.plan;
            result[key].revenue += plan ? (plan.amount / 100) : 0;
          }
          return result;
        };

        const activeBreakdown = breakdown(activeSubs);
        const newBreakdown = breakdown(newSubs);
        const cancelledBreakdown = breakdown(cancelledSubs);
        const total = activeSubs.length;
        const churnRate = total + cancelledSubs.length > 0
          ? (cancelledSubs.length / (total + cancelledSubs.length) * 100).toFixed(2)
          : 0;

        const mrr = activeSubs.reduce((s, sub) => {
          const plan = sub.plan || sub.items?.data?.[0]?.plan;
          if (!plan) return s;
          const amount = plan.amount / 100;
          if (plan.interval === 'month') return s + amount / (plan.interval_count || 1);
          if (plan.interval === 'year') return s + amount / 12;
          return s;
        }, 0);

        const planRow = (key, data) => {
          if (!data?.count) return null;
          return `  ${key.padEnd(10)}: ${data.count} abonnés — ${data.revenue.toFixed(2)}€ (${total > 0 ? Math.round(data.count / total * 100) : 0}% du total actif)`;
        };

        const lines = [
          `📊 Abonnements Stripe — ${date_preset}`,
          ``,
          `━━ ABONNÉS ACTIFS (${total}) ━━`,
          planRow('mensuel', activeBreakdown.monthly),
          planRow('trimestriel', activeBreakdown.quarterly),
          planRow('annuel', activeBreakdown.yearly),
          planRow('autre', activeBreakdown.other),
          ``,
          `MRR: ${mrr.toFixed(2)}€ | ARR: ${(mrr * 12).toFixed(2)}€`,
          ``,
          `━━ NOUVEAUX (${newSubs.length}) ━━`,
          planRow('mensuel', newBreakdown.monthly),
          planRow('trimestriel', newBreakdown.quarterly),
          planRow('annuel', newBreakdown.yearly),
          ``,
          `━━ ANNULÉS (${cancelledSubs.length}) ━━`,
          planRow('mensuel', cancelledBreakdown.monthly),
          planRow('trimestriel', cancelledBreakdown.quarterly),
          planRow('annuel', cancelledBreakdown.yearly),
          cancelledSubs.length === 0 ? '  Aucune annulation sur la période ✅' : null,
          ``,
          `Taux de churn: ${churnRate}%`,
          `Net nouveaux: ${newSubs.length - cancelledSubs.length > 0 ? '+' : ''}${newSubs.length - cancelledSubs.length}`,
        ].filter(v => v != null).join('\n');

        return { content: [{ type: 'text', text: lines }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur Stripe: ${e.message}` }] };
      }
    }
  );

  // ── Growth Tools ────────────────────────────────────────────────────────────

  server.tool(
    'growth_match_ads_to_conversions',
    'Croise les données Meta Ads avec Stripe pour calculer le CAC réel, ROAS et taux de conversion par campagne.',
    {
      date_preset: z.enum(['last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month']).default('last_30d').describe('Période d\'analyse'),
      ad_account_id: z.string().optional().describe('ID du compte publicitaire. Utilise META_AD_ACCOUNT_ID par défaut.')
    },
    async ({ date_preset, ad_account_id }) => {
      const token = META_USER_TOKEN || INSTAGRAM_ACCESS_TOKEN;
      const accountId = ad_account_id || META_AD_ACCOUNT_ID;
      if (!token || !accountId) return { content: [{ type: 'text', text: 'Erreur: META_USER_TOKEN et META_AD_ACCOUNT_ID requis.' }] };
      if (!STRIPE_SECRET_KEY) return { content: [{ type: 'text', text: 'Erreur: STRIPE_SECRET_KEY requis pour le croisement.' }] };

      try {
        const startTs = datePresetToUnixStart(date_preset);
        const endTs = Math.floor(Date.now() / 1000);

        const [campaignsRes, newSubs, charges] = await Promise.all([
          axios.get(`${GRAPH}/${accountId}/campaigns`, {
            params: {
              fields: 'id,name,status,objective',
              effective_status: JSON.stringify(['ACTIVE', 'PAUSED']),
              access_token: token, limit: 50
            }
          }),
          stripeGetAll('subscriptions', { 'created[gte]': startTs, 'created[lte]': endTs }),
          stripeGetAll('charges', { 'created[gte]': startTs, 'created[lte]': endTs })
        ]);

        const campaigns = campaignsRes.data.data || [];
        const insightResults = await Promise.allSettled(
          campaigns.map(c =>
            axios.get(`${GRAPH}/${c.id}/insights`, {
              params: { fields: 'impressions,clicks,spend,ctr,cpc,cpm,reach,frequency', date_preset, access_token: token }
            }).then(r => ({ ...c, insights: r.data.data?.[0] || null }))
          )
        );

        const campaignData = insightResults
          .filter(r => r.status === 'fulfilled' && r.value.insights)
          .map(r => r.value);

        const totalSpend = campaignData.reduce((s, c) => s + parseFloat(c.insights.spend || 0), 0);
        const totalClicks = campaignData.reduce((s, c) => s + parseInt(c.insights.clicks || 0), 0);
        const totalRevenue = charges.filter(c => c.status === 'succeeded' && !c.refunded).reduce((s, c) => s + c.amount, 0) / 100;
        const totalNewSubs = newSubs.length;

        const blendedCac = totalNewSubs > 0 ? (totalSpend / totalNewSubs).toFixed(2) : 'N/A';
        const blendedRoas = totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : 'N/A';
        const blendedCvr = totalClicks > 0 ? (totalNewSubs / totalClicks * 100).toFixed(2) : 'N/A';

        const lines = [
          `🔗 Croisement Ads × Stripe — ${date_preset}`,
          ``,
          `MÉTRIQUES GLOBALES`,
          `  Dépenses ads: ${totalSpend.toFixed(2)}€`,
          `  Revenus Stripe: ${totalRevenue.toFixed(2)}€`,
          `  Nouveaux abonnés: ${totalNewSubs}`,
          `  CAC moyen: ${blendedCac}€`,
          `  ROAS: ${blendedRoas}x`,
          `  Taux de conversion: ${blendedCvr}%`,
          ``,
          `ATTRIBUTION PAR CAMPAGNE (proportionnelle par clics)`,
        ];

        for (const c of campaignData.sort((a, b) => parseFloat(b.insights.spend || 0) - parseFloat(a.insights.spend || 0))) {
          const spend = parseFloat(c.insights.spend || 0);
          const clicks = parseInt(c.insights.clicks || 0);
          const share = totalClicks > 0 ? clicks / totalClicks : 0;
          const estimatedSubs = totalNewSubs * share;
          const estimatedRevenue = totalRevenue * share;
          const cac = estimatedSubs > 0 ? (spend / estimatedSubs).toFixed(2) : 'N/A';
          const roas = spend > 0 ? (estimatedRevenue / spend).toFixed(2) : 'N/A';
          const ctr = parseFloat(c.insights.ctr || 0).toFixed(2);

          let verdict = '🟡';
          if (parseFloat(roas) >= 3) verdict = '🟢';
          else if (parseFloat(roas) < 1 || parseFloat(ctr) < 0.5) verdict = '🔴';

          lines.push(`\n${verdict} ${c.name}`);
          lines.push(`  Dépenses: ${spend.toFixed(2)}€ | CTR: ${ctr}% | Abonnés estimés: ${estimatedSubs.toFixed(1)}`);
          lines.push(`  CAC estimé: ${cac}€ | ROAS estimé: ${roas}x`);
        }

        lines.push(`\n⚠️ Note: attribution proportionnelle par clics (sans tracking UTM direct).`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur: ${e.message}` }] };
      }
    }
  );

  server.tool(
    'growth_daily_report',
    'Génère le rapport growth complet du jour: Ads + Stripe + CAC + ROAS + recommandations STOP/SCALE/TEST + meilleurs hooks + pricing insights.',
    {
      date_preset: z.enum(['last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month']).default('last_7d').describe('Période d\'analyse'),
      save: z.boolean().default(true).describe('Sauvegarder le rapport dans l\'historique')
    },
    async ({ date_preset, save }) => {
      try {
        const report = await generateGrowthReport(date_preset);
        if (save) saveGrowthReport(report);
        return { content: [{ type: 'text', text: formatReport(report) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ Erreur lors de la génération du rapport: ${e.message}` }] };
      }
    }
  );

  server.tool(
    'growth_detect_trends',
    'Analyse les tendances sur les rapports stockés: évolution du CAC, ROAS, MRR, taux de conversion semaine sur semaine.',
    {},
    async () => {
      const { daily } = loadGrowthReports();
      if (daily.length < 2) {
        return { content: [{ type: 'text', text: 'Pas encore assez de rapports pour détecter des tendances (minimum 2 jours). Lancez growth_daily_report chaque jour pour accumuler des données.' }] };
      }

      const trends = analyzeTrends(daily);
      if (!trends) return { content: [{ type: 'text', text: 'Données insuffisantes pour l\'analyse de tendances.' }] };

      const arrow = (pct) => {
        if (pct == null) return '—';
        if (pct > 5) return `↑ +${pct}%`;
        if (pct < -5) return `↓ ${pct}%`;
        return `→ ${pct > 0 ? '+' : ''}${pct}%`;
      };

      const isGood = (metric, pct) => {
        if (pct == null) return null;
        // CAC lower is better, others higher is better
        if (metric === 'blended_cac') return pct < 0 ? '✅' : pct > 10 ? '🔴' : '🟡';
        return pct > 5 ? '✅' : pct < -5 ? '🔴' : '🟡';
      };

      const lines = [
        `📈 ANALYSE DE TENDANCES — ${daily.length} rapports (${daily[0]?.date} → ${daily[daily.length - 1]?.date})`,
        `Comparaison: 7 derniers jours vs 7 jours précédents`,
        ``
      ];

      const metricLabels = {
        blended_cac: 'CAC',
        blended_conversion_rate_pct: 'Taux de conversion',
        roas: 'ROAS',
        mrr: 'MRR',
        ad_spend: 'Dépenses ads'
      };

      for (const [key, label] of Object.entries(metricLabels)) {
        if (trends[key]) {
          const t = trends[key];
          const icon = isGood(key, t.change_pct);
          lines.push(`${icon} ${label}: ${arrow(t.change_pct)}  (${t.previous} → ${t.recent})`);
        }
      }

      if (Object.keys(trends).length === 0) {
        lines.push('Pas encore assez de données pour la comparaison semaine sur semaine.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'growth_get_past_reports',
    'Consulte les rapports growth passés stockés localement.',
    {
      limit: z.number().int().min(1).max(30).default(7).describe('Nombre de rapports à afficher (les plus récents)'),
      summary_only: z.boolean().default(true).describe('Afficher uniquement un résumé (true) ou le rapport complet (false)')
    },
    async ({ limit, summary_only }) => {
      const { daily } = loadGrowthReports();
      if (!daily.length) return { content: [{ type: 'text', text: 'Aucun rapport stocké. Lancez growth_daily_report pour générer le premier rapport.' }] };

      const recent = daily.slice(-limit).reverse();

      if (summary_only) {
        const lines = [`📋 ${recent.length} dernier(s) rapport(s) growth:\n`];
        for (const r of recent) {
          const adInfo = r.ads && !r.ads.error
            ? `Ads: ${r.ads.total_spend}€ dépensés`
            : 'Ads: erreur';
          const stripeInfo = r.stripe && !r.stripe.error
            ? `MRR: ${r.stripe.mrr}€ | +${r.stripe.new_subscriptions} abonnés`
            : 'Stripe: erreur';
          const metricsInfo = r.metrics
            ? `CAC: ${r.metrics.blended_cac ?? 'N/A'}€ | ROAS: ${r.metrics.roas}x | CVR: ${r.metrics.blended_conversion_rate_pct}%`
            : '';
          lines.push(`📅 ${r.date} (${r.period})\n  ${adInfo} | ${stripeInfo}\n  ${metricsInfo}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n\n') }] };
      }

      return { content: [{ type: 'text', text: recent.map(r => formatReport(r)).join('\n\n' + '═'.repeat(60) + '\n\n') }] };
    }
  );

  server.tool(
    'growth_scheduler_status',
    'Affiche le statut du scheduler de rapports automatiques et la configuration actuelle.',
    {},
    async () => {
      const { daily } = loadGrowthReports();
      const lastReport = daily.length ? daily[daily.length - 1] : null;
      const lines = [
        `⏰ SCHEDULER GROWTH — STATUT`,
        ``,
        `Heure d'exécution: ${DAILY_REPORT_HOUR}h00 (Europe/Paris)`,
        `Période analysée: ${DAILY_REPORT_PRESET}`,
        `Notification WhatsApp: ${NOTIFICATION_PHONE || 'non configuré'}`,
        ``,
        `Sources configurées:`,
        `  Meta Ads: ${META_USER_TOKEN && META_AD_ACCOUNT_ID ? '✅ prêt' : '❌ META_USER_TOKEN ou META_AD_ACCOUNT_ID manquant'}`,
        `  Stripe:   ${STRIPE_SECRET_KEY ? '✅ prêt' : '❌ STRIPE_SECRET_KEY manquant'}`,
        `  WhatsApp: ${WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID ? '✅ prêt' : '⚠️ non configuré (notification désactivée)'}`,
        ``,
        `Rapports stockés: ${daily.length} (max 90 jours)`,
        lastReport ? `Dernier rapport: ${lastReport.date} à ${lastReport.generated_at}` : `Dernier rapport: aucun — utilisez growth_daily_report pour en générer un maintenant`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
  console.log(`✅ Meta MCP Server v1.3.0 running on port ${PORT}`);
  console.log(`  WA Phone ID:  ${WHATSAPP_PHONE_NUMBER_ID || 'NOT SET'}`);
  console.log(`  IG Page ID:   ${INSTAGRAM_PAGE_ID || 'NOT SET'}`);
  console.log(`  Ads Account:  ${META_AD_ACCOUNT_ID || 'NOT SET'}`);
  console.log(`  User Token:   ${META_USER_TOKEN ? '✅ set' : '❌ NOT SET'}`);
  console.log(`  Stripe:       ${STRIPE_SECRET_KEY ? '✅ set' : '❌ NOT SET'}`);
  console.log(`  Scheduler:    daily at ${DAILY_REPORT_HOUR}h (Europe/Paris), preset=${DAILY_REPORT_PRESET}`);
});

// ── Daily growth report scheduler ─────────────────────────────────────────────
const cronHour = parseInt(DAILY_REPORT_HOUR, 10);
cron.schedule(`0 ${cronHour} * * *`, async () => {
  console.log(`[Scheduler] Generating daily growth report — ${new Date().toISOString()}`);
  try {
    const report = await generateGrowthReport(DAILY_REPORT_PRESET);
    saveGrowthReport(report);
    console.log(`[Scheduler] Report saved for ${report.date}`);

    if (NOTIFICATION_PHONE && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
      const text = formatReport(report);
      // WhatsApp max message length is 4096 chars
      const truncated = text.length > 4000 ? text.substring(0, 3997) + '...' : text;
      await axios.post(
        `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        { messaging_product: 'whatsapp', to: NOTIFICATION_PHONE, type: 'text', text: { body: truncated } },
        { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      console.log(`[Scheduler] Report sent to WhatsApp ${NOTIFICATION_PHONE}`);
    }
  } catch (e) {
    console.error(`[Scheduler] Error generating report:`, e.message);
  }
}, { timezone: 'Europe/Paris' });
