const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
// Required for Hostinger/Nginx reverse proxy to allow secure session cookies
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = 'HostingerRepairLogicsSecret2026'; // Hardcoded for Hostinger stability

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Ensure upload directories exist
const videoUploadDir = path.join(__dirname, 'public', 'uploads', 'videos');
const driverUploadDir = path.join(__dirname, 'public', 'uploads', 'driver');
const sigUploadDir = path.join(__dirname, 'public', 'uploads');
[videoUploadDir, driverUploadDir, sigUploadDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Initialize SQLite Database
const db = new Database(path.join(__dirname, 'repairlogix.db'));
db.pragma('journal_mode = WAL');

// Create Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT,
    customer_phone TEXT,
    device_model TEXT,
    issue TEXT,
    repair_cost INTEGER,
    station_cut INTEGER,
    cashier_cut INTEGER,
    driver_cut INTEGER,
    tech_cut INTEGER,
    business_cut INTEGER,
    status TEXT DEFAULT 'DROPPED_AT_STATION',
    signature_url TEXT,
    diag_video_url TEXT,
    tech_pre_repair_video_url TEXT,
    tech_post_repair_video_url TEXT,
    driver_station_pickup_img TEXT,
    driver_tech_dropoff_img TEXT,
    driver_tech_pickup_img TEXT,
    driver_station_dropoff_img TEXT,
    cashier_id INTEGER,
    revision_status TEXT DEFAULT 'None',
    revised_cost INTEGER,
    handover_video_url TEXT,
    pickup_signature_url TEXT,
    pickup_selfie_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT,
    activity_type TEXT,
    activity_detail TEXT,
    performed_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add columns if they don't exist
const columns = [
    'diag_video_url', 'tech_pre_repair_video_url', 'tech_post_repair_video_url', 
    'driver_station_pickup_img', 'driver_tech_dropoff_img', 'driver_tech_pickup_img', 
    'driver_station_dropoff_img', 'cashier_id', 'revision_status', 'revised_cost', 
    'handover_video_url', 'pickup_signature_url', 'pickup_selfie_url'
];
columns.forEach(col => {
    try { db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${col.includes('cost') || col.includes('id') ? 'INTEGER' : 'TEXT'}`); } catch (e) {}
});

// Seed Default Users (Synchronous to guarantee users exist before startup)
const users = [
    { username: 'owner', password: 'owner123', role: 'owner' },
    { username: 'cashier', password: 'cashier123', role: 'cashier' },
    { username: 'driver', password: 'driver123', role: 'driver' },
    { username: 'tech', password: 'tech123', role: 'tech' }
];
users.forEach(u => {
    const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(u.username);
    if (!existing) {
        const hashed = bcrypt.hashSync(u.password, 10);
        db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(u.username, hashed, u.role);
    }
});

// Configure Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, videoUploadDir); },
  filename: function (req, file, cb) { cb(null, `vid_${Date.now()}.webm`); }
});
const upload = multer({ storage: storage });

// --- HELPERS ---
function logActivity(orderId, type, detail, performedBy = 'System') {
    db.prepare('INSERT INTO activity_logs (order_id, activity_type, activity_detail, performed_by) VALUES (?, ?, ?, ?)').run(orderId, type, detail, performedBy);
}

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) next();
    else res.status(401).json({ error: "Unauthorized. Please login." });
};

// --- AUTH ROUTES ---
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: "Invalid username or password" });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid username or password" });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth/me', (req, res) => {
    if (req.session.user) res.json({ user: req.session.user });
    else res.status(401).json({ error: "Not logged in" });
});

// Financial Rules Engine
function calculatePayouts(cost) {
  const repairCost = parseInt(cost);
  const stationCut = repairCost >= 100 ? 10 : 0;
  const cashierCut = 5;
  const driverCut = 7;
  const techCut = Math.round(repairCost * 0.75);
  const totalPayouts = stationCut + cashierCut + driverCut + techCut;
  let businessCut = repairCost - totalPayouts;
  if (businessCut < 0) businessCut = 0;
  return { repairCost, stationCut, cashierCut, driverCut, techCut, businessCut };
}

// --- PROTECTED API ROUTES ---

app.post('/api/upload-video', requireAuth, (req, res) => {
  upload.single('video')(req, res, function (err) {
    if (err) return res.status(500).json({ error: "File upload error: " + err.message });
    if (!req.file) return res.status(400).json({ error: "No video file received" });
    res.json({ success: true, videoUrl: `/uploads/videos/${req.file.filename}` });
  });
});

// Get Activity Logs for Evidence
app.get('/api/orders/:id/logs', requireAuth, (req, res) => {
    try {
        const logs = db.prepare('SELECT * FROM activity_logs WHERE order_id = ? ORDER BY created_at ASC').all(req.params.id);
        res.json(logs);
    } catch (err) { res.status(500).json({ error: "Failed to fetch logs" }); }
});

app.patch('/api/orders/:id/tech-video', requireAuth, (req, res) => {
  try {
    const { type, videoUrl } = req.body;
    const column = type === 'pre' ? 'tech_pre_repair_video_url' : 'tech_post_repair_video_url';
    db.prepare(`UPDATE orders SET ${column} = ? WHERE id = ?`).run(videoUrl, req.params.id);
    logActivity(req.params.id, 'MEDIA_UPLOADED', `Tech uploaded ${type}-repair video.`, req.session.user.username);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.patch('/api/orders/:id/driver-image', requireAuth, (req, res) => {
  try {
    const { type, imageBase64 } = req.body;
    const column = `driver_${type}_img`;
    const base64Data = imageBase64.split(',')[1];
    const fileName = `driver_${type}_${Date.now()}.png`;
    fs.writeFileSync(path.join(driverUploadDir, fileName), base64Data, 'base64');
    const imgUrl = `/uploads/driver/${fileName}`;
    db.prepare(`UPDATE orders SET ${column} = ? WHERE id = ?`).run(imgUrl, req.params.id);
    logActivity(req.params.id, 'MEDIA_UPLOADED', `Driver uploaded ${type.replace(/_/g, ' ')} photo.`, req.session.user.username);
    res.json({ success: true, imgUrl });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    res.json(orders);
  } catch (err) { res.status(500).json({ error: "Database error" }); }
});

app.post('/api/orders', requireAuth, (req, res) => {
  try {
    const { customerName, customerPhone, deviceModel, repairItems, repairCost, signatureBase64, diagVideoUrl } = req.body;
    if (!customerName || !customerPhone || !deviceModel || !repairItems || !repairCost) return res.status(400).json({ error: "Missing fields" });

    const payouts = calculatePayouts(repairCost);
    let signatureUrl = null;
    if (signatureBase64) {
      const base64Data = signatureBase64.split(',')[1];
      const fileName = `sig_${Date.now()}.png`;
      try {
        fs.writeFileSync(path.join(sigUploadDir, fileName), base64Data, 'base64');
        signatureUrl = `/uploads/${fileName}`;
      } catch(e) { console.error("Signature save error:", e); }
    }

    const id = `RLX-${Date.now().toString(36).toUpperCase()}`;
    db.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, device_model, issue, repair_cost, station_cut, cashier_cut, driver_cut, tech_cut, business_cut, signature_url, diag_video_url, cashier_id)
      VALUES (@id, @customerName, @customerPhone, @deviceModel, @issue, @repairCost, @stationCut, @cashierCut, @driverCut, @techCut, @businessCut, @signatureUrl, @diagVideoUrl, @cashierId)
    `).run({ id, customerName, customerPhone, deviceModel, issue: repairItems, ...payouts, signatureUrl, diagVideoUrl: diagVideoUrl || null, cashierId: req.session.user.id });

    logActivity(id, 'ORDER_CREATED', `Order created by ${req.session.user.username}. Est: $${repairCost}. Items: ${repairItems}`, req.session.user.username);
    if (signatureUrl) logActivity(id, 'MEDIA_UPLOADED', 'Customer signed estimate approval.', req.session.user.username);
    if (diagVideoUrl) logActivity(id, 'MEDIA_UPLOADED', 'Cashier uploaded diagnostic video.', req.session.user.username);

    res.status(201).json({ success: true, id });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

// --- TECH REVISION & APPROVAL ROUTES ---
app.patch('/api/orders/:id/revise', requireAuth, (req, res) => {
    const { revisedCost, revisedNotes } = req.body;
    if (!revisedCost || !revisedNotes) return res.status(400).json({ error: "Missing cost or notes" });
    
    db.prepare('UPDATE orders SET revision_status = ?, revised_cost = ?, issue = ? WHERE id = ?')
      .run('Pending Customer', revisedCost, revisedNotes, req.params.id);

    logActivity(req.params.id, 'REVISION_REQUESTED', `Tech requested price change to $${revisedCost}. Reason: ${revisedNotes}`, req.session.user.username);

    if (process.env.TWILIO_ACCOUNT_SID) {
        const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
        client.messages.create({
            body: `RepairLogics: Tech recommends a revised estimate of $${revisedCost} for your ${order.device_model}. Reason: ${revisedNotes}. Please click here to approve: https://repairlogics.us/?track=${order.id}`,
            from: process.env.TWILIO_PHONE_NUMBER, to: order.customer_phone
        }).catch(() => {});
    }
    res.json({ success: true });
});

app.patch('/api/public/revise/:id/:action', (req, res) => {
    const { id, action } = req.params;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order || order.revision_status !== 'Pending Customer') return res.status(400).json({ error: "Invalid request" });

    if (action === 'approve') {
        const newPayouts = calculatePayouts(order.revised_cost);
        db.prepare('UPDATE orders SET revision_status = ?, repair_cost = ?, station_cut = ?, cashier_cut = ?, driver_cut = ?, tech_cut = ?, business_cut = ? WHERE id = ?')
          .run('Approved', newPayouts.repairCost, newPayouts.stationCut, newPayouts.cashierCut, newPayouts.driverCut, newPayouts.techCut, newPayouts.businessCut, id);
        logActivity(id, 'REVISION_APPROVED', `Customer APPROVED the revised estimate of $${order.revised_cost}.`, 'Customer');
    } else {
        db.prepare('UPDATE orders SET revision_status = ?, status = ?, repair_cost = ?, station_cut = ?, cashier_cut = ?, driver_cut = ?, tech_cut = ?, business_cut = ? WHERE id = ?')
          .run('Rejected', 'DRIVER_TO_STATION', 0, 0, 0, 0, 0, 0, id);
        logActivity(id, 'REVISION_REJECTED', `Customer REJECTED the revised estimate. Order routed back to driver for return.`, 'Customer');
    }
    res.json({ success: true });
});

app.patch('/api/orders/:id/not-repairable', requireAuth, (req, res) => {
    db.prepare('UPDATE orders SET status = ?, revision_status = ? WHERE id = ?').run('DRIVER_TO_STATION', 'Not Repairable', req.params.id);
    logActivity(req.params.id, 'NOT_REPAIRABLE', `Tech marked device as Not Repairable. Routed to driver for return.`, req.session.user.username);
    
    if (process.env.TWILIO_ACCOUNT_SID) {
        const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
        client.messages.create({
            body: `RepairLogics: Unfortunately, your ${order.device_model} is not repairable. The driver is returning it to the gas station. No charge applied.`,
            from: process.env.TWILIO_PHONE_NUMBER, to: order.customer_phone
        }).catch(() => {});
    }
    res.json({ success: true });
});

// --- CASHIER HANDOVER & PICKUP ROUTE ---
app.patch('/api/orders/:id/handover', requireAuth, (req, res) => {
    const { videoUrl, pickupSignatureBase64, pickupSelfieBase64 } = req.body;
    if (!videoUrl || !pickupSignatureBase64 || !pickupSelfieBase64) return res.status(400).json({ error: "Missing handover video, signature, or selfie" });

    let pickupSignatureUrl = null;
    if (pickupSignatureBase64) {
        const base64Data = pickupSignatureBase64.split(',')[1];
        const fileName = `pickup_sig_${Date.now()}.png`;
        fs.writeFileSync(path.join(sigUploadDir, fileName), base64Data, 'base64');
        pickupSignatureUrl = `/uploads/${fileName}`;
    }

    let pickupSelfieUrl = null;
    if (pickupSelfieBase64) {
        const base64Data = pickupSelfieBase64.split(',')[1];
        const fileName = `pickup_selfie_${Date.now()}.png`;
        fs.writeFileSync(path.join(driverUploadDir, fileName), base64Data, 'base64');
        pickupSelfieUrl = `/uploads/driver/${fileName}`;
    }

    db.prepare('UPDATE orders SET status = ?, handover_video_url = ?, pickup_signature_url = ?, pickup_selfie_url = ? WHERE id = ?')
      .run('COMPLETED', videoUrl, pickupSignatureUrl, pickupSelfieUrl, req.params.id);
    
    logActivity(req.params.id, 'HANDOVER_COMPLETE', `Cashier recorded handover video, customer signature, and selfie. Order COMPLETED.`, req.session.user.username);
    
    if (process.env.TWILIO_ACCOUNT_SID) {
        const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
        client.messages.create({
            body: `RepairLogics: Payment received. Thank you for your business!`,
            from: process.env.TWILIO_PHONE_NUMBER, to: order.customer_phone
        }).catch(() => {});
    }
    res.json({ success: true });
});

// Advance Workflow Status
app.patch('/api/orders/:id/advance', requireAuth, (req, res) => {
  try {
    const workflow = ['DROPPED_AT_STATION', 'DRIVER_TO_TECH', 'AT_TECH', 'REPAIRING', 'REPAIR_DONE', 'DRIVER_TO_STATION', 'READY_FOR_CUSTOMER', 'COMPLETED'];
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const currentIndex = workflow.indexOf(order.status);
    if (currentIndex < workflow.length - 1) {
      const nextStatus = workflow[currentIndex + 1];
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(nextStatus, req.params.id);
      
      const statusMessages = {
          'DRIVER_TO_TECH': 'Driver picked up from station.',
          'AT_TECH': 'Driver dropped off at tech lab.',
          'REPAIRING': 'Tech started repair.',
          'REPAIR_DONE': 'Tech finished repair.',
          'DRIVER_TO_STATION': 'Driver picked up from tech.',
          'READY_FOR_CUSTOMER': 'Driver dropped off at station.',
          'COMPLETED': 'Order completed.'
      };

      logActivity(req.params.id, nextStatus, statusMessages[nextStatus] || `Status changed to ${nextStatus.replace(/_/g, ' ')}`, req.session.user.username);

      if (process.env.TWILIO_ACCOUNT_SID) {
         const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
         let msg = "";
         if (nextStatus === 'DRIVER_TO_TECH') msg = `Your driver has picked up your ${order.device_model}.`;
         else if (nextStatus === 'READY_FOR_CUSTOMER') msg = `Your ${order.device_model} is ready for pickup! Please bring $${order.repair_cost}.`;
         if (msg) client.messages.create({ body: `RepairLogics: ${msg}`, from: process.env.TWILIO_PHONE_NUMBER, to: order.customer_phone }).catch(() => {});
      }
      return res.json({ success: true, newStatus: nextStatus });
    }
    res.json({ success: true, newStatus: order.status });
  } catch (error) { res.status(500).json({ error: "Failed" }); }
});

// --- DYNAMIC MARKETING QR REDIRECT ---
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
const defaultUrl = db.prepare('SELECT * FROM settings WHERE key = ?').get('marketing_redirect_url');
if (!defaultUrl) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('marketing_redirect_url', 'https://repairlogics.us');
}

app.get('/r/marketing', (req, res) => {
  const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get('marketing_redirect_url');
  const targetUrl = setting ? setting.value : 'https://repairlogics.us';
  res.redirect(302, targetUrl);
});

app.get('/api/settings/marketing', requireAuth, (req, res) => {
  const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get('marketing_redirect_url');
  res.json({ url: setting ? setting.value : 'https://repairlogics.us' });
});

app.patch('/api/settings/marketing', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: "Unauthorized" });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('marketing_redirect_url', url);
  res.json({ success: true, url });
});

// --- PUBLIC TRACKING API ---
app.get('/api/track/:id', (req, res) => {
  try {
    const order = db.prepare('SELECT id, customer_name, device_model, status, revision_status, revised_cost, repair_cost, issue, created_at FROM orders WHERE id = ?').get(req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: "Invalid tracking code." });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.listen(PORT, () => console.log(`RepairLogics running on port ${PORT}`));
