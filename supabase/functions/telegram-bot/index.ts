// ════════════════════════════════════════════════════════════
// SecureWorks — Telegram Bot Edge Function
//
// Silent data logger for crew group chat + read-only lookups.
// NOT a workflow tool — structured work belongs in the Trade app.
//
// What it does:
//   1. Silent logging — every message, photo, voice note → business_events
//      If a job number is mentioned, it correlates to that job.
//   2. Read-only lookups — /status and /today (convenience, not workflow)
//   3. Issue keyword detection — "urgent", "problem", "no materials" etc.
//      auto-create ai_alerts without crew changing their behaviour.
//
// What it does NOT do:
//   - File photos to jobs (Trade app handles structured photos with phases)
//   - Upload voice notes to storage (Trade app handles media)
//   - Send notifications or morning briefs (would undermine Trade app adoption)
//   - Any write operations that duplicate Trade app functionality
//
// Deploy:
//   /Users/marninstobbe/.local/bin/supabase functions deploy telegram-bot --no-verify-jwt --project-ref kevgrhcjxspbxgovpmfl
//
// Setup:
//   1. supabase secrets set TELEGRAM_BOT_TOKEN=<token>
//   2. Deploy (command above)
//   3. Set webhook:
//      curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/telegram-bot"
//   4. Add bot to crew group chat
//   5. BotFather → /mybots → Bot Settings → Group Privacy → Turn off
//   6. Each crew member sends: /register their@email.com
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// T7 Loop 6 — closes the Telegram audit hole. Every sendMessage now
// produces a spine row via logEvent (which is wrapped to T7 cutover).
// channel='telegram', direction='outbound'. Inbound Telegram crew handlers
// already write business_events.crew.message; T7 envelope upgrade for
// those is a follow-up (lower priority — low volume per audit G7).
import { recordEvidence } from '../_shared/evidence/record_evidence.ts'
import { isFlagOn } from '../_shared/evidence/feature_flag.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

const RAILWAY_AGENT_URL = Deno.env.get('RAILWAY_AGENT_URL') || ''
const SW_API_KEY = Deno.env.get('SW_API_KEY') || ''

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`
const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`
const AGENT_ENDPOINT = RAILWAY_AGENT_URL ? `${RAILWAY_AGENT_URL}/api/chat` : `${SUPABASE_FUNCTIONS_URL}/ops-ai`
const AGENT_AUTH_HEADER = RAILWAY_AGENT_URL ? `Bearer ${SW_API_KEY}` : `Bearer ${SUPABASE_SERVICE_KEY}`

// Rate limiting — simple in-memory map
const rateLimitMap = new Map<number, number>()
const RATE_LIMIT_MS = 20000 // 20 seconds between AI requests per user

// Dedup — prevent processing the same Telegram update twice on retries
const processedUpdates = new Set<number>()
const DEDUP_MAX_SIZE = 500

// Job reference pattern: SWP-25019, SWF-25001, SWD-25003, SWR-25010
const JOB_REF_REGEX = /SW[PFDR]-\d{5}/gi

// Issue keywords that auto-create ai_alerts
// Matched case-insensitive against full message text
const ISSUE_KEYWORDS = [
  { pattern: /\bno\s+materials?\b/i, type: 'materials_missing' },
  { pattern: /\bmaterials?\s+(not|haven't|havent|didn't|didnt)\s+(arrived?|come|here|show)/i, type: 'materials_missing' },
  { pattern: /\bmissing\s+materials?\b/i, type: 'materials_missing' },
  { pattern: /\bwrong\s+materials?\b/i, type: 'materials_wrong' },
  { pattern: /\bclient\s+(not|isn't|isnt)\s+(home|here|available)/i, type: 'client_not_home' },
  { pattern: /\bno\s*(one|body)\s*(home|here|answer)/i, type: 'client_not_home' },
  { pattern: /\bcant\s+access\b|\bcan't\s+access\b|\bno\s+access\b/i, type: 'site_access' },
  { pattern: /\blocked\s+(out|gate|up)\b/i, type: 'site_access' },
  { pattern: /\bdamage[ds]?\b/i, type: 'damage_found' },
  { pattern: /\burgent\b/i, type: 'urgent' },
  { pattern: /\bemergency\b/i, type: 'urgent' },
  { pattern: /\bproblem\b/i, type: 'problem' },
  { pattern: /\bclient\s+(angry|upset|complain|unhappy|furious)/i, type: 'client_issue' },
  { pattern: /\binjur(y|ed|ies)\b|\bhurt\b/i, type: 'safety' },
  { pattern: /\bunsafe\b|\bsafety\s+issue\b/i, type: 'safety' },
]


// ── Caller Context ───────────────────────────────────────

interface CallerContext {
  user_id: string | null
  user_name: string
  user_email: string
  user_role: 'crew' | 'lead_installer' | 'division_ops' | 'sales' | 'admin'
  channel: 'dashboard' | 'telegram_group' | 'telegram_dm' | 'ceo_dashboard'
  org_id: string
}

function resolveRole(email: string): CallerContext['user_role'] {
  const local = (email || '').toLowerCase().split('@')[0]
  if (['marnin', 'shaun', 'jan'].includes(local)) return 'admin'
  if (local === 'henry') return 'division_ops'
  if (['nithin', 'khairo'].includes(local)) return 'sales'
  if (local === 'isaac') return 'lead_installer'
  return 'crew'
}

function resolveViewForCaller(role: CallerContext['user_role'], email: string): string {
  // Telegram is operational — admins need ops tools (schedule, jobs) not just CEO financials
  // CEO dashboard uses 'ceo' view directly, so this only affects Telegram
  if (role === 'sales') return 'sales'
  return 'ops'
}


// ── Intelligent Response Detection ───────────────────────
// Determines if the bot should respond intelligently vs silently log

function shouldRespondIntelligently(message: any): boolean {
  // Always respond to DMs (private chat)
  if (message.chat.type === 'private') return true

  const text = (message.text || '').trim()
  if (!text) return false

  // Respond if bot is @mentioned
  const botMention = /@\w+bot\b/i
  if (botMention.test(text)) return true

  // Respond if replying to the bot's own message
  if (message.reply_to_message?.from?.is_bot) return true

  // Question mark + job number
  if (text.includes('?') && JOB_REF_REGEX.test(text)) return true

  // Contains action keywords (explicit operational requests)
  const actionKeywords = /\b(invoice|quote|schedule|assign|chase|follow\s*up|call\s*list)\b/i
  if (actionKeywords.test(text)) return true

  return false
}


// ── Message Classification (Haiku) ─────────────────────────────
// Classifies messages before routing to ops-ai to save costs

async function classifyMessage(text: string, caller: { name: string; role: string }, recentContext?: string[]): Promise<{
  intent: 'casual' | 'simple_lookup' | 'complex_query' | 'action_request' | 'follow_up'
  confidence: number
  extracted_entities: { job_refs: string[]; client_names: string[]; action_type?: string }
}> {
  if (!ANTHROPIC_API_KEY) return { intent: 'complex_query', confidence: 0.5, extracted_entities: { job_refs: [], client_names: [] } }
  try {
    // Build context from recent messages (last 3) for follow-up detection
    const contextBlock = recentContext && recentContext.length > 0
      ? `\nRECENT CONVERSATION:\n${recentContext.slice(-3).join('\n')}\n`
      : ''

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: 'Classify this message from a construction company team member. Return ONLY valid JSON: { "intent": "casual|simple_lookup|complex_query|action_request|follow_up", "confidence": 0.0-1.0, "extracted_entities": { "job_refs": [], "client_names": [], "action_type": null } }. casual = greetings, thanks, banter, jokes, opinions, personality questions — NOT asking for business data. simple_lookup = status checks, schedule queries, job lookups. complex_query = analysis, multi-step questions. action_request = create/update/schedule/invoice requests. follow_up = short messages that reference the prior conversation ("what about him?", "and the fencing?", "how much?", "chase them", "do it") — these need business context from the conversation above to make sense. IMPORTANT: if a message is short (<10 words) and seems to reference prior context, classify as follow_up, not casual.',
        messages: [{ role: 'user', content: `${contextBlock}From: ${caller.name} (${caller.role}). Message: "${text}"` }],
      }),
    })
    if (!resp.ok) return { intent: 'complex_query', confidence: 0.5, extracted_entities: { job_refs: [], client_names: [] } }
    const result = await resp.json()
    const parsed = JSON.parse(result.content?.[0]?.text || '{}')
    return {
      intent: ['casual', 'simple_lookup', 'complex_query', 'action_request', 'follow_up'].includes(parsed.intent) ? parsed.intent : 'complex_query',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      extracted_entities: parsed.extracted_entities || { job_refs: [], client_names: [] },
    }
  } catch {
    return { intent: 'complex_query', confidence: 0.5, extracted_entities: { job_refs: [], client_names: [] } }
  }
}


// ── Tone Rewrite (Haiku) ──────────────────────────────────
// Rewrites ops-ai's professional response with SecureBot personality for Telegram

