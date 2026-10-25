import { env } from '../../config/env.js';

/**
 * Catálogo de aplicaciones de Juntial Center. Una app nueva solo necesita su entrada aquí:
 * roles que entiende, eventos que publica/consume y dónde vive. El acceso de cada persona se decide por app.
 */
export const APP_ROLES = {
  admin: { label: 'Administrador', desc: 'Todo, incluido plan, claves de API y configuración.' },
  editor: { label: 'Editor', desc: 'Crea y modifica agentes, CRM, reglas y funciones.' },
  viewer: { label: 'Lector', desc: 'Solo puede consultar.' },
  none: { label: 'Sin acceso', desc: 'No ve la aplicación.' },
};
export const APPS = [
  {
    id: 'juntialagents', name: 'JuntialAgents', status: 'available', icon: '🤖', color: '#0E7C86',
    tagline: 'Agentes de IA, CRM, reglas de flujo y empleados digitales',
    url: () => env.WEB_URL, roles: ['admin', 'editor', 'viewer', 'none'], defaultRole: 'editor',
    publishes: ['agent.created', 'worker.run.completed', 'approval.requested', 'approval.decided', 'crm.record.created', 'crm.record.updated', 'document.received'],
    consumes: ['center.member.joined', 'center.member.removed'],
  },
  { id: 'juntial-flows', name: 'Juntial Flows', status: 'soon', icon: '🔀', color: '#5B4BDB', tagline: 'Integraciones y automatizaciones entre aplicaciones', roles: ['admin', 'editor', 'viewer', 'none'] },
  { id: 'juntial-docs', name: 'Juntial Docs', status: 'soon', icon: '📄', color: '#B45309', tagline: 'Documentos, firmas y plantillas inteligentes', roles: ['admin', 'editor', 'viewer', 'none'] },
  { id: 'juntial-analytics', name: 'Juntial Analytics', status: 'soon', icon: '📊', color: '#1D4ED8', tagline: 'Cuadros de mando con todos los datos de tus apps', roles: ['admin', 'viewer', 'none'] },
];
export const appById = (id) => APPS.find((a) => a.id === id);
export const publicApps = () => APPS.map(({ url, ...a }) => ({ ...a, url: typeof url === 'function' ? url() : url }));
