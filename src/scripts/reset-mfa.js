import { connectDB, disconnectDB } from '../lib/db.js';
import { User } from '../models/index.js';
import { revokeAllSessions } from '../modules/auth/service.js';

// Para cuando alguien del equipo pierde el móvil y los códigos de respaldo. Uso: npm run reset-mfa -- <email>
const [email] = process.argv.slice(2);
if (!email) { console.error('Uso: npm run reset-mfa -- <email>'); process.exit(1); }
await connectDB();
const user = await User.findOneAndUpdate({ email: email.toLowerCase().trim() }, { $set: { mfa: { enabled: false } } }, { new: true });
if (!user) { console.error('No existe ese usuario'); process.exit(1); }
await revokeAllSessions(user._id);
console.log(`✅ Verificación en dos pasos reiniciada para ${user.email}. Se cerraron sus sesiones; configurará la app en su próximo acceso.`);
await disconnectDB(); process.exit(0);
