import OpenAI, { toFile } from 'openai';
import { env } from '../config/env.js';

/** Voz/audio → texto. Usa la clave del cliente (OpenAI) o la de plataforma como respaldo. */
export async function transcribe(buffer, filename, apiKey) {
  const key = apiKey || env.PLATFORM_OPENAI_KEY;
  if (!key) return null;
  const client = new OpenAI({ apiKey: key, timeout: 60000 });
  const r = await client.audio.transcriptions.create({ file: await toFile(buffer, filename), model: env.TRANSCRIBE_MODEL });
  return r.text;
}
