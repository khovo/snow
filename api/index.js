const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// ============================================================
// 1. CONFIGURATION (ቅንብሮች)
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing!');
if (!MONGODB_URI) throw new Error('MONGODB_URI is missing!');

// ============================================================
// 2. DATABASE SCHEMAS (የዳታ አቀማመጥ)
// ============================================================

// A. Anti-Duplicate (ግሩፕ ላይ ሁለቴ እንዳይልክ)
const processedUpdateSchema = new mongoose.Schema({
  update_id: { type: Number, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 } // 1 Hour TTL
});
const ProcessedUpdate = mongoose.models.ProcessedUpdate || mongoose.model('ProcessedUpdate', processedUpdateSchema);

// B. Configs (Start Msg, Layout, Button Names)
const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// C. User Data (Streak, Relapse History, Admin Session)
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: String,
  streakStart: { type: Date, default: Date.now },
  bestStreak: { type: Number, default: 0 },
  relapseHistory: [{ date: { type: Date, default: Date.now }, reason: String }],
  lastActive: { type: Date, default: Date.now },
  adminState: { 
      step: { type: String, default: null },
      tempData: { type: mongoose.Schema.Types.Mixed, default: {} }
  }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

// D. Channels
const channelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  link: { type: String, required: true }
});
const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema);

// E. Custom Buttons (Text, Photo, Video, Voice + Inline Links)
const customButtonSchema = new mongoose.Schema({
  label: { type: String, required: true, unique: true },
  type: { type: String, enum: ['text', 'photo', 'video', 'voice'], default: 'text' },
  content: { type: String, required: true }, // File ID or Text
  caption: { type: String },
  inlineLinks: [{ label: String, url: String }] // For Reading Lists
});
const CustomButton = mongoose.models.CustomButton || mongoose.model('CustomButton', customButtonSchema);

// F. Motivation Texts
const motivationSchema = new mongoose.Schema({
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});
const Motivation = mongoose.models.Motivation || mongoose.model('Motivation', motivationSchema);

// ============================================================
// 3. DATABASE CONNECTION (Global Cache)
// ============================================================
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  try {
    cachedDb = await mongoose.connect(MONGODB_URI, { 
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000 
    });
    console.log("🔥 DB Connected");
    return cachedDb;
  } catch (error) {
    console.error("❌ DB Error:", error);
    throw error;
  }
}

// ============================================================
// 4. HELPER FUNCTIONS
// ============================================================
async function setAdminStep(userId, step, data = {}) {
    await User.findOneAndUpdate({ userId }, { adminState: { step, tempData: data } }, { upsert: true });
}
async function getAdminState(userId) {
    const user = await User.findOne({ userId });
    return user ? user.adminState : { step: null, tempData: {} };
}
async function clearAdminStep(userId) {
    await User.findOneAndUpdate({ userId }, { adminState: { step: null, tempData: {} } });
}
async function getConfig(key, def) {
    const doc = await Config.findOne({ key });
    return doc ? doc.value : def;
}

// ============================================================
// 5. BOT LOGIC
// ============================================================
const bot = new Telegraf(BOT_TOKEN);

// --- START COMMAND ---
bot.start(async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const firstName = ctx.from.first_name || 'Friend';
    
    // User Update
    await User.findOneAndUpdate({ userId }, { firstName, lastActive: new Date() }, { upsert: true });
    if (ADMIN_IDS.includes(userId)) await clearAdminStep(userId);

    // Fetch Configs
    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
    const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');

    // Build Layout
    const defaultLayout = [[urgeLabel, streakLabel], [channelLabel]];
    let layoutRaw = await getConfig('keyboard_layout', defaultLayout);
    let layout = (typeof layoutRaw === 'string') ? JSON.parse(layoutRaw) : layoutRaw;

    // Add Custom Buttons dynamically
    const customBtns = await CustomButton.find({});
    const existingLabels = layout.flat();
    let tempRow = [];
    customBtns.forEach(btn => {
        if (!existingLabels.includes(btn.label)) {
            tempRow.push(btn.label);
            if (tempRow.length === 2) { layout.push(tempRow); tempRow = []; }
        }
    });
    if (tempRow.length > 0) layout.push(tempRow);

    if (ADMIN_IDS.includes(userId)) layout.push(['🔐 Admin Panel']);

    const welcomeMsg = await getConfig('welcome_msg', `ሰላም ${firstName}! እንኳን በሰላም መጣህ።`);
    await ctx.reply(welcomeMsg, Markup.keyboard(layout).resize());
  } catch (e) { console.error(e); }
});

