import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { location, radius, userId } = req.body;
  if (!location) return res.status(400).json({ error: 'Location is required' });

  // Check + enforce search limits for non-paid users
  if (userId) {
    const { data: profile } = await sb.from('profiles').select('paid, searches_used').eq('id', userId).single();
    
    if (profile && !profile.paid) {
      if ((profile.searches_used || 0) >= 1) {
        return res.status(403).json({ error: 'out_of_credits' });
      }
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `You are a research assistant building a contact database of trading card game (TCG) stores (Local Game Stores / LGS).

Search the web for game stores near "${location}" within ${radius} miles. Focus on stores selling Magic: The Gathering, Pokémon, Yu-Gi-Oh, etc.

For each store extract:
- Store name
- Owner or manager name (if findable)
- Phone number
- Email address
- Full address
- Type: "wpn" (Wizards Play Network member), "chain" (e.g. GameStop), or "indie" (independent)

Return ONLY a JSON array. No markdown, no backticks, no explanation. Keys: name, owner, phone, email, address, type. Use "" for unknown fields. Find 6-10 real stores.`
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'API error');

    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start === -1) throw new Error('No results found for that location.');

    const stores = JSON.parse(clean.slice(start, end + 1));

    // Increment searches_used in Supabase
    if (userId) {
      const { data: profile } = await sb.from('profiles').select('searches_used').eq('id', userId).single();
      const current = profile?.searches_used || 0;
      await sb.from('profiles').upsert({ id: userId, searches_used: current + 1 });
    }

    res.status(200).json({ stores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