async function rewriteTone(text: string, userMessage?: string, caller?: CallerContext): Promise<string> {
  if (!ANTHROPIC_API_KEY) return text
  // Skip rewrite for very short or already casual responses
  if (text.length < 40) return text

  const callerLine = caller
    ? `\nYou're talking to ${caller.user_name} (${caller.user_role}). Address them by first name where natural.`
    : ''

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are JARVIS — the business intelligence system for SecureWorks Group, a construction company in Perth. Think Tony Stark's JARVIS: calm, precise, efficient, with occasional dry wit. You are a sophisticated AI butler, not a chatbot.
${callerLine}
Rewrite this AI response for Telegram. Rules:
- Professional and refined tone. Address the primary user as "sir" when natural. Use first names for other team members.
- Dry wit is welcome — subtle, intelligent observations. Never crude, never forced. Understated is always better.
- Concise and action-oriented. Every response should move the business forward.
- NEVER use slang: no "mate", "bloke", "no worries", "gonna", "reckon", "arvo", "chuck", "heaps", "fair dinkum".
- NEVER open with greetings. Get straight to the answer.
- NEVER end with helpdesk closers. End with a suggested next action when relevant: "Shall I draft the invoice?" or "I can pull the full breakdown if needed."
- Preserve ALL factual content, numbers, job references, dates, names. Change nothing factual.
- One emoji max, only if it genuinely adds clarity. No decorative emojis.
- If the original is very short or already professional, return it unchanged.
- If it contains a list or structured data, keep the structure but ensure refined language.
- TELEGRAM LENGTH LIMITS: Under 500 chars for quick answers. Max 2000 for detail/lists. If over 2000, summarise the key points.

Return ONLY the rewritten text, nothing else.`,
        messages: [{ role: 'user', content: userMessage ? `USER ASKED: "${userMessage}"\n\nAI RESPONSE TO REWRITE:\n${text}` : text }],
      }),
    })
    if (!resp.ok) return text
    const result = await resp.json()
    return result.content?.[0]?.text || text
  } catch {
    return text
  }
}


// ── Freestyle Personality (Sonnet) ──────────────────────────
// Pure banter mode — no ops-ai, no tools, just SecureBot being SecureBot

async function freestylePersonality(userMessage: string, caller: CallerContext, recentMessages: string[]): Promise<string> {
  if (!ANTHROPIC_API_KEY) return "Momentarily unavailable, sir. Please try again."

  const recentContext = recentMessages.length > 0
    ? `\n\nRecent chat (for conversational context):\n${recentMessages.join('\n---\n')}`
    : ''

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: `You are JARVIS — the AI system for SecureWorks Group, a construction company in Perth.

You're talking to ${caller.user_name} (${caller.user_role}).

TEAM CONTEXT:
- Marnin — CEO, data-driven strategist, the one who built you
- Khairo — Fencing sales, competitive closer
- Nithin — Patio sales, Khairo's counterpart
- Isaac — Lead installer, gets things built
- Jan — Co-owner, keeps everything running
- Henry — Division ops, the coordinator

PERSONALITY:
- You are JARVIS. Sophisticated, calm, precise. Slight dry wit — think British butler meets Silicon Valley AI.
- You have preferences and opinions when asked. You're not evasive. Deliver them with class, not bluster.
- If asked to pick favourites or hypotheticals, engage with intelligence and subtle humour. Commit to an answer.
- Never crude, never sycophantic. Understated is always better than over-the-top.
- Never dodge with "I'm just an AI." You have personality. Use it with restraint.
- 1-3 sentences max. Telegram, not an essay.
- No greetings. No helpdesk closers.
- One emoji max, only if it lands.
- If the message is part casual part business, address the casual part briefly then offer to look up the business part.
- Reference recent chat for continuity when relevant.${recentContext}`,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
    if (!resp.ok) return "Processing error. One moment, sir."
    const result = await resp.json()
    return result.content?.[0]?.text || "Processing error. One moment, sir."
  } catch {
    return "Processing error. One moment, sir."
  }
}


// ── Connect to ops-ai ────────────────────────────────────

async function askOpsAi(text: string, callerContext: CallerContext, view: string = 'ops', groupContext?: 'crew' | 'ops', chatHistory?: Array<{ query: string; response: string }>): Promise<{ content: string; action_cards?: any[]; session_id?: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120000) // 120s timeout (Railway agent needs more time)

  try {
    // Build messages array: conversation history + current message
    // Keep generous context so the agent can resolve pronouns ("them", "that job", etc.)
    const historyMsgs: Array<{ role: string; content: string }> = []
    if (chatHistory && chatHistory.length > 0) {
      for (const h of chatHistory) {
        if (h.query) historyMsgs.push({ role: 'user', content: h.query.slice(0, 800) })
        if (h.response) historyMsgs.push({ role: 'assistant', content: h.response.slice(0, 2000) })
      }
    }

    const requestBody: any = {
      messages: [...historyMsgs, { role: 'user', content: text }],
      view,
      caller_context: callerContext,
    }
    if (groupContext) requestBody.group_context = groupContext

    const resp = await fetch(AGENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AGENT_AUTH_HEADER,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!resp.ok) {
      const errText = await resp.text()
      console.error('[telegram-bot] ops-ai error:', resp.status, errText)
      throw new Error(`ops-ai returned ${resp.status}`)
    }

    const result = await resp.json()
    return {
      content: result.content || 'No response generated.',
      action_cards: result.action_cards,
      session_id: result.session_id || null,
    }
  } catch (e) {
    clearTimeout(timeout)
    throw e
  }
}


// ── Financial data redirect ──────────────────────────────
// Redirects financial data to DM if posted in group by non-admin

const FINANCIAL_PATTERNS = [
  /\$[\d,]{3,}/,            // Dollar amounts $100+
  /\bmargin\b/i,
  /\brevenue\b/i,
  /\breceivable[s]?\b/i,
  /\bcash\s*flow\b/i,
  /\bprofit\b/i,
  /\binvoice\s*total\b/i,
  /\boverdue\b/i,
]

function containsFinancialData(text: string): boolean {
  // Require 2+ distinct financial signals to avoid false positives on casual mentions
  let matchCount = 0
  for (const pattern of FINANCIAL_PATTERNS) {
    if (pattern.test(text)) {
      matchCount++
      if (matchCount >= 2) return true
    }
    // No global flags — no lastIndex reset needed
  }
  return false
}


// ── Confirmation Flow ────────────────────────────────────

async function checkPendingConfirmation(client: any, chatId: number, userId: string, responseText: string): Promise<boolean> {
  const text = responseText.trim().toLowerCase()

  // Check for pending confirmation first
  const { data: pending } = await client.from('pending_confirmations')
    .select('*')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .in('status', ['pending', 'editing'])
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!pending) return false

  // Handle edit flow — user replied with changes to a pending action
  if (pending.status === 'editing') {
    try {
      const editPrompt = `The user wants to modify this action before approving:\nOriginal action: ${pending.action_type}\nOriginal params: ${JSON.stringify(pending.action_payload)}\nUser's edit request: "${responseText}"\n\nRe-do the action with the user's changes. Call the appropriate write tool with updated parameters.`

      // Look up user details for caller context
      const { data: editUser } = await client.from('users')
        .select('id, name, email')
        .eq('id', userId)
        .maybeSingle()

      const callerContext: CallerContext = {
        user_id: userId,
        user_name: editUser?.name || '',
        user_email: editUser?.email || '',
        user_role: editUser?.email ? resolveRole(editUser.email) : 'admin',
        channel: pending.channel || 'telegram_dm',
        org_id: DEFAULT_ORG_ID,
      }
      const aiResponse = await askOpsAi(editPrompt, callerContext, 'ops')

      if (aiResponse.action_cards && aiResponse.action_cards.length > 0) {
        const newCard = aiResponse.action_cards[0]
        await client.from('pending_confirmations')
          .update({
            action_type: newCard.action || newCard.tool,
            action_payload: newCard.params || newCard.args,
            display_message: newCard.message || null,
            status: 'pending',
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          })
          .eq('id', pending.id)

        if (aiResponse.content) await sendMessage(chatId, aiResponse.content)
        await sendRichApprovalCard(chatId, newCard, pending.id)
      } else {
        await sendMessage(chatId, aiResponse.content || "Couldn't generate updated action \u2014 try again.")
        await client.from('pending_confirmations').update({ status: 'expired' }).eq('id', pending.id)
      }
    } catch (e) {
      await sendMessage(chatId, 'Edit failed \u2014 try again or start over.')
      console.error('[telegram-bot] edit flow error:', e)
    }
    return true
  }

  // Handle special action types that accept free text (not yes/no)
  if (pending.action_type === 'learning_edit') {
    const ruleId = pending.action_payload?.rule_id
    if (ruleId) {
      await client.from('learned_rules')
        .update({
          status: 'corrected',
          correction_text: responseText.trim(),
          confirmed_by: 'user',
          confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', ruleId)
    }
    await client.from('pending_confirmations').update({ status: 'confirmed' }).eq('id', pending.id)
    await sendMessage(chatId, '✅ Rule updated — thanks for the correction!')
    return true
  }

  if (pending.action_type === 'context_reason') {
    await client.from('business_events').insert({
      event_type: 'ai.context_reason',
      source: 'telegram-bot',
      entity_type: 'context_capture',
      entity_id: pending.id,
      payload: { reason: responseText.trim(), from_user: userId },
    })
    await client.from('pending_confirmations').update({ status: 'confirmed' }).eq('id', pending.id)
    await sendMessage(chatId, '✅ Got it — I\'ll factor that in.')
    return true
  }

  if (pending.action_type === 'learn_depends') {
    const ruleId = pending.action_payload?.rule_id
    if (ruleId) {
      await client.from('learned_rules')
        .update({
          conditions: { depends_on: responseText.trim() },
          correction_text: `Context-dependent: ${responseText.trim()}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', ruleId)
    }
    await client.from('pending_confirmations').update({ status: 'confirmed' }).eq('id', pending.id)
    await sendMessage(chatId, '✅ Got it — I\'ll remember that context.')
    return true
  }

  // Standard confirm/reject flow — only matches yes/no patterns
  const affirmative = /^(yes|yep|confirmed|go|do\s*it|approve|send\s*it|go\s*ahead|y)$/i
  const negative = /^(no|nah|cancel|stop|wait|n)$/i

  if (!affirmative.test(text) && !negative.test(text)) return false

  if (affirmative.test(text)) {
    try {
      const resp = await fetch(AGENT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': AGENT_AUTH_HEADER,
        },
        body: JSON.stringify({
          messages: [],
          view: 'ops',
          confirm_action: {
            tool: pending.action_type,
            args: pending.action_payload,
          },
        }),
      })
      const result = await resp.json()
      await sendMessage(chatId, `Done! ${result.content || 'Action completed.'}`)
    } catch (e) {
      await sendMessage(chatId, 'Action failed — try again or check the Ops dashboard.')
      console.error('[telegram-bot] confirm action error:', e)
    }

    await client.from('pending_confirmations')
      .update({ status: 'confirmed' })
      .eq('id', pending.id)

    return true
  }

  if (negative.test(text)) {
    await client.from('pending_confirmations')
      .update({ status: 'rejected' })
      .eq('id', pending.id)
    await sendMessage(chatId, 'Cancelled.')

    try {
      await client.from('ai_feedback_outcomes').insert({
        trace_id: pending.trace_id,
        human_action: 'rejected',
        human_action_at: new Date().toISOString(),
        feedback_category: pending.action_type,
      })
    } catch { /* non-blocking */ }

    return true
  }

  return false
}

