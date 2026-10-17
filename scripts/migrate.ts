import 'dotenv/config';
import { openStore } from '../src/db.js';
const store = openStore();
try { await store.migrate(); console.log('Database schema is ready.'); }
finally { store.close(); }
