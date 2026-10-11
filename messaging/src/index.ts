import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Spectrum, app as appCard } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';
import { GameApi, MessageWorker } from './worker.ts';

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Set ${key} before starting the iMessage service. See docs/imessage.md.`);
  return value;
}

const publicUrl = required('DAL_PUBLIC_URL');
const parsed = new URL(publicUrl);
if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
  throw new Error('DAL_PUBLIC_URL must be a public HTTPS address without credentials, query or fragment.');
}
const api = new GameApi(process.env.DAL_API_URL ?? 'http://127.0.0.1:8000', required('DAL_SPECTRUM_SERVICE_SECRET'));
const delivery = process.env.DAL_SPECTRUM_DELIVERY ?? 'card';
if (delivery !== 'card' && delivery !== 'link') {
  throw new Error('DAL_SPECTRUM_DELIVERY must be card or link.');
}
const stateFile = resolve(process.env.DAL_SPECTRUM_DATA_DIR ?? '../vision/data/messaging', 'messages.sqlite');
mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(stateFile);
const spectrum = await Spectrum({
  projectId: required('SPECTRUM_PROJECT_ID'), projectSecret: required('SPECTRUM_PROJECT_SECRET'),
  providers: [imessage.config()], options: { logLevel: 'warn', flattenGroups: true }, telemetry: false,
});
const worker = new MessageWorker(db, api, {
  async send(spaceId, phone, content) {
    const space = await imessage(spectrum).space.get(spaceId, phone ? { phone } : undefined);
    await space.send('url' in content
      ? delivery === 'link' ? content.url : appCard(content.url, { live: true })
      : content.text);
  },
}, publicUrl);
let stopping = false;
let work: Promise<void> | undefined;
function runQueue(): void {
  if (work || stopping) return;
  work = worker.tick().catch(() => console.error('iMessage queue will retry.')).finally(() => { work = undefined; });
}
const timer = setInterval(runQueue, 2000);
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await spectrum.stop();
  await work;
  db.close();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
console.log('draw.play iMessage service is ready.');
try {
  for await (const [space, message] of spectrum.messages) {
    if (stopping) break;
    if (message.platform !== 'imessage' || message.direction !== 'inbound' || message.content.type !== 'text') continue;
    const im = imessage(space);
    worker.enqueue(message.id, space.id, im.phone ?? '', message.content.text);
    runQueue();
  }
} finally { await stop(); }
