import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const SW_API_KEY = Deno.env.get('SW_API_KEY') || ''

const BLOCKED_KEYWORDS = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'exec', 'execute']
const MAX_ROWS = 1000

serve(async (req: Request) => {
  // Auth check
  const apiKey = req.headers.get('x-api-key') || ''
  if (apiKey !== SW_API_KEY && apiKey !== SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    })
  }

  try {
    const body = await req.json()
    const sql = (body.sql || '').trim()

    if (!sql) {
      return new Response(JSON.stringify({ error: 'sql field required' }), { status: 400 })
    }

    // Security: SELECT only
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ')
    for (const kw of BLOCKED_KEYWORDS) {
      // Check for keyword at start or after a space/semicolon (not inside quoted strings)
      if (new RegExp(`(^|[\\s;(])${kw}\\s`, 'i').test(normalized)) {
        return new Response(JSON.stringify({ error: `Blocked: ${kw.toUpperCase()} statements not allowed. SELECT only.` }), { status: 403 })
      }
    }

    if (!normalized.startsWith('select') && !normalized.startsWith('with')) {
      return new Response(JSON.stringify({ error: 'Only SELECT and WITH (CTE) queries allowed.' }), { status: 403 })
    }

    // Add row limit if not present
    const hasLimit = /\blimit\s+\d+/i.test(sql)
    const safeSql = hasLimit ? sql : `${sql.replace(/;$/, '')} LIMIT ${MAX_ROWS}`

    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data, error } = await client.rpc('exec_sql', { query: safeSql })

    if (error) {
      // Fallback: try direct fetch to PostgREST RPC
      // If exec_sql RPC doesn't exist, use the raw SQL approach
      const pgResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({ query: safeSql }),
      })

      if (!pgResp.ok) {
        // exec_sql RPC doesn't exist — use raw pg connection via Supabase
        // Fallback to using the Supabase client with from().select() for simple queries
        return new Response(JSON.stringify({
          error: `SQL execution failed: ${error.message}. The exec_sql RPC function may not exist. Run this in Supabase SQL Editor: CREATE OR REPLACE FUNCTION exec_sql(query text) RETURNS jsonb AS $$ DECLARE result jsonb; BEGIN EXECUTE query INTO result; RETURN result; END; $$ LANGUAGE plpgsql SECURITY DEFINER;`,
        }), { status: 500 })
      }

      const pgData = await pgResp.json()
      return new Response(JSON.stringify({ rows: pgData, count: Array.isArray(pgData) ? pgData.length : 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    return new Response(JSON.stringify({ rows: data, count: Array.isArray(data) ? data.length : 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
})
