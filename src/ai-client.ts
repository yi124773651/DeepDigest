import type { DigestConfig } from './types';

export async function callAI(prompt: string, config: DigestConfig, systemPrompt?: string): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature: 0.3,
      top_p: 0.8,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`AI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content || '';
}

export function parseJsonResponse<T>(text: string): T {
  let jsonText = text.trim();

  // Strip markdown code blocks
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
  }

  // Try direct parse first
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    // Fallback: find the first { ... } or [ ... ] block in the text
    const match = jsonText.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try {
        return JSON.parse(match[1]) as T;
      } catch { /* fall through */ }
    }
    throw new Error('Failed to parse JSON');
  }
}