// --- MAIN HANDLER (Text, Photo, Video, Voice) ---
bot.on(['text', 'photo', 'video', 'voice'], async (ctx) => {
    if (!ctx.message) return;

    try {
        const userId = String(ctx.from.id);
        const text = ctx.message.text; 

        // === ADMIN WIZARD (Adding Content) ===
        if (ADMIN_IDS.includes(userId)) {
            const state = await getAdminState(userId);
            if (state && state.step) {
                // Cancel Action
                if (text === '/cancel') {
                    await clearAdminStep(userId);
                    return ctx.reply('❌ ሂደቱ ተሰርዟል።');
                }

                // 1. Layout Editing
                if (state.step === 'awaiting_layout') {
                    const lines = text.split('\n').map(l => l.split(',').map(i => i.trim()).filter(x=>x)).filter(r=>r.length>0);
                    await Config.findOneAndUpdate({ key: 'keyboard_layout' }, { value: JSON.stringify(lines) }, { upsert: true });
                    await ctx.reply('✅ Layout Saved! /start'); await clearAdminStep(userId); return;
                }
                // 2. Welcome Message
                if (state.step === 'awaiting_welcome') {
                    await Config.findOneAndUpdate({ key: 'welcome_msg' }, { value: text }, { upsert: true });
                    await ctx.reply('✅ Start Msg Saved!'); await clearAdminStep(userId); return;
                }
                // 3. Rename Buttons
                if (state.step === 'awaiting_urge_name') {
                    await Config.findOneAndUpdate({ key: 'urge_btn_label' }, { value: text }, { upsert: true });
                    await ctx.reply('✅ Saved! /start'); await clearAdminStep(userId); return;
                }
                if (state.step === 'awaiting_streak_name') {
                    await Config.findOneAndUpdate({ key: 'streak_btn_label' }, { value: text }, { upsert: true });
                    await ctx.reply('✅ Saved! /start'); await clearAdminStep(userId); return;
                }
                // 4. Add Channel
                if (state.step === 'awaiting_channel_name') {
                    await setAdminStep(userId, 'awaiting_channel_link', { name: text });
                    return ctx.reply('🔗 Link (https://t.me/...):');
                }
                if (state.step === 'awaiting_channel_link') {
                    await Channel.create({ name: state.tempData.name, link: text });
                    await ctx.reply('✅ Channel Added!'); await clearAdminStep(userId); return;
                }
                // 5. Add Motivation
                if (state.step === 'awaiting_motivation') {
                    await Motivation.create({ text });
                    await ctx.reply('✅ Added!'); await clearAdminStep(userId); return;
                }

                // 6. ADD CUSTOM BUTTON (With Media & Links Support)
                if (state.step === 'awaiting_btn_name') {
                    await setAdminStep(userId, 'awaiting_btn_content', { label: text });
                    return ctx.reply('📥 አሁን ይዘቱን ይላኩ (ፅሁፍ፣ ፎቶ፣ ቪዲዮ ወይም Voice):');
                }
                if (state.step === 'awaiting_btn_content') {
                    let type = 'text', content = '', caption = ctx.message.caption || '';
                    if (ctx.message.voice) { type = 'voice'; content = ctx.message.voice.file_id; }
                    else if (ctx.message.photo) { type = 'photo'; content = ctx.message.photo[ctx.message.photo.length - 1].file_id; }
                    else if (ctx.message.video) { type = 'video'; content = ctx.message.video.file_id; }
                    else if (text) { content = text; }
                    else return ctx.reply('⚠️ Invalid Content.');

                    // Save to temp and ask for links
                    await setAdminStep(userId, 'awaiting_btn_links', { label: state.tempData.label, type, content, caption });
                    
                    return ctx.reply(
                        '🔗 **Link መጨመር ይፈልጋሉ?** (ለምሳሌ ለንባብ ዝርዝር)\n\n' +
                        'ካልፈለጉ "No" ብለው ይላኩ።\n\n' +
                        'ከፈለጉ በዚህ መልኩ ይላኩ:\n' +
                        'ርእስ 1 - https://t.me/link1\n' +
                        'ርእስ 2 - https://t.me/link2'
                    );
                }
                if (state.step === 'awaiting_btn_links') {
                    let inlineLinks = [];
                    if (text && text.toLowerCase() !== 'no') {
                        const lines = text.split('\n');
                        for (let line of lines) {
                            const parts = line.split('-');
                            if (parts.length >= 2) {
                                const label = parts[0].trim();
                                const url = parts.slice(1).join('-').trim();
                                if (label && url.startsWith('http')) inlineLinks.push({ label, url });
                            }
                        }
                    }
                    try {
                        await CustomButton.create({ 
                            label: state.tempData.label, type: state.tempData.type, 
                            content: state.tempData.content, caption: state.tempData.caption,
                            inlineLinks: inlineLinks 
                        });
                        await ctx.reply(`✅ Button "${state.tempData.label}" Created!`);
                    } catch (e) { await ctx.reply('❌ Error: ስሙ ተደጋግሞ ይሆናል።'); }
                    await clearAdminStep(userId); return;
                }
            }
        }

        // === STANDARD USER INTERACTIONS ===
        if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(userId)) return showAdminMenu(ctx);

        const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
        if (text === urgeLabel) {
            const count = await Motivation.countDocuments();
            if (count === 0) return ctx.reply('Empty.');
            const m = await Motivation.findOne().skip(Math.floor(Math.random() * count));
            return ctx.reply(`💪 **በርታ!**\n\n${m.text}`, { parse_mode: 'Markdown' });
        }

        const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
        if (text === streakLabel) return handleStreak(ctx);

        const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
        if (text === channelLabel) {
            const channels = await Channel.find({});
            if (channels.length === 0) return ctx.reply('No Channels.');
            const btns = channels.map(c => [Markup.button.url(c.name, c.link)]);
            return ctx.reply('Channels:', Markup.inlineKeyboard(btns));
        }

        // Custom Buttons Logic (Supports Links!)
        const customBtn = await CustomButton.findOne({ label: text });
        if (customBtn) {
            let extra = { parse_mode: 'Markdown' };
            if (customBtn.caption) extra.caption = customBtn.caption;
            // Add inline links if available
            if (customBtn.inlineLinks && customBtn.inlineLinks.length > 0) {
                const linkBtns = customBtn.inlineLinks.map(l => [Markup.button.url(l.label, l.url)]);
                extra.reply_markup = { inline_keyboard: linkBtns };
            }

            if (customBtn.type === 'photo') return ctx.replyWithPhoto(customBtn.content, extra);
            if (customBtn.type === 'video') return ctx.replyWithVideo(customBtn.content, extra);
            if (customBtn.type === 'voice') return ctx.replyWithVoice(customBtn.content, extra);
            return ctx.reply(customBtn.content, extra);
        }

    } catch (e) { console.error(e); }
});

