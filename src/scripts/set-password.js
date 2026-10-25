import argon2 from 'argon2';
import { connectDB, disconnectDB } from '../lib/db.js';
import { User } from '../models/index.js';

// Uso: npm run set-password -- <email> <contraseña 10+> [rol: superadmin|admin|employee|client]
const [email, password, role = 'superadmin'] = process.argv.slice(2);
if (!email || !password || password.length < 10 || !['superadmin', 'admin', 'employee', 'client'].includes(role)) {
  console.error('Uso: npm run set-password -- <email> <contraseña de 10+ caracteres> [superadmin|admin|employee|client]');
  process.exit(1);
}
await connectDB();
const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
const user = await User.findOneAndUpdate({ email: email.toLowerCase().trim() }, { $set: { passwordHash, role, emailVerified: true, status: 'active' }, $setOnInsert: { name: role === 'superadmin' ? 'Superadmin' : email.split('@')[0] } }, { upsert: true, new: true });
console.log(`✅ ${user.email} → ${user.role}. ${role === 'client' ? 'Entra en /login' : 'Entra en /admin/login (pedirá configurar la app autenticadora la primera vez)'}`);
await disconnectDB();
