import dns from 'node:dns/promises';
import net from 'node:net';

/** Protección SSRF: el código de los clientes no puede llamar a redes privadas, localhost ni metadatos de la nube. */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}
export async function safeUrl(raw) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Solo se permiten URLs http(s)');
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Destino no permitido (red privada o local)');
  return url;
}