// ============================================================
// 6. LOGIC FUNCTIONS (STREAK, RELAPSE, ADMIN)
// ============================================================

async function handleStreak(ctx) {
    const userId = String(ctx.from.id);
    let user = await User.findOne({ userId });
    if (!user) user = await User.create({ userId, firstName: ctx.from.first_name });

    const diff = Math.floor(Math.abs(new Date() - user.streakStart) / 86400000);
    await ctx.reply(
        `🔥 **${user.firstName}**\nStreak: **${diff} Days**\nBest: ${user.bestStreak}`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('💔 ወደቅኩ (Relapse)', `rel_${userId}`)],
            [Markup.button.callback('🏆 ደረጃ (Leaderboard)', `led_${userId}`)],
            [Markup.button.callback('🔄 Refresh', `ref_${userId}`)]
        ])
    );
}

const verify = (ctx, id) => String(ctx.from.id) === id;

// Relapse Menu
bot.action(/^rel_(.+)$/, async ctx => {
    if (!verify(ctx, ctx.match[1])) return ctx.answerCbQuery('Not yours!');
    await ctx.editMessageText('ለምን ወደቅክ? (ምክንያቱን ምረጥ)', Markup.inlineKeyboard([
        [Markup.button.callback('🥱 መሰላቸት', `rsn_bored_${ctx.match[1]}`)],
        [Markup.button.callback('😰 ጭንቀት', `rsn_stress_${ctx.match[1]}`)],
        [Markup.button.callback('🔥 ስሜት', `rsn_urge_${ctx.match[1]}`)],
        [Markup.button.callback('❌ ሰረዝ (Cancel)', `can_${ctx.match[1]}`)]
    ]));
});

