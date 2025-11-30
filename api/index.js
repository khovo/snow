const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// --- 1. CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing!');
if (!MONGODB_URI) throw new Error('MONGODB_URI is missing!');

// --- 2. DATABASE SCHEMAS ---

// A. Anti-Duplicate (Updated)
const processedUpdateSchema = new mongoose.Schema({
  update_id: { type: Number, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 } // Keep only for 1 hour to save space
});
const ProcessedUpdate = mongoose.models.ProcessedUpdate || mongoose.model('ProcessedUpdate', processedUpdateSchema);

// B. Configs
const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// C. User & Admin Session
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: String,
  streakStart: { type: Date, default: Date.now },
  bestStreak: { type: Number, default: 0 },
  relapseHistory: [{ date: { type: Date, default: Date.now }, reason: String }],
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

// E. Custom Buttons
const customButtonSchema = new mongoose.Schema({
  label: { type: String, required: true, unique: true },
  type: { type: String, enum: ['text', 'photo', 'video', 'voice'], default: 'text' },
  content: { type: String, required: true },
  caption: { type: String }
});
const CustomButton = mongoose.models.CustomButton || mongoose.model('CustomButton', customButtonSchema);

// F. Motivation
const motivationSchema = new mongoose.Schema({
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});
const Motivation = mongoose.models.Motivation || mongoose.model('Motivation', motivationSchema);

// --- 3. OPTIMIZED DB CONNECTION (GLOBAL CACHE) ---
// Vercel ላይ ፍጥነት ለመጨመር ይህ ዘዴ ወሳኝ ነው።
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;

  try {
    const opts = { bufferCommands: false, serverSelectionTimeoutMS: 5000 };
    cachedDb = await mongoose.connect(MONGODB_URI, opts);
    console.log("New DB Connection Established");
    return cachedDb;
  } catch (error) {
    console.error("DB Error:", error);
    throw error;
  }
}

// --- 4. HELPER FUNCTIONS ---
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

// --- 5. BOT SETUP ---
const bot = new Telegraf(BOT_TOKEN);

// --- START COMMAND ---
bot.start(async (ctx) => {
    // Ignore Group Service Messages
    if (ctx.message.chat.type !== 'private' && !ctx.message.text) return;
    
    const userId = String(ctx.from.id);
    const firstName = ctx.from.first_name || 'Friend';
    
    await User.findOneAndUpdate({ userId }, { firstName }, { upsert: true });
    if (ADMIN_IDS.includes(userId)) await clearAdminStep(userId);

    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
    const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');

    const defaultLayout = [[urgeLabel, streakLabel], [channelLabel]];
    let layoutRaw = await getConfig('keyboard_layout', defaultLayout);
    let layout = (typeof layoutRaw === 'string') ? JSON.parse(layoutRaw) : layoutRaw;

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
});

