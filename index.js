const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const expo = new Expo();

const DB_PATH = process.env.DB_PATH || '/data/data.json';
const LOGS_PATH = process.env.LOGS_PATH || '/data/logs.json';

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  const originalSend = res.send;
  res.send = function(data) {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - ${res.statusCode}`);
    originalSend.call(this, data);
  };
  next();
});

// Initialize data files
async function initializeData() {
  try {
    await fs.access(DB_PATH);
  } catch (error) {
    const initialData = {
      pushTokens: [],
      lastAvailableCourts: [],
      botStatus: {
        isRunning: false,
        lastCheck: null,
        nextCheck: null
      }
    };
    await fs.writeFile(DB_PATH, JSON.stringify(initialData, null, 2));
  }

  try {
    await fs.access(LOGS_PATH);
  } catch (error) {
    await fs.writeFile(LOGS_PATH, JSON.stringify([], null, 2));
  }
}

// Data helpers
async function readData() {
  const data = await fs.readFile(DB_PATH, 'utf8');
  return JSON.parse(data);
}

async function writeData(data) {
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

async function addLog(message, type = 'info', data = null) {
  const logs = JSON.parse(await fs.readFile(LOGS_PATH, 'utf8'));
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type,
    data
  };
  logs.unshift(logEntry);
  // Keep only last 100 logs
  if (logs.length > 100) {
    logs.splice(100);
  }
  await fs.writeFile(LOGS_PATH, JSON.stringify(logs, null, 2));
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// Court scraping function
async function scrapeCourts() {
  try {
    await addLog('Starting court availability check...');
    
    const response = await axios.get('https://rec.us/joedimaggio', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    await addLog('Successfully fetched website content');
    
    const $ = cheerio.load(response.data);
    const courts = [];
    
    // Look for Friday dates (next 14 days)
    const now = new Date();
    const fridays = [];
    for (let i = 0; i < 14; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() + i);
      if (date.getDay() === 5) { // Friday
        fridays.push(date.toISOString().split('T')[0]);
      }
    }
    
    await addLog(`Looking for availability on Fridays: ${fridays.join(', ')}`);
    
    // Parse the page for court availability
    // This is a generic scraper that looks for common patterns
    $('.calendar-day, .available-slot, .time-slot, .court-slot').each((i, elem) => {
      const text = $(elem).text().trim();
      const dateAttr = $(elem).attr('data-date') || $(elem).find('[data-date]').attr('data-date');
      
      if (text && (text.includes('available') || text.includes('open') || $(elem).hasClass('available'))) {
        courts.push({
          date: dateAttr || 'Unknown',
          time: text,
          court: `Court ${courts.length + 1}`,
          available: true
        });
      }
    });
    
    // If no structured data found, look for any Friday mentions
    if (courts.length === 0) {
      const pageText = $('body').text();
      fridays.forEach(friday => {
        if (pageText.includes(friday) || pageText.includes('Friday')) {
          courts.push({
            date: friday,
            time: 'Various times available',
            court: 'Joe DiMaggio Tennis Courts',
            available: true
          });
        }
      });
    }
    
    await addLog(`Found ${courts.length} available slots`, 'success', courts);
    return courts;
    
  } catch (error) {
    await addLog(`Error scraping courts: ${error.message}`, 'error');
    return [];
  }
}

// Send push notifications
async function sendPushNotifications(courts) {
  const data = await readData();
  const { pushTokens } = data;
  
  await addLog(`Checking push tokens... Found ${pushTokens.length} tokens`);
  
  if (pushTokens.length === 0) {
    await addLog('No push tokens registered for notifications', 'error');
    return;
  }
  
  const validTokens = pushTokens.filter(token => {
    const isValid = Expo.isExpoPushToken(token);
    if (!isValid) {
      addLog(`Invalid push token found: ${token.substring(0, 20)}...`, 'error');
    }
    return isValid;
  });
  
  await addLog(`Found ${validTokens.length} valid push tokens out of ${pushTokens.length} total`);
  
  if (validTokens.length === 0) {
    await addLog('No valid push tokens to send notifications to', 'error');
    return;
  }
  
  const messages = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title: '🎾 Tennis Courts Available!',
    body: `${courts.length} Friday slots found at Joe DiMaggio`,
    data: { courts }
  }));
  
  try {
    await addLog(`Preparing to send ${messages.length} push notifications`);
    const chunks = expo.chunkPushNotifications(messages);
    
    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      await addLog(`Sent push notification chunk of ${chunk.length} messages`, 'success', ticketChunk);
    }
    
    await addLog(`Successfully sent notifications to ${validTokens.length} devices`, 'success');
  } catch (error) {
    await addLog(`Error sending push notifications: ${error.message}`, 'error');
  }
}

// Bot monitoring logic
async function runBot() {
  const data = await readData();
  data.botStatus.lastCheck = new Date().toISOString();
  
  const courts = await scrapeCourts();
  
  // Check if there are new available courts
  const previousCourts = data.lastAvailableCourts || [];
  const newCourts = courts.filter(court => 
    !previousCourts.some(prev => 
      prev.date === court.date && prev.time === court.time
    )
  );
  
  if (newCourts.length > 0) {
    await addLog(`New courts available! Sending notifications for ${newCourts.length} slots`, 'success');
    await sendPushNotifications(newCourts);
  } else {
    await addLog('No new courts available');
  }
  
  data.lastAvailableCourts = courts;
  data.botStatus.nextCheck = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min from now
  await writeData(data);
}

// API Routes
app.get('/', (req, res) => {
  res.json({ 
    message: 'Tennis Court Monitor API', 
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

app.post('/register-push-token', async (req, res) => {
  try {
    const { token } = req.body;
    
    await addLog(`Received push token registration request: ${token ? token.substring(0, 20) + '...' : 'NO TOKEN'}`);
    
    if (!token) {
      await addLog('Push token registration failed: No token provided', 'error');
      return res.status(400).json({ error: 'No push token provided' });
    }
    
    if (!Expo.isExpoPushToken(token)) {
      await addLog(`Push token registration failed: Invalid token format - ${token.substring(0, 20)}...`, 'error');
      return res.status(400).json({ error: 'Invalid push token format' });
    }
    
    const data = await readData();
    if (!data.pushTokens.includes(token)) {
      data.pushTokens.push(token);
      await writeData(data);
      await addLog(`Successfully registered new push token: ${token.substring(0, 20)}...`, 'success');
    } else {
      await addLog(`Push token already registered: ${token.substring(0, 20)}...`);
    }
    
    res.json({ 
      success: true, 
      message: 'Push token registered',
      totalTokens: data.pushTokens.length
    });
  } catch (error) {
    await addLog(`Error registering push token: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/test-notification', async (req, res) => {
  try {
    const data = await readData();
    const { pushTokens } = data;
    
    await addLog(`Test notification requested. Found ${pushTokens.length} registered tokens`);
    
    if (pushTokens.length === 0) {
      await addLog('Test notification failed: No push tokens registered', 'error');
      return res.status(400).json({ error: 'No push tokens registered' });
    }
    
    const validTokens = pushTokens.filter(token => Expo.isExpoPushToken(token));
    await addLog(`Found ${validTokens.length} valid tokens out of ${pushTokens.length} total`);
    
    if (validTokens.length === 0) {
      await addLog('Test notification failed: No valid push tokens', 'error');
      return res.status(400).json({ error: 'No valid push tokens found' });
    }
    
    const messages = validTokens.map(token => ({
      to: token,
      sound: 'default',
      title: '🎾 Test Notification',
      body: 'Push notifications are working correctly!',
      data: { test: true }
    }));
    
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      await addLog(`Test notification chunk sent`, 'success', ticketChunk);
    }
    
    await addLog(`Test notifications sent to ${validTokens.length} devices`, 'success');
    res.json({ success: true, message: `Test notification sent to ${validTokens.length} devices` });
  } catch (error) {
    await addLog(`Error sending test notification: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.get('/logs', async (req, res) => {
  try {
    const logs = JSON.parse(await fs.readFile(LOGS_PATH, 'utf8'));
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/status', async (req, res) => {
  try {
    const data = await readData();
    res.json({
      botStatus: data.botStatus,
      registeredTokens: data.pushTokens.length,
      validTokens: data.pushTokens.filter(token => Expo.isExpoPushToken(token)).length,
      availableCourts: data.lastAvailableCourts || [],
      pushTokens: data.pushTokens.map(token => token.substring(0, 20) + '...') // For debugging
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/force-check', async (req, res) => {
  try {
    await addLog('Manual court check triggered');
    await runBot();
    res.json({ success: true, message: 'Court check completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/debug-tokens', async (req, res) => {
  try {
    const data = await readData();
    const tokenDetails = data.pushTokens.map(token => ({
      preview: token.substring(0, 30) + '...',
      isValid: Expo.isExpoPushToken(token),
      length: token.length
    }));
    
    res.json({
      totalTokens: data.pushTokens.length,
      tokens: tokenDetails
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server and bot
async function startServer() {
  await initializeData();
  
  // Schedule bot to run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    await runBot();
  });
  
  // Run bot once on startup
  setTimeout(() => runBot(), 5000);
  
  app.listen(PORT, () => {
    console.log(`Tennis Court Monitor Server running on port ${PORT}`);
    addLog(`Server started on port ${PORT}`);
  });
}

startServer().catch(console.error);