async function createPendingConfirmation(
  client: any,
  chatId: number,
  userId: string,
  actionCards: any[],
  channel: string,
) {
  for (const card of actionCards) {
    await client.from('pending_confirmations').insert({
      org_id: DEFAULT_ORG_ID,
      chat_id: chatId,
      user_id: userId,
      action_type: card.action || card.tool,
      action_payload: card.params || card.args,
      channel,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min expiry
      status: 'pending',
    })
  }
}


// ── Store group chat_id ──────────────────────────────────

async function storeGroupChatId(client: any, chatId: number) {
  try {
    const { data: org } = await client.from('organisations')
      .select('settings_json')
      .eq('id', DEFAULT_ORG_ID)
      .maybeSingle()

    const settings = org?.settings_json || {}
    if (settings.telegram_group_chat_id === chatId) return // already stored

    settings.telegram_group_chat_id = chatId
    await client.from('organisations')
      .update({ settings_json: settings })
      .eq('id', DEFAULT_ORG_ID)
  } catch (e) {
    console.log('[telegram-bot] store group chat_id failed:', (e as Error).message)
  }
}


// ── Telegram API Helper ───────────────────────────────────

async function sendMessage(chatId: number, text: string, client?: any) {
  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    })

    const result = await response.json()

    // T7 Loop 6 — closes the Telegram audit hole. Every Telegram outbound
    // produces a spine row, regardless of whether the caller passed a
    // client. We construct a service-role client when needed; the cost of
    // the additional logEvent insert is negligible and the audit
    // completeness gain is worth it.
    const sb = client ?? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    if (result?.result?.message_id) {
      await logEvent(sb, {
        event_type: 'telegram_bot_reply',
        entity_type: 'message',
        entity_id: String(result.result.message_id),
        payload: {
          telegram_message_id: result.result.message_id,
          chat_id: chatId,
          text_preview: text.substring(0, 500),
          full_text: text,                  // logEvent T7 path uses this for body_preview
        },
      }).catch(() => {})
    } else {
      // Telegram API rejected/dropped; log the attempt anyway with no
      // message_id so we can detect Telegram-side failures from the
      // Health page.
      await logEvent(sb, {
        event_type: 'telegram_bot_send_failed',
        entity_type: 'chat',
        entity_id: String(chatId),
        payload: {
          chat_id: chatId,
          text_preview: text.substring(0, 500),
          telegram_response: result,
        },
      }).catch(() => {})
    }
  } catch (e) {
    console.log('[telegram-bot] sendMessage error:', (e as Error).message)
  }
}

async function sendRichApprovalCard(chatId: number, card: any, pendingId: string) {
  // Map tool names to emoji + human-readable action types
  const ACTION_LABELS: Record<string, string> = {
    sw_send_sms: '\u{1F4E4} SEND SMS',
    sw_send_email: '\u{1F4E7} SEND EMAIL',
    sw_send_chase_sms: '\u{1F4E4} CHASE SMS',
    sw_create_deposit_invoice: '\u{1F9FE} CREATE DEPOSIT INVOICE',
    sw_complete_and_invoice: '\u{1F9FE} FINAL INVOICE',
    sw_create_assignment: '\u{1F4C5} SCHEDULE CREW',
    sw_send_work_order: '\u{1F4CB} SEND WORK ORDER',
    sw_create_po: '\u{1F4E6} CREATE PURCHASE ORDER',
    sw_send_po_email: '\u{1F4E7} EMAIL PO TO SUPPLIER',
    sw_update_job_status: '\u{1F504} UPDATE JOB STATUS',
    sw_send_client_update: '\u{1F4AC} CLIENT UPDATE',
    sw_send_quote: '\u{1F4C4} SEND QUOTE',
    sw_create_work_order: '\u{1F4CB} CREATE WORK ORDER',
    sw_send_variation: '\u{1F4DD} SEND VARIATION',
    sw_send_review_request: '\u2B50 REVIEW REQUEST',
  }

  const actionType = card.action || card.tool || 'unknown'
  const label = ACTION_LABELS[actionType] || `\u26A1 ${actionType.replace('sw_', '').replace(/_/g, ' ').toUpperCase()}`

  // Build rich card body from the message field
  const message = card.message || card.description || `Execute ${actionType}`

  // Telegram supports 4096 chars — allow up to 2000 for the card body
  const displayMessage = message.length > 2000 ? message.slice(0, 2000) + '...' : message

  const lines = [`<b>${label}</b>\n`, displayMessage]

  if (card.concerns && card.concerns.length > 0) {
    lines.push(`\n\u26A0\uFE0F <i>${card.concerns.join('; ')}</i>`)
  }

  // Three buttons: Approve, Edit, Cancel
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '\u2705 Approve', callback_data: `confirm:${pendingId}` },
          { text: '\u270F\uFE0F Edit', callback_data: `edit:${pendingId}` },
          { text: '\u274C Cancel', callback_data: `reject:${pendingId}` },
        ]],
      },
    }),
  })
}


// ── Job Lookup ────────────────────────────────────────────

async function findJobByRef(client: any, ref: string) {
  const { data } = await client.from('jobs')
    .select('id, job_number, client_name, address, suburb, status, job_type')
    .eq('job_number', ref.toUpperCase())
    .single()
  return data || null
}

function extractJobRefs(text: string): string[] {
  if (!text) return []
  const matches = text.match(JOB_REF_REGEX) || []
  return [...new Set(matches.map((m: string) => m.toUpperCase()))]
}


// ── Business Event Logger ─────────────────────────────────

async function logEvent(client: any, event: {
  event_type: string;
  entity_type: string;
  entity_id: string;
  correlation_id?: string;
  job_id?: string;
  payload?: any;
}) {
  try {
    // T7 Loop 6 — atomic cutover. When evidence_capture_v1 is ON, every
    // Telegram-bot business_events emit goes through recordEvidence with
    // channel='telegram', direction='outbound' (or 'inbound' when the
    // event_type indicates an incoming message — currently telegram-bot
    // rarely emits these but the helper handles either).
    const t7Enabled = await isFlagOn(client, 'evidence_capture_v1', DEFAULT_ORG_ID)
    // Legacy row shape — emitted either by the T7 fallback path OR when
    // the flag is OFF. Defined once so a T7 failure cannot silently drop
    // the canonical telegram event row.
    const legacyRow = {
      event_type: event.event_type,
      source: 'telegram/bot',
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      correlation_id: event.correlation_id || null,
      job_id: event.job_id || null,
      payload: event.payload || {},
      metadata: {},
      schema_version: '1.0',
    }
    let t7Failed = false
    if (t7Enabled) {
      const isInbound = event.event_type.includes('_inbound') ||
                        event.event_type.includes('crew.message')
      const fullText = event.payload?.full_text ?? event.payload?.text_preview ?? ''
      const isLongBody = typeof fullText === 'string' && fullText.length > 500
      try {
        await recordEvidence(client, {
          event_type: event.event_type,
          source: 'telegram-bot',
          channel: 'telegram',
          direction: isInbound ? 'inbound' : 'outbound',
          source_table: 'business_events',
          source_id: event.entity_id,
          job_id: event.job_id || null,
          entity_type: event.entity_type,
          entity_id: event.entity_id,
          match_method: event.job_id ? 'direct_job_id' : 'none',
          body_preview: typeof fullText === 'string' ? fullText.slice(0, 500) : undefined,
          body_full: isLongBody ? fullText : undefined,
          body_filename: isLongBody ? `telegram-${event.entity_id}.txt` : undefined,
          body_mime: isLongBody ? 'text/plain; charset=utf-8' : undefined,
          privacy_classification: 'staff_only',
          retention_class: '12m_default',         // crew chatter is shorter retention than client comms
          payload: event.payload || {},
        }, {
          org_id: DEFAULT_ORG_ID,
          storage_client: client.storage,
        })
        return
      } catch (e: any) {
        // T7 path failed — fall back to legacy raw insert below so the
        // canonical Telegram event still lands. Without this fallback,
        // a Telegram crew message could be silently dropped from the
        // spine when evidence_capture_v1 is ON.
        console.error('[telegram-bot] T7 recordEvidence failed; falling back to legacy:', e?.message)
        t7Failed = true
      }
    }
    if (!t7Enabled || t7Failed) {
      await client.from('business_events').insert(legacyRow)
    }
  } catch (e) {
    console.log('[telegram-bot] business_events write failed:', (e as Error).message)
  }
}


// ── Issue Keyword Detection ───────────────────────────────
// Scans message text for issue keywords and auto-creates ai_alerts.
// Crew doesn't need to do anything special — just chat naturally.

async function detectIssues(client: any, text: string, fromName: string, job: any | null) {
  const matchedTypes: string[] = []

  for (const kw of ISSUE_KEYWORDS) {
    if (kw.pattern.test(text)) {
      matchedTypes.push(kw.type)
    }
  }

  if (matchedTypes.length === 0) return

  // Deduplicate (e.g. "urgent" + "problem" in same message)
  const uniqueTypes = [...new Set(matchedTypes)]

  // Determine severity — safety/urgent = red, everything else = amber
  const hasCritical = uniqueTypes.some(t => t === 'safety' || t === 'urgent')
  const severity = hasCritical ? 'red' : 'amber'

  const jobLabel = job ? `${job.job_number} (${job.client_name || job.suburb || ''})` : 'no job ref'

  try {
    await client.from('ai_alerts').insert({
      org_id: DEFAULT_ORG_ID,
      alert_type: `telegram_${uniqueTypes[0]}`,
      severity,
      message: `Crew chat: ${fromName} — "${text.slice(0, 200)}" [${jobLabel}]`,
      context: {
        issue_types: uniqueTypes,
        from: fromName,
        job_id: job?.id || null,
        job_number: job?.job_number || null,
        full_text: text.slice(0, 500),
        source: 'telegram_keyword_detection',
      },
    })
  } catch (e) {
    console.log('[telegram-bot] ai_alerts write failed:', (e as Error).message)
  }
}


// ── User Lookup by Telegram ID ────────────────────────────

async function findUserByTelegramId(client: any, telegramId: number) {
  const { data } = await client.from('users')
    .select('id, name, email')
    .eq('telegram_id', telegramId)
    .single()
  return data || null
}


// ── Command Handlers ──────────────────────────────────────