// --- MAIN INPUT HANDLER ---
bot.on(['text', 'photo', 'video', 'voice'], async (ctx) => {
    // Ignore updates that are not messages (like pin updates, group migration)
    if (!ctx.message) return;
    
    // Check for "Relocated" or other service messages which might appear as text in some clients
    // But mainly we rely on ctx.message.text
    const text = ctx.message.text;
    const userId = String(ctx.from.id);

    // ADMIN WIZARD
    if (ADMIN_IDS.includes(userId)) {
        const state = await getAdminState(userId);
        if (state && state.step) {
            if (text === '/cancel') {
                await clearAdminStep(userId);
                return ctx.reply('❌ ሂደቱ ተሰርዟል።');
            }

            if (state.step === 'awaiting_layout') {
                if (!text) return ctx.reply('Text only please.');
                const lines = text.split('\n').map(l => l.split(',').map(i => i.trim()).filter(x=>x));
                await Config.findOneAndUpdate({ key: 'keyboard_layout' }, { value: JSON.stringify(lines) }, { upsert: true });
                await ctx.reply('✅ Layout Saved! /start'); await clearAdminStep(userId); return;
            }
            if (state.step === 'awaiting_welcome') {
                await Config.findOneAndUpdate({ key: 'welcome_msg' }, { value: text }, { upsert: true });
                await ctx.reply('✅ Start Msg Saved!'); await clearAdminStep(userId); return;
            }
            if (state.step === 'awaiting_urge_name') {
                await Config.findOneAndUpdate({ key: 'urge_btn_label' }, { value: text }, { upsert: true });
                await ctx.reply('✅ Saved! /start'); await clearAdminStep(userId); return;
            }
            if (state.step === 'awaiting_streak_name') {
                await Config.findOneAndUpdate({ key: 'streak_btn_label' }, { value: text }, { upsert: true });
                await ctx.reply('✅ Saved! /start'); await clearAdminStep(userId); return;
            }
            if (state.step === 'awaiting_channel_name') {
                await setAdminStep(userId, 'awaiting_channel_link', { name: text });
                return ctx.reply('🔗 Link:');
            }
            if (state.step === 'awaiting_channel_link') {
                await Channel.create({ name: state.tempData.name, link: text });
                await ctx.reply('✅ Channel Added!'); await clearAdminStep(userId); return;
            }
            if (state.step === 'awaiting_btn_name') {
                await setAdminStep(userId, 'awaiting_btn_content', { label: text });
                return ctx.reply('📥 Content (Text/Photo/Video/Voice):');
            }
            if (state.step === 'awaiting_btn_content') {
                let type = 'text', content = '', caption = ctx.message.caption || '';
                if (ctx.message.voice) { type = 'voice'; content = ctx.message.voice.file_id; }
                else if (ctx.message.photo) { type = 'photo'; content = ctx.message.photo[ctx.message.photo.length - 1].file_id; }
                else if (ctx.message.video) { type = 'video'; content = ctx.message.video.file_id; }
                else if (text) { content = text; }
                else return ctx.reply('⚠️ Invalid Content.');
                
                try { await CustomButton.create({ label: state.tempData.label, type, content, caption }); } catch(e) {}
                await ctx.reply(`✅ Button "${state.tempData.label}" Created!`); await clearAdminStep(userId); return;
            }
            if (state.step === 'awaiting_motivation') {
                await Motivation.create({ text });
                await ctx.reply('✅ Added!'); await clearAdminStep(userId); return;
            }
        }
    }

    // NORMAL INTERACTIONS
    if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(userId)) return showAdminMenu(ctx);

    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    if (text === urgeLabel) {
        const count = await Motivation.countDocuments();
        if (count === 0) return ctx.reply('...Empty...');
        const random = Math.floor(Math.random() * count);
        const m = await Motivation.findOne().skip(random);
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

    const customBtn = await CustomButton.findOne({ label: text });
    if (customBtn) {
        if (customBtn.type === 'photo') return ctx.replyWithPhoto(customBtn.content, { caption: customBtn.caption });
        if (customBtn.type === 'video') return ctx.replyWithVideo(customBtn.content, { caption: customBtn.caption });
        if (customBtn.type === 'voice') return ctx.replyWithVoice(customBtn.content, { caption: customBtn.caption });
        return ctx.reply(customBtn.content);
    }
});

// --- STREAK LOGIC ---
async function handleStreak(ctx) {
    const userId = String(ctx.from.id);
    let user = await User.findOne({ userId });
    if (!user) user = await User.create({ userId, firstName: ctx.from.first_name });

    const diff = Math.floor(Math.abs(new Date() - user.streakStart) / 86400000);
    await ctx.reply(
        `🔥 **${user.firstName}**\nStreak: **${diff} Days**\nBest: ${user.bestStreak}`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('💔 Relapse', `rel_${userId}`)],
            [Markup.button.callback('🏆 Leaderboard', `led_${userId}`)],
            [Markup.button.callback('🔄 Refresh', `ref_${userId}`)]
        ])
    );
}

// --- CALLBACK ACTIONS ---
const verifyOwner = (ctx, id) => String(ctx.from.id) === id;

bot.action(/^rel_(.+)$/, async (ctx) => {
    if (!verifyOwner(ctx, ctx.match[1])) return ctx.answerCbQuery('Not yours!');
    await ctx.editMessageText('ለምን ወደቅክ?', Markup.inlineKeyboard([
        [Markup.button.callback('🥱 Bored', `rsn_bor_${ctx.match[1]}`)],
        [Markup.button.callback('😰 Stress', `rsn_str_${ctx.match[1]}`)],
        [Markup.button.callback('🔥 Urge', `rsn_urg_${ctx.match[1]}`)],
        [Markup.button.callback('❌ Cancel', `can_${ctx.match[1]}`)]
    ]));
});

bot.action(/^rsn_(.+)_(.+)$/, async (ctx) => {
    if (!verifyOwner(ctx, ctx.match[2])) return ctx.answerCbQuery('Not yours!');
    const uid = ctx.match[2];
    let user = await User.findOne({ userId: uid });
    const days = Math.floor(Math.abs(new Date() - user.streakStart) / 86400000);
    if (days > user.bestStreak) user.bestStreak = days;
    user.streakStart = new Date();
    user.relapseHistory.push({ reason: ctx.match[1] });
    await user.save();
    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.reply('✅ Reset to 0. Stay strong!');
    await ctx.answerCbQuery();
});

