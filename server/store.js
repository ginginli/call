/**
 * 极简 JSON 持久化层。数据写入 data/db.json。
 * 单进程演示足够;重启自动恢复。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error('db.json 读取失败, 使用空库:', e.message);
    }
  }
  return { seq: 1, users: [], cards: [], classes: [], invites: [], notifications: [], jobs: [] };
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = loadDB();
db.users = db.users || [];
db.cards = db.cards || [];
db.classes = db.classes || [];
db.invites = db.invites || [];
db.cardRequests = db.cardRequests || [];
db.featureRequests = db.featureRequests || [];
db.notifications = db.notifications || [];
db.jobs = db.jobs || [];
db.seq = db.seq || 1;

function persist() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('数据保存失败:', e.message);
  }
}

function nextId(prefix) {
  db.seq = (db.seq || 1) + 1;
  return prefix + db.seq.toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { db, persist, nextId, DB_FILE };