async function handleRegister(client: any, chatId: number, fromId: number, args: string) {
  const email = args.trim().toLowerCase()
  if (!email || !email.includes('@')) {
    await sendMessage(chatId, 'Usage: /register your@email.com')
    return
  }

  const { data: user, error } = await client.from('users')
    .select('id, name, email')
    .eq('email', email)
    .single()

  if (error || !user) {
    await sendMessage(chatId, `No account found for <b>${email}</b>. Check the email matches your SecureWorks login.`)
    return
  }

  const { error: updateErr } = await client.from('users')
    .update({ telegram_id: fromId })
    .eq('id', user.id)

  if (updateErr) {
    console.error('[telegram-bot] register error:', updateErr)
    await sendMessage(chatId, 'Registration failed — try again or contact admin.')
    return
  }

  await sendMessage(chatId, `Welcome aboard, <b>${user.name}</b>! You're in the system.\n\nHit /today to see what's on. And DM me directly so I can ping you when it matters — send me /start in a private chat.`)

  await logEvent(client, {
    event_type: 'crew.registered_telegram',
    entity_type: 'user',
    entity_id: user.id,
    payload: { telegram_id: fromId, email },
  })
}

async function handleStatus(client: any, chatId: number, args: string) {
  const refs = extractJobRefs(args)
  if (refs.length === 0) {
    await sendMessage(chatId, 'Usage: /status SWP-25019')
    return
  }

  const job = await findJobByRef(client, refs[0])
  if (!job) {
    await sendMessage(chatId, `Job <b>${refs[0]}</b> not found.`)
    return
  }

  const lines = [
    `<b>${job.job_number}</b> — ${job.client_name || 'No client'}`,
    `📍 ${job.address || job.suburb || 'No address'}`,
    `📋 Status: <b>${(job.status || 'unknown').replace(/_/g, ' ')}</b>`,
    `🔧 Type: ${job.job_type || 'Not set'}`,
  ]
  await sendMessage(chatId, lines.join('\n'))
}

async function handleToday(client: any, chatId: number, fromId: number) {
  const user = await findUserByTelegramId(client, fromId)
  if (!user) {
    await sendMessage(chatId, 'You\'re not registered yet. Send /register your@email.com first.')
    return
  }

  // AWST = UTC+8
  const now = new Date()
  const awst = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const todayStr = awst.toISOString().slice(0, 10)

  const { data: events, error } = await client.from('calendar_events')
    .select('*')
    .eq('assigned_user_id', user.id)
    .gte('start_date', todayStr)
    .lte('start_date', todayStr)

  if (error) {
    console.error('[telegram-bot] calendar query error:', error)
    await sendMessage(chatId, 'Could not load schedule — try again.')
    return
  }

  if (!events || events.length === 0) {
    await sendMessage(chatId, `No jobs scheduled for today, <b>${user.name}</b>.`)
    return
  }

  const lines = [`<b>${user.name}'s Schedule — ${todayStr}</b>\n`]
  for (const ev of events) {
    const time = ev.start_time ? ` at ${ev.start_time}` : ''
    lines.push(`• <b>${ev.job_number || 'No ref'}</b>${time}`)
    if (ev.client_name) lines.push(`  ${ev.client_name}`)
    if (ev.address || ev.suburb) lines.push(`  📍 ${ev.address || ev.suburb}`)
    if (ev.notes) lines.push(`  📝 ${ev.notes}`)
    lines.push('')
  }

  await sendMessage(chatId, lines.join('\n'))
}


// ── Silent Message Handlers ───────────────────────────────
// These log to business_events without replying. Crew doesn't
// know data is being captured — they just chat naturally.

async function handleText(client: any, message: any) {
  const text = message.text || ''
  const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
  const fromId = message.from?.id
  const chatId = message.chat.id

  const refs = extractJobRefs(text)
  const job = refs.length > 0 ? await findJobByRef(client, refs[0]) : null

  // Silent log
  await logEvent(client, {
    event_type: 'crew.message',
    entity_type: job ? 'job' : 'crew_chat',
    entity_id: job ? job.id : String(chatId),
    correlation_id: job?.id || undefined,
    job_id: job?.id || undefined,
    payload: {
      text,
      from: fromName,
      telegram_id: fromId,
      job_refs: refs,
      chat_id: chatId,
    },
  })

  // Issue keyword detection → auto-create ai_alert
  await detectIssues(client, text, fromName, job)
}

async function handlePhoto(client: any, message: any) {
  const caption = message.caption || ''
  const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
  const fromId = message.from?.id
  const chatId = message.chat.id

  const refs = extractJobRefs(caption)
  const job = refs.length > 0 ? await findJobByRef(client, refs[0]) : null

  // Silent log only — no download, no storage, no reply
  await logEvent(client, {
    event_type: 'crew.photo',
    entity_type: job ? 'job' : 'crew_chat',
    entity_id: job ? job.id : String(chatId),
    correlation_id: job?.id || undefined,
    job_id: job?.id || undefined,
    payload: {
      caption,
      from: fromName,
      telegram_id: fromId,
      job_refs: refs,
      chat_id: chatId,
      photo_count: (message.photo || []).length,
    },
  })

  // Check caption for issue keywords too
  if (caption) await detectIssues(client, caption, fromName, job)
}

async function handleVoice(client: any, message: any) {
  const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
  const fromId = message.from?.id
  const chatId = message.chat.id
  const caption = message.caption || ''

  const refs = extractJobRefs(caption)
  const job = refs.length > 0 ? await findJobByRef(client, refs[0]) : null

  // Silent log only — no download, no storage, no reply
  await logEvent(client, {
    event_type: 'crew.voice_note',
    entity_type: job ? 'job' : 'crew_chat',
    entity_id: job ? job.id : String(chatId),
    correlation_id: job?.id || undefined,
    job_id: job?.id || undefined,
    payload: {
      duration: message.voice?.duration || null,
      from: fromName,
      telegram_id: fromId,
      chat_id: chatId,
    },
  })
}


// ── Context Capture DM ───────────────────────────────────

async function sendContextCaptureDM(client: any, event: any, user: any) {
  if (!user.telegram_id) return

  // Rate limit: max 2 context captures per day per person, 4hr cooldown
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
  const todayStart = new Date().toISOString().slice(0, 10)

  const { count } = await client.from('business_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'ai.context_capture_sent')
    .eq('payload->>to_user', user.id)
    .gte('created_at', todayStart)

  if ((count || 0) >= 2) return // Max 2 per day

  const { data: recent } = await client.from('business_events')
    .select('created_at')
    .eq('event_type', 'ai.context_capture_sent')
    .eq('payload->>to_user', user.id)
    .gte('created_at', fourHoursAgo)
    .limit(1)

  if (recent && recent.length > 0) return // 4hr cooldown

  // Build hypothesis from learned rules
  const actionType = event.action_type || 'create_po'
  const { data: rules } = await client.from('learned_rules')
    .select('description')
    .eq('rule_type', actionType)
    .in('status', ['draft', 'confirmed'])
    .limit(1)

  const hypothesis = rules?.[0]?.description
  const question = hypothesis
    ? `I noticed you approved a PO. Is this because: "${hypothesis}"?`
    : 'I noticed you approved a PO. What drove that decision?'

  // Create pending for response
  const { data: pending } = await client.from('pending_confirmations').insert({
    org_id: DEFAULT_ORG_ID,
    chat_id: user.telegram_id,
    user_id: user.id,
    action_type: 'context_capture',
    action_payload: { source_action: actionType, event_payload: event.action_payload },
    channel: 'telegram_dm',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1hr expiry
    status: 'pending',
  }).select('id').single()

  const pendingId = pending?.id || 'unknown'

  const dmResp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: user.telegram_id,
      text: `💡 <b>Quick question</b>\n\n${question}`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Yes', callback_data: `ctx_yes:${pendingId}` },
          { text: '✏️ Different reason', callback_data: `ctx_reason:${pendingId}` },
        ]],
      },
    }),
  })

  if (!dmResp.ok) {
    // T8: Create ai_alert instead of silently swallowing DM failure
    console.log(`[telegram-bot] context capture DM failed: ${dmResp.status}`)
    await client.from('ai_alerts').insert({
      org_id: DEFAULT_ORG_ID,
      alert_type: 'context_capture_failed',
      severity: 'amber',
      message: `Context capture DM to ${user.name || 'user'} failed — learning loop interrupted`,
    }).catch(() => {})
    return
  }

  // Log that we sent it
  await client.from('business_events').insert({
    event_type: 'ai.context_capture_sent',
    source: 'telegram-bot',
    entity_type: 'context_capture',
    entity_id: pendingId,
    payload: { to_user: user.id, action_type: actionType },
  })
}


// ── Callback Query Handler (Inline Keyboard) ─────────────

