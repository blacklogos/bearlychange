// Worker entry. Routes live under src/routes/*; shared helpers under src/lib/*.
// The ASSETS binding (configured in wrangler.toml) serves public/* and is
// matched before the Worker handler — so /widget/widget.js streams from
// the edge cache without ever invoking this code.
import { Hono } from 'hono';
import publicRoutes from './routes/public.mjs';
import adminRoutes from './routes/admin.mjs';

const app = new Hono();

app.route('/', publicRoutes);
app.route('/', adminRoutes);

export default app;
