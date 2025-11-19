const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { createPool } = require('mysql2/promise');
const { fillFormFromDb } = require('./fill_form_from_db');

const CONFIG = {
  PORT: process.env.PORT || 3000,
  HTTPS_PORT: process.env.HTTPS_PORT || 443,
  USE_HTTPS: process.env.USE_HTTPS === 'true',
  HTTP_REDIRECT: process.env.HTTP_REDIRECT === 'true',
  SSL_KEY_PATH: process.env.SSL_KEY_PATH || '/etc/letsencrypt/live/your-domain.com/privkey.pem',
  SSL_CERT_PATH: process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/your-domain.com/fullchain.pem',
  NODE_ENV: process.env.NODE_ENV || 'development',
  DB: {
    host: '217.174.153.182',
    port: 3306,
    user: 'visadcouk_hiten',
    password: 'UVih08BdA3wip',
    database: 'visadcouk_dataf',
  },
};

const { PORT, HTTPS_PORT, USE_HTTPS, HTTP_REDIRECT, SSL_KEY_PATH, SSL_CERT_PATH } = CONFIG;

const app = express();

app.use(cors({
  origin: [
    "https://doc.visad.co.uk",
    "http://localhost:3000",
  ],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "Session-Key", "Accept"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

const dbPool = createPool({
  host: CONFIG.DB.host,
  port: CONFIG.DB.port,
  user: CONFIG.DB.user,
  password: CONFIG.DB.password,
  database: CONFIG.DB.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});


// Root endpoint - matching server-python-https.js pattern
app.get('/', (req, res) => {
  res.json({
    service: 'Schengen Visa PDF Filler (Node)',
    version: '1.0.0',
    status: 'running',
    protocol: USE_HTTPS ? 'https' : 'http',
    endpoints: {
      fillForm: 'POST /api/visa/fill-form',
      health: 'GET /health',
      version: 'GET /version'
    }
  });
});

// Health check endpoint - matching server-python-https.js pattern
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Version endpoint - matching server-python-https.js pattern
app.get('/version', (req, res) => {
  res.json({ version: "1.0.0" });
});

app.post('/api/visa/fill-form', async (req, res, next) => {
  try {
    const {
      travelerId,
      travelCountry,
      recordType = 'traveler',
      flatten = true,
      outputFilename,
    } = req.body || {};

    if (!travelerId) {
      return res.status(400).json({ success: false, error: 'travelerId is required' });
    }
    if (!travelCountry) {
      return res.status(400).json({ success: false, error: 'travelCountry is required' });
    }

    const normalizedCountry = String(travelCountry).trim().toLowerCase();
    if (normalizedCountry !== 'austria') {
      return res.status(400).json({
        success: false,
        error: 'Only travelCountry "Austria" is currently supported.',
      });
    }

    const numericTravelerId = Number(travelerId);
    if (Number.isNaN(numericTravelerId)) {
      return res.status(400).json({ success: false, error: 'travelerId must be numeric.' });
    }

    const result = await fillFormFromDb({
      form: 'austria',
      travelerId: numericTravelerId,
      recordType,
      flatten,
      expectedTravelCountry: travelCountry,
      pool: dbPool,
    });

    if (!result.buffer) {
      throw new Error('PDF generation failed: missing buffer.');
    }

    const filename = outputFilename || `austria-${numericTravelerId}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Updated-Fields': result.updated.length,
      'X-Missing-Fields': result.missingFields.length,
    });
    res.send(result.buffer);
  } catch (err) {
    next(err);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Error handling - improved with better logging
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${new Date().toISOString()}:`, err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: CONFIG.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    ...(CONFIG.NODE_ENV === 'development' && { stack: err.stack })
  });
});

let httpServer;
let httpsServer;

function startHttpServer() {
  // HTTP Server (default)
  http.createServer(app).listen(PORT, () => {
    console.log('\n' + '='.repeat(70));
    console.log('🚀 Schengen Visa PDF Filler API (Node Backend)');
    console.log('='.repeat(70));
    console.log(`📡 Server running on: http://localhost:${PORT}`);
    console.log(`🌍 Environment: ${CONFIG.NODE_ENV}`);
    console.log('\n🔗 Available Endpoints:');
    console.log('   POST   /api/visa/fill-form      - Generate filled Austria PDF');
    console.log('   GET    /health                  - Server health check');
    console.log('   GET    /version                 - API version');
    console.log('\n🔐 CORS Enabled for:');
    console.log('   - https://booking.visad.co.uk');
    console.log('   - https://visad.co.uk');
    console.log('   - https://vault.visad.co.uk');
    console.log('   - http://localhost:3000');
    console.log('='.repeat(70));
    console.log('✅ Server is ready and listening for requests!\n');
  });
}

function startHttpsServer() {
  // HTTPS Server
  try {
    const httpsOptions = {
      key: fs.readFileSync(SSL_KEY_PATH),
      cert: fs.readFileSync(SSL_CERT_PATH)
    };

    https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
      console.log('\n' + '='.repeat(70));
      console.log('🚀 Schengen Visa PDF Filler API (Node Backend - HTTPS)');
      console.log('='.repeat(70));
      console.log(`🔒 HTTPS Server running on: https://localhost:${HTTPS_PORT}`);
      console.log(`🌍 Environment: ${CONFIG.NODE_ENV}`);
      console.log('\n🔗 Available Endpoints:');
      console.log('   POST   /api/visa/fill-form      - Generate filled Austria PDF');
      console.log('   GET    /health                  - Server health check');
      console.log('   GET    /version                 - API version');
      console.log('\n🔐 CORS Enabled for:');
      console.log('   - https://booking.visad.co.uk');
      console.log('   - https://visad.co.uk');
      console.log('   - https://vault.visad.co.uk');
      console.log('   - http://localhost:3000');
      console.log('='.repeat(70));
      console.log('✅ HTTPS Server is ready and listening for requests!\n');
    });

    // Optional: HTTP to HTTPS redirect server
    if (HTTP_REDIRECT) {
      http.createServer((req, res) => {
        res.writeHead(301, { "Location": `https://${req.headers.host}${req.url}` });
        res.end();
      }).listen(PORT, () => {
        console.log(`🔄 HTTP Redirect Server running on port ${PORT} -> HTTPS ${HTTPS_PORT}`);
      });
    }

  } catch (error) {
    console.error('❌ Failed to start HTTPS server:', error.message);
    console.log('💡 Falling back to HTTP mode...');

    // Fallback to HTTP
    http.createServer(app).listen(PORT, () => {
      console.log(`📡 HTTP Server (fallback) running on: http://localhost:${PORT}`);
    });
  }
}

if (USE_HTTPS) {
  startHttpsServer();
} else {
  startHttpServer();
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  dbPool.end().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down...');
  dbPool.end().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});

module.exports = app;