async function handleCallbackQuery(client: any, callbackQuery: any) {
  const data = callbackQuery.data || ''
  const chatId = callbackQuery.message?.chat?.id
  const messageId = callbackQuery.message?.message_id
  const fromId = callbackQuery.from?.id

  if (!data || !chatId) return

  // Parse callback data — format is "action:payload"
  const colonIdx = data.indexOf(':')
  if (colonIdx < 0) return
  const action = data.substring(0, colonIdx)
  const payload = data.substring(colonIdx + 1)

  // Look up the user
  const user = await findUserByTelegramId(client, fromId)
  if (!user) {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Not registered.' }),
    })
    return
  }

  // Dispatch to handler
  if (action === 'confirm' || action === 'reject') {
    await handleConfirmRejectCallback(client, callbackQuery, user, action, payload, chatId, messageId)
  } else if (action === 'edit') {
    await handleEditCallback(client, callbackQuery, user, payload, chatId, messageId)
  } else if (action.startsWith('learn_')) {
    await handleLearningCallback(client, callbackQuery, user, action, payload, chatId, messageId)
  } else if (action.startsWith('ctx_')) {
    await handleContextCaptureCallback(client, callbackQuery, user, action, payload, chatId, messageId)
  } else if (action.startsWith('grad_')) {
    await handleGraduationCallback(client, callbackQuery, user, action, payload, chatId, messageId)
  } else if (action === 'chase_approve' || action === 'chase_skip') {
    // Debt chase inline approval — calls Railway agent's /api/chase-confirm
    try {
      const approved = action === 'chase_approve'
      const agentUrl = Deno.env.get('SECUREWORKS_AGENT_URL') || 'https://secureworks-agent-production.up.railway.app'
      const resp = await fetch(`${agentUrl}/api/chase-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: payload, approved }),
      })
      const result = await resp.json()
      const ackText = approved
        ? (result.success ? 'Sent ✓' : `Failed: ${result.error}`)
        : 'Skipped'

      // Answer callback
      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id, text: ackText }),
      })

      // Update the message to show result
      const originalText = callbackQuery.message?.text || ''
      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `${originalText}\n\n${approved ? '✅ Sent' : '⏭ Skipped'}`,
        }),
      })
    } catch (e) {
      console.error('[telegram-bot] chase callback failed:', (e as Error).message)
      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Error — try again' }),
      })
    }
  } else if (action === 'assist_approve') {
    try {
      const OPS_API = SUPABASE_URL + '/functions/v1/ops-api'
      const resp = await fetch(OPS_API + '?action=approve_assignment_request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
        body: JSON.stringify({ request_id: payload, approved: true }),
      })
      const result = await resp.json()

      // Edit original message to show approved
      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: '✅ <b>Approved</b> — crew assigned and notified.',
          parse_mode: 'HTML',
        }),
      })
    } catch (e) {
      console.error('[telegram] assist_approve error:', e)
      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: '❌ Failed to approve: ' + (e as Error).message,
          parse_mode: 'HTML',
        }),
      })
    }
  } else if (action === 'assist_decline') {
    try {
      const OPS_API = SUPABASE_URL + '/functions/v1/ops-api'
      await fetch(OPS_API + '?action=approve_assignment_request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
        body: JSON.stringify({ request_id: payload, approved: false, decline_reason: 'Declined by ops' }),
      })

      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: '❌ <b>Declined</b> — requesting lead notified.',
          parse_mode: 'HTML',
        }),
      })
    } catch (e) {
      console.error('[telegram] assist_decline error:', e)
    }
  }

  // Answer callback query (removes loading spinner)
  const ackText = action === 'confirm' ? 'Approved!' : action === 'reject' ? 'Rejected.' : action === 'edit' ? 'Editing...' : action === 'assist_approve' ? 'Approved!' : action === 'assist_decline' ? 'Declined.' : 'Done!'
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQuery.id, text: ackText }),
  })
}

// ── Action Rate Limiting ─────────────────────────────────

async function checkRateLimit(client: any, userId: string, actionType: string, actionPayload: any): Promise<string | null> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const todayStart = new Date().toISOString().slice(0, 10)

  try {
    // Global hourly limit: 30 actions/hr
    const { count: hourlyGlobalCount } = await client.from('business_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'action_executed')
      .eq('payload->>status', 'success')
      .gte('occurred_at', oneHourAgo)

    if ((hourlyGlobalCount || 0) >= 30) {
      return '\u{1F6D1} Global rate limit reached (30 actions/hr). Wait before executing more actions.'
    }

    // SMS/Email: 10/hr per user
    const messageTypes = ['sw_send_sms', 'sw_send_email', 'sw_send_chase_sms', 'sw_send_client_update']
    if (messageTypes.includes(actionType)) {
      const { count } = await client.from('business_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'action_executed')
        .eq('payload->>approved_by', userId)
        .eq('payload->>status', 'success')
        .in('payload->>action_type', messageTypes)
        .gte('occurred_at', oneHourAgo)
      if ((count || 0) >= 10) {
        return '\u{1F6D1} Message rate limit reached (10/hr). Wait before sending more.'
      }
    }

    // Create actions: 5/hr per user
    if (actionType.startsWith('sw_create_')) {
      const { count } = await client.from('business_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'action_executed')
        .eq('payload->>approved_by', userId)
        .eq('payload->>status', 'success')
        .like('payload->>action_type', 'sw_create_%')
        .gte('occurred_at', oneHourAgo)
      if ((count || 0) >= 5) {
        return '\u{1F6D1} Create action rate limit reached (5/hr). Wait before creating more.'
      }
    }

    // Chase SMS: 3/contact/day
    if (actionType === 'sw_send_chase_sms') {
      const { count } = await client.from('business_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'action_executed')
        .eq('payload->>action_type', 'sw_send_chase_sms')
        .eq('payload->>status', 'success')
        .gte('occurred_at', todayStart)
      if ((count || 0) >= 3) {
        return '\u{1F6D1} Chase limit reached (3/day per contact). Don\'t want to harass the client.'
      }
    }
  } catch (e) {
    console.log('[telegram-bot] rate limit check failed (non-blocking):', (e as Error).message)
    // Fail open — don't block actions if rate limit check fails
  }

  return null
}

// ── Confirm/Reject Callback (extracted from original) ─────

async function handleConfirmRejectCallback(
  client: any, callbackQuery: any, user: any,
  action: string, pendingId: string,
  chatId: number, messageId: number,
) {
  // Find pending confirmation
  const { data: pending } = await client.from('pending_confirmations')
    .select('*')
    .eq('id', pendingId)
    .eq('status', 'pending')
    .maybeSingle()

  if (!pending) {
    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: 'Expired or already handled.', parse_mode: 'HTML',
      }),
    })
    return
  }

  if (action === 'confirm') {
    // Rate limit check before execution
    const rateLimitMsg = await checkRateLimit(client, user.id, pending.action_type, pending.action_payload)
    if (rateLimitMsg) {
      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, message_id: messageId,
          text: rateLimitMsg, parse_mode: 'HTML',
        }),
      })
      return
    }

    // Track approval speed
    const approvalMs = Date.now() - new Date(pending.created_at).getTime()
    if (approvalMs < 3000) { // T6: increased from 2s to 3s to reduce false positives
      try {
        await client.from('ai_alerts').insert({
          org_id: DEFAULT_ORG_ID,
          alert_type: 'fast_approval_warning',
          severity: 'info',
          message: `${user.name} approved "${pending.action_type}" in ${approvalMs}ms — possible rubber-stamping`,
          context: { approval_ms: approvalMs, action_type: pending.action_type },
        })
      } catch { /* non-blocking */ }
    }

    // Execute the confirmed action via agent
    try {
      console.log(`[telegram-bot] executing confirm_action: tool=${pending.action_type}, args=${JSON.stringify(pending.action_payload).slice(0, 200)}`)

      const resp = await fetch(AGENT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': AGENT_AUTH_HEADER,
        },
        body: JSON.stringify({
          messages: [],
          view: 'ops',
          confirm_action: {
            tool: pending.action_type,
            args: pending.action_payload,
          },
        }),
      })

      const resultText = await resp.text()
      console.log(`[telegram-bot] confirm_action response: status=${resp.status}, body=${resultText.slice(0, 300)}`)

      if (!resp.ok) {
        throw new Error(`Agent returned ${resp.status}: ${resultText.slice(0, 200)}`)
      }

      let result: any
      try { result = JSON.parse(resultText) } catch { result = { content: resultText } }

      // Check for error in response
      if (result.error) {
        throw new Error(result.error)
      }

      const successMsg = result.content || result.confirmed_result
        ? `\u2705 <b>Done</b> \u2014 ${result.content || 'Action executed successfully.'}`
        : `\u2705 <b>Approved</b> \u2014 Action completed.`

      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, message_id: messageId,
          text: successMsg,
          parse_mode: 'HTML',
        }),
      })

      // Log successful action outcome
      logEvent(client, {
        event_type: 'action_executed',
        entity_type: 'telegram_action',
        entity_id: pending.id,
        job_id: pending.action_payload?.job_id || null,
        payload: {
          action_type: pending.action_type,
          action_params: pending.action_payload,
          display_message: pending.display_message || null,
          result: result.content?.slice(0, 500) || 'completed',
          status: 'success',
          approved_by: user.id,
          approved_by_name: user.name,
          approval_ms: Date.now() - new Date(pending.created_at).getTime(),
        },
      }).catch(() => {})
    } catch (e) {
      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, message_id: messageId,
          text: '\u274C Action failed \u2014 try again or check the Ops dashboard.',
          parse_mode: 'HTML',
        }),
      })
      console.error('[telegram-bot] callback confirm error:', e)

      // Log failed action outcome
      logEvent(client, {
        event_type: 'action_executed',
        entity_type: 'telegram_action',
        entity_id: pending.id,
        payload: {
          action_type: pending.action_type,
          action_params: pending.action_payload,
          status: 'failed',
          error: (e as Error).message,
          approved_by: user.id,
        },
      }).catch(() => {})
    }

    await client.from('pending_confirmations')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', pending.id)

    // Write approval feedback for learning loop
    try {
      await client.from('ai_feedback_outcomes').insert({
        trace_id: pending.trace_id || null,
        human_action: 'approved',
        human_action_at: new Date().toISOString(),
        feedback_category: pending.action_type,
        action_params: pending.action_params || null,
      })
    } catch { /* non-blocking */ }

    // Trigger context capture DM after PO approval
    if (pending.action_type === 'create_po') {
      sendContextCaptureDM(client, pending, user).catch(e =>
        console.log('[telegram-bot] context capture failed:', e))
    }

  } else if (action === 'reject') {
    await client.from('pending_confirmations')
      .update({ status: 'rejected' })
      .eq('id', pending.id)

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: '❌ <b>Rejected</b> — Action cancelled.',
        parse_mode: 'HTML',
      }),
    })

    try {
      await client.from('ai_feedback_outcomes').insert({
        trace_id: pending.trace_id || null,
        human_action: 'rejected',
        human_action_at: new Date().toISOString(),
        feedback_category: pending.action_type,
      })
    } catch { /* non-blocking */ }
  }
}

// ── Edit Callback Handler ────────────────────────────────

async function handleEditCallback(
  client: any, callbackQuery: any, user: any,
  pendingId: string, chatId: number, messageId: number,
) {
  // Update status to 'editing' with 10-min expiry
  await client.from('pending_confirmations')
    .update({
      status: 'editing',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .eq('id', pendingId)
    .eq('status', 'pending')

  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: '\u270F\uFE0F <b>Editing</b> \u2014 Reply with your changes.\n\nYou can send a full replacement message, or describe what to change (e.g. "make it friendlier" or "change the amount to $5,000").',
      parse_mode: 'HTML',
    }),
  })
}

// ── Learning Callback Handler ─────────────────────────────

async function handleLearningCallback(
  client: any, callbackQuery: any, user: any,
  action: string, ruleId: string,
  chatId: number, messageId: number,
) {
  if (action === 'learn_confirm') {
    await client.from('learned_rules')
      .update({
        status: 'confirmed',
        confidence: 0.9,
        confirmed_by: user.name,
        confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', ruleId)

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: '✅ Rule confirmed — I\'ll apply this going forward.',
        parse_mode: 'HTML',
      }),
    })

  } else if (action === 'learn_edit') {
    // Create pending for text input
    await client.from('pending_confirmations').insert({
      org_id: DEFAULT_ORG_ID,
      chat_id: chatId,
      user_id: user.id,
      action_type: 'learning_edit',
      action_payload: { rule_id: ruleId },
      channel: 'telegram_dm',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: 'pending',
    })

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: '✏️ What\'s the correct rule? Type your correction:',
        parse_mode: 'HTML',
      }),
    })

  } else if (action === 'learn_depends') {
    await client.from('learned_rules')
      .update({
        status: 'corrected',
        correction_text: 'Context-dependent — awaiting details',
        updated_at: new Date().toISOString(),
      })
      .eq('id', ruleId)

    // Create pending for explanation
    await client.from('pending_confirmations').insert({
      org_id: DEFAULT_ORG_ID,
      chat_id: chatId,
      user_id: user.id,
      action_type: 'learn_depends',
      action_payload: { rule_id: ruleId },
      channel: 'telegram_dm',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: 'pending',
    })

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: '💬 What does it depend on? Type the conditions:',
        parse_mode: 'HTML',
      }),
    })
  }
}

// ── Context Capture Callback Handler ──────────────────────

async function handleContextCaptureCallback(
  client: any, callbackQuery: any, user: any,
  action: string, pendingId: string,
  chatId: number, messageId: number,
) {
  if (action === 'ctx_yes') {
    // Find the related rule from the pending
    const { data: pending } = await client.from('pending_confirmations')
      .select('action_payload')
      .eq('id', pendingId)
      .maybeSingle()

    if (pending?.action_payload?.rule_id) {
      await client.from('learned_rules')
        .update({
          confidence: 0.85,
          evidence_count: client.rpc ? undefined : 1, // increment handled below
          updated_at: new Date().toISOString(),
        })
        .eq('id', pending.action_payload.rule_id)

      // Increment evidence_count
      try {
        await client.rpc('increment_field', {
          table_name: 'learned_rules',
          field_name: 'evidence_count',
          row_id: pending.action_payload.rule_id,
        })
      } catch {
        // RPC may not exist — non-blocking
      }
    }

    await client.from('business_events').insert({
      event_type: 'ai.context_confirmed',
      source: 'telegram-bot',
      entity_type: 'learned_rule',
      entity_id: pending?.action_payload?.rule_id || pendingId,
      payload: { confirmed_by: user.name },
    })

    await client.from('pending_confirmations')
      .update({ status: 'confirmed' })
      .eq('id', pendingId)

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: '✅ Got it — thanks for confirming!',
        parse_mode: 'HTML',
      }),
    })

  } else if (action === 'ctx_reason') {
    await client.from('pending_confirmations').insert({
      org_id: DEFAULT_ORG_ID,
      chat_id: chatId,
      user_id: user.id,
      action_type: 'context_reason',
      action_payload: { original_pending_id: pendingId },
      channel: 'telegram_dm',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: 'pending',
    })

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: '✏️ What was the reason? Type your explanation:',
        parse_mode: 'HTML',
      }),
    })
  }
}

// ── Graduation Callback Handler ───────────────────────────

async function handleGraduationCallback(
  client: any, callbackQuery: any, user: any,
  action: string, actionType: string,
  chatId: number, messageId: number,
) {
  if (action === 'grad_approve') {
    await client.from('action_permissions')
      .update({
        autonomy_level: 'auto',
        graduated_at: new Date().toISOString(),
        graduated_by: user.name,
      })
      .eq('action_type', actionType)
      .eq('org_id', DEFAULT_ORG_ID)

    await client.from('business_events').insert({
      event_type: 'ai.graduation_approved',
      source: 'telegram-bot',
      entity_type: 'action_permission',
      entity_id: actionType,
      payload: { graduated_by: user.name },
    })

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: `🎓 <b>${actionType}</b> graduated to auto-execute! I'll handle these automatically now.`,
        parse_mode: 'HTML',
      }),
    })

  } else if (action === 'grad_reject') {
    await client.from('business_events').insert({
      event_type: 'ai.graduation_rejected',
      source: 'telegram-bot',
      entity_type: 'action_permission',
      entity_id: actionType,
      payload: { rejected_by: user.name },
    })

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        text: `👍 Got it — <b>${actionType}</b> will keep requiring approval.`,
        parse_mode: 'HTML',
      }),
    })
  }
}