bot.action(/^ref_(.+)$/, async (ctx) => {
    if (!verifyOwner(ctx, ctx.match[1])) return ctx.answerCbQuery('Not yours!');
    try { await ctx.deleteMessage(); } catch(e){}
    await handleStreak(ctx);
    await ctx.answerCbQuery();
});

bot.action(/^can_(.+)$/, async (ctx) => {
    if (!verifyOwner(ctx, ctx.match[1])) return ctx.answerCbQuery('Not yours!');
    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.answerCbQuery('Cancelled');
});

bot.action(/^led_(.+)$/, async (ctx) => {
    const tops = await User.find().sort({ streakStart: 1 }).limit(10);
    let msg = '🏆 **Top 10**\n';
    tops.forEach((u, i) => msg += `${i+1}. ${u.firstName} - ${Math.floor(Math.abs(new Date() - u.streakStart)/86400000)} days\n`);
    await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `ref_${ctx.match[1]}`)]])});
});

// --- ADMIN MENU ---
async function showAdminMenu(ctx) {
    const c = await User.countDocuments();
    await ctx.reply(`⚙️ **Admin** (Users: ${c})`, Markup.inlineKeyboard([
        [Markup.button.callback('➕ Motivation', 'adm_mot'), Markup.button.callback('🔲 Layout', 'adm_lay')],
        [Markup.button.callback('📝 Start Msg', 'adm_wel'), Markup.button.callback('🏷️ Rename', 'adm_ren')],
        [Markup.button.callback('📢 Channels', 'adm_chan'), Markup.button.callback('🔘 Custom Btn', 'adm_cus')]
    ]));
}

const ask = (ctx, step, txt) => { setAdminStep(String(ctx.from.id), step); ctx.reply(txt); ctx.answerCbQuery(); };
bot.action('adm_mot', c => ask(c, 'awaiting_motivation', 'Send Motivation:'));
bot.action('adm_lay', c => ask(c, 'awaiting_layout', 'Send Layout (csv):'));
bot.action('adm_wel', c => ask(c, 'awaiting_welcome', 'Send Start Msg:'));
bot.action('adm_ren', c => { c.reply('Which?', Markup.inlineKeyboard([[Markup.button.callback('🆘 Urge', 'ren_urg'), Markup.button.callback('📅 Streak', 'ren_str')]])); c.answerCbQuery(); });
bot.action('ren_urg', c => ask(c, 'awaiting_urge_name', 'New Urge Name:'));
bot.action('ren_str', c => ask(c, 'awaiting_streak_name', 'New Streak Name:'));
bot.action('adm_chan', async c => { const ch = await Channel.find({}); c.editMessageText('Channels:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_ch')], ...ch.map(x=>[Markup.button.callback(`🗑️ ${x.name}`, `del_ch_${x._id}`)])])); });
bot.action('add_ch', c => ask(c, 'awaiting_channel_name', 'Channel Name:'));
bot.action(/^del_ch_(.+)$/, async c => { await Channel.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });
bot.action('adm_cus', async c => { const b = await CustomButton.find({}); c.editMessageText('Custom:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_cus')], ...b.map(x=>[Markup.button.callback(`🗑️ ${x.label}`, `del_cus_${x._id}`)])])); });
bot.action('add_cus', c => ask(c, 'awaiting_btn_name', 'Button Name:'));
bot.action(/^del_cus_(.+)$/, async c => { await CustomButton.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });


// --- 6. SERVERLESS HANDLER (STRICT DEDUPLICATION) ---
module.exports = async (req, res) => {
    // 1. ወዲያውኑ መልስ መስጠት (Timeout ለመከላከል)
    // ይሄ Vercel Functionን እንዲዘጋ አያደርገውም፣ ግን Telegramን "እሺ ሰምቻለሁ" ይለዋል።
    // ማሳሰቢያ: Vercel ላይ response ከላክን በኋላ execution ሊቆም ይችላል፣ ስለዚህ await እናደርጋለን።
    
    try {
        if (req.method === 'POST') {
            const update = req.body;
            const updateId = update.update_id;

            // Connection Cache Check
            await connectToDatabase();

            // A. Anti-Duplicate Check
            try {
                await ProcessedUpdate.create({ update_id: updateId });
            } catch (err) {
                if (err.code === 11000) {
                    console.log(`Duplicate update ignored: ${updateId}`);
                    return res.status(200).send('OK');
                }
                console.error("Unknown DB Error", err);
                return res.status(200).send('OK'); // Always return OK to stop retries
            }

            // B. Process Update
            try {
                await bot.handleUpdate(update);
            } catch (e) {
                console.error("Bot Handler Error:", e);
            }
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Server Error:', error);
        res.status(200).send('OK');
    }
};
