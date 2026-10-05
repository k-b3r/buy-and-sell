// The only file that loads @google/genai (depcruise heavy-dep owner): workers
// that build a real Gemini client import this file by path, so code that only
// needs the GeminiClient type or its wrappers never loads the SDK.
import { GoogleGenAI } from '@google/genai'
import type { GeminiClient } from './gemini'

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
    async generateGroundedText(prompt: string): Promise<string> {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      })
      if (response.text === undefined) {
        throw new Error('Gemini response contained no text')
      }
      return response.text
    },
  }
}