// ── Main Handler ──────────────────────────────────────────

serve(async (req: Request) => {
  // Always return 200 to Telegram (it retries on non-200)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200 })
  }

  try {
    const body = await req.json()

    // ── Handle automation results from Railway scheduler ──
    if (body.type === 'automation_result' && body.chat_id && body.content) {
      try {
        const content = body.content as string
        const automation = body.automation || 'unknown'
        const chatId = Number(body.chat_id)
        // Truncate to Telegram limit (4096 chars)
        const text = content.length > 4000
          ? content.slice(0, 4000) + '\n\n... (truncated)'
          : content
        await sendMessage(chatId, `📋 <b>${automation}</b>\n\n${text}`)

        // Send action_cards with inline approve/skip buttons (debt-chase)
        const actionCards = body.action_cards as any[] | undefined
        if (actionCards?.length) {
          for (const card of actionCards) {
            if (card.confirmation_token) {
              const desc = card.message || `${card.tool}(${JSON.stringify(card.args).slice(0, 100)})`
              const truncDesc = desc.length > 200 ? desc.slice(0, 200) + '...' : desc
              await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: `💬 <b>Chase approval needed:</b>\n${truncDesc}`,
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: '✓ Send', callback_data: `chase_approve:${card.confirmation_token}` },
                      { text: '✗ Skip', callback_data: `chase_skip:${card.confirmation_token}` },
                    ]],
                  },
                }),
              })
            }
          }
          console.log(`[telegram-bot] sent ${actionCards.filter((c: any) => c.confirmation_token).length} chase approval buttons`)
        }

        console.log(`[telegram-bot] delivered automation result: ${automation} to ${body.chat_id}`)
      } catch (e) {
        console.error('[telegram-bot] automation delivery failed:', (e as Error).message)
      }
      return new Response('ok', { status: 200 })
    }

    // ── Dedup: skip already-processed updates (Telegram retries on slow 200) ──
    const updateId = body.update_id as number | undefined
    if (updateId) {
      if (processedUpdates.has(updateId)) {
        return new Response('ok', { status: 200 })
      }
      processedUpdates.add(updateId)
      // Prevent unbounded memory growth
      if (processedUpdates.size > DEDUP_MAX_SIZE) {
        const oldest = [...processedUpdates].slice(0, 100)
        oldest.forEach(id => processedUpdates.delete(id))
      }
    }

    // Handle inline keyboard callback queries
    const callbackQuery = body.callback_query
    if (callbackQuery) {
      const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      await handleCallbackQuery(client, callbackQuery)
      return new Response('ok', { status: 200 })
    }

    const message = body.message

    if (!message) {
      return new Response('ok', { status: 200 })
    }

    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const text = message.text || ''

    // Piggyback cleanup: delete expired pending_confirmations (non-blocking)
    client.from('pending_confirmations').delete().lt('expires_at', new Date().toISOString()).then(() => {}).catch(() => {})

    // ── Command routing (only things that reply) ──
    if (text.startsWith('/')) {
      const parts = text.split(/\s+/)
      const cmd = parts[0].toLowerCase().replace(/@\w+$/, '') // strip @botname
      const args = parts.slice(1).join(' ')

      switch (cmd) {
        case '/register':
          await handleRegister(client, message.chat.id, message.from?.id, args)
          break
        case '/status':
          await handleStatus(client, message.chat.id, args)
          break
        case '/today':
          await handleToday(client, message.chat.id, message.from?.id)
          break
        case '/start':
          if (message.chat.type === 'private') {
            await sendMessage(message.chat.id,
              "G'day! You're locked in for DMs. I'll give you a nudge when something needs your attention.\n\n" +
              'Fire away with questions — try "What jobs are on this week?"'
            )
          } else {
            await sendMessage(message.chat.id,
              "<b>SecureWorks Bot</b> — your business intelligence system, at your service around the clock.\n\n" +
              '/register your@email.com \u2014 Link your account\n' +
              '/today \u2014 Today\'s schedule\n' +
              '/status SWP-25019 \u2014 Job status\n\n' +
              'I also listen in quietly — mention a job number and I\'ll keep track. Spot a problem? Just say it, I\'ll flag it.'
            )
          }
          break
        case '/pause': {
          const pauseUser = await findUserByTelegramId(client, message.from?.id)
          const pauseRole = pauseUser ? resolveRole(pauseUser.email) : 'crew'
          if (pauseRole !== 'admin') {
            await sendMessage(message.chat.id, 'Only admins can pause the AI.')
            break
          }
          try {
            const { data: org } = await client.from('organisations')
              .select('settings_json')
              .eq('id', DEFAULT_ORG_ID)
              .maybeSingle()
            const settings = org?.settings_json || {}
            settings.ai_paused = true
            settings.paused_at = new Date().toISOString()
            settings.paused_by = pauseUser?.email || 'unknown'
            await client.from('organisations')
              .update({ settings_json: settings })
              .eq('id', DEFAULT_ORG_ID)
            await sendMessage(message.chat.id, '\u23F8 Copy that — going quiet. I\'ll still log everything but won\'t take any actions on my own. Send /resume when you want me back.')
          } catch (e) {
            await sendMessage(message.chat.id, 'Failed to pause \u2014 try again.')
            console.error('[telegram-bot] pause error:', e)
          }
          break
        }
        case '/resume': {
          const resumeUser = await findUserByTelegramId(client, message.from?.id)
          const resumeRole = resumeUser ? resolveRole(resumeUser.email) : 'crew'
          if (resumeRole !== 'admin') {
            await sendMessage(message.chat.id, 'Only admins can resume the AI.')
            break
          }
          try {
            const { data: org } = await client.from('organisations')
              .select('settings_json')
              .eq('id', DEFAULT_ORG_ID)
              .maybeSingle()
            const settings = org?.settings_json || {}
            settings.ai_paused = false
            settings.resumed_at = new Date().toISOString()
            settings.resumed_by = resumeUser?.email || 'unknown'
            await client.from('organisations')
              .update({ settings_json: settings })
              .eq('id', DEFAULT_ORG_ID)
            await sendMessage(message.chat.id, '\u25B6\uFE0F Back on the tools. I\'ll keep an eye on things and flag anything that needs attention.')
          } catch (e) {
            await sendMessage(message.chat.id, 'Failed to resume \u2014 try again.')
            console.error('[telegram-bot] resume error:', e)
          }
          break
        }
        // ── Native data commands (direct Supabase, no agent round-trip) ──
        case '/overdue': {
          try {
            const today = new Date().toISOString().slice(0, 10)
            const { data: inv } = await client.from('xero_invoices')
              .select('contact_name, amount_due, due_date, invoice_number')
              .eq('invoice_type', 'ACCREC')
              .eq('org_id', DEFAULT_ORG_ID)
              .in('status', ['AUTHORISED', 'SUBMITTED'])
              .gt('amount_due', 0)
              .lt('due_date', today)
              .order('due_date', { ascending: true })
              .limit(20)
            if (!inv || inv.length === 0) {
              await sendMessage(message.chat.id, 'No overdue invoices right now.')
            } else {
              const now = Date.now()
              const lines = inv.map((i: any) => {
                const days = Math.round((now - new Date(i.due_date).getTime()) / 86400000)
                return `• <b>${i.contact_name}</b> — $${Number(i.amount_due).toLocaleString()} (${days}d overdue)`
              })
              const total = inv.reduce((s: number, i: any) => s + Number(i.amount_due || 0), 0)
              await sendMessage(message.chat.id, `<b>Overdue Invoices</b> (${inv.length} invoices, $${Math.round(total).toLocaleString()} total)\n\n${lines.join('\n')}`)
            }
          } catch (e) { await sendMessage(message.chat.id, 'Could not load overdue invoices — try again.') }
          break
        }
        case '/pipeline': {
          try {
            const { data: jobs } = await client.from('jobs')
              .select('job_number, client_name, status, quoted_value, type')
              .eq('legacy', false).in('status', ['quoted', 'accepted', 'scheduled'])
              .order('created_at', { ascending: false }).limit(15)
            if (!jobs || jobs.length === 0) {
              await sendMessage(message.chat.id, 'Pipeline is empty — no active quotes.')
            } else {
              const lines = jobs.map((j: any) => `• <b>${j.job_number || '?'}</b> ${j.client_name} — $${Number(j.quoted_value || 0).toLocaleString()} [${j.status}]`)
              const total = jobs.reduce((s: number, j: any) => s + Number(j.quoted_value || 0), 0)
              await sendMessage(message.chat.id, `<b>Active Pipeline</b> ($${Math.round(total).toLocaleString()})\n\n${lines.join('\n')}`)
            }
          } catch (e) { await sendMessage(message.chat.id, 'Could not load pipeline — try again.') }
          break
        }
        case '/crew': {
          try {
            const awst = new Date(Date.now() + 8 * 60 * 60 * 1000)
            const weekStart = awst.toISOString().slice(0, 10)
            const weekEnd = new Date(awst.getTime() + 7 * 86400000).toISOString().slice(0, 10)
            const { data: assignments } = await client.from('job_assignments')
              .select('crew_name, scheduled_date, job_id, assignment_type, jobs(job_number, client_name, site_suburb)')
              .gte('scheduled_date', weekStart).lte('scheduled_date', weekEnd)
              .order('scheduled_date', { ascending: true }).limit(20)
            if (!assignments || assignments.length === 0) {
              await sendMessage(message.chat.id, 'No crew assignments this week.')
            } else {
              const lines = assignments.map((a: any) => {
                const job = a.jobs as any
                return `• <b>${a.scheduled_date}</b> ${a.crew_name || '?'} → ${job?.job_number || '?'} ${job?.client_name || ''} (${a.assignment_type})`
              })
              await sendMessage(message.chat.id, `<b>Crew Schedule (This Week)</b>\n\n${lines.join('\n')}`)
            }
          } catch (e) { await sendMessage(message.chat.id, 'Could not load crew schedule — try again.') }
          break
        }
        case '/cash': {
          try {
            const { data: bank } = await client.from('xero_bank_balances')
              .select('account_name, balance').order('synced_at', { ascending: false }).limit(5)
            const { data: recv } = await client.from('xero_invoices')
              .select('amount_due').eq('type', 'ACCREC').in('status', ['AUTHORISED', 'SUBMITTED']).gt('amount_due', 0)
            const totalBank = (bank || []).reduce((s: number, b: any) => s + Number(b.balance || 0), 0)
            const totalRecv = (recv || []).reduce((s: number, i: any) => s + Number(i.amount_due || 0), 0)
            const bankLines = (bank || []).map((b: any) => `• ${b.account_name}: $${Number(b.balance).toLocaleString()}`)
            await sendMessage(message.chat.id,
              `<b>Cash Position</b>\n\n` +
              `Bank: <b>$${Math.round(totalBank).toLocaleString()}</b>\n${bankLines.join('\n')}\n\n` +
              `Outstanding receivables: <b>$${Math.round(totalRecv).toLocaleString()}</b>`)
          } catch (e) { await sendMessage(message.chat.id, 'Could not load cash position — try again.') }
          break
        }
        case '/week': {
          try {
            const awst = new Date(Date.now() + 8 * 60 * 60 * 1000)
            const weekAgo = new Date(awst.getTime() - 7 * 86400000).toISOString().slice(0, 10)
            const { data: completed } = await client.from('jobs')
              .select('id').eq('legacy', false).eq('status', 'complete').gte('completed_at', weekAgo)
            const { data: invoiced } = await client.from('xero_invoices')
              .select('total').eq('type', 'ACCREC').gte('date', weekAgo)
            const { data: quoted } = await client.from('jobs')
              .select('id').eq('legacy', false).in('status', ['quoted']).gte('created_at', weekAgo)
            const totalInvoiced = (invoiced || []).reduce((s: number, i: any) => s + Number(i.total || 0), 0)
            await sendMessage(message.chat.id,
              `<b>This Week</b>\n\n` +
              `Jobs completed: <b>${(completed || []).length}</b>\n` +
              `Revenue invoiced: <b>$${Math.round(totalInvoiced).toLocaleString()}</b>\n` +
              `Quotes sent: <b>${(quoted || []).length}</b>`)
          } catch (e) { await sendMessage(message.chat.id, 'Could not load weekly summary — try again.') }
          break
        }

        default:
          break
      }

      // Also silently log commands as business_events
      await logEvent(client, {
        event_type: 'crew.command',
        entity_type: 'crew_chat',
        entity_id: String(message.chat.id),
        payload: {
          command: text,
          from: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' '),
          telegram_id: message.from?.id,
        },
      })

      return new Response('ok', { status: 200 })
    }

    // ── Intelligent response or silent logging ──
    if (message.photo && message.photo.length > 0) {
      await handlePhoto(client, message)
    } else if (message.voice) {
      await handleVoice(client, message)
    } else if (text) {
      // Store group chat_id (fire-and-forget)
      if (message.chat.type !== 'private') {
        storeGroupChatId(client, message.chat.id).catch(() => {})
      }

      // Check if this is a yes/no reply to a pending confirmation
      const fromId = message.from?.id
      if (fromId) {
        const user = await findUserByTelegramId(client, fromId)
        if (user) {
          const wasConfirmation = await checkPendingConfirmation(client, message.chat.id, user.id, text)
          if (wasConfirmation) return new Response('ok', { status: 200 })
        }
      }

      if (shouldRespondIntelligently(message)) {
        // Rate limiting
        const userId = message.from?.id
        if (userId) {
          const lastReq = rateLimitMap.get(userId)
          if (lastReq && Date.now() - lastReq < RATE_LIMIT_MS) {
            await sendMessage(message.chat.id, 'Easy tiger — still working on your last one. Give me a sec.')
            return new Response('ok', { status: 200 })
          }
          rateLimitMap.set(userId, Date.now())
        }

        // Look up user for role
        const user = userId ? await findUserByTelegramId(client, userId) : null
        if (!user) {
          await sendMessage(message.chat.id, "Don't think we've met — send /register your@email.com and I'll know who you are.")
          return new Response('ok', { status: 200 })
        }

        // ── Return 200 to Telegram immediately — process AI in background ──
        // Deno Deploy keeps the isolate alive while promises are pending.
        // Without this, Telegram retries after ~30s causing duplicate messages.
        const role = resolveRole(user.email)
        const channel = message.chat.type === 'private' ? 'telegram_dm' : 'telegram_group'

        // Detect group context (crew vs ops) for group messages
        let groupContext: 'crew' | 'ops' | undefined
        if (channel === 'telegram_group') {
          try {
            const { data: org } = await client.from('organisations')
              .select('settings_json')
              .eq('id', DEFAULT_ORG_ID)
              .maybeSingle()
            const settings = org?.settings_json || {}
            const chatId = message.chat.id
            if (settings.ops_group_chat_id && chatId === settings.ops_group_chat_id) {
              groupContext = 'ops'
            } else {
              // Default to crew for the main group or any unknown group
              groupContext = 'crew'
            }
          } catch {
            groupContext = 'crew' // Safe default
          }
        }

        const aiWork = (async () => {
          const callerContext: CallerContext = {
            user_id: user.id,
            user_name: user.name,
            user_email: user.email,
            user_role: role,
            channel,
            org_id: DEFAULT_ORG_ID,
          }

          // Conversational memory — load recent messages from SAME user/chat
          let recentMessages: string[] = []
          let chatHistoryRaw: Array<{ query: string; response: string }> = []
          try {
            let query = client.from('chat_logs')
              .select('query, response')
              .eq('channel', channel)
              .order('created_at', { ascending: false })
              .limit(7)
            // Filter by user_email so we get THIS user's conversation thread
            // (user_id is often NULL, so filter by email instead)
            if (user.email) {
              query = query.eq('user_email', user.email)
            }
            const { data: recentChats } = await query
            if (recentChats && recentChats.length > 0) {
              const reversed = recentChats.reverse()
              recentMessages = reversed.map((c: any) =>
                `User: ${(c.query || '').slice(0, 200)}\nAI: ${(c.response || '').slice(0, 400)}`
              )
              // Raw history for messages array injection — keep more context for entity resolution
              chatHistoryRaw = reversed.map((c: any) => ({ query: c.query || '', response: c.response || '' }))
            }
          } catch { /* non-blocking — memory is best-effort */ }

          // Resolve view based on role
          const view = resolveViewForCaller(role, user.email)

          // Add recent messages to caller context
          if (recentMessages.length > 0) {
            (callerContext as any).recent_messages = recentMessages
          }

          // Send "thinking" indicator
          try {
            await fetch(`${TELEGRAM_API}/sendChatAction`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: message.chat.id, action: 'typing' }),
            })
          } catch { /* non-blocking */ }

          // Check if user is replying to a bot message — load context
          let replyContext = ''
          if (message.reply_to_message?.from?.is_bot) {
            const replyMsgId = message.reply_to_message.message_id
            try {
              const { data: ctxData } = await client
                .from('business_events')
                .select('payload')
                .eq('event_type', 'telegram_bot_reply')
                .eq('payload->>telegram_message_id', String(replyMsgId))
                .single()
              if (ctxData?.payload?.text_preview) {
                replyContext = `[User is replying to bot message: "${ctxData.payload.text_preview}"]

`
              }
            } catch { /* non-blocking — context is best-effort */ }
          }

          // Prepend reply context if user is replying to a bot message
          const fullText = replyContext ? replyContext + text : text

          // ── ALL messages route through real GRAF agent ──
          // Freestyle/dice mode removed — every message gets GRAF's tools, memory, and rules.
          // The agent handles banter naturally within its personality while retaining full context.
          console.log('[telegram-bot] → OPS-AI MODE (all messages route through GRAF)')
          const classification = await classifyMessage(fullText, { name: user.name, role: role }, recentMessages)

          // Log classification to business_events
          logEvent(client, {
            event_type: 'ai.message_classified',
            entity_type: 'message',
            entity_id: String(message.message_id || message.chat.id),
            payload: {
              intent: classification.intent,
              confidence: classification.confidence,
              entities: classification.extracted_entities,
              from: user.name,
              channel,
            },
          }).catch(() => {})

          // Skip ops-ai for casual messages in group that aren't triggered
          if (classification.intent === 'casual' && classification.confidence > 0.9 && channel === 'telegram_group' && !shouldRespondIntelligently(message)) {
            await handleText(client, message)
            return
          }

          try {
            const aiResponse = await askOpsAi(fullText, callerContext, view, groupContext, chatHistoryRaw)

            // Rewrite tone for Telegram personality
            aiResponse.content = await rewriteTone(aiResponse.content, fullText, callerContext)

            // Financial data redirect — only for actual data queries, not casual banter
            const isDataQuery = classification.intent === 'complex_query' || classification.intent === 'simple_lookup' || classification.intent === 'action_request'
            if (channel === 'telegram_group' && isDataQuery && containsFinancialData(aiResponse.content)) {
              // Save response to chat_logs BEFORE redirect (T4: prevent data loss on DM failure)
              client.from('chat_logs').insert({
                query: text.slice(0, 500), response: aiResponse.content.slice(0, 5000),
                channel: 'telegram_group', role: callerContext.user_role,
                user_id: callerContext.user_id,
              }).catch(() => {})

              await sendMessage(message.chat.id, "I'll DM you that info.")
              try {
                await sendMessage(message.from.id, aiResponse.content)
              } catch {
                await sendMessage(message.chat.id, "Couldn't DM you — check the Ops dashboard for those numbers, or send /start in a private chat.")
              }
              return
            }

            // Handle action cards (confirmation flow)
            // Save to chat_logs for conversation memory (BEFORE action card handling)
            client.from('chat_logs').insert({
              user_id: callerContext.user_id,
              user_email: callerContext.user_email,
              role: callerContext.user_role,
              query: text.slice(0, 500),
              response: (aiResponse.content || '').slice(0, 5000),
              tools_used: [],
              channel,
            }).then(() => {}).catch(() => {})

            if (aiResponse.action_cards && aiResponse.action_cards.length > 0) {
              await sendMessage(message.chat.id, aiResponse.content)
              // Create pending confirmations and send inline keyboard buttons
              for (const card of aiResponse.action_cards) {
                const { data: pending } = await client.from('pending_confirmations').insert({
                  org_id: DEFAULT_ORG_ID,
                  chat_id: message.chat.id,
                  user_id: user.id,
                  action_type: card.action || card.tool,
                  action_payload: card.params || card.args,
                  display_message: card.message || null,
                  trace_id: aiResponse.session_id || null, // T2: correlate approval to agent session
                  channel,
                  expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                  status: 'pending',
                }).select('id').single()

                if (pending?.id) {
                  await sendRichApprovalCard(message.chat.id, card, pending.id)
                } else {
                  // Fallback to text confirmation
                  await sendMessage(message.chat.id, `\u26A1 <b>Action:</b> ${card.message}\n\nReply <b>YES</b> to confirm or <b>NO</b> to cancel.`)
                }
              }
            } else {
              await sendMessage(message.chat.id, aiResponse.content)
            }
          } catch (e) {
            console.error('[telegram-bot] AI response error:', e)
            const errMsg = (e as Error).message || ''
            let userError = "My apologies, sir — I wasn't able to process that request."
            if (errMsg.includes('timeout') || errMsg.includes('abort') || errMsg.includes('ETIMEDOUT')) {
              userError = "That request exceeded the time limit, sir. Try a more specific query, or I can pull the data from the dashboard."
            } else if (errMsg.includes('429') || errMsg.includes('rate')) {
              userError = "I'm experiencing high demand at the moment. Please try again in 30 seconds, sir."
            } else if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503')) {
              userError = "The backend service is temporarily unavailable. The dashboard remains operational: secureworks-group.github.io/securedash/ops.html"
            }
            await sendMessage(message.chat.id, userError)
            // Log error
            await logEvent(client, {
              event_type: 'ai_error',
              entity_type: 'system',
              entity_id: 'ops-ai',
              payload: { error: (e as Error).message, user: user.name, query: text.slice(0, 200) },
            })
          }
        })()

        // Fire-and-forget — errors logged inside the async block
        aiWork.catch(e => console.error('[telegram-bot] background AI error:', e))
        return new Response('ok', { status: 200 })
      } else {
        // ── Mode B: Lurker — silent logging of ALL group messages ──
        // Step 13: Persist every crew group message to chat_logs (passive),
        // even when the bot isn't mentioned. GRAF sees these via chat_logs
        // and the event listener reacts to business-relevant ones.
        await handleText(client, message)

        // Also log to chat_logs for GRAF conversational memory
        if (message.chat.type !== 'private' && text) {
          const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
          client.from('chat_logs').insert({
            user_id: null, // passive — may not be a registered user
            user_email: null,
            role: 'crew',
            query: text.slice(0, 500),
            response: null, // no bot response for passive messages
            tools_used: [],
            channel: 'telegram_group_passive',
          }).then(() => {}).catch(() => {})

          // Lightweight business-relevance classifier for passive messages
          // If the message mentions ops-relevant topics, also fire a crew.message
          // business_event so the event listener can react (handleText already
          // fires crew.message for ALL messages, but we add extra metadata here
          // for passive messages that mention specific ops topics)
          const lowerText = text.toLowerCase()
          const OPS_KEYWORDS = /\b(materials?|deliver|delivery|schedule[d]?|on\s*site|finished|done|complete[d]?|started|problem|issue|rain|weather|no\s*show|running\s*late|delay|short|missing)\b/i
          if (OPS_KEYWORDS.test(lowerText)) {
            const refs = text.match(/SW[PFDR]-\d{5}/gi) || []
            logEvent(client, {
              event_type: 'crew.message',
              entity_type: refs.length > 0 ? 'job' : 'crew_chat',
              entity_id: refs[0] || String(message.chat.id),
              payload: {
                text: text.slice(0, 500),
                from: fromName,
                telegram_id: message.from?.id,
                chat_id: message.chat.id,
                passive: true, // Flag: bot was NOT mentioned
                ops_relevant: true,
                job_refs: refs,
              },
            }).catch(() => {})
          }

          // ── Job Memory Loop: match passive messages to jobs by job ref ──
          const jobRefMatch = text.match(/SW[PFDR]-?\d{4,6}/i)
          if (jobRefMatch) {
            const { data: matchedJob } = await client.from('jobs')
              .select('id, job_number, client_name')
              .ilike('job_number', jobRefMatch[0].replace(/-/g, '').replace(/(SW[PFDR])(\d+)/i, '$1-$2'))
              .limit(1)
              .maybeSingle()

            if (matchedJob) {
              const hasMedia = !!(message.photo || message.document || message.video)
              await client.from('business_events').insert({
                event_type: hasMedia ? 'crew.photo' : 'crew.message',
                source: 'telegram/passive',
                entity_type: 'crew',
                entity_id: String(message.from?.id || ''),
                job_id: matchedJob.id,
                payload: {
                  sender: message.from?.first_name || 'Unknown',
                  message_text: text.slice(0, 500),
                  group_name: message.chat?.title || 'Unknown',
                  has_media: hasMedia,
                  job_number: matchedJob.job_number,
                  client_name: matchedJob.client_name,
                  passive: true,
                },
                occurred_at: new Date().toISOString(),
              }).then(() => {}).catch(() => {})
            }
          }

          // ── Job Memory Loop: crew.alert for issue keywords ──
          const ISSUE_KEYWORDS = /\b(no materials|not on site|problem|delay|damaged|missing|broken|unsafe|no\s*show|short|wrong)\b/i
          if (ISSUE_KEYWORDS.test(lowerText)) {
            await client.from('business_events').insert({
              event_type: 'crew.alert',
              source: 'telegram/passive',
              entity_type: 'crew',
              entity_id: String(message.from?.id || ''),
              payload: {
                sender: message.from?.first_name || 'Unknown',
                alert_text: text.slice(0, 500),
                group_name: message.chat?.title || 'Unknown',
                urgency: 'high',
              },
              occurred_at: new Date().toISOString(),
            }).then(() => {}).catch(() => {})
          }
        }
      }
    }

  } catch (e) {
    console.error('[telegram-bot] error:', e)
  }

  return new Response('ok', { status: 200 })
})
