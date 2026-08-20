import { GoogleGenAI } from '@google/genai'

export interface GeminiClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export function createGeminiClient(apiKey: string, model = 'gemini-2.5-flash'): GeminiClient {
  const ai = new GoogleGenAI({ apiKey })
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      })
      if (response.text === undefined) {
        throw new Error('Gemini response contained no text')
      }
      return JSON.parse(response.text)
    },
  }
}
