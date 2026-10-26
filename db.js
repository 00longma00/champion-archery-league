const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

const defaultData = {
  config: {
    adminPin: process.env.ADMIN_PIN || '1234',
    leagueTime: process.env.LEAGUE_TIME || '7:00 PM',
    defaultStatus: 'PENDING'
  },
  archers: [
    // { id, name, email, remindMe: true/false, createdAt }
  ],
  events: {
    // 'YYYY-MM-DD': { date: 'YYYY-MM-DD', status: 'ON' | 'OFF' | 'PENDING', note: '' }
  },
  rsvps: {
    // 'YYYY-MM-DD': [ { archerName, status: 'YES'|'NO'|'MAYBE', note, updatedAt } ]
  }
};

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
      return defaultData;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading data.json:', err);
    return defaultData;
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing data.json:', err);
  }
}

function getUpcomingSunday(baseDate = new Date()) {
  const d = new Date(baseDate);
  const day = d.getDay(); // 0 is Sunday
  const diff = (7 - day) % 7;
  d.setDate(d.getDate() + diff);
  
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = {
  readDB,
  writeDB,
  getUpcomingSunday
};
