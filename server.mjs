// bearlychange — Express entry point. Routes live in routes/, shared
// helpers in lib/. This file only wires middleware and listens.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import publicRoutes from './routes/public.mjs';
import adminRoutes from './routes/admin.mjs';
import { ADMIN_USER, ADMIN_PASS } from './lib/http-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4322;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/widget', express.static(path.join(__dirname, 'public')));

// CORS is open for GET only — public reads from any origin (Astro embeds),
// writes stay cookie-less and require explicit Basic auth.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(publicRoutes);
app.use(adminRoutes);

app.listen(PORT, () => {
  console.log(`bearlychange running on http://localhost:${PORT}`);
  console.log(`admin auth: ${ADMIN_USER} / ${ADMIN_PASS}`);
});
