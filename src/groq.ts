import Groq from 'groq-sdk'

export interface GroqClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export function createGroqClient(apiKey: string, model = 'openai/gpt-oss-120b'): GroqClient {
  const client = new Groq({ apiKey })
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            // groq-sdk types `schema` as `{ [key: string]: unknown }` (a Record),
            // not the plain `object` this client's public interface exposes —
            // confirmed via node_modules/groq-sdk/resources/chat/completions.d.ts.
            schema: schema as Record<string, unknown>,
          },
        },
      })
      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error('Groq response contained no content')
      }
      return JSON.parse(content)
    },
  }
}