// Process Relapse Reason
bot.action(/^rsn_(.+)_(.+)$/, async ctx => {
    if (!verify(ctx, ctx.match[2])) return ctx.answerCbQuery();
    const u = await User.findOne({ userId: ctx.match[2] });
    const d = Math.floor(Math.abs(new Date() - u.streakStart) / 86400000);
    if (d > u.bestStreak) u.bestStreak = d;
    u.streakStart = new Date();
    u.relapseHistory.push({ reason: ctx.match[1] });
    await u.save();
    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.reply('✅ መዝግቤያለሁ። ቀናትህ ወደ 0 ተመልሰዋል። ጠንክር! 💪');
    await ctx.answerCbQuery();
});

// Helper Actions
bot.action(/^ref_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return; try{await ctx.deleteMessage();}catch(e){} await handleStreak(ctx); ctx.answerCbQuery(); });
bot.action(/^can_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return; try{await ctx.deleteMessage();}catch(e){} ctx.answerCbQuery('Cancelled'); });

// Leaderboard
bot.action(/^led_(.+)$/, async ctx => {
    const t = await User.find().sort({ streakStart: 1 }).limit(10);
    let m = '🏆 **Top 10 Leaders**\n'; 
    t.forEach((u, i) => m += `${i+1}. ${u.firstName} - ${Math.floor(Math.abs(new Date() - u.streakStart)/86400000)} d\n`);
    await ctx.editMessageText(m, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `ref_${ctx.match[1]}`)]])});
});

// Admin Panel
async function showAdminMenu(ctx) {
    const c = await User.countDocuments();
    await ctx.reply(`⚙️ Admin Dashboard (Users: ${c})`, Markup.inlineKeyboard([
        [Markup.button.callback('➕ Motivation', 'adm_mot'), Markup.button.callback('🔲 Layout', 'adm_lay')],
        [Markup.button.callback('📝 Start Msg', 'adm_wel'), Markup.button.callback('🏷️ Rename', 'adm_ren')],
        [Markup.button.callback('📢 Channels', 'adm_chan'), Markup.button.callback('🔘 Custom Btn', 'adm_cus')]
    ]));
}

const ask = (ctx, s, t) => { setAdminStep(String(ctx.from.id), s); ctx.reply(t); ctx.answerCbQuery(); };
bot.action('adm_mot', c => ask(c, 'awaiting_motivation', 'Send Text:'));
bot.action('adm_lay', c => ask(c, 'awaiting_layout', 'Send Layout:'));
bot.action('adm_wel', c => ask(c, 'awaiting_welcome', 'Send Msg:'));
bot.action('adm_ren', c => { c.reply('Which?', Markup.inlineKeyboard([[Markup.button.callback('Urge', 'ren_urg'), Markup.button.callback('Streak', 'ren_str')]])); c.answerCbQuery(); });
bot.action('ren_urg', c => ask(c, 'awaiting_urge_name', 'New Name:'));
bot.action('ren_str', c => ask(c, 'awaiting_streak_name', 'New Name:'));
bot.action('adm_chan', async c => { const ch = await Channel.find({}); c.editMessageText('Channels:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_ch')], ...ch.map(x=>[Markup.button.callback(`🗑️ ${x.name}`, `del_ch_${x._id}`)])])); });
bot.action('add_ch', c => ask(c, 'awaiting_channel_name', 'Name:'));
bot.action(/^del_ch_(.+)$/, async c => { await Channel.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });
bot.action('adm_cus', async c => { const b = await CustomButton.find({}); c.editMessageText('Custom:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_cus')], ...b.map(x=>[Markup.button.callback(`🗑️ ${x.label}`, `del_cus_${x._id}`)])])); });
bot.action('add_cus', c => ask(c, 'awaiting_btn_name', 'Name:'));
bot.action(/^del_cus_(.+)$/, async c => { await CustomButton.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });

// ============================================================
// 7. SERVERLESS EXPORT (Anti-Duplicate & Timeout Protection)
// ============================================================
module.exports = async (req, res) => {
    // 1. Ping Check
    if (req.method === 'GET') return res.status(200).send('Active');

    // 2. Main Logic
    if (req.method === 'POST') {
        const update = req.body;
        const updateId = update.update_id;

        const botLogic = async () => {
            await connectToDatabase();
            // Dedup Check
            try { await ProcessedUpdate.create({ update_id: updateId }); } 
            catch (e) { if(e.code===11000) return; throw e; }
            // Run
            await bot.handleUpdate(update);
        };

        try {
            // Timeout Protection (4.5s)
            await Promise.race([
                botLogic(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4500))
            ]);
        } catch (e) { if (e.message !== 'Timeout') console.error('Error:', e); }
    }
    // Always OK to prevent retries
    res.status(200).send('OK');
};
