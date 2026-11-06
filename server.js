import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Security and tactical asset headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url.endsWith('.glb')) {
    res.setHeader('Content-Type', 'model/gltf-binary');
  } else if (req.url.endsWith('manifest.json')) {
    res.setHeader('Content-Type', 'application/manifest+json');
  } else if (req.url.endsWith('sw.js')) {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

// Serve Three.js library from local node_modules for 100% offline support
app.use('/vendor/three', express.static(join(__dirname, 'node_modules/three')));

// Serve root static assets (HTML, JS, icons, CSS, 3D assets)
app.use(express.static(__dirname));

// Also check dist if exists
if (fs.existsSync(join(__dirname, 'dist'))) {
  app.use(express.static(join(__dirname, 'dist')));
}

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TASER 7 Tactical Simulator running on http://0.0.0.0:${PORT}`);
});
